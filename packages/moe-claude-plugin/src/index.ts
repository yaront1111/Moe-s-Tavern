// =============================================================================
// @moe/claude-plugin — public surface
// =============================================================================

export {
  callTool,
  postEvent,
  findDaemonInfo,
  DaemonError,
  type DaemonInfo,
  type DaemonClientOptions,
} from './daemonClient.js';

export { runPostToolUseHook, type PostToolUseInput } from './postToolUse.js';
