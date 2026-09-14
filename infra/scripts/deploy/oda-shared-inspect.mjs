// Read-only deployment review. Running this in an existing OFD production
// service requires explicit authorization for that service's execution context.
// Never logs connection strings, passwords, activity, or business records.
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  query_timeout: 8_000,
  application_name: 'oda_isolation_readonly_review',
});
const deadline = setTimeout(() => {
  console.error('ODA_ISOLATION_REVIEW_FAILED TIMEOUT');
  process.exit(1);
}, 30_000);

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '8s'");
  const identity = await client.query(`
    SELECT current_database() AS database, current_user AS role,
           rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
    FROM pg_roles WHERE rolname = current_user
  `);
  if (identity.rows[0]?.database !== 'ofd_postgres') {
    throw new Error('UNEXPECTED_DATABASE');
  }
  const databases = await client.query(`
    SELECT datname AS database, pg_get_userbyid(datdba) AS owner,
           datacl::text AS access_rules,
           has_database_privilege(current_user, oid, 'CONNECT') AS can_connect
    FROM pg_database WHERE datname IN ('ofd_postgres', 'oda_production')
  `);
  const memberships = await client.query(`
    SELECT rolname AS inherited_role, rolsuper, rolcreaterole,
           rolcreatedb, rolbypassrls
    FROM pg_roles
    WHERE rolname <> current_user AND pg_has_role(current_user, oid, 'MEMBER')
  `);
  await client.query('ROLLBACK');
  console.log('ODA_ISOLATION_REVIEW ' + JSON.stringify({
    identity: identity.rows,
    databases: databases.rows,
    memberships: memberships.rows,
  }));
} catch {
  console.error('ODA_ISOLATION_REVIEW_FAILED');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  clearTimeout(deadline);
}
