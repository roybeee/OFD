import { defineConfig, devices } from '@playwright/test';

const externalBaseUrl = process.env.E2E_BASE_URL;
const externalApiBase = process.env.E2E_API_BASE;
const externalRun = Boolean(externalBaseUrl || externalApiBase);
if (externalRun && process.env.E2E_ALLOW_WRITES !== 'qa') {
  throw new Error('External E2E creates QA records. Set E2E_ALLOW_WRITES=qa only for an isolated QA deployment.');
}
if (externalRun && (!externalBaseUrl || !externalApiBase)) {
  throw new Error('External E2E requires both E2E_BASE_URL and E2E_API_BASE. They must target the same isolated QA deployment.');
}
if (externalBaseUrl && externalApiBase && new URL(externalBaseUrl).origin !== new URL(externalApiBase).origin) {
  throw new Error('E2E_BASE_URL and E2E_API_BASE must have the same origin.');
}
if (externalRun && (!process.env.E2E_HQ_USERNAME || !process.env.E2E_HQ_PASSWORD)) {
  throw new Error('External E2E requires a pre-provisioned E2E_HQ_USERNAME and E2E_HQ_PASSWORD.');
}
if (externalRun && !process.env.E2E_QA_TOKEN) {
  throw new Error('External E2E requires E2E_QA_TOKEN from the isolated QA deployment.');
}
if (externalBaseUrl && externalApiBase) {
  const target = new URL(externalBaseUrl);
  const loopback = target.hostname === '127.0.0.1' || target.hostname === 'localhost' || target.hostname === '::1';
  if (target.hostname === 'ofd-workstation.onrender.com') throw new Error('Production OFD is never an allowed E2E write target.');
  if (!loopback && target.protocol !== 'https:') throw new Error('External E2E requires HTTPS.');
}
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:4100';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: '../test-results/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: '../playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'light',
    reducedMotion: 'reduce'
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'npm run build:render -w @ofd/web && node legacy-server.cjs',
        url: 'http://127.0.0.1:4100/health',
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe'
      },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
