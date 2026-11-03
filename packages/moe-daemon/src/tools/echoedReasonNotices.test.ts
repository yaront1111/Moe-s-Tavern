import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { qaRejectTool } from './qaReject.js';
import { requestReplanTool } from './requestReplan.js';
import { releaseTaskTool } from './releaseTask.js';
import type { ChatMessage } from '../types/schema.js';

// release_task fingerprints the working tree with a git subprocess; these cases
// only care about the chat lines, so the module is mocked (as in releaseTask.test.ts).
vi.mock('../util/diskState.js', () => ({ computeDiskStateSignature: vi.fn() }));

// qa_reject, request_replan and release_task echo text an agent wrote (a reason,
// a title, a handoff summary) into system lines. A tag that text spells must not
// page seats. The at-sign is built at runtime so this source never spells one.
const at = String.fromCharCode(64);
// A known busy seat mid-prose, code-shaped tokens no seat owns, and group tags
// at the start of a line (where they address).
const freeText = (label: string) =>
  `${label}: see ${at}worker-busy, ${at}JvmOverloads and ${at}types/node\n${at}all ${at}workers heads up`;

describe('echoed agent text in system lines addresses no seat', () => {
  const h = new ToolTestHarness();
  let events: Array<{ message: ChatMessage; routingTargets: string[] }>;
  let unsubscribe: () => void;

  const channelId = (name: string) => h.state.getChannels().find((c) => c.name === name)!.id;
  const posted = (name: string, content: string) =>
    events.filter((e) => e.message.channel === channelId(name) && e.message.content === content);
  function expectUnaddressed(name: string, content: string) {
    const lines = posted(name, content);
    expect(lines).toHaveLength(1);
    expect(lines[0].message.mentions).toEqual([]);
    expect(lines[0].routingTargets).toEqual([]);
  }

  async function load(task: Parameters<ToolTestHarness['createTask']>[0], workerA = false) {
    h.createTask(task);
    // The busy seat today's routing pages: without it no case could fail.
    h.createWorker({ id: 'worker-busy', status: 'CODING' });
    if (workerA) h.createWorker({ id: 'worker-a', status: 'CODING', currentTaskId: 'task-1' });
    await h.state.load();
    events = [];
    unsubscribe = h.state.subscribe((event) => {
      if (event.type === 'MESSAGE_CREATED') {
        events.push({ message: event.payload, routingTargets: event.routingTargets ?? [] });
      }
    });
  }

  beforeEach(() => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    unsubscribe = () => {};
  });
  afterEach(() => { unsubscribe(); vi.restoreAllMocks(); h.cleanup(); });

  it('(a) qa_reject: the QA rejected line', async () => {
    await load({ status: 'REVIEW', assignedWorkerId: 'qa-a', contextFetchedBy: ['qa-a'] });
    const reason = freeText('reject');
    await qaRejectTool(h.state).handler({ taskId: 'task-1', reason, workerId: 'qa-a' }, h.state);

    expectUnaddressed('general', `task-1: QA rejected: ${reason}`);
    expect(h.state.getUnreadSummary('worker-busy')?.channels?.[channelId('general')] ?? 0).toBe(0);
  });

  it('(b) request_replan: the Replan requested line', async () => {
    await load({
      status: 'WORKING', assignedWorkerId: 'worker-a',
      implementationPlan: [{ stepId: 'step-1', description: 'One', status: 'IN_PROGRESS', affectedFiles: [] }],
    }, true);
    const reason = freeText('replan');
    await requestReplanTool(h.state).handler(
      { taskId: 'task-1', stepId: 'step-1', reason, workerId: 'worker-a' }, h.state
    );

    expectUnaddressed('general', `task-1: Replan requested (broke at step step-1): ${reason}`);
  });

  it('(c) release_task: the released line, with title, reason and handoff summaries', async () => {
    const title = `Port the ${at}JvmOverloads shim for ${at}worker-busy`;
    await load({ status: 'WORKING', assignedWorkerId: 'worker-a', title }, true);
    const reason = freeText('release');
    const whatIsDone = freeText('done');
    const whatRemains = freeText('remains');
    await releaseTaskTool(h.state).handler(
      { taskId: 'task-1', workerId: 'worker-a', reason, handoffNote: { whatIsDone, whatRemains } }, h.state
    );

    const line = `🔓 worker-a released task: ${title} (${reason})\n  done: ${whatIsDone}\n  remains: ${whatRemains}`;
    expectUnaddressed('general', line);
    expectUnaddressed('workers', line);
    // The #governors copy is the governor's page: it still parses its tags.
    const governors = posted('governors', line);
    expect(governors).toHaveLength(1);
    expect(governors[0].message.mentions).toContain('worker-busy');
  });

  it('(d) release_task: the auto-route line', async () => {
    await load({
      status: 'WORKING', assignedWorkerId: null,
      implementationPlan: [{ stepId: 'step-1', description: 'One', status: 'COMPLETED', affectedFiles: [] }],
    });
    const general = vi.spyOn(h.state, 'postToGeneral');
    await releaseTaskTool(h.state).handler({ taskId: 'task-1', reason: freeText('route') }, h.state);

    const line = '🔧 task task-1 was unassigned but stuck in WORKING; auto-routed to REVIEW';
    expectUnaddressed('general', line);
    expectUnaddressed('workers', line);
    // The line names no one, so the #general copy is feed either way: pin the call.
    expect(general).toHaveBeenCalledWith(line, { parseMentions: false });
  });

  it('(e) postToRoleChannel parses mentions unless told not to', async () => {
    await load({ status: 'WORKING' });
    const plain = `${at}worker-busy plain role post`;
    const echoed = `${at}worker-busy echoed role post`;
    await h.state.postToRoleChannel('workers', plain);
    await h.state.postToRoleChannel('workers', echoed, { parseMentions: false });

    const [addressed] = posted('workers', plain);
    expect(addressed.message.mentions).toEqual(['worker-busy']);
    expect(addressed.routingTargets).toEqual(['worker-busy']);
    expectUnaddressed('workers', echoed);
  });
});
