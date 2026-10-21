import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { chatReadTool } from './chatRead.js';
import { chatResyncTool } from './chatResync.js';
import { chatWaitTool } from './chatWait.js';
import type { ChatMessage } from '../types/schema.js';

// The daemon's status lines in #general (task moved, claimed, step completed,
// landing reports) were most of what chat fed into agent context. Agents now
// skip them; the IDE, which reads the channel without the filter, still shows
// them. A system line that mentions someone is still shown to agents.
describe('the #general system feed', () => {
  const h = new ToolTestHarness();
  let general: string;
  let governors: string;
  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createWorker({ id: 'worker-chat' });
    h.createWorker({ id: 'worker-peer' });
    h.createWorker({ id: 'worker-busy', status: 'CODING' });
    await h.state.load();
    general = h.state.getChannels().find((channel) => channel.name === 'general')!.id;
    governors = h.state.getChannels().find((channel) => channel.name === 'governors')!.id;
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  async function post(channel: string, sender: string, content: string): Promise<ChatMessage> {
    return (await h.state.sendMessage({ channel, sender, content })).message;
  }

  async function read(args: Record<string, unknown>): Promise<{ messages: ChatMessage[]; cursor: string | null }> {
    return await chatReadTool(h.state).handler({ workerId: 'worker-chat', ...args }, h.state) as {
      messages: ChatMessage[]; cursor: string | null;
    };
  }

  it('agent reads skip it and keep people, agents and system lines that mention someone', async () => {
    const feed = await post(general, 'system', 'task-1: Task moved to WORKING by worker-peer');
    const human = await post(general, 'human', 'please look at task-1');
    const agent = await post(general, 'worker-peer', 'on it');
    const paged = await post(general, 'system', '@worker-chat 🚧 worker-peer blocked on task-1: proxy down');
    const governorsLine = await post(governors, 'system', '⚠️ worker-peer stale on task-1');

    const visible = [human.id, agent.id, paged.id];
    expect((await read({ channel: '#general' })).messages.map((m) => m.id)).toEqual(visible);
    // The feed is only hidden in #general: role channels carry the alerts.
    expect((await read({ channel: '#governors' })).messages.map((m) => m.id)).toEqual([governorsLine.id]);
    const resync = await chatResyncTool(h.state).handler({ workerId: 'worker-chat', channel: general }, h.state) as {
      messages: ChatMessage[];
    };
    expect(resync.messages.map((m) => m.id)).toEqual(visible);

    // Opt back in, and the IDE's unfiltered read, both see the whole channel.
    const all = [feed.id, ...visible];
    expect((await read({ channel: '#general', sinceId: undefined, workerId: undefined, includeSystem: true }))
      .messages.map((m) => m.id)).toEqual(all);
    expect((await h.state.getMessages(general)).map((m) => m.id)).toEqual(all);
  });

  it('hidden lines never fill a page or strand a reader behind them', async () => {
    const first = await post(general, 'human', 'first');
    expect((await read({ channel: general })).cursor).toBe(first.id);

    for (let i = 0; i < 30; i++) await post(general, 'system', `task-${i}: Task moved to PLANNING by unknown`);
    const second = await post(general, 'worker-peer', 'second');
    for (let i = 0; i < 30; i++) await post(general, 'system', `task-${i}: Step 1 completed: build`);
    const third = await post(general, 'human', 'third');

    const page = await read({ channel: general, limit: 2 });
    expect(page.messages.map((m) => m.id)).toEqual([second.id, third.id]);
    expect(page.cursor).toBe(third.id);

    await post(general, 'system', 'task-1: Task moved to REVIEW by worker-peer');
    expect((await read({ channel: general })).messages).toEqual([]);
    const fourth = await post(general, 'human', 'fourth');
    expect((await read({ channel: general })).messages.map((m) => m.id)).toEqual([fourth.id]);
  });

  it('pages nobody: no chat_wait wake and no unread count for a feed line', async () => {
    let settled = false;
    const pending = (chatWaitTool(h.state).handler(
      { workerId: 'worker-chat', channels: [general], timeoutMs: 2000 }, h.state
    ) as Promise<{ hasMessage: boolean; messages?: ChatMessage[] }>).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await post(general, 'system', 'task-2: Task moved to REVIEW by worker-peer');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    const wake = await post(general, 'worker-peer', 'task-2 is ready for review');
    const result = await pending;
    expect(result.messages?.map((m) => m.id)).toEqual([wake.id]);

    // A mention-less system line routes to every busy seat; in #general it
    // counts for none of them. A system line that mentions a seat still does.
    await post(general, 'system', 'task-1: Task moved to WORKING by unknown');
    expect(h.state.getUnreadSummary('worker-busy')).toBeNull();
    await post(general, 'system', '@worker-busy your lease on benchmark-box expires soon');
    expect(h.state.getUnreadSummary('worker-busy')?.channels[general]).toBe(1);
  });

  it('a system post names its task unless the line already does', async () => {
    await h.state.postSystemMessage('task-9', 'QA approved — task complete');
    await h.state.postSystemMessage('task-9', '🔗 worker-peer set dependencies on task-9: [task-8] (was [none])');

    const contents = (await h.state.getMessages(general)).map((m) => m.content);
    expect(contents).toContain('task-9: QA approved — task complete');
    expect(contents).toContain('🔗 worker-peer set dependencies on task-9: [task-8] (was [none])');
  });
});
