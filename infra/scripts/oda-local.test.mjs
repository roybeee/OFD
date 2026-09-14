import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const launcher = fileURLToPath(new URL('./oda-local.sh', import.meta.url));
const fakeDocker = `#!/bin/sh
task_pinned_endpoint=""
if [ "\${1:-}" = --host ]; then
  task_pinned_endpoint="$2"
  shift 2
fi
if [ "\${1:-}" != context ]; then
  case "$task_pinned_endpoint" in unix://*|npipe://*) ;; *) printf 'daemon endpoint not pinned\\n' >&2; exit 43 ;; esac
  if [ -n "\${DOCKER_CONTEXT:-}\${DOCKER_HOST:-}" ]; then
    printf 'inherited Docker selection not cleared\\n' >&2; exit 44
  fi
fi
case "$1" in
  context) printf '%s\\n' "\${ODA_TEST_CONTEXT_ENDPOINT:-unix:///var/run/docker.sock}"; exit 0 ;;
  info) exit 0 ;;
  volume) [ "\${ODA_TEST_VOLUME_EXISTS:-}" = yes ] && printf 'oda-workstation-local_oda_local_postgres\\n'; exit 0 ;;
  compose)
    [ "\${2:-}" = version ] && exit 0
    printf '%s\\n' "$*" >> "$ODA_TEST_ROOT/commands"
    if [ -n "\${ODA_LOCAL_DATABASE_PASSWORD:-}\${ODA_LOCAL_SESSION_SECRET:-}\${ODA_LOCAL_ENCRYPTION_KEY:-}\${ODA_LOCAL_SETUP_TOKEN:-}" ]; then
      printf 'inherited secrets not cleared\\n' >&2; exit 42
    fi
    case "$*" in *pg_dump*) printf 'PGDMP-example-dump' ;; esac
    exit 0 ;;
esac
exit 1
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oda-launch-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  for (const [name, content] of Object.entries({
    docker: fakeDocker,
    uname: '#!/bin/sh\nprintf Linux\\n\n',
    'xdg-open': '#!/bin/sh\nexit 0\n',
  })) {
    await writeFile(join(bin, name), content);
    await chmod(join(bin, name), 0o700);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_DATA_HOME: root, ODA_TEST_ROOT: root,
    ODA_LOCAL_DATABASE_PASSWORD: 'poison-inherited', ODA_LOCAL_SESSION_SECRET: 'poison-inherited',
    ODA_LOCAL_ENCRYPTION_KEY: 'poison-inherited', ODA_LOCAL_SETUP_TOKEN: 'poison-inherited' };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  return { root, env, envPath: join(root, 'oda-workstation', 'local.env'),
    run(action, extraEnv = {}) { return spawnSync('bash', [launcher, action], { env: { ...env, ...extraEnv }, encoding: 'utf8' }); },
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

test('local launch retains generated secrets across restarts and never prints the setup token', async () => {
  const f = await fixture();
  try {
    const first = f.run('start');
    assert.equal(first.status, 0, first.stderr);
    const saved = await readFile(f.envPath, 'utf8');
    assert.match(saved, /ODA_LOCAL_DATABASE_PASSWORD=[a-f0-9]{64}\n/);
    const token = saved.match(/ODA_LOCAL_SETUP_TOKEN=(.+)/)[1];
    assert.ok(!`${first.stdout}${first.stderr}`.includes(token));
    const second = f.run('start');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(f.envPath, 'utf8'), saved);
    const commands = await readFile(join(f.root, 'commands'), 'utf8');
    assert.ok(commands.includes(`--env-file ${f.envPath}`));
    assert.ok(commands.includes('--project-name oda-workstation-local'));
    assert.ok(!commands.includes('--project-directory'));
  } finally { await f.cleanup(); }
});

test('missing settings never overwrite secrets for an existing database volume', async () => {
  const f = await fixture();
  try {
    const result = f.run('start', { ODA_TEST_VOLUME_EXISTS: 'yes' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /기존 ODA 데이터/);
    await assert.rejects(access(f.envPath));
  } finally { await f.cleanup(); }
});

test('stop preserves volumes and backup includes database plus matching encryption keys', async () => {
  const f = await fixture();
  try {
    assert.equal(f.run('start').status, 0);
    const stopped = f.run('stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    const commands = await readFile(join(f.root, 'commands'), 'utf8');
    assert.match(commands, / stop\n/);
    assert.doesNotMatch(commands, /(?:down|volume rm|--volumes| -v\b)/);
    const backup = f.run('backup');
    assert.equal(backup.status, 0, backup.stderr);
    const backupRoot = join(f.root, 'oda-workstation', 'backups');
    const [folder] = await readdir(backupRoot);
    assert.equal(await readFile(join(backupRoot, folder, 'oda.dump'), 'utf8'), 'PGDMP-example-dump');
    assert.equal(await readFile(join(backupRoot, folder, 'local.env'), 'utf8'), await readFile(f.envPath, 'utf8'));
  } finally { await f.cleanup(); }
});

test('a remote Docker endpoint and shell code in settings are rejected before start', async () => {
  const f = await fixture();
  try {
    const remote = f.run('start', { DOCKER_HOST: 'tcp://remote.example:2375' });
    assert.notEqual(remote.status, 0);
    assert.match(remote.stderr, /이 컴퓨터의 Docker/);
    assert.equal(f.run('start').status, 0);
    await writeFile(f.envPath, 'ODA_LOCAL_DATABASE_PASSWORD=$(touch /tmp/not-executed)\n');
    const tampered = f.run('start');
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /형식/);
  } finally { await f.cleanup(); }
});

test('effective DOCKER_CONTEXT overrides DOCKER_HOST and every daemon operation stays on the verified endpoint', async () => {
  const f = await fixture();
  try {
    const remoteContext = f.run('start', { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: 'remote-hetzner',
      ODA_TEST_CONTEXT_ENDPOINT: 'ssh://server.example' });
    assert.notEqual(remoteContext.status, 0);
    assert.match(remoteContext.stderr, /이 컴퓨터의 Docker/);
    await assert.rejects(access(f.envPath));
    await assert.rejects(access(join(f.root, 'commands')));
    const localContext = { DOCKER_HOST: 'tcp://unused-remote.example:2375', DOCKER_CONTEXT: 'desktop-linux',
      ODA_TEST_CONTEXT_ENDPOINT: 'unix:///var/run/docker.sock' };
    for (const action of ['start', 'status', 'logs', 'backup', 'stop']) {
      const response = f.run(action, localContext);
      assert.equal(response.status, 0, `${action}: ${response.stderr}`);
    }
    const commands = await readFile(join(f.root, 'commands'), 'utf8');
    assert.doesNotMatch(commands, /context use|unused-remote|remote-hetzner/);
  } finally { await f.cleanup(); }
});
