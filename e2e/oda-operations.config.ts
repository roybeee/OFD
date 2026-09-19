import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'oda-operations.smoke.ts', outputDir: '../test-results/oda-operations',
  timeout: 60_000, expect: { timeout: 12_000 }, workers: 1, fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5265', locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node --import tsx oda-operations-server.mjs', url: 'http://127.0.0.1:5265/api/v2/health', reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
