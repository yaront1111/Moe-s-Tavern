import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from './toolTestHarness.js';
import { joinTeamTool } from './joinTeam.js';
import { chatReadTool } from './chatRead.js';
import { chatSendTool } from './chatSend.js';
import { deregisterWorkerTool } from './deregisterWorker.js';
import type { ChatMessage, Team } from '../types/schema.js';

// A notification-only session answers a routed mention for an IDLE seat that
// holds no task. Its worker record can be gone (pruned stale) or DEAD (a hot
// reload deregistered it, then exec'd the same seat). Only an explicit
// join_team from the seat's fresh pre-flight brings that identity back, so the
// reply goes out under the seat's own id and reading the mention moves its
// cursor. Heartbeats and chat calls from an old session must not revive DEAD.
describe('moe.join_team re-registers an idle seat for its notification session', () => {
  const h = new ToolTestHarness();
  const SEAT = 'worker-seat';
  let general: string;
  let team: Team;

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    await h.state.load();
    general = h.state.getChannels().find((channel) => channel.name === 'general')!.id;
    team = await h.state.createTeam({ name: 'Workers' });
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  const join = (workerId: string, teamId = team.id) =>
    joinTeamTool(h.state).handler({ teamId, workerId }, h.state) as Promise<{ team: Team }>;
  const read = (workerId: string) =>
    chatReadTool(h.state).handler({ channel: general, workerId }, h.state) as Promise<{ messages: ChatMessage[] }>;
  const send = (workerId: string, content: string, replyTo?: string) =>
    chatSendTool(h.state).handler({ channel: general, workerId, content, replyTo }, h.state) as Promise<{ messageId: string }>;

  const lose: Record<'pruned' | 'DEAD', () => Promise<void>> = {
    pruned: () => h.state.deleteWorker(SEAT),
    DEAD: async () => {
      await deregisterWorkerTool(h.state).handler({ workerId: SEAT, reason: 'wrapper_restart' }, h.state);
    },
  };

  describe.each(['pruned', 'DEAD'] as const)('a %s idle seat', (kind) => {
    beforeEach(async () => {
      await join(SEAT);
      // The seat had read #general before, so it holds a cursor.
      await h.state.sendMessage({ channel: general, sender: 'human', content: 'earlier chatter' });
      await read(SEAT);
      await lose[kind]();
    });

    it('replies under its own id and does not see the same mention twice once it rejoins', async () => {
      const mention = (await h.state.sendMessage({
        channel: general, sender: 'human', content: `@${SEAT} please confirm the rollout`,
      })).message;
      expect(mention.mentions).toEqual([SEAT]);

      const result = await join(SEAT);
      expect(result.team.memberIds).toEqual([SEAT]);
      expect(h.state.getWorker(SEAT)?.status).toBe('IDLE');
      expect(h.state.getWorker(SEAT)?.teamId).toBe(team.id);

      const first = await read(SEAT);
      expect(first.messages.map((m) => m.id)).toContain(mention.id);
      expect(h.state.getWorker(SEAT)?.chatCursors?.[general]).toBe(mention.id);

      const reply = await send(SEAT, 'confirmed', mention.id);
      const stored = (await h.state.getMessages(general)).find((m) => m.id === reply.messageId);
      expect(stored?.sender).toBe(SEAT);

      const second = await read(SEAT);
      expect(second.messages.map((m) => m.id)).not.toContain(mention.id);
      expect(second.messages.map((m) => m.id)).toEqual([reply.messageId]);
    });
  });

  it('cannot reply as a pruned seat until it rejoins (the reported symptom)', async () => {
    await join(SEAT);
    await h.state.deleteWorker(SEAT);
    await expect(send(SEAT, 'hello')).rejects.toThrow('Unknown sender');
  });

  it('a heartbeat from an old session never revives a DEAD seat; a fresh join does', async () => {
    await join(SEAT);
    const frozen = '2026-10-26T04:44:45.000Z';
    await h.state.updateWorker(SEAT, { lastActivityAt: frozen });
    await lose.DEAD();

    expect(await h.state.touchWorker(SEAT)).toBeNull();
    await read(SEAT);
    expect(h.state.getWorker(SEAT)?.status).toBe('DEAD');
    expect(h.state.getWorker(SEAT)?.lastActivityAt).toBe(frozen);

    await join(SEAT);
    const revived = h.state.getWorker(SEAT)!;
    expect(revived.status).toBe('IDLE');
    expect(revived.lastActivityAt > frozen).toBe(true);
    // Live again: heartbeats count, and a direct mention routes to it.
    expect(await h.state.touchWorker(SEAT)).not.toBeNull();
    const { routingTargets } = await h.state.sendMessage({ channel: general, sender: 'human', content: `@${SEAT} ping` });
    expect(routingTargets).toEqual([SEAT]);
  });

  it('leaves a busy live seat exactly as it was when it rejoins, with no duplicate membership', async () => {
    h.createWorker({ id: 'worker-busy', type: 'CODEX', status: 'CODING', currentTaskId: 'task-1', teamId: null });
    await h.state.load();
    await join('worker-busy');
    await h.state.updateWorkerCursors('worker-busy', { [general]: 'msg-seen' });
    const before = h.state.getWorker('worker-busy')!;

    await join('worker-busy');
    const after = await join('worker-busy');

    expect(after.team.memberIds).toEqual(['worker-busy']);
    const worker = h.state.getWorker('worker-busy')!;
    expect(worker).toEqual(before);
  });

  it('a refused join (unknown or full team) leaves a DEAD seat DEAD', async () => {
    await join(SEAT);
    await lose.DEAD();
    const full = await h.state.createTeam({ name: 'Tiny', maxSize: 1 });
    await join('worker-other', full.id);

    await expect(join(SEAT, 'team-missing')).rejects.toThrow('team-missing');
    await expect(join(SEAT, full.id)).rejects.toThrow('is full');
    expect(h.state.getWorker(SEAT)?.status).toBe('DEAD');
  });

  it('still refuses an unknown sender and the reserved system sender', async () => {
    await expect(send('worker-never-joined', 'hi')).rejects.toThrow('Unknown sender');
    await expect(send('system', 'hi')).rejects.toThrow('system');
  });
});
