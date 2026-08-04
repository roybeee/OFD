import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

if (process.env.APP_MODE !== 'test') throw new Error('CI PostgreSQL runtime smoke requires APP_MODE=test');
if (process.env.REPOSITORY_MODE !== 'postgres') throw new Error('CI PostgreSQL runtime smoke requires REPOSITORY_MODE=postgres');
if (!String(process.env.DATABASE_URL ?? '').startsWith('postgresql://')) throw new Error('CI PostgreSQL runtime smoke requires PostgreSQL');

const migrationFiles = (await readdir(new URL('../../../packages/db/migrations/', import.meta.url)))
  .filter((name) => /^\d+.*\.sql$/.test(name)).map((name) => name.replace(/\.sql$/, '')).sort();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const result = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const applied = new Set(result.rows.map((row) => String(row.version)));
  const missing = migrationFiles.filter((version) => !applied.has(version));
  if (missing.length > 0) throw new Error(`CI database is missing migrations: ${missing.join(', ')}`);
} finally {
  await pool.end();
}

const host = '127.0.0.1';
const port = 4199;
const healthUrl = `http://${host}:${port}/api/v2/health`;
const readinessUrl = `http://${host}:${port}/api/v2/ready`;
const output = [];
const api = spawn(process.execPath, ['apps/api/dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    APP_MODE: 'test',
    REPOSITORY_MODE: 'postgres',
    API_HOST: host,
    API_PORT: String(port),
    LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [api.stdout, api.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { output.push(String(chunk)); if (output.join('').length > 8_000) output.shift(); });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (api.exitCode !== null) throw new Error(`test-mode PostgreSQL API exited before health check (code ${api.exitCode})`);
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && body.ok === true && body.mode === 'test') return;
    } catch { /* bounded retry while the server binds */ }
    await delay(200);
  }
  throw new Error(`test-mode PostgreSQL API did not become healthy at ${healthUrl}`);
}

async function verifyPostgresReadiness() {
  const response = await fetch(readinessUrl, { signal: AbortSignal.timeout(2_000) });
  const body = await response.json();
  const database = body.components?.database;
  const migrations = body.components?.migrations;
  if (database?.ok !== true || database.mode !== 'postgres') {
    throw new Error(`compiled API did not report a healthy PostgreSQL repository: ${JSON.stringify(database)}`);
  }
  if (migrations?.ok !== true || migrations.applied !== migrationFiles.length) {
    throw new Error(`compiled API did not report the complete migration ledger: ${JSON.stringify(migrations)}`);
  }
}

async function stop() {
  if (api.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => { api.kill('SIGKILL'); resolve(); }, 3_000);
    api.once('exit', () => { clearTimeout(timer); resolve(); });
    api.kill('SIGTERM');
  });
}

try {
  await waitForHealth();
  await verifyPostgresReadiness();
  console.log(`Test-mode API smoke passed against PostgreSQL with ${migrationFiles.length} applied migration(s).`);
} catch (error) {
  const diagnostics = output.join('').trim();
  if (diagnostics) console.error(diagnostics.slice(-4_000));
  throw error;
} finally {
  await stop();
}
