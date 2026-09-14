/**
 * Explicit, one-time provisioning for the existing OFD PostgreSQL host.
 *
 * Run only as an approved operations job. Never add this file to application
 * startup, migrations, or CI against a production database. Required inputs:
 *   DATABASE_URL: the existing ofd_postgres_user / ofd_postgres connection
 *   ODA_PROVISION_APPLY=1
 *   ODA_PROVISION_OFD_PASSWORD and ODA_PROVISION_ODA_PASSWORD: distinct, strong
 *   passwords (32+ characters), injected as temporary secret environment values.
 *
 * ofd_app owns only the OFD database and its existing application objects, so
 * the existing automatic migration command remains compatible. oda_app owns
 * only the new ODA database. Neither application role has cluster privileges or
 * membership in another role. The managed administrator remains able to operate
 * both databases; its credential must be removed from both application services
 * only after this job succeeds and the replacement connections are verified.
 *
 * CREATE DATABASE cannot share the ownership transaction. Every completed stage
 * is reported without secrets. Failures leave new resources in place for review;
 * they never DROP a database, delete business rows, or terminate live sessions.
 * Recovery: suspend ODA first; preserve/reinstate the old OFD application
 * connection, then use the logged rollback manifest as the managed administrator.
 * Never drop the new database unless its data has separately been reviewed.
 */
import pg from 'pg';
import { pathToFileURL } from 'node:url';

const OFD_DATABASE = 'ofd_postgres';
const ADMIN_ROLE = 'ofd_postgres_user';
const OFD_ROLE = 'ofd_app';
const ODA_DATABASE = 'oda_production';
const ODA_ROLE = 'oda_app';
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

