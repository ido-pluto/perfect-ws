import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./globalSetup.ts'],
    include: ['tests/**/*.browser.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    teardownTimeout: 15_000,
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
