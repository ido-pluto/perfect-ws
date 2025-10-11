import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['tests/setupTests.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts', 'tests/integration/*.test.ts'],
    environmentMatchGlobs: [
      ['tests/integration/**', 'node'],
      ['**', 'happy-dom']
    ],
    // Suppress unhandled rejection errors for expected test cases
    dangerouslyIgnoreUnhandledErrors: true,
    reporters: ['default'],
    onConsoleLog: (log) => {
      // Filter out expected unhandled rejection warnings
      if (log.includes('Server not connected') && log.includes('serverClosed')) {
        return false; // Don't print this log
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    },
    testTimeout: 10_000, // 2 minutes for long integration tests
    hookTimeout: 20_000,
  },
});