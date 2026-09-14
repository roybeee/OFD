import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../../', import.meta.url);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 3_000);
  timer.unref();
}

function launch(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit',
    shell: process.platform === 'win32' && command === npm });
  children.add(child);
  child.once('error', error => {
    console.error(`ODA 실행 실패: ${error.message}`);
    children.delete(child);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`ODA 서버가 종료되었습니다 (${signal ?? code ?? 'unknown'}).`);
      stop(code || 1);
    }
  });
  return child;
}

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`${port} 포트를 사용 중입니다. 이전 ODA 실행 창을 종료해 주세요.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

try {
  // Do not silently choose another UI port while retaining an unrelated API.
  await Promise.all([requireFreePort(4100), requireFreePort(5173)]);
  const built = spawn(npm, ['run', 'build:packages'], { cwd: root, stdio: 'inherit',
    shell: process.platform === 'win32' });
  children.add(built);
  const code = await new Promise((resolve, reject) => {
    built.once('error', reject);
    built.once('exit', code => resolve(code));
  });
  children.delete(built);
  if (code !== 0) throw new Error('실행 파일 빌드에 실패했습니다. 위 오류를 확인해 주세요.');
  if (!stopping) {
    // Explicitly isolated demo: inherited production settings never reach this process.
    const env = { ...process.env, NODE_ENV: 'development', APP_MODE: 'test', WORKSTATION_BRAND: 'oda',
      REPOSITORY_MODE: 'memory', STORAGE_MODE: 'mock', EMAIL_PROVIDER: 'mock', PROVIDER_MODE: 'mock',
      API_HOST: '127.0.0.1', API_PORT: '4100', VITE_API_BASE: '/api/v2', VITE_ALLOW_TEST_API: 'true' };
    launch(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], env);
    let ready = false;
    for (let attempt = 0; attempt < 100 && !stopping; attempt += 1) {
      try {
        const response = await fetch('http://127.0.0.1:4100/api/v2/health', { signal: AbortSignal.timeout(800) });
        const health = await response.json();
        if (response.ok && health.ok && health.mode === 'test') { ready = true; break; }
      } catch { /* bounded startup wait */ }
      await delay(150);
    }
    if (!ready && !stopping) throw new Error('ODA API가 준비되지 않았습니다.');
    if (ready && !stopping) {
      launch(process.execPath, ['node_modules/vite/bin/vite.js', 'apps/web', '--mode', 'oda', '--host', '127.0.0.1', '--strictPort',
        ...(process.argv.includes('--open') ? ['--open', '/store/oda-settlement'] : [])], env);
      console.log('\nODA 테스트 화면: http://localhost:5173/store/oda-settlement\n테스트 자료만 사용하세요. 이 실행은 종료 시 자료가 초기화됩니다.\n');
    }
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
