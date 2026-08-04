import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRenderClient,
  deployRelease,
  deployService,
  rollbackRelease,
} from './deploy/render-release.mjs';

const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const OLD_SHA = '89abcdef0123456789abcdef0123456789abcdef';

function fetchSequence(steps, calls = []) {
  return {
    calls,
    fetch: async (url, init = {}) => {
      const step = steps.shift();
      assert.ok(step, `Unexpected Render request: ${init.method ?? 'GET'} ${url}`);
      const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (step.url) assert.match(call.url, step.url);
      if (step.method) assert.equal(call.method, step.method);
      const body = step.body === null || step.body === undefined ? null : JSON.stringify(step.body);
      return new Response(body, { status: step.status ?? 200, headers: body ? { 'Content-Type': 'application/json' } : {} });
    },
    done: () => assert.equal(steps.length, 0, `${steps.length} mocked Render response(s) were not consumed`),
  };
}

test('uses a 201 deploy id, records the previous live deploy, and verifies the final commit', async () => {
  const sequence = fetchSequence([
    { url: /\/services\/srv-api\/deploys\?/, body: [{ deploy: { id: 'dep-old', status: 'live', commit: { id: OLD_SHA }, createdAt: '2026-01-01T00:00:00Z' } }] },
    { method: 'POST', url: /\/services\/srv-api\/deploys$/, status: 201, body: { id: 'dep-new', status: 'build_in_progress' } },
    { url: /\/services\/srv-api\/deploys\/dep-new$/, body: { id: 'dep-new', status: 'live', commit: { id: RELEASE_SHA } } },
  ]);
  const client = createRenderClient({ token: 'test-token', fetchImpl: sequence.fetch });

  const result = await deployService({ client, label: 'api', serviceId: 'srv-api', commitId: RELEASE_SHA, sleep: async () => undefined });

  assert.deepEqual(result, {
    label: 'api', serviceId: 'srv-api', deployId: 'dep-new', commitId: RELEASE_SHA, status: 'live',
    previousLiveDeployId: 'dep-old', previousLiveCommitId: OLD_SHA,
  });
  assert.deepEqual(sequence.calls[1]?.body, { commitId: RELEASE_SHA, clearCache: 'do_not_clear' });
  sequence.done();
});

test('resolves an official 202 queued response with no body through List deploys', async () => {
  const sequence = fetchSequence([
    { url: /\/services\/srv-worker\/deploys\?limit=100&status=live$/, body: [] },
    { method: 'POST', url: /\/services\/srv-worker\/deploys$/, status: 202, body: null },
    { url: /createdAfter=/, body: [{ deploy: { id: 'dep-queued', status: 'queued', commit: { id: RELEASE_SHA }, createdAt: '2026-01-02T00:00:00Z' } }] },
    { url: /\/services\/srv-worker\/deploys\/dep-queued$/, body: { id: 'dep-queued', status: 'live', commit: { id: RELEASE_SHA } } },
  ]);
  const client = createRenderClient({ token: 'test-token', fetchImpl: sequence.fetch });

  const result = await deployService({ client, label: 'worker', serviceId: 'srv-worker', commitId: RELEASE_SHA, sleep: async () => undefined });

  assert.equal(result.deployId, 'dep-queued');
  assert.equal(result.commitId, RELEASE_SHA);
  sequence.done();
});

test('fails closed when Render reports live for a different commit', async () => {
  const sequence = fetchSequence([
    { body: [] },
    { method: 'POST', status: 201, body: { id: 'dep-wrong' } },
    { body: { id: 'dep-wrong', status: 'live', commit: { id: OLD_SHA } } },
  ]);
  const client = createRenderClient({ token: 'test-token', fetchImpl: sequence.fetch });

  await assert.rejects(
    () => deployService({ client, label: 'web', serviceId: 'srv-web', commitId: RELEASE_SHA, sleep: async () => undefined }),
    new RegExp(`expected ${RELEASE_SHA}`),
  );
  sequence.done();
});

test('deploys API, worker, and Web sequentially and emits reproducible release evidence', async () => {
  const steps = [];
  for (const label of ['api', 'worker', 'web']) {
    steps.push(
      { url: new RegExp(`/services/srv-${label}/deploys\\?`), body: [{ deploy: { id: `dep-${label}-old`, status: 'live', commit: { id: OLD_SHA } } }] },
      { method: 'POST', url: new RegExp(`/services/srv-${label}/deploys$`), status: 201, body: { id: `dep-${label}-new` } },
      { url: new RegExp(`/services/srv-${label}/deploys/dep-${label}-new$`), body: { id: `dep-${label}-new`, status: 'live', commit: { id: RELEASE_SHA } } },
    );
  }
  const sequence = fetchSequence(steps);
  const client = createRenderClient({ token: 'test-token', fetchImpl: sequence.fetch });
  const snapshots = [];

  const manifest = await deployRelease({
    client,
    commitId: RELEASE_SHA,
    services: [['api', 'srv-api'], ['worker', 'srv-worker'], ['web', 'srv-web']],
    sleep: async () => undefined,
    onManifest: async (value) => snapshots.push(structuredClone(value)),
  });

  assert.equal(manifest.status, 'live');
  assert.deepEqual(manifest.services.map(({ label, deployId, commitId, previousLiveDeployId }) => ({ label, deployId, commitId, previousLiveDeployId })), [
    { label: 'api', deployId: 'dep-api-new', commitId: RELEASE_SHA, previousLiveDeployId: 'dep-api-old' },
    { label: 'worker', deployId: 'dep-worker-new', commitId: RELEASE_SHA, previousLiveDeployId: 'dep-worker-old' },
    { label: 'web', deployId: 'dep-web-new', commitId: RELEASE_SHA, previousLiveDeployId: 'dep-web-old' },
  ]);
  assert.equal(snapshots.at(-1)?.status, 'live');
  sequence.done();
});

test('rolls back the recorded release in reverse service order and verifies target commits', async () => {
  const calls = [];
  const steps = [];
  for (const label of ['web', 'worker', 'api']) {
    steps.push(
      { method: 'POST', url: new RegExp(`/services/srv-${label}/rollback$`), status: 201, body: { id: `rollback-${label}` } },
      { url: new RegExp(`/services/srv-${label}/deploys/rollback-${label}$`), body: { id: `rollback-${label}`, status: 'live', commit: { id: OLD_SHA } } },
    );
  }
  const sequence = fetchSequence(steps, calls);
  const client = createRenderClient({ token: 'test-token', fetchImpl: sequence.fetch });
  const sourceManifest = {
    releaseSha: RELEASE_SHA,
    services: ['api', 'worker', 'web'].map((label) => ({
      label, serviceId: `srv-${label}`, deployId: `dep-${label}-new`, commitId: RELEASE_SHA,
      previousLiveDeployId: `dep-${label}-old`, previousLiveCommitId: OLD_SHA,
    })),
  };

  const manifest = await rollbackRelease({
    client,
    sourceManifest,
    serviceIds: { api: 'srv-api', worker: 'srv-worker', web: 'srv-web' },
    sleep: async () => undefined,
    onManifest: async () => undefined,
  });

  assert.equal(manifest.status, 'live');
  assert.deepEqual(manifest.services.map((service) => service.label), ['web', 'worker', 'api']);
  assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.body), [
    { deployId: 'dep-web-old' }, { deployId: 'dep-worker-old' }, { deployId: 'dep-api-old' },
  ]);
  sequence.done();
});
