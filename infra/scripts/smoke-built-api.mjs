import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const host = '127.0.0.1';
const port = 4199;
const healthUrl = `http://${host}:${port}/api/v2/health`;
const output = [];

const api = spawn(process.execPath, ['apps/api/dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    APP_MODE: 'demo',
    PROVIDER_MODE: 'mock',
    STORAGE_MODE: 'mock',
    EMAIL_PROVIDER: 'mock',
    API_HOST: host,
    API_PORT: String(port),
    LOG_LEVEL: 'silent'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

for (const stream of [api.stdout, api.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output.push(String(chunk));
    if (output.join('').length > 8_000) output.shift();
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (api.exitCode !== null) {
      throw new Error(`built API exited before health check (code ${api.exitCode})`);
    }
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && body.ok === true && body.mode === 'demo' && body.providerMode === 'mock') return body;
    } catch {
      // The port may not be listening yet; retry within the bounded startup window.
    }
    await delay(200);
  }
  throw new Error(`built API did not become healthy at ${healthUrl}`);
}

async function stopApi() {
  if (api.exitCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      api.kill('SIGKILL');
      finish();
    }, 3_000);
    api.once('exit', finish);
    api.kill('SIGTERM');
  });
}

try {
  await waitForHealth();
  console.log('Built API runtime smoke passed.');
} catch (error) {
  const diagnostics = output.join('').trim();
  if (diagnostics) console.error(diagnostics.slice(-4_000));
  throw error;
} finally {
  await stopApi();
}
