/**
 * Approved native PostgreSQL fixture check; never an application startup step.
 * The existing managed connection is used only for catalog checks and creating /
 * removing uniquely named disposable resources. Application SQL uses fixture DBs.
 * Call runNativeCheck(provisionSource, managedDatabaseUrl) from an operations job,
 * or set ODA_PROVISION_NATIVE_CHECK=1 for the standalone entry point.
 * No production provision is performed. Credentials stay in process memory.
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const assert = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { safeCode: code });
};
const password = () => `Aa1!${randomBytes(36).toString('base64url')}`;

export function prepareFixtureSource(source, names) {
  assert(typeof source === 'string' && source.length < 150_000, 'PROVISION_SOURCE_REQUIRED');
  const constants = {
    OFD_DATABASE: ['ofd_postgres', names.ofdDb], ADMIN_ROLE: ['ofd_postgres_user', names.admin],
    OFD_ROLE: ['ofd_app', names.ofdRole], ODA_DATABASE: ['oda_production', names.odaDb],
    ODA_ROLE: ['oda_app', names.odaRole],
  };
  for (const [constant, [original, replacement]] of Object.entries(constants)) {
    if (!/^oda_probe_[a-f0-9]{12}_[a-z_]+$/.test(replacement)) {
      throw Object.assign(new Error('FIXTURE_NAME_INVALID'), { safeCode: 'FIXTURE_NAME_INVALID',
        safeDetails: { constant, generatedFixtureName: String(replacement).slice(0, 90) } });
    }
    const declaration = `const ${constant} = '${original}';`;
    assert(source.split(declaration).length === 2, 'PROVISION_CONSTANT_MATCH_FAILED');
    source = source.replace(declaration, `const ${constant} = '${replacement}';`);
  }
  // Old versions embedded production role names in a DO block. Such a version
  // cannot safely be tested by replacing just the constants.
  assert(!/ALTER ROLE (?:ofd_app|oda_app)\b/.test(source), 'HARDCODED_PRODUCTION_ROLE_REJECTED');
  assert(source.split("import pg from 'pg';").length === 2, 'PROVISION_IMPORT_MATCH_FAILED');
  const require = createRequire(import.meta.url);
  return source.replace("import pg from 'pg';",
    `import pg from ${JSON.stringify(pathToFileURL(require.resolve('pg')).href)};`);
}

export async function runNativeCheck(source, databaseUrl, options = {}) {
  const log = options.log ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  let stage = 'initialization';
  try {
    return await runNativeCheckImpl(source, databaseUrl, { ...options, log,
      recordStage: (value) => { stage = value; } });
  } catch (error) {
    const rawCode = error.safeCode ?? error.code ?? 'NATIVE_CHECK_UNEXPECTED_FAILURE';
    const code = /^[A-Z0-9_]{1,100}$/.test(rawCode) ? rawCode : 'NATIVE_CHECK_UNEXPECTED_FAILURE';
    // Never emit message/stack: URL parsers and module errors may include inputs.
    log({ nativeCheck: 'stopped', stage, code,
      errorType: ['Error','TypeError','SyntaxError','ReferenceError','URIError'].includes(error.name)
        ? error.name : 'Error',
      fixtureNameDiagnostic: code === 'FIXTURE_NAME_INVALID' ? error.safeDetails : undefined });
    throw Object.assign(new Error(code), { safeCode: code });
  }
}

async function runNativeCheckImpl(source, databaseUrl, options = {}) {
  const log = options.log ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const prefix = `oda_probe_${randomBytes(6).toString('hex')}`;
  const names = { admin: `${prefix}_admin`, ofdRole: `${prefix}_ofd_app`,
    odaRole: `${prefix}_oda_app`, ofdDb: `${prefix}_ofd`, odaDb: `${prefix}_oda` };
  options.recordStage('prepare_fixture_source');
  const fixtureSource = prepareFixtureSource(source, names);
  const allowedRoles = new Set([names.admin, names.ofdRole, names.odaRole]);
  const allowedDbs = new Set([names.ofdDb, names.odaDb]);
  const createdRoles = new Set();
  const createdDbs = new Set();
  const activeClients = new Set();
  const secrets = { admin: password(), ofd: password(), oda: password() };
  const checks = [];
  let scratch;
  let deadlineExpired = false;
  let failure;
  let managedUser;
  let completed = false;
  const cleanupErrors = [];
  let base;
  options.recordStage('validate_managed_connection_input');
  try { base = new URL(databaseUrl); } catch { assert(false, 'MANAGED_URL_REQUIRED'); }
  assert(['postgres:', 'postgresql:'].includes(base.protocol)
    && decodeURIComponent(base.username) === 'ofd_postgres_user'
    && decodeURIComponent(base.pathname.slice(1)) === 'ofd_postgres'
    && base.password && !base.hash, 'MANAGED_URL_TARGET_MISMATCH');
  for (const [key, value] of base.searchParams) {
    assert(key === 'sslmode' && value === 'require', 'MANAGED_URL_OVERRIDE_REJECTED');
  }
  const urlFor = (db, role, secret) => {
    assert(allowedDbs.has(db) && allowedRoles.has(role), 'FIXTURE_CONNECTION_TARGET_REJECTED');
    const url = new URL(base);
    url.pathname = `/${db}`; url.username = role; url.password = secret;
    return url.href;
  };
  const makeClient = (connectionString, management = false) => {
    const url = new URL(connectionString);
    if (!management) {
      assert(allowedDbs.has(decodeURIComponent(url.pathname.slice(1)))
        && allowedRoles.has(decodeURIComponent(url.username)), 'PRODUCTION_CONNECTION_ATTEMPT_REJECTED');
    }
    const raw = new pg.Client({ connectionString, connectionTimeoutMillis: 4_000,
      query_timeout: 6_000, application_name: prefix });
    activeClients.add(raw);
    let inTransaction = false;
    let pendingRoles = [];
    return {
      async connect() { assert(!deadlineExpired, 'NATIVE_CHECK_DEADLINE'); await raw.connect(); },
      async end() { activeClients.delete(raw); await raw.end(); },
      async query(sql, args) {
        assert(!deadlineExpired, 'NATIVE_CHECK_DEADLINE');
        const statement = String(sql).trim();
        const createRole = /^CREATE ROLE "([^"]+)"\b/.exec(statement)
          ?? /^CREATE ROLE "([^"]+)"\s/.exec(statement);
        const createDb = /^CREATE DATABASE "([^"]+)"\s/.exec(statement);
        if (createRole) assert(allowedRoles.has(createRole[1]), 'ROLE_CREATION_OUTSIDE_FIXTURE_REJECTED');
        if (createDb) assert(allowedDbs.has(createDb[1]), 'DATABASE_CREATION_OUTSIDE_FIXTURE_REJECTED');
        if (statement.includes("set_config('oda_provision.ofd_role'")) {
          assert(args?.[2] === names.ofdRole && args?.[3] === names.odaRole,
            'ROLE_PASSWORD_TARGET_OUTSIDE_FIXTURE_REJECTED');
        }
        const result = await raw.query(sql, args);
        if (/^BEGIN(?:\s|$)/.test(statement)) { inTransaction = true; pendingRoles = []; }
        if (createRole) {
          if (inTransaction) pendingRoles.push(createRole[1]); else createdRoles.add(createRole[1]);
        }
        if (createDb) createdDbs.add(createDb[1]);
        if (statement === 'COMMIT') {
          pendingRoles.forEach((role) => createdRoles.add(role)); pendingRoles = []; inTransaction = false;
        }
        if (statement === 'ROLLBACK') { pendingRoles = []; inTransaction = false; }
        return result;
      },
    };
  };
  // 65 s for validation plus at most 20 s for cleanup keeps this job bounded.
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    for (const client of activeClients) void client.end().catch(() => {});
  }, 65_000);
  options.recordStage('create_managed_client');
  const manager = makeClient(base.href, true);
  let oldAdmin;
  try {
    options.recordStage('connect_managed_database');
    await manager.connect();
    options.recordStage('verify_managed_identity_and_fixture_names');
    const identity = (await manager.query(`SELECT current_user AS role,
      r.rolcreatedb,r.rolcreaterole,r.rolsuper FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    assert(identity?.role === 'ofd_postgres_user' && identity.rolcreatedb
      && identity.rolcreaterole && !identity.rolsuper, 'MANAGED_ROLE_IDENTITY_MISMATCH');
    managedUser = identity.role;
    const collisions = (await manager.query(`SELECT rolname AS name FROM pg_roles WHERE rolname=ANY($1::text[])
      UNION ALL SELECT datname FROM pg_database WHERE datname=ANY($2::text[])`,
    [[...allowedRoles], [...allowedDbs]])).rows;
    assert(collisions.length === 0, 'FIXTURE_NAMES_ALREADY_EXIST');
    log({ nativeCheck: 'started', prefix, fixtureDatabases: [...allowedDbs], fixtureRoles: [...allowedRoles] });

    options.recordStage('create_fixture_admin_and_database');
    await manager.query('BEGIN');
    options.recordStage('create_fixture_admin_role');
    await manager.query(`CREATE ROLE ${quote(names.admin)} NOLOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`);
    options.recordStage('bind_fixture_admin_password');
    await manager.query("SELECT set_config('oda_native.role',$1,true),set_config('oda_native.password',$2,true)",
      [names.admin, secrets.admin]);
    options.recordStage('set_fixture_admin_password');
    await manager.query(`DO $native$ BEGIN EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L',
      current_setting('oda_native.role'),current_setting('oda_native.password')); END $native$`);
    options.recordStage('grant_fixture_admin_inherit_and_set');
    // ADMIN was already granted automatically by PostgreSQL's bootstrap role.
    // A self-grant of ADMIN would form a circular grant dependency (0LP01).
    await manager.query(`GRANT ${quote(names.admin)} TO ${quote(managedUser)} WITH INHERIT TRUE, SET TRUE`);
    options.recordStage('commit_fixture_admin_role');
    await manager.query('COMMIT');
    options.recordStage('create_fixture_ofd_database');
    await manager.query(`CREATE DATABASE ${quote(names.ofdDb)} OWNER ${quote(names.admin)}`);
    options.recordStage('connect_fixture_admin');
    oldAdmin = makeClient(urlFor(names.ofdDb, names.admin, secrets.admin));
    await oldAdmin.connect();
    options.recordStage('create_fixture_schema');
    await oldAdmin.query(`CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    await oldAdmin.query(`CREATE TABLE native_audit(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      label text NOT NULL)`);
    await oldAdmin.query(`CREATE FUNCTION native_immutable() RETURNS trigger LANGUAGE plpgsql AS
      $$BEGIN RAISE EXCEPTION 'append only'; END;$$`);
    await oldAdmin.query(`CREATE TRIGGER native_immutable_trigger BEFORE UPDATE OR DELETE ON native_audit
      FOR EACH ROW EXECUTE FUNCTION native_immutable()`);
    await oldAdmin.query("INSERT INTO native_audit(label) VALUES ('fixture-before')");

    options.recordStage('load_and_run_fixture_provision_module');
    scratch = await mkdtemp(join(tmpdir(), `${prefix}-`));
    const modulePath = join(scratch, 'provision-fixture.mjs');
    await writeFile(modulePath, fixtureSource, { mode: 0o600 });
    const module = await import(pathToFileURL(modulePath).href);
    let provisionResult;
    provisionResult = await module.provisionSharedDatabase({
      DATABASE_URL: urlFor(names.ofdDb, names.admin, secrets.admin), ODA_PROVISION_APPLY: '1',
      ODA_PROVISION_OFD_PASSWORD: secrets.ofd, ODA_PROVISION_ODA_PASSWORD: secrets.oda,
    }, { makeClient, log: (entry) => {
      // Only names/stages/error codes are forwarded; never full SQL or parameters.
      log({ nativeProvisionStage: entry.stage, lastCompletedStage: entry.lastCompletedStage,
        code: entry.code });
    } });
    assert(provisionResult.stage === 'database_provisioning_verified', 'NATIVE_PROVISION_DID_NOT_VERIFY');
    checks.push('native_role_creation_and_owner_transfer', 'both_cross_database_connections_rejected',
      'existing_platform_connect_privileges_preserved');

    options.recordStage('verify_fixture_dml_and_migration_compatibility');
    // The admin connection opened before ownership changed must still support
    // normal operations, matching the live OFD rolling deployment window.
    await oldAdmin.query("INSERT INTO native_audit(label) VALUES ('fixture-old-admin-after')");
    await oldAdmin.query('BEGIN');
    await oldAdmin.query('SELECT sequence FROM native_audit ORDER BY sequence DESC LIMIT 1 FOR UPDATE');
    await oldAdmin.query('ROLLBACK');
    checks.push('preexisting_admin_session_dml_and_lock_preserved');

    const app = makeClient(urlFor(names.ofdDb, names.ofdRole, secrets.ofd));
    await app.connect();
    await app.query("INSERT INTO native_audit(label) VALUES ('fixture-new-app')");
    await app.query('BEGIN');
    await app.query("SELECT pg_advisory_xact_lock(hashtext('ofd_schema_migrations'))");
    await app.query(`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,
      checksum_sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
    await app.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 text');
    await app.query('SELECT version,checksum_sha256 FROM schema_migrations ORDER BY version FOR UPDATE');
    await app.query('ALTER TABLE schema_migrations ALTER COLUMN checksum_sha256 SET NOT NULL');
    await app.query("INSERT INTO schema_migrations(version,checksum_sha256) VALUES ('001_native_fixture','fixture-checksum')");
    await app.query('CREATE TABLE native_new_migration(id integer PRIMARY KEY)');
    await app.query('ALTER TABLE native_new_migration ADD COLUMN payload text');
    await app.query('COMMIT');
    checks.push('existing_migration_runner_ddl_and_new_migration_compatible', 'identity_sequence_insert_compatible');
    let triggerDenied = false;
    try { await app.query("UPDATE native_audit SET label='must-not-change'"); }
    catch (error) { triggerDenied = error.code === 'P0001'; }
    assert(triggerDenied, 'IMMUTABLE_TRIGGER_NOT_PRESERVED');
    const rows = (await app.query('SELECT label FROM native_audit ORDER BY sequence')).rows;
    assert(rows.map((row) => row.label).join(',') === 'fixture-before,fixture-old-admin-after,fixture-new-app',
      'FIXTURE_DATA_CHANGED_UNEXPECTEDLY');
    checks.push('immutable_trigger_and_existing_rows_preserved');
    await app.end();
    await oldAdmin.end(); oldAdmin = undefined;
    completed = true;
  } catch (error) {
    failure = error.safeCode ?? (/^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : 'NATIVE_CHECK_FAILED');
  } finally {
    clearTimeout(deadline);
    for (const client of activeClients) await client.end().catch(() => {});
    activeClients.clear();
    const cleanup = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 3_000,
      query_timeout: 4_000, application_name: `${prefix}_cleanup` });
    const cleanupDeadline = setTimeout(() => { void cleanup.end().catch(() => {}); }, 20_000);
    try {
      await cleanup.connect();
      await cleanup.query("SET lock_timeout='1500ms'");
      await cleanup.query("SET statement_timeout='3s'");
      // Database contents are exclusively this check's fixture rows. Still avoid
      // FORCE: an unexpected remaining connection is reported for inspection.
      for (const db of [...createdDbs].reverse()) {
        assert(allowedDbs.has(db) && db.startsWith(`${prefix}_`), 'UNSAFE_FIXTURE_CLEANUP_DATABASE');
        try { await cleanup.query(`DROP DATABASE ${quote(db)}`); createdDbs.delete(db); }
        catch (error) { cleanupErrors.push({ type: 'database', name: db, code: error.code ?? 'CLEANUP_FAILED' }); }
      }
      // Drop child roles while the managed role can SET ROLE to its test admin.
      // No production roles, grants, object owners or databases are removed.
      for (const role of [names.ofdRole, names.odaRole, names.admin]) {
        if (!createdRoles.has(role)) continue;
        assert(allowedRoles.has(role) && role.startsWith(`${prefix}_`), 'UNSAFE_FIXTURE_CLEANUP_ROLE');
        try {
          if (role !== names.admin) await cleanup.query(`SET ROLE ${quote(names.admin)}`);
          await cleanup.query(`DROP ROLE ${quote(role)}`);
          await cleanup.query('RESET ROLE');
          createdRoles.delete(role);
        } catch (error) {
          await cleanup.query('RESET ROLE').catch(() => {});
          cleanupErrors.push({ type: 'role', name: role, code: error.code ?? 'CLEANUP_FAILED' });
        }
      }
    } catch (error) {
      cleanupErrors.push({ type: 'cleanup', code: error.safeCode ?? error.code ?? 'CLEANUP_FAILED' });
    } finally {
      clearTimeout(cleanupDeadline);
      await cleanup.end().catch(() => {});
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
    log({ nativeCheck: completed && cleanupErrors.length === 0 ? 'passed' : 'failed', prefix,
      checks, failure, cleanupErrors, remainingCreatedDatabases: [...createdDbs],
      remainingCreatedRoles: [...createdRoles], productionDatabaseDataOrAclChanged: false });
  }
  assert(completed && cleanupErrors.length === 0, failure ?? 'NATIVE_CHECK_CLEANUP_FAILED');
  return { ok: true, prefix, checks, fixtureResourcesRemoved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    assert(process.env.ODA_PROVISION_NATIVE_CHECK === '1', 'EXPLICIT_NATIVE_CHECK_REQUIRED');
    const source = await readFile(new URL('./oda-shared-provision.mjs', import.meta.url), 'utf8');
    await runNativeCheck(source, process.env.DATABASE_URL);
  })().catch((error) => {
    process.stderr.write(`ODA native check stopped: ${error.safeCode ?? 'NATIVE_CHECK_FAILED'}\n`);
    process.exitCode = 1;
  });
}
