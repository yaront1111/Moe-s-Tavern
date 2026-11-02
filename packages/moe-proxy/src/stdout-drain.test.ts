import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { once } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WebSocketServer } from 'ws';

/**
 * A one-shot reply bigger than the ~64 KiB OS pipe buffer must reach a reader
 * that starts late. The reader here is paused at spawn and only resumed once
 * the proxy has closed its daemon socket and 300 ms have passed since the
 * daemon sent the reply, so a proxy that calls process.exit() right after its
 * stdout write loses the tail libuv still has queued.
 *
 * Windows is skipped on purpose: Node makes a Windows stdout pipe blocking, so
 * the write itself waits for the reader and no queued tail can be lost. (A
 * reader that never drains then blocks the proxy inside the write, which is
 * out of scope.)
 */

const REPLY_TEXT_LENGTH = 2 * 1024 * 1024;
const READER_GATE_MS = 300;
const PROXY_ENTRY = path.join(__dirname, '../dist/index.js');

interface Daemon {
  connections: number;
  sentAt: number | null;
  sentBytes: number;
  closedAt: number | null;
}

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

interface Fixture {
  daemon: Daemon;
  proxy: ReturnType<typeof spawnProxy>;
  stdoutChunks: Buffer[];
  stdoutEnded: Promise<void>;
  closed: Promise<void>;
  exited: Promise<void>;
  exit: () => Exit | null;
  stderr: () => string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(cond: () => boolean, ms: number, what: string, f?: Fixture): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms}ms waiting for ${what}; proxy stderr: ${f ? f.stderr().slice(-500) : ''}`);
    }
    await sleep(20);
  }
}

function spawnProxy(testDir: string) {
  return spawn(process.execPath, [PROXY_ENTRY], {
    env: { ...process.env, MOE_PROJECT_PATH: testDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe.skipIf(process.platform === 'win32')('moe-proxy drains stdout before a success exit', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      try {
        await cleanup();
      } catch { /* keep draining the rest */ }
    }
  });

  /** Fake daemon plus a spawned real proxy; the reader is registered at spawn and paused. */
  async function startFixture(replyDelayMs: number): Promise<Fixture> {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-drain-test-'));
    cleanups.push(() => fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5 }));
    fs.mkdirSync(path.join(testDir, '.moe'));

    const server = new WebSocketServer({ port: 0 });
    cleanups.push(() => {
      for (const client of server.clients) client.terminate();
      server.close();
    });
    await once(server, 'listening');
    fs.writeFileSync(
      path.join(testDir, '.moe', 'daemon.json'),
      JSON.stringify({
        port: (server.address() as { port: number }).port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectPath: testDir,
      })
    );

    const daemon: Daemon = { connections: 0, sentAt: null, sentBytes: 0, closedAt: null };
    server.on('connection', (ws) => {
      daemon.connections++;
      ws.on('close', () => { daemon.closedAt = Date.now(); });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id: number };
        setTimeout(() => {
          const reply = JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'x'.repeat(REPLY_TEXT_LENGTH) }] },
          });
          daemon.sentBytes = Buffer.byteLength(reply);
          daemon.sentAt = Date.now();
          ws.send(reply);
        }, replyDelayMs);
      });
    });

    const proxy = spawnProxy(testDir);
    let exitInfo: Exit | null = null;
    let stderrText = '';
    proxy.stderr.setEncoding('utf8');
    proxy.stderr.on('data', (chunk: string) => { stderrText += chunk; });
    // Never attach this later: when the child exits, child_process resumes and
    // discards an unconsumed stdout, so a late reader would hang, not fail.
    const stdoutChunks: Buffer[] = [];
    proxy.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    proxy.stdout.pause();
    const stdoutEnded = once(proxy.stdout, 'end').then(() => undefined, () => undefined);
    const closed = new Promise<void>((resolve) => proxy.once('close', () => resolve()));
    const exited = new Promise<void>((resolve) => {
      proxy.once('exit', (code, signal) => {
        exitInfo = { code, signal, at: Date.now() };
        resolve();
      });
    });
    cleanups.push(async () => {
      if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill('SIGKILL');
      await within(closed, 2000, 'killed proxy to close');
    });
    return { daemon, proxy, stdoutChunks, stdoutEnded, closed, exited, exit: () => exitInfo, stderr: () => stderrText };
  }

  async function connectAndRequest(f: Fixture): Promise<void> {
    await waitUntil(() => f.daemon.connections > 0, 5000, 'proxy to connect to the fake daemon', f);
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'moe.list_tasks', arguments: {} } };
    f.proxy.stdin.write(JSON.stringify(request) + '\n');
  }

  async function waitForReplySent(f: Fixture): Promise<number> {
    await waitUntil(() => f.daemon.sentAt !== null, 5000, 'the fake daemon to send its reply', f);
    return f.daemon.sentAt!;
  }

  /** The reader may start only once the proxy closed its socket and the reply is 300 ms old. */
  async function waitForReaderGate(f: Fixture): Promise<void> {
    await waitUntil(
      () => f.daemon.closedAt !== null && f.daemon.sentAt !== null && Date.now() - f.daemon.sentAt >= READER_GATE_MS,
      10_000,
      'the proxy to close its daemon socket and the reader gate to elapse',
      f
    );
  }

  async function readLateAndAssertComplete(f: Fixture): Promise<void> {
    await waitForReaderGate(f);
    f.proxy.stdout.resume();
    await within(f.stdoutEnded, 10_000, 'proxy stdout to end');
    await within(f.closed, 10_000, 'proxy to close');

    const text = Buffer.concat(f.stdoutChunks).toString('utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    // Numbers first: the reply is 2 MB, so never let a failure diff the text.
    expect(lines.length).toBe(1);
    expect(Buffer.byteLength(lines[0])).toBe(f.daemon.sentBytes);
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(lines[0]) as { id: number; result: { content: Array<{ text: string }> } };
    expect(parsed.id).toBe(1);
    expect(parsed.result.content[0].text.length).toBe(REPLY_TEXT_LENGTH);
    expect(f.exit()?.code).toBe(0);
  }

  it('delivers a 2 MB reply complete on the drainTick exit (request still pending at stdin EOF)', async () => {
    const f = await startFixture(100);
    await connectAndRequest(f);
    f.proxy.stdin.end();
    await waitForReplySent(f);

    await readLateAndAssertComplete(f);
    expect(f.stderr()).toMatch(/Waiting for 1 pending request/);
  }, 30_000);

  it('delivers a 2 MB reply complete on the gracefulShutdown immediate exit (nothing pending at EOF)', async () => {
    const f = await startFixture(0);
    await connectAndRequest(f);
    // The reply is written and its id forgotten once stdout has data; only then close stdin.
    await waitUntil(
      () => f.proxy.stdout.readableLength > 0 || f.stdoutChunks.length > 0,
      5000,
      'the proxy to write its reply',
      f
    );
    f.proxy.stdin.end();

    await readLateAndAssertComplete(f);
    expect(f.stderr()).not.toMatch(/Waiting for \d+ pending request/);
  }, 30_000);

  it('exits 1 about 2 s after the reply when the reader never drains stdout', async () => {
    const f = await startFixture(100);
    await connectAndRequest(f);
    f.proxy.stdin.end();
    const sentAt = await waitForReplySent(f);

    await within(f.exited, 10_000, 'proxy to exit');
    await within(f.closed, 10_000, 'proxy to close');
    const exit = f.exit()!;
    expect(exit.code).toBe(1);
    expect(exit.at - sentAt).toBeGreaterThanOrEqual(1800);
    expect(exit.at - sentAt).toBeLessThan(5000);
    expect(f.stderr()).toMatch(/stdout did not drain within 2000ms/);
  }, 30_000);

  it('exits 1 at once on EPIPE when the reader closes the pipe during the wait', async () => {
    const f = await startFixture(100);
    await connectAndRequest(f);
    f.proxy.stdin.end();
    await waitForReplySent(f);
    await waitForReaderGate(f);

    const destroyedAt = Date.now();
    f.proxy.stdout.destroy();
    await within(f.exited, 10_000, 'proxy to exit');
    await within(f.closed, 10_000, 'proxy to close');
    const exit = f.exit()!;
    expect(exit.code).toBe(1);
    expect(exit.at - destroyedAt).toBeLessThan(1000);
    expect(f.stderr()).toMatch(/stdout write failed: .*EPIPE/);
  }, 30_000);
});
