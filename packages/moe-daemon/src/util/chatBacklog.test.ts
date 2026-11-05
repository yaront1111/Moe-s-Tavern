import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import type { ChatMessage, Worker } from '../types/schema.js';
import { PER_CHANNEL_SCAN_LIMIT, applyChatDelivery, collectChatBacklog } from './chatBacklog.js';

const SEAT = 'worker-seat';

describe('collectChatBacklog over a run of the caller\'s own posts', () => {
  let testDir: string;
  let state: StateManager;
  let general: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-chatbacklog-test-'));
    const moePath = path.join(testDir, '.moe');
    for (const dir of ['epics', 'tasks', 'workers', 'proposals', 'teams', 'channels', 'messages']) {
      fs.mkdirSync(path.join(moePath, dir), { recursive: true });
    }
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(moePath, 'project.json'), JSON.stringify({
      id: 'proj-test',
      name: 'Chat Backlog Project',
      rootPath: testDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL', agentCommand: 'claude' },
      createdAt: now,
      updatedAt: now,
    }, null, 2));
    const worker: Worker = {
      id: SEAT, type: 'CLAUDE', projectId: 'proj-test', epicId: '', currentTaskId: null, status: 'IDLE',
      branch: 'main', modifiedFiles: [], startedAt: now, lastActivityAt: now, lastError: null, errorCount: 0, teamId: null,
    };
    fs.writeFileSync(path.join(moePath, 'workers', `${SEAT}.json`), JSON.stringify(worker, null, 2));
    state = new StateManager({ projectPath: testDir });
    await state.load();
    general = state.getChannels().find((channel) => channel.name === 'general')!.id;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function post(content: string, sender = 'human'): Promise<ChatMessage> {
    return (await state.sendMessage({ channel: general, sender, content })).message;
  }

  async function ownPosts(count: number): Promise<ChatMessage[]> {
    const posts: ChatMessage[] = [];
    for (let i = 0; i < count; i++) posts.push(await post(`own note ${i}`, SEAT));
    return posts;
  }

  /** chat_wait's entry drain over #general: the ids it delivers, its cursor moves applied. */
  async function drain(): Promise<string[]> {
    const burst = await collectChatBacklog(state, SEAT, new Set([general]));
    await applyChatDelivery(state, SEAT, burst);
    return burst.messages.map((message) => message.id);
  }

  const cursor = (): string | undefined => state.getWorker(SEAT)?.chatCursors?.[general];

  /** A delivered line, so the seat holds a position in #general before its run. */
  async function anchor(): Promise<ChatMessage> {
    const line = await post('before the run');
    expect(await drain()).toEqual([line.id]);
    expect(cursor()).toBe(line.id);
    return line;
  }

  it('reads past more than a page of its own posts to the line behind them', async () => {
    await anchor();
    await ownPosts(PER_CHANNEL_SCAN_LIMIT + 5);
    const behind = await post('behind the run');

    expect(await drain()).toEqual([behind.id]);
    expect(cursor()).toBe(behind.id);
  });

  it('moves the cursor past a full page of its own posts with nothing behind it', async () => {
    await anchor();
    const run = await ownPosts(PER_CHANNEL_SCAN_LIMIT);

    expect(await drain()).toEqual([]);
    expect(cursor()).toBe(run[run.length - 1].id);
  });

  it('holds the cursor before a run of its own posts shorter than a page', async () => {
    const line = await anchor();
    await ownPosts(PER_CHANNEL_SCAN_LIMIT - 1);

    expect(await drain()).toEqual([]);
    expect(cursor()).toBe(line.id);
  });
});
