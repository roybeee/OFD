// Synthetic, isolated local ODA UI harness. Never connects to production services.
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDemoRepository, DEMO_IDS } from '@ofd/db';
import { MockObjectStorage } from '@ofd/integrations';
import { buildApp } from '../apps/api/src/app.ts';
import { createServer } from 'vite';

process.env.VITE_ALLOW_TEST_API = 'true';
process.env.VITE_API_BASE = '/api/v2';
const root = fileURLToPath(new URL('../', import.meta.url));
const app = await buildApp({ repository: createDemoRepository(), storage: new MockObjectStorage(),
  env: { APP_MODE: 'test', WORKSTATION_BRAND: 'oda', PROVIDER_MODE: 'mock', REPOSITORY_MODE: 'memory', STORAGE_MODE: 'mock', EMAIL_PROVIDER: 'mock', LOG_LEVEL: 'silent' }, logger: false });
const seed = await app.inject({ method: 'POST', url: `/api/v2/oda/${DEMO_IDS.storeDoksan}/hr/commands`,
  headers: { 'x-demo-actor-id': DEMO_IDS.owner, 'idempotency-key': randomUUID() },
  payload: { expectedVersion: 0, type: 'employee.create', input: { employeeNumber: 'SMOKE-STAFF', name: '테스트 직원', hireDate: '2026-01-01', actorId: DEMO_IDS.staff } } });
if (seed.statusCode !== 200) throw new Error(`Synthetic employee setup failed: ${seed.body}`);
await app.listen({ host: '127.0.0.1', port: 4165 });
const web = await createServer({ root: `${root}apps/web`, configFile: `${root}apps/web/vite.config.ts`, mode: 'oda',
  server: { host: '127.0.0.1', port: 5265, strictPort: true, proxy: { '/api/v2': 'http://127.0.0.1:4165' } } });
await web.listen();
let closing = false;
async function close() { if (closing) return; closing = true; await web.close(); await app.close(); process.exit(0); }
process.once('SIGINT', close); process.once('SIGTERM', close);
