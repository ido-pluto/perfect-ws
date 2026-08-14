import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/rpc-gc.test.ts'],
    environment: 'node',
    coverage: { enabled: false },
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 100_000,
    hookTimeout: 100_000,
  },
});
