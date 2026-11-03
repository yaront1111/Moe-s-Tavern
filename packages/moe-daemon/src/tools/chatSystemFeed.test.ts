import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { chatReadTool } from './chatRead.js';
import { chatResyncTool } from './chatResync.js';
import { chatWaitTool } from './chatWait.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import type { ChatMessage } from '../types/schema.js';
import { isRoutinePresenceLine } from '../util/chatPayload.js';

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

// Wrapper restarts deregister a seat after almost every CLI session. The
// "<id> left (<reason>)" line and a "(no tasks held)" banner it leaves in role
// channels paged every busy seat and woke every chat_wait; they are feed too.
// A banner that released a task or dropped a resource claim stays actionable.
describe('routine presence lines', () => {
  const h = new ToolTestHarness();
  let workers: string;
  let governors: string;
  let events: Array<{ message: ChatMessage; routingTargets: string[] }>;
  let unsubscribe: () => void;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    h.createWorker({ id: 'worker-peer' });
    h.createWorker({ id: 'worker-busy', status: 'CODING' });
    h.createWorker({ id: 'worker-holder', status: 'CODING', currentTaskId: 'task-1' });
    h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-holder' });
    await h.state.load();
    workers = h.state.getChannels().find((channel) => channel.name === 'workers')!.id;
    governors = h.state.getChannels().find((channel) => channel.name === 'governors')!.id;
    events = [];
    unsubscribe = h.state.subscribe((event) => {
      if (event.type === 'MESSAGE_CREATED') {
        events.push({ message: event.payload, routingTargets: event.routingTargets ?? [] });
      }
    });
  });
  afterEach(() => { unsubscribe(); vi.restoreAllMocks(); h.cleanup(); });

  const deregister = (workerId: string, reason: string) =>
    deregisterWorkerTool(h.state).handler({ workerId, reason }, h.state);

  const routedTo = (content: string, channel?: string) =>
    events.filter((e) => e.message.content === content && (!channel || e.message.channel === channel));

  async function postSystem(channel: string, content: string, sender = 'system'): Promise<string[]> {
    return (await h.state.sendMessage({ channel, sender, content })).routingTargets;
  }

  it('a routine deregistration pages nobody and wakes no parked chat_wait', async () => {
    await h.state.updateWorker('worker-peer', { chatCursors: { [workers]: 'msg-x', [governors]: 'msg-x' } });
    let settled = false;
    const pending = (chatWaitTool(h.state).handler(
      { workerId: 'worker-busy', channels: [governors], timeoutMs: 2000 }, h.state
    ) as Promise<{ hasMessage: boolean; messages?: ChatMessage[] }>).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await deregister('worker-peer', 'wrapper_restart');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const left = 'worker-peer left (wrapper_restart)';
    const banner = '🔌 worker-peer deregistered (wrapper_restart); (no tasks held)';
    for (const channel of [workers, governors]) {
      expect(routedTo(left, channel)).toHaveLength(1);
      expect(routedTo(banner, channel)).toHaveLength(1);
    }
    const presence = [...routedTo(left), ...routedTo(banner)];
    expect(presence).toHaveLength(4);
    for (const event of presence) expect(event.routingTargets).toEqual([]);
    expect(h.state.getUnreadSummary('worker-busy')).toBeNull();
    expect(settled).toBe(false);

    const human = (await h.state.sendMessage({ channel: governors, sender: 'human', content: 'status?' })).message;
    const result = await pending;
    expect(result.messages?.map((m) => m.id)).toEqual([human.id]);
  });

  it('a deregistration that released a task still routes to busy seats', async () => {
    await h.state.updateWorker('worker-holder', { chatCursors: { [workers]: 'msg-x' } });
    await deregister('worker-holder', 'terminal_closed');

    const banner = '🔌 worker-holder deregistered (terminal_closed); released 1 task: task-1→WORKING';
    for (const channel of [workers, governors]) {
      const [event] = routedTo(banner, channel);
      expect(event?.routingTargets).toContain('worker-busy');
    }
    const unread = h.state.getUnreadSummary('worker-busy');
    expect(unread?.channels[workers]).toBe(1);
    expect(unread?.channels[governors]).toBe(1);
    // The seat's own "left" line is routine presence: it adds no unread count.
    expect(routedTo('worker-holder left (terminal_closed)').map((e) => e.routingTargets)).toEqual([[]]);
  });

  it('(h1) a hot reload of a task-holding seat holds its task and pages nobody', async () => {
    let settled = false;
    const pending = (chatWaitTool(h.state).handler(
      { workerId: 'worker-busy', channels: [governors], timeoutMs: 2000 }, h.state
    ) as Promise<{ hasMessage: boolean; messages?: ChatMessage[] }>).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await deregister('worker-holder', 'wrapper_restart');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const holdUntil = h.state.getWorker('worker-holder')?.reloadHoldUntil;
    expect(typeof holdUntil).toBe('string');
    expect(h.state.getTask('task-1')?.assignedWorkerId).toBe('worker-holder');

    const banner = `🔌 worker-holder reloading (wrapper_restart); holding 1 task(s) for its relaunch until ${holdUntil}: task-1(WORKING)`;
    for (const channel of [workers, governors]) {
      const posted = routedTo(banner, channel);
      expect(posted).toHaveLength(1);
      for (const event of posted) expect(event.routingTargets).toEqual([]);
    }
    for (const id of ['worker-busy', 'worker-holder', 'worker-peer']) {
      expect(h.state.getUnreadSummary(id)).toBeNull();
    }
    expect(settled).toBe(false);

    const human = (await h.state.sendMessage({ channel: governors, sender: 'human', content: 'status?' })).message;
    const result = await pending;
    expect(result.messages?.map((m) => m.id)).toEqual([human.id]);

    const hidden = await chatReadTool(h.state).handler({ workerId: 'worker-busy', channel: workers }, h.state) as {
      messages: ChatMessage[];
    };
    expect(hidden.messages).toEqual([]);
    const shown = await chatReadTool(h.state).handler({ channel: workers, includeSystem: true }, h.state) as {
      messages: ChatMessage[];
    };
    expect(shown.messages.map((m) => m.id)).toEqual([routedTo(banner, workers)[0].message.id]);
  });

  it.each([
    ['blocked', 'governors', '🚧 worker-peer blocked on task-1: proxy down'],
    ['stale', 'governors', '⚠️ worker-peer stale on task-1 (T) — last activity 1900s ago. Quiet ≠ dead (long builds/tests are silent): ping before acting; never release on idle alone.'],
    ['QA reject', 'workers', '❌ QA rejected task-1: tests fail'],
    ['file collision', 'workers', '⚠️ file collision on task-1: task-2: `a.ts`'],
    ['commit', 'governors', '📦 completion commit recorded for task-1: abc1234 on moe/work — 2 path(s), 0 inferred, 0 skipped, 0 unattributed'],
    ['dropped claims only', 'governors', '🔌 worker-x deregistered (terminal_closed); (no tasks held); dropped 1 resource claim: slot lease (task-1)'],
  ])('keeps routing the %s banner to busy seats', async (_name, channelName, content) => {
    const channel = channelName === 'governors' ? governors : workers;
    expect(await postSystem(channel, content)).toContain('worker-busy');
    expect(h.state.getUnreadSummary('worker-busy')?.channels[channel]).toBe(1);
  });

  it.each([
    ['an agent posting a left line', 'worker-peer', 'worker-x left (bye)'],
    ['a left line whose reason mentions a seat', 'system', 'worker-x left (restart @worker-busy)'],
    ['a left line not anchored at the closing paren', 'system', 'worker-x left (bye) again'],
    ['a banner not anchored at its no-tasks suffix', 'system', '🔌 worker-x deregistered (bye); (no tasks held) again'],
  ])('does not treat %s as feed: agent reads still show it', async (_name, sender, content) => {
    const message = (await h.state.sendMessage({ channel: workers, sender, content })).message;
    const read = await chatReadTool(h.state).handler({ workerId: 'worker-peer', channel: workers }, h.state) as {
      messages: ChatMessage[];
    };
    expect(read.messages.map((m) => m.id)).toEqual([message.id]);
  });
});

