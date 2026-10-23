import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { recordAccountReport } from '../state/accountStore.js';
import { ACCOUNT_ID_RE } from '../accounts/registry.js';
import { parseUsageWindows } from '../accounts/usageWindows.js';
import { invalidInput } from '../util/errors.js';

/**
 * Wrapper-only: one report for a leased account, as the claude CLI printed it
 * (a stream-json rate_limit_event, or the interactive statusline's
 * rate_limits), plus what the wrapper saw at exit: a refusal at the limit, or
 * a sign-in probe that found the account signed out. Malformed windows are
 * dropped rather than refused (see accounts/usageWindows.ts).
 */
export function reportAccountUsageTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.report_account_usage',
    description:
      'Wrapper-only. Records the usage windows the claude CLI reported for a leased account (five_hour, seven_day, …: percent or utilization, resetsAt, status). refused:true marks a launch refused at the limit, which parks the account until its spent window resets. signIn "signed_out" or "other" records a failed sign-in probe, which takes the account out of rotation until it is signed in again. Unknown account ids are ignored. Not intended to be called by agents.',
    inputSchema: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: 'Reporting seat (moe-proxy injects it).' },
        accountId: { type: 'string', pattern: ACCOUNT_ID_RE.source },
        windows: {
          type: 'object',
          description: 'Keyed by window name: { percent (0-100) | utilization (0-1), resetsAt (epoch s, epoch ms or ISO), status }.',
          additionalProperties: {
            type: 'object',
            properties: {
              percent: { type: 'number' },
              utilization: { type: 'number' },
              resetsAt: { type: ['number', 'string'] },
              status: { type: 'string' },
            },
          },
        },
        refused: { type: 'boolean', description: 'True when the launch was refused at the usage limit.' },
        signIn: { type: 'string', enum: ['signed_out', 'other'], description: 'What a sign-in probe found after a launch failed fast.' },
      },
      required: ['accountId'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as { workerId?: unknown; accountId?: unknown; windows?: unknown; refused?: unknown; signIn?: unknown };
      if (typeof params.accountId !== 'string' || !ACCOUNT_ID_RE.test(params.accountId)) {
        throw invalidInput('accountId', 'must be the id of a leased account');
      }
      if (params.signIn !== undefined && params.signIn !== 'signed_out' && params.signIn !== 'other') {
        throw invalidInput('signIn', 'must be "signed_out" or "other"');
      }
      const nowMs = Date.now();
      return recordAccountReport(state, {
        workerId: typeof params.workerId === 'string' ? params.workerId : undefined,
        accountId: params.accountId,
        windows: parseUsageWindows(params.windows, nowMs),
        refused: params.refused === true,
        signIn: params.signIn,
      }, nowMs);
    },
  };
}
