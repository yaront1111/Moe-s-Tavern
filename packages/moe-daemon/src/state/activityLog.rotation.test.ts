// get_activity_log across LogRotator generations (task-05a77c0d).
// The (rN) cases fail on the pre-fix activityLog.ts, which reads only the live
// activity.log; (c0) is a live-file-only control that passes before and after.
import fs from 'fs';
import zlib from 'zlib';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { getActivityLogTool } from '../tools/getActivityLog.js';
import { LogRotator } from '../util/LogRotator.js';
import { logger } from '../util/logger.js';

type Result = {
  events: Array<{ id: string; taskId?: string }>;
  hasMore: boolean;
  search: { complete: boolean; scannedLines: number };
};

describe('moe.get_activity_log across rotated generations', () => {
  const h = new ToolTestHarness();
  let logPath = '';
  const query = (args: Record<string, unknown>) => getActivityLogTool(h.state).handler(args, h.state) as Promise<Result>;
  const line = (id: string, taskId: string) => JSON.stringify({
    id, timestamp: '2026-11-03T00:00:00.000Z', projectId: 'proj-test', taskId, event: 'TASK_UPDATED', payload: {},
  });
  const lines = (prefix: string, taskId: string, n: number) => Array.from({ length: n }, (_, i) => line(`${prefix}-${i}`, taskId));
  const writeGen = (n: number, body: string[]) => fs.writeFileSync(`${logPath}.${n}.gz`, zlib.gzipSync(`${body.join('\n')}\n`));
  const writeLive = (body: string[]) => fs.writeFileSync(logPath, body.length ? `${body.join('\n')}\n` : '');

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder();
    h.createEpic();
    await h.state.load();
    logPath = `${h.moePath}/activity.log`;
  });
  afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });

  it('(c0) control: a live-only log answers as before', async () => {
    writeLive([line('evt-a', 'task-a'), line('evt-b', 'task-b')]);
    const r = await query({ taskId: 'task-a' });
    expect(r.events.map((e) => e.id)).toEqual(['evt-a']);
    expect(r.search.complete).toBe(true);
  });

  it('(r1) a filtered query finds an event LogRotator moved into activity.log.1.gz', async () => {
    writeLive([line('evt-a', 'task-a')]);
    expect(await new LogRotator(logPath, { maxSizeMB: 0.0001 }).rotateIfNeeded()).toBe(true);
    fs.appendFileSync(logPath, `${line('evt-b', 'task-b')}\n`);
    const r = await query({ taskId: 'task-a' });
    expect(r.events.map((e) => e.id)).toEqual(['evt-a']);
    expect(r.search.complete).toBe(true);
  });

  it('(r2) unfiltered paging crosses the rotation boundary', async () => {
    writeLive([line('evt-a', 'task-a')]);
    expect(await new LogRotator(logPath, { maxSizeMB: 0.0001 }).rotateIfNeeded()).toBe(true);
    fs.appendFileSync(logPath, `${line('evt-b', 'task-b')}\n`);
    const first = await query({ limit: 1 });
    expect(first.events.map((e) => e.id)).toEqual(['evt-b']);
    expect(first.hasMore).toBe(true);
    const second = await query({ offset: 1, limit: 1 });
    expect(second.events.map((e) => e.id)).toEqual(['evt-a']);
  });

  it('(r3) newest-first across files, and complete:true once every generation was read', async () => {
    writeLive([line('live-0', 'task-x')]);
    writeGen(1, lines('g1', 'task-x', 3));
    writeGen(2, [line('target', 'task-a'), ...lines('g2', 'task-x', 2)]);
    const all = await query({ limit: 100 });
    expect(all.events.map((e) => e.id)).toEqual(['live-0', 'g1-2', 'g1-1', 'g1-0', 'g2-1', 'g2-0', 'target']);
    const r = await query({ taskId: 'task-a' });
    expect(r.events.map((e) => e.id)).toEqual(['target']);
    expect(r.search).toMatchObject({ complete: true, scannedLines: 7 });
  });

  it('(r4) the 5000-line scan stops inside a generation: complete:false and the older target stays unread', async () => {
    writeLive([line('live-0', 'task-x')]);
    writeGen(1, lines('g1', 'task-x', 5000));
    writeGen(2, [line('target', 'task-a')]);
    const r = await query({ taskId: 'task-a' });
    expect(r.events).toEqual([]);
    expect(r.search).toMatchObject({ complete: false, scannedLines: 5000 });
  });

  it('(r5) the scan fills exactly at a generation end while an older one exists: complete:false', async () => {
    writeLive([]);
    writeGen(1, lines('g1', 'task-x', 5000));
    writeGen(2, [line('target', 'task-a')]);
    const r = await query({ taskId: 'task-a' });
    expect(r.events).toEqual([]);
    expect(r.search).toMatchObject({ complete: false, scannedLines: 5000 });
  });

  it('(r7) the scan fills exactly at the last generation end: complete:true', async () => {
    writeLive([]);
    writeGen(1, [line('target', 'task-a'), ...lines('g1', 'task-x', 4999)]);
    const r = await query({ taskId: 'task-a' });
    expect(r.events.map((e) => e.id)).toEqual(['target']);
    expect(r.search).toMatchObject({ complete: true, scannedLines: 5000 });
  });

  it('(r6) a corrupt generation is skipped with a warning and complete:false, never a throw', async () => {
    const warn = vi.spyOn(logger, 'warn');
    writeLive([line('live-0', 'task-x')]);
    fs.writeFileSync(`${logPath}.1.gz`, 'not gzip at all');
    writeGen(2, [line('target', 'task-a')]);
    const r = await query({ taskId: 'task-a' });
    expect(r.events.map((e) => e.id)).toEqual(['target']);
    expect(r.search.complete).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
