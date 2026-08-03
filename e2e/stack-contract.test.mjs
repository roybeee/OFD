import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('Playwright uses the V2 stack and never the legacy publisher or SQLite server', async () => {
  const [config, stack] = await Promise.all([read('e2e/playwright.config.ts'), read('e2e/start-v2-stack.mjs')]);
  assert.doesNotMatch(`${config}\n${stack}`, /legacy-server|build:render|server\/public\/v2|sqlite/i);
  assert.match(stack, /apps\/api\/src\/server\.ts/);
  assert.match(stack, /apps\/worker\/src\/main\.ts/);
  assert.match(stack, /node_modules\/vite\/bin\/vite\.js/);
  assert.match(stack, /REPOSITORY_MODE:\s*'postgres'/);
});

test('CI E2E uses PostgreSQL 16, migrations, deterministic seed, and protected test credentials', async () => {
  const workflow = await read('.github/workflows/v2.yml');
  const job = workflow.match(/\n  e2e:\n[\s\S]*?(?=\n  deploy-production:)/)?.[0] ?? '';
  assert.match(job, /image:\s*postgres:16-alpine/);
  assert.match(job, /APP_MODE:\s*test/);
  assert.match(job, /REPOSITORY_MODE:\s*postgres/);
  assert.match(job, /npm run migrate -w @ofd\/db/);
  assert.match(job, /node e2e\/seed-postgres\.mjs/);
  assert.match(job, /E2E_ALLOW_RESET:\s*"1"/);
  assert.doesNotMatch(job, /APP_MODE:\s*demo|memory|SQLite|build:render|legacy-server|server\/public\/v2/i);
});

test('seed reset and external target are fail-closed', async () => {
  const [seed, safety] = await Promise.all([read('e2e/seed-postgres.mjs'), read('e2e/target-safety.ts')]);
  assert.match(seed, /E2E_ALLOW_RESET/);
  assert.match(seed, /e2e\|test/);
  assert.match(seed, /schema_migrations/);
  assert.match(safety, /ofd-workstation\.onrender\.com/);
  assert.match(safety, /forbidden/i);
});
