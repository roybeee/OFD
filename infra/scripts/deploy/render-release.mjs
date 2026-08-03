import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as defaultSleep } from 'node:timers/promises';

export const DEFAULT_SERVICE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
const FAILED_STATUSES = new Set(['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated']);

function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fullSha(value, name = 'commit SHA') {
  const sha = String(value ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${name} must be a full 40-character Git commit SHA`);
  return sha.toLowerCase();
}

function deployFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const candidate = value.deploy && typeof value.deploy === 'object' ? value.deploy : value;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

function deployIdOf(deploy) {
  return String(deploy?.id ?? '').trim();
}

function commitIdOf(deploy) {
  return String(deploy?.commit?.id ?? deploy?.commitId ?? '').trim().toLowerCase();
}

function createdAtOf(deploy) {
  const parsed = Date.parse(String(deploy?.createdAt ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDeployList(body) {
  if (!Array.isArray(body)) throw new Error('Render list deploys response was not an array');
  return body.map(deployFrom).filter(Boolean);
}

export function createRenderClient({ token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('RENDER_API_KEY is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  return {
    async request(path, init = {}) {
      const response = await fetchImpl(`https://api.render.com/v1${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      const text = await response.text();
      let body = null;
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`Render API ${init.method ?? 'GET'} ${path} returned invalid JSON (${response.status})`);
        }
      }
      if (!response.ok) {
        const detail = body ? `: ${JSON.stringify(body).slice(0, 500)}` : '';
        throw new Error(`Render API ${init.method ?? 'GET'} ${path} failed with ${response.status}${detail}`);
      }
      return { status: response.status, body };
    },
  };
}

async function listDeploys(client, serviceId, { createdAfter, status } = {}) {
  const query = new URLSearchParams({ limit: '100' });
  if (createdAfter) query.set('createdAfter', createdAfter);
  if (status) query.set('status', status);
  const { body } = await client.request(`/services/${encodeURIComponent(serviceId)}/deploys?${query}`);
  return normalizeDeployList(body);
}

async function findPreviousLiveDeploy(client, serviceId) {
  const deploys = await listDeploys(client, serviceId, { status: 'live' });
  return deploys
    .filter((deploy) => deploy.status === 'live' && deployIdOf(deploy))
    .sort((left, right) => createdAtOf(right) - createdAtOf(left))[0] ?? null;
}

async function sleepWithinDeadline({ sleep, pollIntervalMs, deadline, now }) {
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  await sleep(Math.min(pollIntervalMs, remaining));
  return true;
}

async function discoverQueuedDeploy({ client, serviceId, commitId, createdAfter, deadline, sleep, pollIntervalMs, now }) {
  while (now() < deadline) {
    const deploys = await listDeploys(client, serviceId, { createdAfter });
    const match = deploys
      .filter((deploy) => deployIdOf(deploy) && commitIdOf(deploy) === commitId)
      .sort((left, right) => createdAtOf(right) - createdAtOf(left))[0];
    if (match) return match;
    if (!await sleepWithinDeadline({ sleep, pollIntervalMs, deadline, now })) break;
  }
  throw new Error(`Render did not expose the queued deploy for commit ${commitId} before timeout`);
}

async function waitForLiveDeploy({ client, label, serviceId, deployId, commitId, deadline, sleep, pollIntervalMs, now }) {
  let lastStatus = 'unknown';
  while (now() < deadline) {
    const { body } = await client.request(`/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`);
    const current = deployFrom(body);
    lastStatus = String(current?.status ?? 'unknown');
    if (lastStatus === 'live') {
      const actualCommitId = commitIdOf(current);
      if (actualCommitId !== commitId) {
        throw new Error(`Render ${label} deploy ${deployId} is live at commit ${actualCommitId || 'unknown'}, expected ${commitId}`);
      }
      return current;
    }
    if (FAILED_STATUSES.has(lastStatus)) throw new Error(`Render ${label} deploy ${deployId} ended with ${lastStatus}`);
    if (!await sleepWithinDeadline({ sleep, pollIntervalMs, deadline, now })) break;
  }
  throw new Error(`Render ${label} deploy ${deployId} timed out with status ${lastStatus}`);
}

async function resolveTriggeredDeploy({ response, client, serviceId, commitId, startedAt, deadline, sleep, pollIntervalMs, now }) {
  if (response.status !== 201 && response.status !== 202) {
    throw new Error(`Render trigger deploy returned unexpected success status ${response.status}`);
  }
  const direct = deployFrom(response.body);
  if (deployIdOf(direct)) return direct;
  return discoverQueuedDeploy({
    client,
    serviceId,
    commitId,
    createdAfter: new Date(startedAt - 60_000).toISOString(),
    deadline,
    sleep,
    pollIntervalMs,
    now,
  });
}

