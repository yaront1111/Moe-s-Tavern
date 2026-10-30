import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { WebSocketServer } from 'ws';
import {
  MAX_HEALTH_BODY_BYTES,
  displayServedPath,
  isAbsoluteAnyOs,
  probeDaemonIdentity,
} from './daemonIdentity.js';

const HOST = '127.0.0.1';
const OTHER_PROJECT = path.join(os.tmpdir(), 'other-moe-project');
const PROXY_ENTRY = path.join(__dirname, '../dist/index.js');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

async function listen(handler: Handler): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const reply = (status: number, body: string): Handler => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
};

const healthy = (projectPath: unknown): Handler =>
  reply(200, JSON.stringify({ status: 'healthy', pid: process.pid, projectPath }));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('probeDaemonIdentity', () => {
  it.each(['D:\\proj', 'D:/proj', '/mnt/d/proj'])(
    'classifies the spelling %s of /mnt/d/proj as same',
    async (served) => {
      const { port } = await listen(healthy(served));
      await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'same' });
    },
  );

  it('classifies another absolute project as foreign and returns the served path verbatim', async () => {
    const { port } = await listen(healthy(OTHER_PROJECT));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj'))
      .resolves.toEqual({ kind: 'foreign', projectPath: OTHER_PROJECT });
  });

  it('classifies a different drive-letter project as foreign', async () => {
    const { port } = await listen(healthy('D:\\other'));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj'))
      .resolves.toEqual({ kind: 'foreign', projectPath: 'D:\\other' });
  });

  it('classifies a 503 unhealthy reply by its projectPath too', async () => {
    const body = JSON.stringify({ status: 'unhealthy', projectPath: OTHER_PROJECT });
    const { port } = await listen(reply(503, body));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj'))
      .resolves.toEqual({ kind: 'foreign', projectPath: OTHER_PROJECT });
  });

  it('classifies a 503 unhealthy reply for this project as same', async () => {
    const body = JSON.stringify({ status: 'unhealthy', projectPath: '/mnt/d/proj' });
    const { port } = await listen(reply(503, body));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'same' });
  });

  // The daemon reports its raw --project argument, which can be relative. Resolving
  // it against the proxy's cwd would invent a mismatch.
  it.each(['.', '../x', 'proj', 'sub/proj', 'C:proj'])('classifies the relative served path %j as unknown', async (served) => {
    const { port } = await listen(healthy(served));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });

  it('classifies a refused connection as unknown', async () => {
    const { server, port } = await listen(healthy('/mnt/d/proj'));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });

  it('classifies a server that never answers as unknown within the timeout', async () => {
    const { port } = await listen(() => { /* accept, never answer */ });
    const startedAt = Date.now();
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj', { timeoutMs: 150 }))
      .resolves.toEqual({ kind: 'unknown' });
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('classifies a server that trickles bytes forever as unknown within the timeout', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const timer = setInterval(() => res.write(' '), 10);
      res.on('close', () => clearInterval(timer));
    });
    const startedAt = Date.now();
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj', { timeoutMs: 300 }))
      .resolves.toEqual({ kind: 'unknown' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('classifies a non-JSON body as unknown', async () => {
    const { port } = await listen(reply(200, '<html>not a daemon</html>'));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });

  // Both bodies are valid JSON naming this very project, so only the byte cap
  // can tell them apart.
  const paddedBody = (bytes: number): string => {
    const head = '{"projectPath":"/mnt/d/proj","pad":"';
    const tail = '"}';
    return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
  };

  it('accepts a body of exactly the cap', async () => {
    const { port } = await listen(reply(200, paddedBody(MAX_HEALTH_BODY_BYTES)));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'same' });
  });

  it('classifies a body one byte over the cap as unknown', async () => {
    const { port } = await listen(reply(200, paddedBody(MAX_HEALTH_BODY_BYTES + 1)));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });

  it('classifies an older daemon reply without projectPath as unknown', async () => {
    const { port } = await listen(reply(200, JSON.stringify({ status: 'healthy', pid: 1 })));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });

  it.each([[42], [''], [null], [['/mnt/d/proj']]])(
    'classifies a projectPath of %j as unknown',
    async (served) => {
      const { port } = await listen(healthy(served));
      await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
    },
  );

  it('classifies a JSON array body as unknown', async () => {
    const { port } = await listen(reply(200, JSON.stringify([{ projectPath: OTHER_PROJECT }])));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });

  it('classifies the 426 of a bare WebSocket server as unknown', async () => {
    const wss = new WebSocketServer({ port: 0, host: HOST });
    await new Promise<void>((resolve) => wss.on('listening', resolve));
    const port = (wss.address() as AddressInfo).port;
    try {
      await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it.each([500, 404])('classifies a %i reply as unknown even when it names another project', async (status) => {
    const { port } = await listen(reply(status, JSON.stringify({ projectPath: OTHER_PROJECT })));
    await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('isAbsoluteAnyOs', () => {
  // path.isAbsolute is per-OS: on Linux it rejects 'D:\\x'. The daemon reports
  // whatever spelling its own OS was given, so the check must not depend on ours.
  it.each(['D:\\x', 'D:/x', 'd:\\', '\\\\server\\share', '/mnt/d/x', '/'])('accepts %j', (value) => {
    expect(isAbsoluteAnyOs(value)).toBe(true);
  });

  it.each(['', '.', '../x', 'sub/proj', 'C:proj', 'C:', '\\\\', '\\x'])('rejects %j', (value) => {
    expect(isAbsoluteAnyOs(value)).toBe(false);
  });
});

describe('displayServedPath', () => {
  it('leaves an ordinary path alone', () => {
    expect(displayServedPath('D:\\projexts\\app')).toBe('D:\\projexts\\app');
  });

  it('flattens control characters so a served path cannot forge a log line', () => {
    expect(displayServedPath('/other\r\nINJECTED\u0000')).toBe('/other??INJECTED?');
  });

  it('bounds a served path to 300 characters plus an ellipsis', () => {
    expect(displayServedPath(`/${'x'.repeat(5000)}`)).toBe(`/${'x'.repeat(299)}...`);
  });
});

describe('moe-proxy bridges only to a daemon serving its own project', () => {
  let testDir: string;

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** A fake daemon: /health answers `served()`, and every /mcp upgrade is counted. */
  async function startFakeDaemon(served: () => unknown) {
    const upgrades: string[] = [];
    const { server, port } = await listen((req, res) => healthy(served())(req, res));
    server.on('upgrade', (req) => upgrades.push(req.url ?? ''));
    const wss = new WebSocketServer({ server });
    return { server, port, wss, upgrades };
  }

  function startProxy(port: number) {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-identity-test-'));
    fs.mkdirSync(path.join(testDir, '.moe'));
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.json'), JSON.stringify({
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: testDir,
    }));
    const stdout: string[] = [];
    const proxy = spawn('node', [PROXY_ENTRY], {
      env: { ...process.env, MOE_PROJECT_PATH: testDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proxy.stdout!.on('data', (chunk) => {
      stdout.push(...chunk.toString().split('\n').filter((line: string) => line.startsWith('{')));
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { proxy.kill(); reject(new Error('Proxy did not exit')); }, 7000);
      proxy.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    return { proxy, stdout, exited };
  }

  const waitFor = async (predicate: () => boolean, ms = 5000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it('E1: exits 1 naming both projects and never opens /mcp for a foreign daemon', async () => {
    const daemon = await startFakeDaemon(() => OTHER_PROJECT);
    const { stdout, exited } = startProxy(daemon.port);

    expect(await exited).toBe(1);
    const message = JSON.parse(stdout[0]).error.message as string;
    expect(message).toContain(OTHER_PROJECT);
    expect(message).toContain(testDir);
    expect(message).toMatch(/restart/i);
    expect(daemon.upgrades).toEqual([]);
  }, 12000);

  it('E1b: names a hostile served path as one bounded line', async () => {
    const daemon = await startFakeDaemon(() => `/other\nINJECTED${'x'.repeat(5000)}`);
    const { stdout, exited } = startProxy(daemon.port);

    expect(await exited).toBe(1);
    const message = JSON.parse(stdout[0]).error.message as string;
    expect(message).toContain('/other?INJECTED');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThan(700);
    expect(daemon.upgrades).toEqual([]);
  }, 12000);

  it('E2: opens /mcp for a daemon serving this project', async () => {
    const daemon = await startFakeDaemon(() => testDir);
    const { proxy, exited } = startProxy(daemon.port);

    await waitFor(() => daemon.upgrades.length >= 1);
    expect(daemon.upgrades).toEqual(['/mcp']);
    proxy.stdin!.end();
    expect(await exited).toBe(0);
  }, 12000);

  it('E3: probes again on reconnect and exits 1 when another daemon took the port', async () => {
    let served: unknown;
    const daemon = await startFakeDaemon(() => served);
    daemon.wss.on('connection', (ws) => {
      served = OTHER_PROJECT;
      ws.terminate();
    });
    const { stdout, exited } = startProxy(daemon.port);
    served = testDir;

    expect(await exited).toBe(1);
    expect(daemon.upgrades).toEqual(['/mcp']);
    expect(stdout.some((line) => JSON.parse(line).error?.message?.includes(OTHER_PROJECT))).toBe(true);
  }, 15000);

  it('E4: an older daemon whose /health has no projectPath still connects', async () => {
    const daemon = await startFakeDaemon(() => undefined);
    const { proxy, exited } = startProxy(daemon.port);

    await waitFor(() => daemon.upgrades.length >= 1);
    proxy.stdin!.end();
    expect(await exited).toBe(0);
  }, 12000);
});
