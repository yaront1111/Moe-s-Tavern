import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

// The trap: a seat's MOE_WORKER_ID (qa-...) role-trimmed get_context and failed
// 4 getContext.test.ts cases. vitest.config.ts blanks the seat identity.
describe('vitest env isolation', () => {
  it.each(['MOE_WORKER_ID', 'MOE_TASK_ID', 'MOE_PROJECT_PATH'])('%s is blanked', (name) => {
    expect(process.env[name]).toBe('');
  });

  it('points MOE_ACCOUNTS_FILE at a file that does not exist', () => {
    expect(process.env.MOE_ACCOUNTS_FILE).toBe(
      path.join(os.tmpdir(), 'moe-vitest-no-accounts', 'claude-accounts.json'),
    );
  });
});
