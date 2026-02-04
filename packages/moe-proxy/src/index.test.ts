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
