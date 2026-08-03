import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (!process.env.DATABASE_URL) {
  throw new Error('V2 E2E is PostgreSQL-only. Start Postgres 16 and set DATABASE_URL=postgresql://.../ofd_v2_e2e.');
}

const secureDefaults = {
  NODE_ENV: 'test',
  APP_MODE: 'test',
  REPOSITORY_MODE: 'postgres',
  PROVIDER_MODE: 'mock',
  STORAGE_MODE: 'mock',
  EMAIL_PROVIDER: 'mock',
  POPBILL_PRODUCTION_ENABLED: 'false',
  POPBILL_TAX_INVOICE_ENABLED: 'false',
  POPBILL_BANK_SYNC_ENABLED: 'false',
  POPBILL_SMS_ENABLED: 'false',
  SESSION_SECRET: 'e2e-session-4f64b77ebf52f272b7d9f8f7910832829c95bb83df4de798',
  ENCRYPTION_KEY: 'Y7XV5T6vzYD9OtYf85rHuuaSNmrYovfzmvFihTbqpSI=',
  POPBILL_WEBHOOK_API_KEY: 'e2e-webhook-c715bad7bf7196538d40dbf31d8569b7',
  API_HOST: '127.0.0.1',
  API_PORT: '4100',
  LOG_LEVEL: 'warn',
  WORKER_ID: 'e2e-worker',
  WORKER_POLL_MS: '100',
  WORKER_BATCH_SIZE: '50',
  WORKER_HEARTBEAT_TTL_MS: '60000',
  VITE_DEMO_MODE: 'false',
  VITE_ALLOW_TEST_API: 'true',
  VITE_API_BASE: '/api/v2',
};
const env = { ...process.env, ...secureDefaults };
const children = [];

function node(script, args = [], options = {}) {
  const child = spawn(process.execPath, [resolve(root, script), ...args], {
    cwd: options.cwd ?? root,
    env,
    stdio: options.stdio ?? 'inherit',
  });
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      process.stderr.write(`E2E child ${script} exited early (${code ?? signal}).\n`);
      void stop(code ?? 1);
    }
  });
  return child;
}

async function run(script, args = []) {
  const child = spawn(process.execPath, [resolve(root, script), ...args], { cwd: root, env, stdio: 'inherit' });
  const code = await new Promise((resolveCode) => child.once('exit', (value) => resolveCode(value ?? 1)));
  if (code !== 0) throw new Error(`${script} failed with exit code ${code}`);
}

async function waitFor(url, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* bounded readiness polling */ }
    await delay(250);
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolveExit) => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveExit(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  })));
  process.exitCode = code;
}

process.once('SIGINT', () => void stop(0));
process.once('SIGTERM', () => void stop(0));

try {
  if (env.E2E_SKIP_PREPARE !== '1') {
    await run('node_modules/tsx/dist/cli.mjs', ['packages/db/src/migrate.ts']);
    await run('e2e/seed-postgres.mjs');
  }
  node('node_modules/tsx/dist/cli.mjs', ['apps/api/src/server.ts']);
  node('node_modules/tsx/dist/cli.mjs', ['apps/worker/src/main.ts']);
  await waitFor('http://127.0.0.1:4100/api/v2/health', 'Fastify API');
  await waitFor('http://127.0.0.1:4100/api/v2/ready', 'API/worker readiness');
  node('node_modules/vite/bin/vite.js', ['--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: resolve(root, 'apps/web') });
  await waitFor('http://127.0.0.1:5173/', 'Vite Web');
  process.stdout.write('OFD V2 E2E stack ready: Vite Web + Fastify API + Worker + PostgreSQL.\n');
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await stop(1);
}
