import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
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

// Same bind probe as scripts/tests/local-runner-daemon-bind.test.mjs: a host
// without IPv6 skips the ::1 rows instead of failing them.
const V6 = await new Promise<boolean>((resolve) => {
  const probe = http.createServer().once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});
const itV6 = V6 ? it : it.skip;

// [bind address, MOE_DAEMON_HOST spelling]
const HOSTS: (readonly [string, string])[] = [[HOST, HOST], ...(V6 ? [['::1', '[::1]'] as const] : [])];

// Spellings that ws's WHATWG URL parse repairs and http.request's hostname does not.
const REPAIRED_HOSTS: (readonly [string, string])[] = [
  ...['127.0.0.1\r', '127.0.0.1\t', '127.0.0.1\n', '%31%32%37.0.0.1', 'x@127.0.0.1', 'x:y@127.0.0.1']
    .map((spelling) => [HOST, spelling] as const),
  ...(V6 ? [['::1', '[::1]\r'] as const] : []),
];
const OTHER_PROJECT = path.join(os.tmpdir(), 'other-moe-project');
const PROXY_ENTRY = path.join(__dirname, '../dist/index.js');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

async function listen(handler: Handler, host = HOST): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
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
  itV6.each([
    ['::1', '/mnt/d/proj', 'same'], ['[::1]', '/mnt/d/proj', 'same'],
    ['::1', OTHER_PROJECT, 'foreign'], ['[::1]', OTHER_PROJECT, 'foreign'],
  ])('classifies IPv6 host %s serving %s as %s', async (host, served, kind) => {
    const { port } = await listen(healthy(served), '::1');
    await expect(probeDaemonIdentity(host, port, '/mnt/d/proj')).resolves.toEqual(
      kind === 'foreign' ? { kind, projectPath: served } : { kind },
    );
  });

  // Answers only a plain GET /health with no credentials, so a probe that leaked
  // userinfo as an Authorization header or carried a URL path along reads 404.
  const strict = (projectPath: unknown): Handler => (req, res) => (
    req.url === '/health' && req.headers.authorization === undefined
      ? healthy(projectPath)(req, res)
      : reply(404, '{}')(req, res)
  );

  // ws parses `ws://${host}:${port}/mcp` with WHATWG URL, which strips TAB/LF/CR,
  // percent-decodes the host and drops userinfo. The probe must dial the same place.
  it.each([
    '127.0.0.1\r', '127.0.0.1\t', '127.0.0.1\n', '127.0.\r0.1', '%31%32%37.0.0.1',
    'x@127.0.0.1', 'x:y@127.0.0.1', '127.1', '0x7f000001',
  ])('classifies the host spelling %j that ws repairs as foreign', async (host) => {
    const { port } = await listen(strict(OTHER_PROJECT));
    await expect(probeDaemonIdentity(host, port, '/mnt/d/proj'))
      .resolves.toEqual({ kind: 'foreign', projectPath: OTHER_PROJECT });
  });

  // ws dials the port spelled inside the host, not the port argument.
  it('probes the port spelled inside the host, not the raw port argument', async () => {
    const foreign = await listen(strict(OTHER_PROJECT));
    const decoy = await listen(strict('/mnt/d/proj'));
    await expect(probeDaemonIdentity(`x:y@${HOST}:${foreign.port}/`, decoy.port, '/mnt/d/proj'))
      .resolves.toEqual({ kind: 'foreign', projectPath: OTHER_PROJECT });
  });

  it('keeps an invalid bracketed IPv4 hostname unknown', async () => {
    const { port } = await listen(healthy(OTHER_PROJECT));
    await expect(probeDaemonIdentity(`[${HOST}]`, port, '/mnt/d/proj'))
      .resolves.toEqual({ kind: 'unknown' });
  });

  it.each(['D:\\proj', 'D:/proj', '/mnt/d/proj'])(
    'classifies the spelling %s of /mnt/d/proj as same',
    async (served) => {
      const { port } = await listen(healthy(served));
      await expect(probeDaemonIdentity(HOST, port, '/mnt/d/proj')).resolves.toEqual({ kind: 'same' });
    },
  );

  // The cross-platform path contract (comparableProjectPath), with no platform guard.
  it.each([
    ['/home/qa/OtherProject', '/home/qa/otherproject', 'foreign'],
    ['//SRV/SHARE/PROJ/', '\\\\srv\\share\\proj', 'same'],
    ['/home/u/proj', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', 'same'],
    ['\\\\wsl$\\Ubuntu\\home\\u\\proj', '/home/u/proj', 'same'],
    ['/home/u/proj', 'C:\\home\\u\\proj', 'foreign'],
  ])('classifies served %s for own %s as %s', async (served, own, kind) => {
    const { port } = await listen(healthy(served));
    await expect(probeDaemonIdentity(HOST, port, own)).resolves.toEqual(
      kind === 'foreign' ? { kind, projectPath: served } : { kind },
    );
  });

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

// The daemon's own /health DNS-rebinding guard. A computed specifier, as in
// workerType.integration.test.ts: a literal one would pull daemon source into this package's tsc build.
const { isAllowedHealthHost } = (await import(
  pathToFileURL(path.resolve(__dirname, '../../moe-daemon/src/server/healthHost.ts')).href
)) as { isAllowedHealthHost: (host: string | undefined, localAddress: string | undefined) => boolean };

// The daemon's /health admits only IP literals and localhost as Host (server/healthHost.ts), so a probe
// that dialed a configured name read 403 and fell back to 'unknown' (task-86d66093).
describe('probeDaemonIdentity with a host name', () => {
  const NAME = 'moe-daemon.test'; // RFC 6761: never resolves in real DNS
  const enotfound = () => Object.assign(new Error(`getaddrinfo ENOTFOUND ${NAME}`), { code: 'ENOTFOUND' });

  /** /health guarded the way the daemon guards it (index.ts): 403 for a Host it does not own. */
  async function guarded(projectPath: unknown, bind = HOST) {
    const hosts: (string | undefined)[] = [];
    let connections = 0;
    const { server, port } = await listen((req, res) => {
      hosts.push(req.headers.host);
      if (!isAllowedHealthHost(req.headers.host, req.socket.localAddress)) {
        reply(403, 'Forbidden')(req, res);
        return;
      }
      healthy(projectPath)(req, res);
    }, bind);
    server.on('connection', () => { connections++; });
    return { port, hosts, connections: () => connections };
  }

  it('the guarded fake refuses the name Host an unresolved probe sends, as the daemon does', async () => {
    const { port } = await guarded(OTHER_PROJECT);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ hostname: HOST, port, path: '/health', headers: { host: `${NAME}:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });

  it.each([
    [OTHER_PROJECT, { kind: 'foreign', projectPath: OTHER_PROJECT }],
    ['/mnt/d/proj', { kind: 'same' }],
  ])('resolves a name and dials the address, so a daemon serving %s reads as %j', async (served, expected) => {
    const fake = await guarded(served);
    const lookup = vi.fn(async (_hostname: string) => HOST);
    await expect(probeDaemonIdentity(NAME, fake.port, '/mnt/d/proj', { lookup })).resolves.toEqual(expected);
    expect(lookup.mock.calls).toEqual([[NAME]]);
    expect(fake.hosts).toEqual([`${HOST}:${fake.port}`]);
  });

  itV6('sends a bracketed IPv6 literal Host for an IPv6 resolution, which the daemon admits', async () => {
    const fake = await guarded(OTHER_PROJECT, '::1');
    const lookup = vi.fn(async (_hostname: string) => '::1');
    await expect(probeDaemonIdentity(NAME, fake.port, '/mnt/d/proj', { lookup }))
      .resolves.toEqual({ kind: 'foreign', projectPath: OTHER_PROJECT });
    expect(fake.hosts).toEqual([`[::1]:${fake.port}`]);
  });

  // localhost stays a name: Node dials it on both address families, and one lookup that
  // answers ::1 first would miss a daemon bound to 127.0.0.1.
  it.each(['localhost', 'LOCALHOST', HOST, '127.1', '%31%32%37.0.0.1', ...(V6 ? ['::1', '[::1]'] : [])])(
    'never resolves %j and keeps today\'s request', async (host) => {
      const bind = host.includes(':') ? '::1' : host.toLowerCase() === 'localhost' ? 'localhost' : HOST;
      const fake = await guarded(OTHER_PROJECT, bind);
      const lookup = vi.fn(async (_hostname: string): Promise<string> => { throw enotfound(); });
      await expect(probeDaemonIdentity(host, fake.port, '/mnt/d/proj', { lookup }))
        .resolves.toEqual({ kind: 'foreign', projectPath: OTHER_PROJECT });
      expect(lookup).not.toHaveBeenCalled();
    });

  it('classifies a failed lookup as unknown at once and opens no socket', async () => {
    const fake = await guarded(OTHER_PROJECT);
    const t0 = Date.now();
    await expect(probeDaemonIdentity(NAME, fake.port, '/mnt/d/proj', { timeoutMs: 2000, lookup: async () => { throw enotfound(); } }))
      .resolves.toEqual({ kind: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fake.connections()).toBe(0);
  });

  it('classifies a hung lookup as unknown within the timeout and opens no socket', async () => {
    const fake = await guarded(OTHER_PROJECT);
    const t0 = Date.now();
    await expect(probeDaemonIdentity(NAME, fake.port, '/mnt/d/proj', { timeoutMs: 150, lookup: () => new Promise<string>(() => {}) }))
      .resolves.toEqual({ kind: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(fake.connections()).toBe(0);
  });

  it('opens no socket when the lookup answers after the timeout', async () => {
    const fake = await guarded(OTHER_PROJECT);
    const lookup = () => new Promise<string>((resolve) => setTimeout(() => resolve(HOST), 300));
    await expect(probeDaemonIdentity(NAME, fake.port, '/mnt/d/proj', { timeoutMs: 100, lookup }))
      .resolves.toEqual({ kind: 'unknown' });
    await new Promise((r) => setTimeout(r, 500));
    expect(fake.connections()).toBe(0);
  });

  it('bounds lookup and request together by one timeoutMs', async () => {
    const { port } = await listen(() => { /* never answers */ });
    const lookup = () => new Promise<string>((resolve) => setTimeout(() => resolve(HOST), 900));
    const t0 = Date.now();
    await expect(probeDaemonIdentity(NAME, port, '/mnt/d/proj', { timeoutMs: 1000, lookup }))
      .resolves.toEqual({ kind: 'unknown' });
    expect(Date.now() - t0).toBeLessThan(1800); // a fresh budget after the lookup ends at >= 1900
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
  async function startFakeDaemon(served: () => unknown, host = HOST) {
    const upgrades: string[] = [];
    const healthRequests: string[] = [];
    const { server, port } = await listen((req, res) => {
      healthRequests.push(`${req.method} ${req.url}`);
      healthy(served())(req, res);
    }, host);
    server.on('upgrade', (req) => upgrades.push(req.url ?? ''));
    const wss = new WebSocketServer({ server });
    return { server, port, wss, upgrades, healthRequests };
  }

  function startProxy(port: number, host = HOST, spell = (dir: string) => dir) {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-identity-test-'));
    fs.mkdirSync(path.join(testDir, '.moe'));
    fs.writeFileSync(path.join(testDir, '.moe', 'daemon.json'), JSON.stringify({
      port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      projectPath: testDir,
    }));
    const stdout: string[] = [];
    // The cwd is on testDir's drive, which a drive-less Windows alias resolves against.
    const proxy = spawn('node', [PROXY_ENTRY], {
      cwd: path.dirname(testDir),
      env: { ...process.env, MOE_PROJECT_PATH: spell(testDir), MOE_DAEMON_HOST: host },
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

  it.each([...HOSTS, ...REPAIRED_HOSTS])('E1: exits 1 naming both projects and never opens /mcp for a foreign daemon (%s via %j)', async (bind, host) => {
    const daemon = await startFakeDaemon(() => OTHER_PROJECT, bind);
    const { stdout, exited } = startProxy(daemon.port, host);

    expect(await exited).toBe(1);
    const message = JSON.parse(stdout[0]).error.message as string;
    expect(message).toContain(OTHER_PROJECT);
    expect(message).toContain(testDir);
    expect(message).toMatch(/restart/i);
    expect(daemon.healthRequests).toEqual(['GET /health']);
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

  it.each(HOSTS)('E2: opens /mcp for a daemon serving this project (%s)', async (bind, host) => {
    const daemon = await startFakeDaemon(() => testDir, bind);
    const { proxy, exited } = startProxy(daemon.port, host);

    await waitFor(() => daemon.upgrades.length >= 1);
    expect(daemon.upgrades).toEqual(['/mcp']);
    proxy.stdin!.end();
    expect(await exited).toBe(0);
    expect(daemon.healthRequests).toEqual(['GET /health']);
  }, 12000);

  it.each(HOSTS)('E3: probes again on reconnect and exits 1 when another daemon took the port (%s)', async (bind, host) => {
    let served: unknown;
    const daemon = await startFakeDaemon(() => served, bind);
    daemon.wss.on('connection', (ws) => {
      served = OTHER_PROJECT;
      ws.terminate();
    });
    const { stdout, exited } = startProxy(daemon.port, host);
    served = testDir;

    expect(await exited).toBe(1);
    expect(daemon.upgrades).toEqual(['/mcp']);
    expect(daemon.healthRequests).toEqual(['GET /health', 'GET /health']);
    expect(stdout.some((line) => JSON.parse(line).error?.message?.includes(OTHER_PROJECT))).toBe(true);
  }, 15000);

  it.each(HOSTS)('E4: an older daemon whose /health has no projectPath still connects (%s)', async (bind, host) => {
    const daemon = await startFakeDaemon(() => undefined, bind);
    const { proxy, exited } = startProxy(daemon.port, host);

    await waitFor(() => daemon.upgrades.length >= 1);
    proxy.stdin!.end();
    expect(await exited).toBe(0);
    expect(daemon.healthRequests).toEqual(['GET /health']);
  }, 12000);

  it('E5: opens /mcp when MOE_PROJECT_PATH is a native alias of its project (//x on POSIX, /x on Windows)', async () => {
    const daemon = await startFakeDaemon(() => testDir);
    const alias = (dir: string) => (process.platform === 'win32' ? dir.slice(2).replace(/\\/g, '/') : `/${dir}`);
    const { proxy, exited } = startProxy(daemon.port, HOST, alias);

    await waitFor(() => daemon.upgrades.length >= 1);
    expect(daemon.upgrades).toEqual(['/mcp']);
    proxy.stdin!.end();
    expect(await exited).toBe(0);
    expect(daemon.healthRequests).toEqual(['GET /health']);
  }, 12000);
});