// state/workerLifecycle.ts beginReloadHold writes this banner. Its shape is the
// only thing isRoutinePresenceLine may accept: a hold with anything appended, or
// a release or dropped-claims banner, still pages busy seats.
describe('the reload-hold banner shape', () => {
  const until = '2026-11-03T13:40:22.435Z';
  const hold = `🔌 worker-x reloading (wrapper_restart); holding 1 task(s) for its relaunch until ${until}: task-1(WORKING)`;
  const at = String.fromCharCode(64);

  it.each([
    ['one task', hold],
    ['two tasks', `🔌 worker-x reloading (wrapper_restart); holding 2 task(s) for its relaunch until ${until}: task-1(WORKING), task-2(AWAITING_APPROVAL)`],
    ['a 32-hex task id', hold.replace('task-1(WORKING)', 'task-13ff6bb41f1844eca9c75082169a5f08(BLOCKED)')],
  ])('(h2) accepts %s', (_name, content) => {
    expect(isRoutinePresenceLine(content)).toBe(true);
  });

  it.each([
    ['a release banner', '🔌 worker-x deregistered (terminal_closed); released 1 task: task-1→WORKING'],
    ['a dropped-claims banner', '🔌 worker-x deregistered (terminal_closed); (no tasks held); dropped 1 resource claim: slot lease (task-1)'],
    ['appended text', hold + ' again'],
    ['an appended release clause', hold + '; released 1 task: task-2→WORKING'],
    ['an appended line', hold + '\n' + at + 'worker-busy'],
    ['another reason', hold.replace('(wrapper_restart)', '(terminal_closed)')],
    ['a non-ISO deadline', hold.replace(until, 'soon')],
    ['an empty task list', hold.replace(': task-1(WORKING)', ': ')],
    ['a trailing space', hold + ' '],
  ])('(h3) rejects %s', (_name, content) => {
    expect(isRoutinePresenceLine(content)).toBe(false);
  });

  it('(h4) a long hold-like line stays fast', () => {
    const started = Date.now();
    expect(isRoutinePresenceLine(hold.replace(': task-1(WORKING)', ': ' + 'x(Y), '.repeat(3000) + 'x(Y) z'))).toBe(false);
    expect(isRoutinePresenceLine('🔌')).toBe(false);
    expect(isRoutinePresenceLine(' ')).toBe(false);
    expect(isRoutinePresenceLine('a'.repeat(50000))).toBe(false);
    expect(isRoutinePresenceLine(' reloading'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