export async function deployService({
  client,
  label,
  serviceId,
  commitId: requestedCommitId,
  timeoutMs = DEFAULT_SERVICE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = defaultSleep,
  now = Date.now,
  onProgress = async () => undefined,
}) {
  const commitId = fullSha(requestedCommitId);
  const previous = await findPreviousLiveDeploy(client, serviceId);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const response = await client.request(`/services/${encodeURIComponent(serviceId)}/deploys`, {
    method: 'POST',
    body: JSON.stringify({ commitId, clearCache: 'do_not_clear' }),
  });
  const triggered = await resolveTriggeredDeploy({ response, client, serviceId, commitId, startedAt, deadline, sleep, pollIntervalMs, now });
  const deployId = deployIdOf(triggered);
  const base = {
    label,
    serviceId,
    deployId,
    commitId,
    status: String(triggered.status ?? (response.status === 202 ? 'queued' : 'created')),
    previousLiveDeployId: deployIdOf(previous) || null,
    previousLiveCommitId: commitIdOf(previous) || null,
  };
  await onProgress(base);
  const live = await waitForLiveDeploy({ client, label, serviceId, deployId, commitId, deadline, sleep, pollIntervalMs, now });
  const completed = { ...base, status: 'live', commitId: commitIdOf(live) };
  await onProgress(completed);
  return completed;
}

export async function rollbackService({
  client,
  label,
  serviceId,
  targetDeployId,
  targetCommitId: requestedCommitId,
  timeoutMs = DEFAULT_SERVICE_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = defaultSleep,
  now = Date.now,
  onProgress = async () => undefined,
}) {
  const commitId = fullSha(requestedCommitId, `${label} rollback commit SHA`);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const response = await client.request(`/services/${encodeURIComponent(serviceId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ deployId: targetDeployId }),
  });
  if (response.status !== 201) throw new Error(`Render rollback returned unexpected success status ${response.status}`);
  const triggered = await resolveTriggeredDeploy({ response, client, serviceId, commitId, startedAt, deadline, sleep, pollIntervalMs, now });
  const deployId = deployIdOf(triggered);
  const base = { label, serviceId, deployId, commitId, targetDeployId, status: String(triggered.status ?? 'created') };
  await onProgress(base);
  const live = await waitForLiveDeploy({ client, label, serviceId, deployId, commitId, deadline, sleep, pollIntervalMs, now });
  const completed = { ...base, status: 'live', commitId: commitIdOf(live) };
  await onProgress(completed);
  return completed;
}

function upsertService(manifest, service) {
  const index = manifest.services.findIndex((item) => item.label === service.label);
  if (index === -1) manifest.services.push(service);
  else manifest.services[index] = service;
}

export async function deployRelease({ client, commitId: requestedCommitId, services, timeoutMs, pollIntervalMs, sleep, now = Date.now, onManifest }) {
  const commitId = fullSha(requestedCommitId);
  const manifest = {
    kind: 'render-deploy',
    releaseSha: commitId,
    status: 'running',
    startedAt: new Date(now()).toISOString(),
    services: [],
  };
  await onManifest(manifest);
  try {
    for (const [label, serviceId] of services) {
      await deployService({
        client, label, serviceId, commitId, timeoutMs, pollIntervalMs, sleep, now,
        onProgress: async (service) => { upsertService(manifest, service); await onManifest(manifest); },
      });
    }
    manifest.status = 'live';
    manifest.completedAt = new Date(now()).toISOString();
    await onManifest(manifest);
    return manifest;
  } catch (error) {
    manifest.status = 'failed';
    manifest.completedAt = new Date(now()).toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    await onManifest(manifest);
    throw error;
  }
}

export async function rollbackRelease({ client, sourceManifest, serviceIds, timeoutMs, pollIntervalMs, sleep, now = Date.now, onManifest }) {
  const source = new Map(sourceManifest.services.map((service) => [service.label, service]));
  const targets = ['web', 'worker', 'api'].map((label) => {
    const service = source.get(label);
    if (!service?.deployId) return null;
    if (!service.previousLiveDeployId || !service.previousLiveCommitId) {
      throw new Error(`Release manifest does not contain a previous live deploy for ${label}`);
    }
    const expectedServiceId = serviceIds[label];
    if (!expectedServiceId || expectedServiceId !== service.serviceId) {
      throw new Error(`Release manifest service id for ${label} does not match the configured Render service`);
    }
    return { label, serviceId: expectedServiceId, targetDeployId: service.previousLiveDeployId, targetCommitId: service.previousLiveCommitId };
  }).filter(Boolean);
  if (targets.length === 0) throw new Error('Release manifest has no deployed services to roll back');

  const manifest = {
    kind: 'render-rollback',
    sourceReleaseSha: sourceManifest.releaseSha,
    status: 'running',
    startedAt: new Date(now()).toISOString(),
    services: [],
  };
  await onManifest(manifest);
  try {
    for (const target of targets) {
      await rollbackService({
        client, ...target, timeoutMs, pollIntervalMs, sleep, now,
        onProgress: async (service) => { upsertService(manifest, service); await onManifest(manifest); },
      });
    }
    manifest.status = 'live';
    manifest.completedAt = new Date(now()).toISOString();
    await onManifest(manifest);
    return manifest;
  } catch (error) {
    manifest.status = 'failed';
    manifest.completedAt = new Date(now()).toISOString();
    manifest.error = error instanceof Error ? error.message : String(error);
    await onManifest(manifest);
    throw error;
  }
}

export function formatManifestSummary(manifest) {
  const title = manifest.kind === 'render-rollback' ? 'Render production rollback' : 'Render production deployment';
  const rows = [
    `### ${title}`,
    '',
    `Status: **${manifest.status}**`,
    '',
    '| Service | Deploy ID | Commit | Previous/target deploy | Previous/target commit | Status |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const service of manifest.services) {
    rows.push(`| ${service.label} | ${service.deployId ?? '-'} | ${service.commitId ?? '-'} | ${service.previousLiveDeployId ?? service.targetDeployId ?? '-'} | ${service.previousLiveCommitId ?? '-'} | ${service.status ?? '-'} |`);
  }
  if (manifest.error) rows.push('', `Error: ${manifest.error}`);
  return `${rows.join('\n')}\n`;
}

