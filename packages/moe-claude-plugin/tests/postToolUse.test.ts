import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  isMoeToolName,
  normalizeToolName,
  resolveWorkerId,
  runPostToolUseHook,
} from '../src/postToolUse.js';

function makeProjectWithDaemon(port: number): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-hook-'));
  const moeDir = path.join(tmp, '.moe');
  fs.mkdirSync(moeDir, { recursive: true });
  fs.writeFileSync(
    path.join(moeDir, 'daemon.json'),
    JSON.stringify({
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: tmp,
    })
  );
  return tmp;
}

describe('classifier helpers', () => {
  it('detects moe tool names in both mcp__moe__ and moe. forms', () => {
    expect(isMoeToolName('mcp__moe__moe_list_tasks')).toBe(true);
    expect(isMoeToolName('moe.list_tasks')).toBe(true);
    expect(isMoeToolName('Bash')).toBe(false);
    expect(isMoeToolName('mcp__github__create_issue')).toBe(false);
    expect(isMoeToolName(undefined)).toBe(false);
    expect(isMoeToolName(123)).toBe(false);
  });

  it('normalizes mcp__moe__ names to moe.* form', () => {
    expect(normalizeToolName('mcp__moe__moe_start_step')).toBe('moe.start_step');
    expect(normalizeToolName('mcp__moe__chat_send')).toBe('moe.chat_send');
    expect(normalizeToolName('moe.complete_task')).toBe('moe.complete_task');
  });

  it('uses MOE_WORKER_ID when set, else hashes session_id, else null', () => {
    const original = process.env.MOE_WORKER_ID;
    try {
      process.env.MOE_WORKER_ID = 'worker-real';
      expect(resolveWorkerId({})).toBe('worker-real');

      delete process.env.MOE_WORKER_ID;
      const id = resolveWorkerId({ session_id: 'abc123' });
      expect(id).toMatch(/^claude-[a-f0-9]{10}$/);

      expect(resolveWorkerId({})).toBeNull();
    } finally {
      if (original === undefined) delete process.env.MOE_WORKER_ID;
      else process.env.MOE_WORKER_ID = original;
    }
  });
});

describe('runPostToolUseHook', () => {
  let server: Server;
  let wss: WebSocketServer;
  let port: number;
  let received: string[];

  beforeEach(async () => {
    received = [];
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => {
        received.push(data.toString());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('skips non-moe tools without contacting the daemon', async () => {
    const project = makeProjectWithDaemon(port);
    const result = await runPostToolUseHook({
      tool_name: 'Bash',
      session_id: 's1',
      cwd: project,
    });
    expect(result).toEqual({ forwarded: false, reason: 'non-moe-tool' });
    expect(received).toHaveLength(0);
  });

  it('forwards moe.* tool events with the expected envelope', async () => {
    const project = makeProjectWithDaemon(port);
    const prev = process.env.MOE_WORKER_ID;
    process.env.MOE_WORKER_ID = 'worker-test';
    try {
      const result = await runPostToolUseHook({
        tool_name: 'mcp__moe__moe_start_step',
        tool_input: { taskId: 'task-1', stepId: 'step-1' },
        tool_response: { success: true },
        session_id: 's2',
        duration_ms: 42,
        cwd: project,
      });
      expect(result.forwarded).toBe(true);
      // Give the server a moment to receive the frame.
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(1);
      const env = JSON.parse(received[0]) as { type: string; payload: Record<string, unknown> };
      expect(env.type).toBe('AGENT_TOOL_EVENT');
      expect(env.payload.workerId).toBe('worker-test');
      expect(env.payload.tool).toBe('moe.start_step');
      expect(env.payload.durationMs).toBe(42);
      expect(env.payload.args).toEqual({ taskId: 'task-1', stepId: 'step-1' });
    } finally {
      if (prev === undefined) delete process.env.MOE_WORKER_ID;
      else process.env.MOE_WORKER_ID = prev;
    }
  });

  it('does not throw when the daemon is unreachable', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-plugin-noport-'));
    const moeDir = path.join(tmp, '.moe');
    fs.mkdirSync(moeDir, { recursive: true });
    fs.writeFileSync(
      path.join(moeDir, 'daemon.json'),
      JSON.stringify({ port: 1, pid: 1, startedAt: 'x', projectPath: tmp })
    );
    const prev = process.env.MOE_WORKER_ID;
    process.env.MOE_WORKER_ID = 'worker-test';
    try {
      const result = await runPostToolUseHook({
        tool_name: 'mcp__moe__moe_list_tasks',
        session_id: 's3',
        cwd: tmp,
      });
      // The send fails internally, but the hook returns cleanly.
      expect(result.forwarded).toBe(false);
      expect(result.reason).toBe('send-failed');
    } finally {
      if (prev === undefined) delete process.env.MOE_WORKER_ID;
      else process.env.MOE_WORKER_ID = prev;
    }
  });

  it('honors MOE_DISABLE_TOOL_HOOK=1', async () => {
    const project = makeProjectWithDaemon(port);
    const prev = process.env.MOE_DISABLE_TOOL_HOOK;
    process.env.MOE_DISABLE_TOOL_HOOK = '1';
    try {
      const result = await runPostToolUseHook({
        tool_name: 'mcp__moe__moe_list_tasks',
        session_id: 's4',
        cwd: project,
      });
      expect(result).toEqual({ forwarded: false, reason: 'disabled' });
      expect(received).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.MOE_DISABLE_TOOL_HOOK;
      else process.env.MOE_DISABLE_TOOL_HOOK = prev;
    }
  });
});
