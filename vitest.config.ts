import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
    pool: 'forks',
    testTimeout: 20000,
    env: { NODE_NO_WARNINGS: '1' },
  },
});
