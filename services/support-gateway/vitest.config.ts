import { defineConfig } from 'vitest/config';

// These are integration/contract tests (spec section 18/19: "run contract tests," "a staging
// upgrade passes the full contract suite") - they hit the actually-running gateway and Chatwoot
// instance, not mocks. See test/README.md for what must be running first. Sequential, not
// parallel: several tests share and mutate the same fixture conversations.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    fileParallelism: false,
  },
});
