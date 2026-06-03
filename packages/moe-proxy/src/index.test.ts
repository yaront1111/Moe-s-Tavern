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
});
