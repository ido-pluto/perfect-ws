import { defineConfig } from 'vitest/config';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['tests/setupTests.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: ['tests/browser/**', 'tests/rpc-gc.test.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['tests/*.test.ts', 'tests/*.spec.ts', 'tests/browser/**', 'tests/rpc-gc.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/*.test.ts', 'tests/*.spec.ts'],
          exclude: ['tests/integration/**', 'tests/browser/**', 'tests/rpc-gc.test.ts'],
          environment: 'happy-dom',
        },
      },
    ],
    reporters: ['default'],
    onConsoleLog: (log) => {
      if (log.includes('Server not connected') && log.includes('serverClosed')) {
        return false;
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
    testTimeout: isCI ? 30_000 : 10_000,
    hookTimeout: isCI ? 40_000 : 20_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // Real WebSocket tests need some parallelism, but CI runners have fewer cores.
        maxForks: isCI ? 4 : 8,
        minForks: 1,
      }
    }
  },
});
