import { defineConfig, devices } from '@playwright/test';
import { assertSafeE2eTarget } from './target-safety';

const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:5173';
const target = assertSafeE2eTarget(baseURL, process.env.E2E_ALLOW_WRITES);
if (process.env.E2E_API_BASE && new URL(process.env.E2E_API_BASE).origin !== target.origin) {
  throw new Error('E2E_API_BASE and E2E_BASE_URL must use the same origin; V2 E2E exercises the Web reverse proxy.');
}

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  outputDir: '../test-results/e2e',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: '../playwright-report', open: 'never' }], ['junit', { outputFile: '../test-results/e2e-junit.xml' }]]
    : [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'light',
  },
  ...(externalBaseUrl ? {} : { webServer: {
    command: 'node start-v2-stack.mjs',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  } }),
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