function manifestPersistence({ manifestPath, summaryPath }) {
  let summaryWritten = false;
  return async (manifest) => {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (!summaryWritten && (manifest.status === 'live' || manifest.status === 'failed') && summaryPath) {
      await appendFile(summaryPath, formatManifestSummary(manifest), 'utf8');
      summaryWritten = true;
    }
  };
}

function readTimeout(env) {
  const timeoutMs = Number(env.RENDER_SERVICE_TIMEOUT_MS ?? DEFAULT_SERVICE_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 30 * 60 * 1_000) {
    throw new Error('RENDER_SERVICE_TIMEOUT_MS must be an integer between 60000 and 1800000');
  }
  return timeoutMs;
}

function configuredServices(env) {
  return [
    ['api', required(env, 'RENDER_API_SERVICE_ID')],
    ['worker', required(env, 'RENDER_WORKER_SERVICE_ID')],
    ['web', required(env, 'RENDER_WEB_SERVICE_ID')],
  ];
}

export async function deployReleaseFromEnv(env = process.env) {
  const client = createRenderClient({ token: required(env, 'RENDER_API_KEY') });
  const manifestPath = String(env.RENDER_DEPLOY_MANIFEST ?? 'render-deploy-manifest.json');
  const manifest = await deployRelease({
    client,
    commitId: required(env, 'GITHUB_SHA'),
    services: configuredServices(env),
    timeoutMs: readTimeout(env),
    onManifest: manifestPersistence({ manifestPath, summaryPath: env.GITHUB_STEP_SUMMARY }),
  });
  console.log(`Render release ${manifest.releaseSha} is live; evidence written to ${manifestPath}.`);
  return manifest;
}

export async function rollbackReleaseFromEnv(env = process.env, sourceManifestPath = env.RENDER_DEPLOY_MANIFEST ?? 'render-deploy-manifest.json') {
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
  const services = Object.fromEntries(configuredServices(env));
  const client = createRenderClient({ token: required(env, 'RENDER_API_KEY') });
  const manifestPath = String(env.RENDER_ROLLBACK_MANIFEST ?? 'render-rollback-manifest.json');
  const manifest = await rollbackRelease({
    client,
    sourceManifest,
    serviceIds: services,
    timeoutMs: readTimeout(env),
    onManifest: manifestPersistence({ manifestPath, summaryPath: env.GITHUB_STEP_SUMMARY }),
  });
  console.log(`Render rollback is live; evidence written to ${manifestPath}.`);
  return manifest;
}