function check(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

export function readProvisionInputs(env) {
  check(env.ODA_PROVISION_APPLY === '1', 'EXPLICIT_PROVISION_APPLY_REQUIRED');
  const ofdPassword = String(env.ODA_PROVISION_OFD_PASSWORD ?? '');
  const odaPassword = String(env.ODA_PROVISION_ODA_PASSWORD ?? '');
  for (const password of [ofdPassword, odaPassword]) {
    check(password.length >= 32 && password.length <= 256
      && /[a-z]/.test(password) && /[A-Z]/.test(password)
      && /[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password)
      && !/[\x00-\x20\x7f]/.test(password), 'STRONG_PROVISION_PASSWORD_REQUIRED');
  }
  check(ofdPassword !== odaPassword, 'DISTINCT_PROVISION_PASSWORDS_REQUIRED');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { check(false, 'MANAGED_CONNECTION_REQUIRED'); }
  check(['postgres:', 'postgresql:'].includes(url.protocol)
    && decodeURIComponent(url.username) === ADMIN_ROLE
    && decodeURIComponent(url.pathname.slice(1)) === OFD_DATABASE
    && url.password && url.hostname && !url.hash, 'MANAGED_CONNECTION_TARGET_MISMATCH');
  for (const [key, value] of url.searchParams) {
    check(key === 'sslmode' && value === 'require', 'MANAGED_CONNECTION_OVERRIDE_REJECTED');
  }
  check(url.searchParams.getAll('sslmode').length <= 1, 'MANAGED_CONNECTION_OVERRIDE_REJECTED');
  check(decodeURIComponent(url.password) !== ofdPassword
    && decodeURIComponent(url.password) !== odaPassword, 'ADMIN_PASSWORD_REUSE_REJECTED');
  return { url, ofdPassword, odaPassword };
}

function connectionFor(inputs, database, role, password) {
  const url = new URL(inputs.url);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = password;
  return url.href;
}

async function transaction(client, operation) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '1500ms'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function inspect(client) {
  const identity = (await client.query(`SELECT current_database() AS database,
    current_user AS role, session_user AS session_role,
    r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  check(identity?.database === OFD_DATABASE && identity.role === ADMIN_ROLE
    && identity.session_role === ADMIN_ROLE && identity.rolcreaterole
    && identity.rolcreatedb && !identity.rolsuper && !identity.rolbypassrls,
  'MANAGED_DATABASE_IDENTITY_MISMATCH');

  const collisions = await client.query(`SELECT 'role' AS kind,rolname AS name
    FROM pg_roles WHERE rolname=ANY($1::text[])
    UNION ALL SELECT 'database',datname FROM pg_database WHERE datname=$2`,
  [[OFD_ROLE, ODA_ROLE], ODA_DATABASE]);
  check(collisions.rows.length === 0, 'NEW_RESOURCE_NAME_ALREADY_EXISTS_NO_CHANGES');

  const database = (await client.query(`SELECT d.datname, r.rolname AS owner,
    d.datallowconn, d.datacl::text AS acl,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
      WHERE a.grantee=0 AND a.privilege_type='CONNECT') AS public_connect
    FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1`,
  [OFD_DATABASE])).rows[0];
  check(database?.owner === ADMIN_ROLE && database.datallowconn,
    'EXISTING_DATABASE_OWNER_MISMATCH');
  // Render's primaryuser/datadog monitoring connections may rely on PUBLIC.
  // Snapshot every existing login with CONNECT before either new role exists,
  // then preserve exactly that access explicitly when PUBLIC is removed.
  const existingConnections = (await client.query(`SELECT r.rolname AS role,
    r.rolsuper AS superuser,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
      WHERE a.grantee=r.oid AND a.privilege_type='CONNECT') AS direct_connect
    FROM pg_roles r CROSS JOIN pg_database d
    WHERE d.datname=$1 AND r.rolcanlogin
      AND has_database_privilege(r.oid,d.oid,'CONNECT') ORDER BY r.rolname`,
  [OFD_DATABASE])).rows;
  check(existingConnections.some((row) => row.role === ADMIN_ROLE),
    'ADMIN_CONNECT_SNAPSHOT_MISSING');

  const schema = (await client.query(`SELECT n.nspname AS name,r.rolname AS owner,
    n.nspacl::text AS acl FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='public'`)).rows[0];
  check(schema && [ADMIN_ROLE, 'pg_database_owner'].includes(schema.owner),
    'PUBLIC_SCHEMA_OWNER_REQUIRES_REVIEW');

  // Ignore extension-owned objects and all objects owned by PostgreSQL's service
  // accounts. Indexes, table row types and table-owned identity sequences follow
  // their table owner; sequence statements are harmless after that propagation.
  const relations = (await client.query(`SELECT c.oid,c.relname AS name,c.relkind AS kind,
    r.rolname AS owner,n.nspname AS schema
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='public' AND r.rolname=$1
      AND c.relkind IN ('r','p','v','m','S','f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
        AND d.objid=c.oid AND d.deptype='e')
    ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END,c.relname`,
  [ADMIN_ROLE])).rows;
  check(relations.some((relation) => relation.name === 'schema_migrations'
    && relation.kind === 'r'), 'MANAGED_MIGRATION_LEDGER_OWNER_REQUIRED');
  const functions = (await client.query(`SELECT p.oid,p.proname AS name,p.prokind AS kind,
    r.rolname AS owner,n.nspname AS schema,
    pg_get_function_identity_arguments(p.oid) AS arguments
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND r.rolname=$1
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass
        AND d.objid=p.oid AND d.deptype='e') ORDER BY p.proname,p.oid`,
  [ADMIN_ROLE])).rows;
  check(functions.every((fn) => ['f', 'p', 'a', 'w'].includes(fn.kind)),
    'UNSUPPORTED_APPLICATION_ROUTINE');
  return { database, schema, relations, functions, existingConnections };
}

function ownershipStatements(snapshot, role) {
  const statements = [];
  for (const relation of snapshot.relations) {
    const command = { r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW',
      S: 'SEQUENCE', f: 'FOREIGN TABLE' }[relation.kind];
    statements.push(`ALTER ${command} ${quote(relation.schema)}.${quote(relation.name)} OWNER TO ${quote(role)}`);
  }
  for (const fn of snapshot.functions) {
    const command = fn.kind === 'p' ? 'PROCEDURE' : fn.kind === 'a' ? 'AGGREGATE' : 'FUNCTION';
    statements.push(`ALTER ${command} ${quote(fn.schema)}.${quote(fn.name)}(${fn.arguments}) OWNER TO ${quote(role)}`);
  }
  return statements;
}

export function recoveryManifest(snapshot) {
  return {
    instructions: [
      'Suspend ODA before reverting OFD to the managed administrator connection.',
      'The administrator retains INHERIT and SET access to the new application roles; old OFD connections remain usable.',
      'If only a new application deployment failed, restore the old OFD connection first; ownership rollback is not required for recovery.',
      'If ownership reversal is required, run the SQL below as ofd_postgres_user in ofd_postgres, with ODA stopped.',
      'Do not drop new databases or roles automatically. Review their contents, active connections and dependencies before separate cleanup.',
      'A database created with ALLOW_CONNECTIONS false may remain disabled after failure; review the last completed stage.',
    ],
    originalConnectRoles: snapshot.existingConnections,
    sql: [
      'BEGIN', "SET LOCAL lock_timeout='1500ms'", "SET LOCAL statement_timeout='15s'",
      `ALTER DATABASE ${quote(OFD_DATABASE)} OWNER TO ${quote(ADMIN_ROLE)}`,
      ...ownershipStatements(snapshot, ADMIN_ROLE),
      ...(snapshot.schema.owner === ADMIN_ROLE
        ? [`ALTER SCHEMA public OWNER TO ${quote(ADMIN_ROLE)}`] : []),
      // No unrelated grants are revoked. Restore just the PUBLIC CONNECT bit
      // changed here; all other original grants survive the round trip.
      `${snapshot.database.public_connect ? 'GRANT CONNECT ON' : 'REVOKE CONNECT ON'} DATABASE ${quote(OFD_DATABASE)} ${snapshot.database.public_connect ? 'TO' : 'FROM'} PUBLIC`,
      ...snapshot.existingConnections.filter((row) => !row.direct_connect).map((row) =>
        `REVOKE CONNECT ON DATABASE ${quote(OFD_DATABASE)} FROM ${quote(row.role)}`),
      `REVOKE CONNECT ON DATABASE ${quote(OFD_DATABASE)} FROM ${quote(OFD_ROLE)}`,
      `REVOKE USAGE,CREATE ON SCHEMA public FROM ${quote(OFD_ROLE)}`,
      'COMMIT',
    ],
  };
}

async function verifyOwnDatabase(makeClient, inputs, database, role, password) {
  const client = makeClient(connectionFor(inputs, database, role, password));
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const row = (await client.query(`SELECT current_database() AS database,
      current_user AS role,current_schema() AS schema,r.rolsuper,r.rolcreaterole,
      r.rolcreatedb,r.rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS memberships,
      has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner
      FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    check(row?.database === database && row.role === role && row.owner === role
      && row.schema === 'public' && row.schema_usage && row.schema_create
      && !row.rolsuper && !row.rolcreaterole && !row.rolcreatedb
      && !row.rolbypassrls && !row.memberships, 'APPLICATION_DATABASE_IDENTITY_FAILED');
    await client.query('COMMIT');
    return { database, role, owner: row.owner, globalPrivileges: false, memberships: false };
  } finally {
    await client.end().catch(() => {});
  }
}

