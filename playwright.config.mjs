import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.mjs/,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tools/serve.mjs',
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'unit', testMatch: /unit\.spec\.mjs/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /unit\.spec\.mjs/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /unit\.spec\.mjs/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /unit\.spec\.mjs/ },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] }, testMatch: /ui\.spec\.mjs/ },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] }, testMatch: /ui\.spec\.mjs/ },
  ],
});
