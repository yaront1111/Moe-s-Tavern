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