async function verifyRejectedConnection(makeClient, inputs, database, role, password) {
  const client = makeClient(connectionFor(inputs, database, role, password));
  let connected = false;
  let failureCode;
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    failureCode = error.code;
  } finally {
    await client.end().catch(() => {});
  }
  check(!connected && failureCode === '42501', 'CROSS_DATABASE_CONNECTION_NOT_PROVEN_BLOCKED');
  return { database, role, rejected: true, sqlState: failureCode };
}

async function verifyPreservedMetadata(client, snapshot) {
  const connections = (await client.query(`SELECT r.rolname AS role,
    has_database_privilege(r.oid,$1,'CONNECT') AS can_connect
    FROM pg_roles r WHERE r.rolname=ANY($2::text[]) ORDER BY r.rolname`,
  [OFD_DATABASE, snapshot.existingConnections.map((row) => row.role)])).rows;
  check(connections.length === snapshot.existingConnections.length
    && connections.every((row) => row.can_connect), 'EXISTING_OFD_CONNECT_ACCESS_NOT_PRESERVED');
  const relations = (await client.query(`SELECT c.oid,pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c WHERE c.oid=ANY($1::oid[])`,
  [snapshot.relations.map((row) => row.oid)])).rows;
  const functions = (await client.query(`SELECT p.oid,pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p WHERE p.oid=ANY($1::oid[])`,
  [snapshot.functions.map((row) => row.oid)])).rows;
  check(relations.length === snapshot.relations.length
    && functions.length === snapshot.functions.length
    && [...relations, ...functions].every((row) => row.owner === OFD_ROLE),
  'OFD_APPLICATION_OWNERSHIP_NOT_VERIFIED');
  return { preservedConnectRoles: connections.map((row) => row.role),
    verifiedRelationOwners: relations.length, verifiedRoutineOwners: functions.length };
}

