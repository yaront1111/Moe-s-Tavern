import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import { MEMORY_TYPES } from '../types/schema.js';
import type { MemoryType } from '../types/schema.js';

export function recallTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.recall',
    description: 'Search the project knowledge base for relevant memories. Returns conventions, gotchas, patterns, decisions, procedures, and insights saved by previous agents.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        types: { type: 'array', items: { type: 'string', enum: MEMORY_TYPES }, description: 'Filter by memory type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        epicId: { type: 'string', description: 'Scope to memories from a specific epic' },
        files: { type: 'array', items: { type: 'string' }, description: 'Match by related file paths' },
        limit: { type: 'number', description: 'Max results (default 10, max 30)' },
        minConfidence: { type: 'number', description: 'Minimum confidence threshold (default 0.3)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        query?: string; types?: string[]; tags?: string[];
        epicId?: string; files?: string[]; limit?: number; minConfidence?: number;
      };

      const mm = state.getMemoryManager();
      const results = await mm.search({
        query: params.query,
        types: params.types as MemoryType[] | undefined,
        tags: params.tags,
        epicId: params.epicId,
        files: params.files,
        limit: params.limit,
        minConfidence: params.minConfidence,
      });

      return {
        memories: results.map(r => ({
          id: r.entry.id,
          type: r.entry.type,
          content: r.entry.content,
          tags: r.entry.tags,
          confidence: r.entry.confidence,
          score: Math.round(r.score * 1000) / 1000,
          source: r.entry.source,
          createdAt: r.entry.createdAt,
        })),
        totalCount: results.length,
      };
    },
  };
}
