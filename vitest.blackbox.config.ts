import { defineConfig } from 'vitest/config';

// Black-box acceptance tests (plan NG, M0): they drive the built package through its command line, its HTTP API and
// the files it writes, never through source imports. `npm run test:blackbox`.
export default defineConfig({
  test: {
    include: ['tests/blackbox/**/*.test.ts'],
    globalSetup: ['tests/blackbox/global-setup.ts'],
    pool: 'forks',
    testTimeout: 90_000,
    hookTimeout: 180_000,
    env: { NODE_NO_WARNINGS: '1' },
  },
});
