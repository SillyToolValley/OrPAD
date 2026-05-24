import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  retries: process.env.CI ? 2 : 0,
  reporter: [['html'], ['list']],
  projects: [
    {
      name: 'electron',
      testMatch: 'tests/e2e/*.spec.ts',
      // Electron tests launch full desktop app instances. Running them in
      // parallel causes worker teardown timeouts and perf false positives on
      // Windows, while serial execution keeps the assertions deterministic.
      workers: 1,
      use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
      },
    },
    {
      name: 'web-chromium',
      use: { ...devices['Desktop Chrome'] },
      testMatch: 'tests/e2e/web/*.spec.ts',
    },
    {
      name: 'web-firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: 'tests/e2e/web/*.spec.ts',
    },
    {
      name: 'web-webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: 'tests/e2e/web/*.spec.ts',
    },
  ],
});
