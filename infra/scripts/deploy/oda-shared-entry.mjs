import { assertSharedIsolation } from './oda-shared-guard.mjs';
import { runDeploymentPreflight } from './preflight.mjs';

const role = process.argv[2];
if (!['api', 'worker', 'migrate', 'bootstrap'].includes(role)) throw new Error('Expected api, worker, migrate, or bootstrap');
if (runDeploymentPreflight(process.env, role === 'bootstrap' ? 'migrate' : role) !== 0) process.exit(1);
try {
  await assertSharedIsolation(process.env);
} catch (error) {
  // Do not print driver messages, stack traces, URLs or credentials.
  console.error('ODA isolation check failed. Verify dedicated DB/role, peer permissions, origin and bucket before deployment.');
  process.exit(1);
}
console.log('ODA database isolation checks passed.');
if (role === 'api') await import('../../../apps/api/dist/server.js');
if (role === 'worker') await import('../../../apps/worker/dist/main.js');
if (role === 'migrate') await import('../../../packages/db/dist/migrate.js');
if (role === 'bootstrap') {
  process.argv.splice(2, 1);
  await import('../../../apps/api/dist/bootstrap-oda.js');
}
