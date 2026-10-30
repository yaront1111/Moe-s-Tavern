import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import WebSocket, { WebSocketServer } from 'ws';

describe('moe-proxy graceful shutdown', () => {
  let testDir: string;
  let mockServer: WebSocketServer | null = null;
  let mockPort: number;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-shutdown-test-'));
    const moePath = path.join(testDir, '.moe');
    fs.mkdirSync(moePath);

    // Start mock WebSocket server on random port
    mockServer = new WebSocketServer({ port: 0 });
    mockPort = (mockServer.address() as { port: number }).port;

    // Write daemon.json pointing to our mock server
    fs.writeFileSync(
      path.join(moePath, 'daemon.json'),
      JSON.stringify({
        port: mockPort,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectPath: testDir,
      })
    );
  });

  afterEach(async () => {
    if (mockServer) {
      mockServer.close();
      mockServer = null;
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns clear JSON-RPC error for daemon.json project mismatch', async () => {
    fs.writeFileSync(
      path.join(testDir, '.moe', 'daemon.json'),
      JSON.stringify({
        port: mockPort,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        projectPath: path.join(os.tmpdir(), 'other-moe-project'),
      })
    );

    const responses: string[] = [];
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proxy.stdout!.on('data', (chunk) => {
      responses.push(...chunk.toString().trim().split('\n').filter((line: string) => line.startsWith('{')));
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });

    expect(exitCode).toBe(1);
    expect(responses.length).toBeGreaterThan(0);
    const parsed = JSON.parse(responses[0]);
    expect(parsed.error.message).toBe('daemon.json belongs to a different project');
  }, 10000);

  it('returns clear JSON-RPC error for a daemon.json larger than 64 KiB', async () => {
    const body = JSON.stringify({
      port: mockPort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: testDir,
    });
    fs.writeFileSync(
      path.join(testDir, '.moe', 'daemon.json'),
      body + ' '.repeat(65537 - Buffer.byteLength(body))
    );

    const responses: string[] = [];
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proxy.stdout!.on('data', (chunk) => {
      responses.push(...chunk.toString().trim().split('\n').filter((line: string) => line.startsWith('{')));
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });

    expect(exitCode).toBe(1);
    expect(responses.length).toBeGreaterThan(0);
    const parsed = JSON.parse(responses[0]);
    expect(parsed.error.message).toBe('daemon.json is larger than 64 KiB');
  }, 10000);

  it('waits for pending response before exiting on stdin close', async () => {
    const responses: string[] = [];
    let clientConnected = false;

    // Set up mock server to echo back with delay
    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // Respond after 100ms delay (simulates daemon processing)
        setTimeout(() => {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: '{"ok":true}' }] }
          }));
        }, 100);
      });
    });

    // Spawn proxy process
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Collect stdout responses
    proxy.stdout!.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      responses.push(...lines.filter((l: string) => l.startsWith('{')));
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    // Send a request
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    });
    proxy.stdin!.write(request + '\n');

    // Immediately close stdin (before response arrives)
    proxy.stdin!.end();

    // Wait for proxy to exit
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy did not exit')), 5000);
      proxy.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Verify we received the response before exit
    expect(responses.length).toBe(1);
    expect(JSON.parse(responses[0]).result).toBeDefined();
  }, 10000);

  it('returns error response when server never responds and message times out', async () => {
    const responses: string[] = [];
    let clientConnected = false;

    // Server accepts connection but never responds to messages
    mockServer!.on('connection', () => {
      clientConnected = true;
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: {
        ...process.env,
        MOE_PROJECT_PATH: testDir,
        MOE_MESSAGE_TIMEOUT_MS: '500',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proxy.stdout!.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      responses.push(...lines.filter((l: string) => l.startsWith('{')));
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    // Send a request - server will never respond
    proxy.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'test' }
    }) + '\n');

    // Wait for timeout error response (timeout checker runs every 5s)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hasError = responses.some(r => {
          try {
            const p = JSON.parse(r);
            return p.id === 42 && p.error;
          } catch { return false; }
        });
        if (hasError) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });

    // Close stdin to trigger shutdown
    proxy.stdin!.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', () => { clearTimeout(timeout); resolve(); });
    });

    // Verify error response was received with timeout message
    const errorResponse = responses
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .find(r => r && r.id === 42 && r.error);
    expect(errorResponse).toBeDefined();
    expect(errorResponse!.error.message).toContain('timed out');
  }, 15000);

  it('does not crash when connection drops during message exchange', async () => {
    let clientConnected = false;

    // Server accepts connection then terminates on first message
    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('message', () => {
        ws.terminate();
      });
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    // Send multiple requests rapidly - server will terminate on first
    for (let i = 1; i <= 3; i++) {
      proxy.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { name: 'test' }
      }) + '\n');
    }

    // Close stdin to trigger graceful shutdown (max 2s wait)
    setTimeout(() => proxy.stdin!.end(), 500);

    // Wait for proxy to exit
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 10000);
      proxy.on('exit', (code) => { clearTimeout(timeout); resolve(code); });
    });

    // Proxy should exit cleanly (0 from graceful shutdown), NOT crash with unhandled exception
    expect(exitCode).not.toBeNull();
    expect([0, 1]).toContain(exitCode);
  }, 15000);

  it('sends clean close frame to daemon on graceful shutdown', async () => {
    let clientConnected = false;
    let serverReceivedClose = false;

    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('close', () => {
        serverReceivedClose = true;
      });
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    // Close stdin to trigger graceful shutdown
    proxy.stdin!.end();

    // Wait for proxy to exit
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Give the server a moment to process the close frame
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify daemon received a clean close event
    expect(serverReceivedClose).toBe(true);
  }, 10000);

  it('returns id-aware error for an oversized stdin line', async () => {
    const responses: string[] = [];
    let clientConnected = false;

    // Server accepts the connection; the oversized line is rejected by the proxy
    // before it ever reaches the daemon, so the server should see no message.
    mockServer!.on('connection', () => {
      clientConnected = true;
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proxy.stdout!.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      responses.push(...lines.filter((l: string) => l.startsWith('{')));
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) { clearInterval(check); resolve(); }
      }, 50);
    });

    // Build a >1MB single line carrying a recoverable id. The padding lives in a
    // string field so the line stays valid-ish JSON shape for id extraction.
    const padding = 'x'.repeat(1024 * 1024 + 1000);
    const oversized = `{"jsonrpc":"2.0","id":777,"method":"tools/call","params":{"name":"big","blob":"${padding}"}}`;
    proxy.stdin!.write(oversized + '\n');

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hit = responses.some(r => {
          try { const p = JSON.parse(r); return p.id === 777 && p.error; } catch { return false; }
        });
        if (hit) { clearInterval(check); resolve(); }
      }, 100);
    });

    proxy.stdin!.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', () => { clearTimeout(timeout); resolve(); });
    });

    const errorResponse = responses
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .find(r => r && r.id === 777 && r.error);
    expect(errorResponse).toBeDefined();
    expect(errorResponse!.error.message).toContain('too large');
  }, 15000);

  it('drops a late daemon response that arrives after the per-message timeout', async () => {
    const responses: string[] = [];
    let clientConnected = false;

    // Server responds only AFTER the per-message timeout has already fired.
    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        // Reply only AFTER the timeout checker (5s cadence) has already errored
        // out the request. The proxy must drop this late reply, not forward it.
        setTimeout(() => {
          try {
            ws.send(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: '{"late":true}' }] }
            }));
          } catch { /* socket may be gone */ }
        }, 6500);
      });
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: {
        ...process.env,
        MOE_PROJECT_PATH: testDir,
        // 500ms request timeout; the checker runs every 5s, so the request is
        // errored at ~5s. The server's late reply (6.5s) lands afterward.
        MOE_MESSAGE_TIMEOUT_MS: '500',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proxy.stdout!.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      responses.push(...lines.filter((l: string) => l.startsWith('{')));
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) { clearInterval(check); resolve(); }
      }, 50);
    });

    proxy.stdin!.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'slow' }
    }) + '\n');

    // Wait for the timeout error to be emitted by the checker.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const hit = responses.some(r => {
          try { const p = JSON.parse(r); return p.id === 99 && p.error; } catch { return false; }
        });
        if (hit) { clearInterval(check); resolve(); }
      }, 100);
    });

    // Give the late server reply (~6.5s after send) plus any erroneous forward
    // time to surface before we assert it was dropped.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    proxy.stdin!.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', () => { clearTimeout(timeout); resolve(); });
    });

    const forId99 = responses
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(r => r && r.id === 99);
    // Exactly one response for id 99: the timeout error. The late result must
    // have been dropped, not forwarded as a duplicate.
    expect(forId99.length).toBe(1);
    expect(forId99[0].error).toBeDefined();
    expect(forId99[0].error.message).toContain('timed out');
    expect(forId99.some(r => r.result)).toBe(false);
  }, 25000);

  it('buffer overflow discards only the partial, preserving an already-complete line', async () => {
    const responses: string[] = [];
    let clientConnected = false;

    // Echo back any complete request the proxy forwards.
    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: '{"ok":true}' }] }
        }));
      });
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proxy.stdout!.on('data', (chunk) => {
      const lines = chunk.toString().trim().split('\n');
      responses.push(...lines.filter((l: string) => l.startsWith('{')));
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) { clearInterval(check); resolve(); }
      }, 50);
    });

    // One complete request line, then a >2MB newline-free partial in the SAME
    // chunk. The complete line must be drained/answered first; the partial then
    // overflows the buffer and is discarded on its own.
    const completeLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'first' }
    });
    const overflowPartial = '{"jsonrpc":"2.0","id":22,"blob":"' + 'y'.repeat(2 * 1024 * 1024 + 1000);
    proxy.stdin!.write(completeLine + '\n' + overflowPartial);

    // Wait for the echoed result for id 11 AND the overflow error.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const parsed = responses
          .map(r => { try { return JSON.parse(r); } catch { return null; } })
          .filter(Boolean) as Array<{ id?: unknown; result?: unknown; error?: { message?: string } }>;
        const gotResult = parsed.some(r => r.id === 11 && r.result);
        const gotOverflow = parsed.some(r => r.error && /overflow/i.test(r.error.message ?? ''));
        if (gotResult && gotOverflow) { clearInterval(check); resolve(); }
      }, 100);
    });

    proxy.stdin!.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 5000);
      proxy.on('exit', () => { clearTimeout(timeout); resolve(); });
    });

    const parsed = responses
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean) as Array<{ id?: unknown; result?: unknown; error?: { message?: string } }>;
    // The already-complete request was answered...
    expect(parsed.some(r => r.id === 11 && r.result)).toBe(true);
    // ...and the partial triggered an overflow error rather than destroying it.
    expect(parsed.some(r => r.error && /overflow/i.test(r.error.message ?? ''))).toBe(true);
  }, 15000);

  it('exits immediately when no pending requests', async () => {
    let clientConnected = false;

    mockServer!.on('connection', () => {
      clientConnected = true;
    });

    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (clientConnected) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const startTime = Date.now();

    // Close stdin without sending any requests
    proxy.stdin!.end();

    // Wait for proxy to exit
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Proxy did not exit')), 5000);
      proxy.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Should exit quickly (under 500ms) since no pending requests
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(500);
  }, 10000);
  it('exposes moe_<name> aliases under MOE_TOOL_NAME_STYLE=underscore and maps calls back', async () => {
    const seenByDaemon: string[] = [];
    let clientConnected = false;
    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'tools/list') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
            { name: 'moe.get_context', description: 'd', inputSchema: { type: 'object' } },
            { name: 'moe.wait_for_task', description: 'd', inputSchema: { type: 'object' } },
          ] } }));
        } else if (msg.method === 'tools/call') {
          seenByDaemon.push(msg.params.name);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: msg.params.name }] } }));
        }
      });
    });

    const responses: string[] = [];
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir, MOE_TOOL_NAME_STYLE: 'underscore', MOE_WORKER_ID: 'worker-t' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proxy.stdout!.on('data', (chunk) => {
      responses.push(...chunk.toString().trim().split('\n').filter((l: string) => l.startsWith('{')));
    });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => { if (clientConnected) { clearInterval(check); resolve(); } }, 50);
    });

    const waitFor = (n: number) => new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const check = setInterval(() => {
        if (responses.length >= n) { clearInterval(check); resolve(); }
        else if (Date.now() - t0 > 5000) { clearInterval(check); reject(new Error(`only ${responses.length} responses`)); }
      }, 25);
    });

    proxy.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
    await waitFor(1);
    const list = JSON.parse(responses[0]);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['moe_get_context', 'moe_wait_for_task']);

    // A recorded alias, a guessed alias and the daemon's own spelling all reach the daemon as moe.<name>.
    proxy.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'moe_get_context', arguments: {} } }) + '\n');
    proxy.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'moe_submit_plan', arguments: {} } }) + '\n');
    proxy.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'moe.list_tasks', arguments: {} } }) + '\n');
    await waitFor(4);
    expect(seenByDaemon).toEqual(['moe.get_context', 'moe.submit_plan', 'moe.list_tasks']);

    proxy.stdin!.end();
    await new Promise<void>((resolve) => { const t = setTimeout(() => { proxy.kill(); resolve(); }, 5000); proxy.on('exit', () => { clearTimeout(t); resolve(); }); });
  }, 20000);

  it('stamps the runner identity from the env onto claim_next_task, and onto nothing else', async () => {
    const seenByDaemon: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let clientConnected = false;
    mockServer!.on('connection', (ws) => {
      clientConnected = true;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method !== 'tools/call') return;
        seenByDaemon.push(msg.params);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
      });
    });

    const responses: string[] = [];
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir, MOE_WORKER_ID: 'architect-t',
        MOE_RUNNER_PROCESS_STARTED_AT: '4242@1337', MOE_RUNNER_HOST: 'build-box' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proxy.stdout!.on('data', (chunk) => {
      responses.push(...chunk.toString().trim().split('\n').filter((l: string) => l.startsWith('{')));
    });
    await new Promise<void>((resolve) => {
      const check = setInterval(() => { if (clientConnected) { clearInterval(check); resolve(); } }, 50);
    });

    const call = (id: number, name: string, args: Record<string, unknown>) =>
      proxy.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    // The in-session claim gets the pair; the wrapper's own pre-flight claim
    // already names it and is left alone; no other tool is touched.
    call(1, 'moe.claim_next_task', { statuses: ['PLANNING'] });
    call(2, 'moe.get_context', {});
    call(3, 'moe.claim_next_task', { statuses: ['PLANNING'], processStartedAt: '9@9', host: 'wrapper-host' });
    const t0 = Date.now();
    while (responses.length < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
    expect(seenByDaemon).toEqual([
      { name: 'moe.claim_next_task', arguments: { statuses: ['PLANNING'], workerId: 'architect-t', processStartedAt: '4242@1337', host: 'build-box' } },
      { name: 'moe.get_context', arguments: { workerId: 'architect-t' } },
      { name: 'moe.claim_next_task', arguments: { statuses: ['PLANNING'], workerId: 'architect-t', processStartedAt: '9@9', host: 'wrapper-host' } },
    ]);

    proxy.stdin!.end();
    await new Promise<void>((resolve) => { const t = setTimeout(() => { proxy.kill(); resolve(); }, 5000); proxy.on('exit', () => { clearTimeout(t); resolve(); }); });
  }, 20000);

  // CQ-F09: spawn a proxy recording the raw frames the daemon receives and every stdout line.
  async function spawnIdentityProxy(env: Record<string, string>, reply: (msg: { id?: unknown }) => string) {
    const frames: string[] = [];
    const lines: string[] = [];
    let connected = false;
    mockServer!.on('connection', (ws) => {
      connected = true;
      ws.on('message', (data) => { frames.push(data.toString()); ws.send(reply(JSON.parse(data.toString()))); });
    });
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let partial = '';
    proxy.stdout!.on('data', (chunk) => {
      const parts = (partial + chunk.toString()).split('\n');
      partial = parts.pop()!;
      lines.push(...parts.filter(Boolean));
    });
    const exited = new Promise<void>((resolve) => proxy.on('exit', () => resolve()));
    await new Promise<void>((resolve) => { const c = setInterval(() => { if (connected) { clearInterval(c); resolve(); } }, 25); });
    const waitFor = async (n: number) => { const t0 = Date.now(); while (lines.length < n && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25)); };
    const close = async () => { proxy.stdin!.end(); const t = setTimeout(() => proxy.kill(), 5000); await exited; clearTimeout(t); };
    return { proxy, frames, lines, waitFor, close };
  }
  const IDENTITY_ENV = { MOE_WORKER_ID: 'worker-t', MOE_SESSION_ID: 'worker-t@2026-10-26T00:00:00Z',
    MOE_ATTEMPT_ID: 'attempt-0123', MOE_ATTEMPT_GENERATION: '3', MOE_TOOL_NAME_STYLE: 'underscore' };
  const ok = (msg: { id?: unknown }) => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  const rpc = (id: number, name: string, args: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  it('carries the session execution identity to start_step and get_context under the underscore alias style', async () => {
    const servedContext = { attemptId: 'attempt-0123', generation: 3, receiptId: 'ctxreceipt-1', packetId: 'sha256:ab' };
    const served = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ servedContext }) }] } });
    const p = await spawnIdentityProxy(IDENTITY_ENV, (msg) => (msg.id === 2 ? served : ok(msg)));
    p.proxy.stdin!.write([rpc(1, 'moe_start_step', { taskId: 'task-1', stepId: 'step-1' }),
      rpc(2, 'moe_get_context', { taskId: 'task-1' }), rpc(3, 'moe.claim_next_task', { statuses: ['WORKING'] })].join('\n') + '\n');
    await p.waitFor(3);
    const sessionId = IDENTITY_ENV.MOE_SESSION_ID;
    expect(p.frames.map((f) => JSON.parse(f).params)).toEqual([
      { name: 'moe.start_step', arguments: { taskId: 'task-1', stepId: 'step-1', workerId: 'worker-t', attemptId: 'attempt-0123', generation: 3, sessionId } },
      { name: 'moe.get_context', arguments: { taskId: 'task-1', workerId: 'worker-t', sessionId } },
      { name: 'moe.claim_next_task', arguments: { statuses: ['WORKING'], workerId: 'worker-t' } },
    ]);
    expect(p.lines).toContain(served);
    await p.close();
  }, 20000);

  it('refuses caller substitution without forwarding, keeping stdin framing', async () => {
    const p = await spawnIdentityProxy(IDENTITY_ENV, ok);
    const step = { taskId: 'task-1', stepId: 'step-1' };
    p.proxy.stdin!.write([
      rpc(10, 'moe.start_step', { ...step, attemptId: 'attempt-other' }),
      JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }),
      `[${rpc(12, 'moe.start_step', { ...step, generation: '3' })}]`,
      rpc(13, 'moe.start_step', { ...step, attemptId: 'attempt-0123', generation: 3, sessionId: IDENTITY_ENV.MOE_SESSION_ID }),
    ].join('\n') + '\n');
    await p.waitFor(4);
    await p.close();
    const data = { tool: 'moe.start_step', codeName: 'EXECUTION_IDENTITY_SUBSTITUTED' };
    const out = p.lines.map((l) => JSON.parse(l));
    expect(out).toHaveLength(4);
    expect(out.filter((r) => r.id === 10)).toEqual([
      { jsonrpc: '2.0', id: 10, error: { code: -32003, message: expect.stringContaining('attemptId'), data } }]);
    expect(out.find(Array.isArray)).toEqual([
      { jsonrpc: '2.0', id: 12, error: { code: -32003, message: expect.stringMatching(/^batch refused: .*generation/), data } }]);
    expect(out.filter((r) => r.id === 11 || r.id === 13).map((r) => r.result?.content?.[0]?.text)).toEqual(['ok', 'ok']);
    expect(p.frames.map((f) => JSON.parse(f).id)).toEqual([11, 13]);
  }, 20000);

  it('is the legacy proxy when the session carries no identity', async () => {
    const p = await spawnIdentityProxy({ MOE_WORKER_ID: '', MOE_SESSION_ID: '', MOE_ATTEMPT_ID: '', MOE_ATTEMPT_GENERATION: '' }, ok);
    const line = '{"jsonrpc":"2.0",  "id":20,"method":"tools/call","params":{ "name":"moe.start_step","arguments":{"taskId":"task-1", "attemptId":"x"}}}';
    p.proxy.stdin!.write(line + '\n');
    await p.waitFor(1);
    expect(p.frames).toEqual([line]);
    expect(p.lines).toEqual([ok({ id: 20 })]);
    await p.close();
  }, 20000);

  // WT-10P: the wrappers' one-shot RPC writes one bare tools/call (no MCP
  // `initialize`) and closes stdin. Every timing below is measured from that EOF.
  type Line = { at: number; msg: { id?: unknown; result?: unknown; error?: { message?: string } } };
  const replyTimers: NodeJS.Timeout[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    replyTimers.splice(0).forEach(clearTimeout);
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const later = (fn: () => void, ms: number) => { replyTimers.push(setTimeout(fn, ms)); };
  const blockingCall = (id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'moe.wait_for_resource', arguments: { resourceId: 'gradle', taskId: 'task-1' } } });

  // A mock daemon answering every request after delayMs (null: never), recording arrivals.
  function mockDaemon(delayMs: number | null, onRequest?: (ws: WebSocket, msg: { id?: unknown; method?: string }) => void) {
    const state = { connections: 0, arrivals: [] as number[] };
    mockServer!.on('connection', (ws) => {
      state.connections++;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        state.arrivals.push(Date.now());
        onRequest?.(ws, msg);
        if (delayMs === null) return;
        later(() => { try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } })); } catch { /* gone */ } }, delayMs);
      });
    });
    return state;
  }

  function spawnOneShot(env: Record<string, string> = {}) {
    const lines: Line[] = [];
    const proxy = spawn('node', [path.join(__dirname, '../dist/index.js')], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(proxy);
    let partial = '';
    proxy.stdout!.on('data', (chunk) => {
      const parts = (partial + chunk.toString()).split('\n');
      partial = parts.pop()!;
      for (const part of parts.filter(Boolean)) lines.push({ at: Date.now(), msg: JSON.parse(part) });
    });
    const closed = new Promise<{ code: number | null; at: number }>((resolve) => {
      proxy.on('close', (code) => resolve({ code, at: Date.now() }));
    });
    // A proxy that outlives `ms` is SIGKILLed, so its exit code (null) fails the test.
    const exit = async (ms: number) => { const t = setTimeout(() => proxy.kill('SIGKILL'), ms); const r = await closed; clearTimeout(t); return r; };
    const send = (line: string) => { proxy.stdin!.write(line + '\n'); proxy.stdin!.end(); return Date.now(); };
    return { proxy, lines, exit, send };
  }
  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('condition not met');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it.each(['after', 'before'])('a one-shot blocking call written %s connect returns a daemon reply arriving >2s after stdin EOF', async (when) => {
    const daemon = mockDaemon(3000);
    const p = spawnOneShot();
    if (when === 'after') await until(() => daemon.connections > 0);
    const eofAt = p.send(blockingCall());
    const { code } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }]);
    expect(p.lines[0].at - eofAt).toBeGreaterThanOrEqual(2500);
    expect(code).toBe(0);
  }, 15000);

  it('a one-shot blocking call with no daemon reply errors at its recorded deadline', async () => {
    const daemon = mockDaemon(null);
    const p = spawnOneShot({ MOE_BLOCKING_TIMEOUT_MS: '3000' });
    await until(() => daemon.connections > 0);
    const eofAt = p.send(blockingCall());
    const { code } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Request timed out after 3000ms' } }]);
    expect(p.lines[0].at - eofAt).toBeGreaterThanOrEqual(2500);
    expect(p.lines[0].at - eofAt).toBeLessThan(6000);
    expect(code).toBe(0);
  }, 15000);

  it('a one-shot blocking call fails at once when the daemon drops the socket during the drain', async () => {
    const daemon = mockDaemon(null, (ws) => later(() => ws.terminate(), 1000));
    const p = spawnOneShot();
    await until(() => daemon.connections > 0);
    p.send(blockingCall());
    const { code } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Connection to daemon lost before response received' } }]);
    expect(p.lines[0].at - (daemon.arrivals[0] + 1000)).toBeLessThan(1500);
    expect(code).toBe(0);
  }, 15000);

  it('a one-shot blocking call that never leaves the queue errors at the 2s grace', async () => {
    const probe = new WebSocketServer({ port: 0 });
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(resolve));
    const daemonJson = path.join(testDir, '.moe', 'daemon.json');
    fs.writeFileSync(daemonJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(daemonJson, 'utf-8')), port: deadPort }));
    const p = spawnOneShot();
    const eofAt = p.send(blockingCall());
    const { code } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Proxy shutting down with message still queued' } }]);
    expect(p.lines[0].at - eofAt).toBeLessThan(6000);
    expect(code).toBe(0);
  }, 15000);

  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)('%s caps a pending EOF drain at 2s with one response', async (signal) => {
    const daemon = mockDaemon(10000);
    const p = spawnOneShot();
    await until(() => daemon.connections > 0);
    p.send(blockingCall());
    await new Promise((r) => setTimeout(r, 500));
    p.proxy.kill(signal);
    const signalAt = Date.now();
    const { code, at } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Proxy shutting down before response received' } }]);
    expect(at - signalAt).toBeLessThan(3000);
    expect(code).toBe(0);
  }, 15000);

  it('an initialized session keeps the 2s EOF grace for a blocking call', async () => {
    mockDaemon(null, (ws, msg) => {
      if (msg.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }));
      else later(() => { try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })); } catch { /* gone */ } }, 3000);
    });
    const p = spawnOneShot();
    p.proxy.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) + '\n');
    await until(() => p.lines.length > 0);
    const eofAt = p.send(blockingCall());
    const { code } = await p.exit(10000);
    expect(p.lines.slice(1).map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Proxy shutting down before response received' } }]);
    expect(p.lines[1].at - eofAt).toBeGreaterThanOrEqual(1800);
    expect(p.lines[1].at - eofAt).toBeLessThan(4000);
    expect(code).toBe(0);
  }, 15000);

  it('a one-shot ordinary request keeps the 2s EOF grace', async () => {
    const daemon = mockDaemon(null);
    const p = spawnOneShot();
    await until(() => daemon.connections > 0);
    const eofAt = p.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    const { code } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Proxy shutting down before response received' } }]);
    expect(p.lines[0].at - eofAt).toBeGreaterThanOrEqual(1800);
    expect(p.lines[0].at - eofAt).toBeLessThan(4000);
    expect(code).toBe(0);
  }, 15000);

  // WT-10P step 2: MOE_PROXY_ONESHOT_DEADLINE_MS, one absolute bound over the whole process.
  const deadlineError = (id: unknown) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Proxy deadline exceeded (MOE_PROXY_ONESHOT_DEADLINE_MS)' } });

  it('the one-shot deadline bounds a proxy that never connects', async () => {
    fs.rmSync(path.join(testDir, '.moe', 'daemon.json'));
    const spawnAt = Date.now();
    const p = spawnOneShot({ MOE_PROXY_ONESHOT_DEADLINE_MS: String(spawnAt + 1500) });
    p.send(blockingCall());
    const { code, at } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([deadlineError(null)]);
    expect(at - spawnAt).toBeGreaterThanOrEqual(1200);
    expect(at - spawnAt).toBeLessThan(4000);
    expect(code).toBe(1);
  }, 15000);

  it('the one-shot deadline cuts an EOF drain short with one error and no late success', async () => {
    mockDaemon(4000);
    const spawnAt = Date.now();
    const p = spawnOneShot({ MOE_PROXY_ONESHOT_DEADLINE_MS: String(spawnAt + 2500) });
    p.send(blockingCall());
    const { code } = await p.exit(10000);
    expect(p.lines.map((l) => l.msg)).toEqual([deadlineError(1)]);
    expect(p.lines[0].at - spawnAt).toBeGreaterThanOrEqual(2200);
    expect(p.lines[0].at - spawnAt).toBeLessThan(3800);
    expect(code).toBe(1);
  }, 15000);

  it.each(['abc', '-5', '1e12', '9'.repeat(20), 'x'.repeat(5000)])('an invalid one-shot deadline (case %#) fails closed', async (value) => {
    const daemon = mockDaemon(null);
    const p = spawnOneShot({ MOE_PROXY_ONESHOT_DEADLINE_MS: value });
    p.send(blockingCall());
    const { code } = await p.exit(5000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: null,
      error: { code: -32000, message: expect.stringMatching(/^Invalid MOE_PROXY_ONESHOT_DEADLINE_MS: /) } }]);
    expect(p.lines[0].msg.error!.message!.length).toBeLessThan(200);
    expect(code).toBe(1);
    expect(daemon.connections).toBe(0);
  }, 10000);

  it.each([['blank', ' '], ['40 days away', String(Date.now() + 40 * 24 * 3600 * 1000)]])('a %s one-shot deadline leaves a normal call alone', async (_label, value) => {
    mockDaemon(100);
    const p = spawnOneShot({ MOE_PROXY_ONESHOT_DEADLINE_MS: value });
    p.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    const { code } = await p.exit(5000);
    expect(p.lines.map((l) => l.msg)).toEqual([{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }]);
    expect(code).toBe(0);
  }, 10000);
});