export async function provisionSharedDatabase(env = process.env, options = {}) {
  const inputs = readProvisionInputs(env);
  const log = options.log ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const makeClient = options.makeClient ?? ((connectionString) => new pg.Client({
    connectionString, connectionTimeoutMillis: 10_000, query_timeout: 20_000,
    application_name: 'oda-approved-shared-provision',
  }));
  const client = makeClient(inputs.url.href);
  let stage = 'not_started';
  let connected = false;
  let databaseCreated = false;
  let ownershipCommitConfirmed = false;
  let snapshot;
  try {
    await client.connect();
    connected = true;
    // Serialize two accidental concurrent invocations without waiting on one.
    const locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('oda_shared_provision_v1')) AS locked")).rows[0]?.locked;
    check(locked, 'ANOTHER_PROVISION_JOB_IS_RUNNING');
    const migrationLocked = (await client.query("SELECT pg_try_advisory_lock(hashtext('ofd_schema_migrations')) AS locked")).rows[0]?.locked;
    check(migrationLocked, 'OFD_MIGRATION_IS_RUNNING_RETRY_AFTER_IT_FINISHES');
    snapshot = await inspect(client);
    stage = 'read_only_inventory_verified';
    log({ stage, database: OFD_DATABASE, originalOwner: snapshot.database.owner,
      originalSchemaOwner: snapshot.schema.owner,
      preservedConnectRoles: snapshot.existingConnections,
      ownership: [...snapshot.relations, ...snapshot.functions],
      recovery: recoveryManifest(snapshot) });

    await transaction(client, async () => {
      // Collision checks are repeated inside the creation transaction.
      const collisions = await client.query(`SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])
        UNION ALL SELECT 1 FROM pg_database WHERE datname=$2`, [[OFD_ROLE, ODA_ROLE], ODA_DATABASE]);
      check(collisions.rows.length === 0, 'NEW_RESOURCE_NAME_ALREADY_EXISTS_NO_CHANGES');
      for (const role of [OFD_ROLE, ODA_ROLE]) {
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      }
      // Bind passwords as protocol parameters; never put them in job arguments,
      // static SQL text, logged output or a persistent configuration file.
      await client.query(`SELECT set_config('oda_provision.ofd_password',$1,true),
        set_config('oda_provision.oda_password',$2,true),
        set_config('oda_provision.ofd_role',$3,true),set_config('oda_provision.oda_role',$4,true)`,
        [inputs.ofdPassword, inputs.odaPassword, OFD_ROLE, ODA_ROLE]);
      await client.query(`DO $provision$ BEGIN
        EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L',current_setting('oda_provision.ofd_role'),current_setting('oda_provision.ofd_password'));
        EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L',current_setting('oda_provision.oda_role'),current_setting('oda_provision.oda_password'));
      END $provision$`);
      // This direction preserves the administrator's old/live OFD connections.
      // Application roles must never be members of the managed admin role.
      for (const role of [OFD_ROLE, ODA_ROLE]) {
        await client.query(`GRANT ${quote(role)} TO ${quote(ADMIN_ROLE)} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      }
    });
    stage = 'dedicated_roles_created';
    log({ stage });

    await client.query(`CREATE DATABASE ${quote(ODA_DATABASE)} OWNER ${quote(ODA_ROLE)} ALLOW_CONNECTIONS false`);
    databaseCreated = true;
    stage = 'oda_database_created_connections_disabled';
    log({ stage });
    await transaction(client, async () => {
      await client.query(`REVOKE ALL ON DATABASE ${quote(ODA_DATABASE)} FROM PUBLIC`);
      await client.query(`GRANT CONNECT ON DATABASE ${quote(ODA_DATABASE)} TO ${quote(ODA_ROLE)},${quote(ADMIN_ROLE)}`);
      // Keep connections disabled until OFD ownership and reciprocal ACLs commit.
    });
    stage = 'oda_database_acl_prepared';
    log({ stage });

    await transaction(client, async () => {
      for (const row of snapshot.existingConnections) {
        await client.query(`GRANT CONNECT ON DATABASE ${quote(OFD_DATABASE)} TO ${quote(row.role)}`);
      }
      await client.query(`GRANT CONNECT ON DATABASE ${quote(OFD_DATABASE)} TO ${quote(OFD_ROLE)}`);
      await client.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${quote(ADMIN_ROLE)},${quote(OFD_ROLE)}`);
      await client.query(`ALTER DATABASE ${quote(OFD_DATABASE)} OWNER TO ${quote(OFD_ROLE)}`);
      if (snapshot.schema.owner === ADMIN_ROLE) {
        await client.query(`ALTER SCHEMA public OWNER TO ${quote(OFD_ROLE)}`);
      }
      for (const statement of ownershipStatements(snapshot, OFD_ROLE)) await client.query(statement);
      await client.query(`REVOKE CONNECT ON DATABASE ${quote(OFD_DATABASE)} FROM PUBLIC`);
      // A single commit makes the new database available only after both ACLs
      // and all OFD object ownership changes are ready.
      await client.query(`ALTER DATABASE ${quote(ODA_DATABASE)} ALLOW_CONNECTIONS true`);
    });
    ownershipCommitConfirmed = true;
    stage = 'ownership_and_reciprocal_acl_committed';
    log({ stage });

    const preservedMetadata = await verifyPreservedMetadata(client, snapshot);
    const identities = [];
    identities.push(await verifyOwnDatabase(makeClient, inputs, OFD_DATABASE, OFD_ROLE, inputs.ofdPassword));
    identities.push(await verifyOwnDatabase(makeClient, inputs, ODA_DATABASE, ODA_ROLE, inputs.odaPassword));
    const blockedConnections = [];
    blockedConnections.push(await verifyRejectedConnection(makeClient, inputs, ODA_DATABASE, OFD_ROLE, inputs.ofdPassword));
    blockedConnections.push(await verifyRejectedConnection(makeClient, inputs, OFD_DATABASE, ODA_ROLE, inputs.odaPassword));
    stage = 'database_provisioning_verified';
    const result = { stage, identities, blockedConnections, preservedMetadata,
      applicationServicesChanged: false, migrationsExecuted: false,
      next: 'Verify the existing OFD migration command with ofd_app, then replace API and worker DATABASE_URL secrets sequentially. Remove temporary provisioning password values. Deploy ODA only after both OFD services use ofd_app.' };
    log(result);
    return result;
  } catch (error) {
    // Before the ownership transaction succeeds, the ODA database stays disabled.
    // After it succeeds, never change a working production database in a catch
    // block. Report the exact boundary and require deliberate recovery instead.
    const code = error.safeCode ?? (/^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : 'PROVISION_FAILED');
    log({ stage: 'failed', lastCompletedStage: stage, code, databaseCreated,
      ownershipTransactionCommitConfirmed: ownershipCommitConfirmed,
      recoveryRequiresInspection: 'A timeout or connection failure can leave a commit outcome uncertain; inspect owners and ACLs before recovery. An unconfirmed commit is not proof of rollback.',
      resourcesAutomaticallyDeleted: false,
      recovery: snapshot ? recoveryManifest(snapshot) : undefined });
    const safeError = new Error(code);
    safeError.safeCode = code;
    throw safeError;
  } finally {
    if (connected) await client.end().catch(() => {});
    // These are operation-only secrets. Remove them from this process as soon
    // as possible; the caller must also remove their Render secret values.
    delete env.ODA_PROVISION_OFD_PASSWORD;
    delete env.ODA_PROVISION_ODA_PASSWORD;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  provisionSharedDatabase().catch((error) => {
    process.stderr.write(`ODA provisioning stopped: ${error.safeCode ?? 'PROVISION_FAILED'}\n`);
    process.exitCode = 1;
  });
}
