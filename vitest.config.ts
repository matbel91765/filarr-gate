import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __GATE_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/support/noProduction.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
