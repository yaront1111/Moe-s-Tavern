import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { missingRequired, invalidInput } from '../util/errors.js';
import { MEMORY_TYPES } from '../types/schema.js';
import type { MemoryType } from '../types/schema.js';

export function rememberTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.remember',
    description: 'Save a learning to the project knowledge base. Use this to share conventions, gotchas, patterns, decisions, procedures, or insights discovered during work.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge to save (max 2000 chars)' },
        type: { type: 'string', enum: MEMORY_TYPES, description: 'Type of knowledge: convention, gotcha, pattern, decision, procedure, or insight' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags (auto-generated if omitted)' },
        workerId: { type: 'string', description: 'Your worker ID' },
        taskId: { type: 'string', description: 'Current task ID (optional)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Related file paths (optional)' },
      },
      required: ['content', 'type', 'workerId'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        content?: string; type?: string; tags?: string[];
        workerId?: string; taskId?: string; files?: string[];
      };

      if (!params.content?.trim()) throw missingRequired('content');
      if (!params.type) throw missingRequired('type');
      if (!params.workerId) throw missingRequired('workerId');
      if (!MEMORY_TYPES.includes(params.type as MemoryType)) {
        throw invalidInput('type', `must be one of: ${MEMORY_TYPES.join(', ')}`);
      }

      const mm = state.getMemoryManager();
      const result = await mm.addEntry({
        content: params.content,
        type: params.type as MemoryType,
        tags: params.tags,
        workerId: params.workerId,
        taskId: params.taskId,
        files: params.files,
      });

      if (result.wasDuplicate) {
        return {
          memoryId: result.entry.id,
          message: 'Similar memory already exists — merged (confidence boosted)',
          wasDuplicate: true,
          mergedWith: result.mergedWith,
        };
      }

      return {
        memoryId: result.entry.id,
        message: 'Memory saved to project knowledge base',
        wasDuplicate: false,
        tags: result.entry.tags,
      };
    },
  };
}
