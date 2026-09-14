import pg from 'pg';
import { validateOdaSettlementProfile } from '../validate-production-env.mjs';

function requireValue(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required for isolated ODA deployment`);
  return value;
}

/** Fixed targets prevent copying the OFD connection string into an ODA service. */
export function readSharedTarget(env) {
  if (env.ODA_SHARED_DATABASE !== 'true' || env.WORKSTATION_BRAND !== 'oda'
      || env.APP_MODE !== 'production' || env.REPOSITORY_MODE !== 'postgres') {
    throw new Error('ODA shared deployment must explicitly use production PostgreSQL');
  }
  let url;
  try { url = new URL(requireValue(env, 'DATABASE_URL')); }
  catch { throw new Error('ODA DATABASE_URL is missing or invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('ODA requires PostgreSQL');
  const database = requireValue(env, 'ODA_DB_NAME');
  const role = requireValue(env, 'ODA_DB_ROLE');
  const peerDatabase = requireValue(env, 'ODA_PEER_DB_NAME');
  const peerRoles = requireValue(env, 'ODA_PEER_DB_ROLES').split(',').map(x => x.trim());
  if (database !== 'oda_production' || role !== 'oda_app') throw new Error('ODA database and role must use the dedicated production names');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(peerDatabase) || peerDatabase === database
      || peerRoles.some(x => !/^[a-z][a-z0-9_]{0,62}$/.test(x) || x === role)) {
    throw new Error('OFD peer database and runtime roles must be distinct and explicitly identified');
  }
  // URL parameters can override libpq connection fields, SSL, or search_path.
  if ([...url.searchParams.keys()].some(x => x !== 'sslmode')
      || (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'require')) {
    throw new Error('Only sslmode=require is allowed on the ODA database URL');
  }
  try {
    if (decodeURIComponent(url.pathname.slice(1)) !== database || decodeURIComponent(url.username) !== role || !url.password) {
      throw new Error('mismatch');
    }
  } catch { throw new Error('ODA database URL must use its dedicated database, user, and password'); }
  const pool = Number(env.DB_POOL_MAX);
  if (!Number.isInteger(pool) || pool < 1 || pool > 3) throw new Error('ODA shared DB_POOL_MAX must be between 1 and 3');
  let origin, peerOrigin;
  try {
    origin = new URL(requireValue(env, 'WEB_ORIGIN'));
    peerOrigin = new URL(requireValue(env, 'ODA_PEER_WEB_ORIGIN'));
  } catch { throw new Error('ODA and OFD HTTPS origins are required'); }
  if (origin.protocol !== 'https:' || peerOrigin.protocol !== 'https:' || origin.hostname === peerOrigin.hostname
      || origin.origin !== env.WEB_ORIGIN || env.PUBLIC_APP_URL !== origin.origin) {
    throw new Error('ODA requires a separate HTTPS hostname and exact WEB_ORIGIN/PUBLIC_APP_URL');
  }
  if (env.ODA_SETTLEMENT_ONLY === 'true') {
    const errors = validateOdaSettlementProfile(env);
    if (errors.length) throw new Error('ODA settlement-only profile is incomplete');
  } else if (!/^oda[-.][a-z0-9.-]+$/.test(String(env.S3_BUCKET ?? ''))) throw new Error('ODA requires an explicitly separate oda- prefixed private bucket');
  return { database, role, peerDatabase, peerRoles: [...new Set(peerRoles)], connectionString: url.href };
}

/** Read-only validation: no grants, migrations, or OFD writes are performed here. */
export async function assertSharedIsolation(env, makeClient = config => new pg.Client(config)) {
  const target = readSharedTarget(env);
  const client = makeClient({ connectionString: target.connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const identity = (await client.query(`SELECT current_database() AS database, current_user AS role,
      current_schema() AS schema, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
      EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships
      FROM pg_roles r WHERE rolname = current_user`)).rows[0];
    if (!identity || identity.database !== target.database || identity.role !== target.role || identity.schema !== 'public'
        || identity.rolsuper || identity.rolcreaterole || identity.rolcreatedb || identity.rolbypassrls || identity.has_memberships) {
      throw new Error('ODA database identity or least-privilege role check failed');
    }
    const peers = (await client.query(`SELECT r.rolname,
      has_database_privilege(r.oid, current_database(), 'CONNECT') AS can_connect_oda,
      EXISTS (SELECT 1 FROM pg_roles elevated WHERE
        (elevated.rolsuper OR elevated.rolcreaterole OR elevated.rolcreatedb OR elevated.rolbypassrls)
        AND (r.oid = elevated.oid OR pg_has_role(r.oid, elevated.oid, 'MEMBER'))) AS privileged
      FROM pg_roles r WHERE r.rolname = ANY($1::text[])`, [target.peerRoles])).rows;
    if (peers.length !== target.peerRoles.length || peers.some(row => row.can_connect_oda || row.privileged)) {
      throw new Error('OFD runtime roles can access or administer ODA; separate least-privilege credentials first');
    }
    const peer = (await client.query(`SELECT has_database_privilege(current_user, datname, 'CONNECT') AS can_connect
      FROM pg_database WHERE datname = $1`, [target.peerDatabase])).rows[0];
    if (!peer || peer.can_connect) throw new Error('ODA can connect to OFD or the OFD database identity is missing');
    await client.query('COMMIT');
  } finally { await client.end(); }
}
