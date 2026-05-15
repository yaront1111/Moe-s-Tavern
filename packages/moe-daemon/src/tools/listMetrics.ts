import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { invalidInput } from '../util/errors.js';
import {
  computeMetricsAggregate,
  filterTasksForMetrics,
  toPerTaskMetric,
} from '../util/metrics.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function listMetricsTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.list_metrics',
    description: 'Return per-task metrics + aggregate (avg wall-clock, first-pass approval %, avg reopens). Aggregate is defined even when no tasks match.',
    inputSchema: {
      type: 'object',
      properties: {
        epicId: { type: 'string', description: 'Restrict to a single epic' },
        sinceIso: { type: 'string', description: 'ISO 8601 cutoff; only tasks last touched at/after this time are included' },
        limit: { type: 'number', description: `Cap on per-task entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Aggregate is always over the full filtered set.` }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as { epicId?: string; sinceIso?: string; limit?: number };

      if (params.sinceIso !== undefined && typeof params.sinceIso !== 'string') {
        throw invalidInput('sinceIso', 'must be an ISO 8601 string');
      }
      if (params.sinceIso && !Number.isFinite(Date.parse(params.sinceIso))) {
        throw invalidInput('sinceIso', 'is not a valid ISO 8601 timestamp');
      }
      let limit = typeof params.limit === 'number' ? params.limit : DEFAULT_LIMIT;
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
      limit = Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);

      const filtered = filterTasksForMetrics(state.tasks.values(), {
        epicId: params.epicId,
        sinceIso: params.sinceIso,
      });

      // Sort newest-first by doneAt then firstClaimAt then updatedAt so
      // recent activity floats to the top of the per-task list.
      filtered.sort((a, b) => {
        const aTs = a.metrics?.doneAt ?? a.metrics?.firstClaimAt ?? a.updatedAt ?? a.createdAt ?? '';
        const bTs = b.metrics?.doneAt ?? b.metrics?.firstClaimAt ?? b.updatedAt ?? b.createdAt ?? '';
        return bTs.localeCompare(aTs);
      });

      const aggregate = computeMetricsAggregate(filtered);
      const perTask = filtered.slice(0, limit).map(toPerTaskMetric);

      return {
        aggregate,
        tasks: perTask,
        totalMatched: filtered.length,
      };
    }
  };
}
