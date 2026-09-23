import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 90000, expect: { timeout: 20000 }, workers: 1, fullyParallel: false,
  use: { channel: process.env.RELAY_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'), trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } }, { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }]
});

