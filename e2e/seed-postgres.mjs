import pg from 'pg';
import { createDemoSeed, discoverMigrations, PostgresRepository } from '@ofd/db';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;

export function assertIsolatedDatabase(env = process.env) {
  if (env.E2E_ALLOW_RESET !== '1') throw new Error('E2E_ALLOW_RESET=1 is required before resetting an E2E database.');
  const raw = String(env.DATABASE_URL ?? '');
  if (!raw.startsWith('postgresql://')) throw new Error('V2 E2E is PostgreSQL-only; set DATABASE_URL to an isolated test database.');
  const url = new URL(raw);
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase();
  if (!/(?:^|_)(?:e2e|test)(?:_|$)/.test(databaseName)) {
    throw new Error(`Refusing to reset PostgreSQL database '${databaseName}'; its name must contain an isolated e2e/test segment.`);
  }
  return raw;
}

export async function seedPostgres(env = process.env) {
  const databaseUrl = assertIsolatedDatabase(env);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const required = await discoverMigrations();
  try {
    const applied = await pool.query('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version');
    const byVersion = new Map(applied.rows.map((row) => [String(row.version), String(row.checksum_sha256)]));
    const missing = required.filter((migration) => byVersion.get(migration.version) !== migration.checksumSha256);
    if (missing.length > 0) throw new Error(`E2E database migrations are missing or drifted: ${missing.map(({ version }) => version).join(', ')}`);

    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations' ORDER BY tablename");
    if (tables.rows.length > 0) {
      const identifiers = tables.rows.map(({ tablename }) => `"${String(tablename).replaceAll('"', '""')}"`).join(', ');
      await pool.query(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await pool.end();
  }

  const repository = PostgresRepository.connect(databaseUrl, { ...env, DB_POOL_MAX: '2' });
  try {
    await repository.commit({ changes: createDemoSeed(new Date('2026-08-04T00:00:00.000Z')) });
  } finally {
    await repository.close();
  }
  process.stdout.write('Seeded deterministic OFD V2 E2E fixtures in isolated PostgreSQL.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await seedPostgres();
