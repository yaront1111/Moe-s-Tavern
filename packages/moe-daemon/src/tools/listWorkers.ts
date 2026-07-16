import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput } from '../util/errors.js';
import { isWorkerAlive, LIVENESS_TIMEOUT_MS } from '../util/workerLiveness.js';

const DEFAULT_LIVENESS_TIMEOUT_MS = LIVENESS_TIMEOUT_MS; // single source of truth
const MAX_LIVENESS_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export function listWorkersTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.list_workers',
    description: 'List all registered workers with presence (alive/stale) based on lastActivityAt. Display-only signal: a stale worker may be mid-build with its CLI blocked on a long local step — staleness alone is NEVER grounds to release its task.',
    inputSchema: {
      type: 'object',
      properties: {
        livenessTimeoutMs: {
          type: 'number',
          description: 'Workers with lastActivityAt older than this are reported as not alive (default 120000)'
        },
        onlyStale: {
          type: 'boolean',
          description: 'If true, only include workers where isAlive=false. Default false.'
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { livenessTimeoutMs?: number; onlyStale?: boolean };

      let timeoutMs = DEFAULT_LIVENESS_TIMEOUT_MS;
      if (params.livenessTimeoutMs !== undefined) {
        if (
          typeof params.livenessTimeoutMs !== 'number' ||
          !Number.isFinite(params.livenessTimeoutMs) ||
          params.livenessTimeoutMs < 0
        ) {
          throw invalidInput('livenessTimeoutMs', 'must be a non-negative finite number');
        }
        timeoutMs = Math.min(params.livenessTimeoutMs, MAX_LIVENESS_TIMEOUT_MS);
      }

      const now = Date.now();

      const workers: Array<{
        workerId: string;
        type: string;
        status: string;
        currentTaskId: string | null;
        currentTaskTitle: string | null;
        lastActivityAt: string;
        secondsSinceLastActivity: number;
        isAlive: boolean;
        epicId: string | null;
        teamId: string | null;
      }> = [];

      for (const w of state.workers.values()) {
        const ts = w.lastActivityAt ? new Date(w.lastActivityAt).getTime() : 0;
        const sinceMs = isNaN(ts) || ts === 0 ? Number.POSITIVE_INFINITY : now - ts;
        const isAlive = isWorkerAlive(w, now, timeoutMs);
        if (params.onlyStale && isAlive) continue;

        let currentTaskTitle: string | null = null;
        if (w.currentTaskId) {
          const task = state.getTask(w.currentTaskId);
          if (task) currentTaskTitle = task.title;
        }

        const secondsSinceLastActivity = sinceMs === Number.POSITIVE_INFINITY
          ? -1
          : Math.floor(sinceMs / 1000);

        workers.push({
          workerId: w.id,
          type: w.type,
          status: w.status,
          currentTaskId: w.currentTaskId,
          currentTaskTitle,
          lastActivityAt: w.lastActivityAt,
          secondsSinceLastActivity,
          isAlive,
          epicId: w.epicId || null,
          teamId: w.teamId,
        });
      }

      // Sort: alive workers first (by id), then stale (by oldest activity)
      workers.sort((a, b) => {
        if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
        if (a.isAlive) return a.workerId.localeCompare(b.workerId);
        return b.secondsSinceLastActivity - a.secondsSinceLastActivity;
      });

      const aliveCount = workers.filter((w) => w.isAlive).length;
      const staleWithTask = workers.filter((w) => !w.isAlive && w.currentTaskId);

      return {
        workers,
        summary: {
          total: workers.length,
          alive: aliveCount,
          stale: workers.length - aliveCount,
          staleWithAssignedTask: staleWithTask.length,
          livenessTimeoutMs: timeoutMs,
        },
        ...(staleWithTask.length > 0
          ? {
              hint: `${staleWithTask.length} worker(s) are quiet past the presence window while holding tasks. Quiet ≠ dead: a long build or test run can outlast the window. Ping them in #workers first; release only after a confirmed crash or with human approval. Never call moe.release_task on idle time alone — WORKING/PLANNING tasks are deliberately not auto-released, and a crashed QA's REVIEW task self-heals after reviewStaleTimeoutMs.`,
              staleAssignments: staleWithTask.map((w) => ({
                workerId: w.workerId,
                taskId: w.currentTaskId,
                taskTitle: w.currentTaskTitle,
                secondsSinceLastActivity: w.secondsSinceLastActivity,
              })),
            }
          : {}),
      };
    }
  };
}
