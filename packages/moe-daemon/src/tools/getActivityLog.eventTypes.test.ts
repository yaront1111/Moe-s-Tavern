// get_activity_log's eventTypes example names only real activity event types,
// and an unknown value is reported back instead of silently matching nothing
// (task-72f02ef3; hunt 11-03 #11 repro zzHuntB_eventTypeExample, ported as (e2)
// and (e3): the advertised filter now finds a status change, and the value the
// old example advertised is reported in unknownEventTypes, never refused).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { getActivityLogTool } from './getActivityLog.js';
import { ACTIVITY_EVENT_TYPES } from '../types/schema.js';

type LogResult = {
  events: Array<{ event: string; taskId?: string; payload: Record<string, unknown> }>;
  count: number;
  unknownEventTypes?: string[];
};

describe('moe.get_activity_log eventTypes', () => {
  const h = new ToolTestHarness();
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createTask({ id: 'task-s', status: 'BACKLOG' });
    await h.state.load();
    await h.state.updateTask('task-s', { status: 'PLANNING' });
    await h.state.flushActivityLog();
  });
  afterEach(() => h.cleanup());

  const tool = () => getActivityLogTool(h.state);
  const query = async (args: Record<string, unknown>) => (await tool().handler(args, h.state)) as LogResult;
  // The "(e.g. A, B, C)" list in the eventTypes description.
  const examples = (): string[] => {
    const described = (tool().inputSchema as { properties: { eventTypes: { description: string } } })
      .properties.eventTypes.description;
    const match = /\(e\.g\. ([^)]+)\)/.exec(described);
    return match ? match[1].split(',').map((s) => s.trim()) : [];
  };

  it('(e1) every example type in the eventTypes description is an activity event type', () => {
    const named = examples();
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const type of named) {
      expect(ACTIVITY_EVENT_TYPES as readonly string[]).toContain(type);
    }
    expect(named).not.toContain('TASK_STATUS_CHANGED');
  });

  it('(e2) a status change is findable with the advertised example types', async () => {
    const result = await query({ taskId: 'task-s', eventTypes: examples(), limit: 100, maxPayloadChars: 0 });
    expect(result.events.some((e) => e.event === 'TASK_UPDATED' && e.payload.status === 'PLANNING')).toBe(true);
    expect('unknownEventTypes' in result).toBe(false);
  });

  it('(e3) an unknown value still returns the normal page and is reported once, case-sensitively', async () => {
    const known = await query({ taskId: 'task-s', eventTypes: ['TASK_UPDATED'], limit: 100 });
    const mixed = await query({
      taskId: 'task-s',
      eventTypes: ['TASK_UPDATED', 'TASK_STATUS_CHANGED', 'TASK_STATUS_CHANGED', 'task_updated'],
      limit: 100,
    });
    expect(known.events.length).toBeGreaterThan(0);
    expect(mixed.events).toEqual(known.events);
    expect(mixed.count).toBe(known.count);
    expect(mixed.unknownEventTypes).toEqual(['TASK_STATUS_CHANGED', 'task_updated']);

    const onlyUnknown = await query({ eventTypes: ['TASK_STATUS_CHANGED'] });
    expect(onlyUnknown.events).toEqual([]);
    expect(onlyUnknown.unknownEventTypes).toEqual(['TASK_STATUS_CHANGED']);
  });

  it('(e4) a query with only known types, or no eventTypes, carries no unknownEventTypes key', async () => {
    expect('unknownEventTypes' in await query({ eventTypes: ['TASK_UPDATED', 'STEP_COMPLETED'] })).toBe(false);
    expect('unknownEventTypes' in await query({})).toBe(false);
  });
});
