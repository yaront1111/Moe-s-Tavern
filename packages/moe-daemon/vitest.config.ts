import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Every snapshot reads the machine's Claude account list (accounts/registry.ts):
    // point it at a file that does not exist, never at the developer's real one.
    env: {
      MOE_ACCOUNTS_FILE: path.join(os.tmpdir(), 'moe-vitest-no-accounts', 'claude-accounts.json'),
      // Agent seats export their identity; daemon modules read it as the caller
      // (src/tools/getContext.ts) and the project (src/index.ts). Blank it here,
      // because every reader treats blank as unset; a test that needs one stubs it.
      ...Object.fromEntries(['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_PROJECT_PATH'].map((name) => [name, ''])),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        global: {
          statements: 60,
          branches: 60,
          functions: 60,
          lines: 60,
        },
      },
      reportsDirectory: './coverage',
    },
  },
});
