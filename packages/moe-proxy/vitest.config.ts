import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Agent seats export MOE_SESSION_ID and MOE_WORKER_TYPE (and MOE_DAEMON_HOST
    // in WSL agent mode), and every proxy spawned here inherits process.env.
    // Blank them all here (every reader treats blank as unset); a test that
    // needs one sets it.
    env: Object.fromEntries([
      'MOE_WORKER_ID', 'MOE_SESSION_ID', 'MOE_ATTEMPT_ID', 'MOE_ATTEMPT_GENERATION',
      'MOE_RUNNER_PROCESS_STARTED_AT', 'MOE_RUNNER_HOST', 'MOE_DAEMON_HOST',
      'MOE_TOOL_NAME_STYLE', 'MOE_MESSAGE_TIMEOUT_MS', 'MOE_WORKER_TYPE',
    ].map((name) => [name, ''])),
  },
});
