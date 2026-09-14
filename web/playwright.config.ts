import { defineConfig, devices } from '@playwright/test';

export const E2E_PORT = 3998;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Builds the PWA, then starts carbs-server on a throwaway database serving web/dist.
    command: 'pnpm build && node e2e/start-server.mjs',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
