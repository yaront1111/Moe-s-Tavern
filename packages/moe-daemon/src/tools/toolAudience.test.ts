import { describe, it, expect } from 'vitest';
import { getTools, toolsForRole, TOOL_AUDIENCE } from './index.js';
import type { StateManager } from '../state/StateManager.js';

describe('TOOL_AUDIENCE', () => {
  const tools = getTools({} as StateManager);

  it('names exactly the registered tools, so a new tool gets an explicit audience', () => {
    expect(Object.keys(TOOL_AUDIENCE).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('keeps each role\'s core loop listed and hides wrapper-only tools from everyone', () => {
    const names = (role: 'architect' | 'worker' | 'qa' | 'governor') =>
      new Set(toolsForRole(tools, role).map((t) => t.name));
    expect(names('architect')).toContain('moe.submit_plan');
    expect(names('worker')).toContain('moe.complete_task');
    expect(names('qa')).toContain('moe.qa_reject');
    expect(names('governor')).toContain('moe.submit_plan_critique');
    for (const role of ['architect', 'worker', 'qa', 'governor'] as const) {
      expect(names(role)).not.toContain('moe.heartbeat');
      expect(names(role)).not.toContain('moe.lease_account');
      expect(names(role)).not.toContain('moe.report_account_usage');
      expect(names(role)).toContain('moe.get_context');
      expect(names(role)).toContain('moe.chat_send');
    }
    expect(toolsForRole(tools, null)).toHaveLength(tools.length);
  });
});
