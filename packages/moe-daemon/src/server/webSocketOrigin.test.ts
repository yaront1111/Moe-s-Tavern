import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import { randomBytes } from 'crypto';
import net from 'net';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RUNNER_KEY_HEADER, ensureRunnerKey } from './runnerChannel.js';
import { McpAdapter } from './McpAdapter.js';
import { MoeWebSocketServer, isAllowedUpgradeOrigin } from './WebSocketServer.js';
import { StateManager } from '../state/StateManager.js';
import { logger } from '../util/logger.js';

const REFUSAL_LOG = 'Refused WebSocket upgrade: Origin not allowed';
const FOREIGN = 'https://example.com';

type ServerInternals = {
  onConnection: (ws: WebSocket, req: IncomingMessage) => void;
  pluginClients: Set<WebSocket>;
  mcpClients: Set<WebSocket>;
};

describe('isAllowedUpgradeOrigin', () => {
  it('accepts only an absent Origin while the allowed set is empty', () => {
    expect(isAllowedUpgradeOrigin(undefined)).toBe(true);
    for (const origin of [FOREIGN, 'null', '', 'http://127.0.0.1:9876', 'file://']) {
      expect(isAllowedUpgradeOrigin(origin)).toBe(false);
    }
  });
});

describe('MoeWebSocketServer Origin rule', () => {
  let projectDir: string;
  let keyDir: string;
  let previousKeyDir: string | undefined;
  let httpServer: Server;
  let wsServer: MoeWebSocketServer;
  let internals: ServerInternals;
  let onConnection: ReturnType<typeof vi.spyOn>;
  let port: number;
  let runnerKey: string;
  let cleanups: (() => void)[];

  beforeEach(async () => {
    cleanups = [];
    previousKeyDir = process.env.MOE_RUNNER_KEY_DIR;
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-origin-keys-'));
    process.env.MOE_RUNNER_KEY_DIR = keyDir;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-origin-project-'));
    for (const dir of ['epics', 'tasks', 'workers', 'proposals']) fs.mkdirSync(path.join(projectDir, '.moe', dir), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.moe', 'project.json'), JSON.stringify({
      id: 'proj-origin', name: 'Origin', rootPath: projectDir,
      globalRails: { techStack: [], forbiddenPatterns: [], requiredPatterns: [], formatting: '', testing: '', customRules: [] },
      settings: { approvalMode: 'CONTROL' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));
    const state = new StateManager({ projectPath: projectDir });
    await state.load();
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => undefined);
    }
    runnerKey = fs.readFileSync(await ensureRunnerKey(projectDir), 'utf8');
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as { port: number }).port;
    wsServer = new MoeWebSocketServer(httpServer, state, new McpAdapter(state));
    internals = wsServer as unknown as ServerInternals;
    onConnection = vi.spyOn(internals, 'onConnection');
  });

  afterEach(async () => {
    for (const cleanup of cleanups) cleanup();
    await wsServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    vi.restoreAllMocks();
    if (previousKeyDir === undefined) delete process.env.MOE_RUNNER_KEY_DIR;
    else process.env.MOE_RUNNER_KEY_DIR = previousKeyDir;
    fs.rmSync(keyDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const within = <T>(promise: Promise<T>, what: string) => Promise.race([promise, new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 3000))]);
  const wsKey = () => randomBytes(16).toString('base64');

  /** Write exact handshake bytes; resolve the whole response once it closes, or its head on a 101. */
  const rawUpgrade = (endpoint: string, headerLines: string[]) => within(new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    cleanups.push(() => socket.destroy());
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (text.startsWith('HTTP/1.1 101') && text.includes('\r\n\r\n')) resolve(text);
    });
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`GET ${endpoint} HTTP/1.1\r\n${headerLines.map((line) => `${line}\r\n`).join('')}\r\n`));
  }), `${endpoint} response`);
  /** The headers every handshake needs, after the caller's extra lines. */
  const handshake = (extra: string[], version = '13') => [
    `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${wsKey()}`, `Sec-WebSocket-Version: ${version}`, ...extra,
  ];

  /** Open a 'ws' client; resolve 'open' or the refused handshake's HTTP status. */
  const wsOutcome = (endpoint: string, options?: WebSocket.ClientOptions) => within(new Promise<'open' | number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`, options);
    cleanups.push(() => ws.terminate());
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  }), `${endpoint} outcome`);

  const expectRefused = (response: string, origin?: string) => {
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(response.endsWith('\r\n\r\nForbidden')).toBe(true);
    if (origin) expect(response).not.toContain(origin);
    expect(onConnection).not.toHaveBeenCalled();
    expect(internals.pluginClients.size).toBe(0);
    expect(internals.mcpClients.size).toBe(0);
  };

  describe('refused: an Origin header is present', () => {
    it.each(['/ws', '/mcp', '/', '/ws?client=x'])('refuses Origin %s with 403 and runs no handler', async (endpoint) => {
      expectRefused(await rawUpgrade(endpoint, handshake([`Origin: ${FOREIGN}`])), FOREIGN);
      expect(logger.warn).toHaveBeenCalledWith(
        { remoteAddress: '127.0.0.1', path: endpoint.split('?')[0], origin: FOREIGN }, REFUSAL_LOG);
    });

    it.each(['/ws', '/mcp'])('refuses the literal Origin null on %s', async (endpoint) => {
      expectRefused(await rawUpgrade(endpoint, handshake(['Origin: null'])), 'null');
    });

    it.each(['/ws', '/mcp'])('refuses an empty Origin value on %s', async (endpoint) => {
      expectRefused(await rawUpgrade(endpoint, handshake(['Origin: '])));
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ origin: '' }), REFUSAL_LOG);
    });

    it.each(['/ws', '/mcp'])('refuses a mixed-case Origin header name on %s', async (endpoint) => {
      expectRefused(await rawUpgrade(endpoint, handshake([`oRiGiN: ${FOREIGN}`])), FOREIGN);
    });

    it('refuses Origin on a version-8 handshake, where ws reads only Sec-WebSocket-Origin', async () => {
      expectRefused(await rawUpgrade('/ws', handshake([`Origin: ${FOREIGN}`], '8')), FOREIGN);
    });

    it('refuses a Sec-WebSocket-Origin header on a version-13 handshake', async () => {
      expectRefused(await rawUpgrade('/mcp', handshake([`Sec-WebSocket-Origin: ${FOREIGN}`])), FOREIGN);
    });

    it('refuses an Origin on /runner even with a valid runner key', async () => {
      expectRefused(await rawUpgrade('/runner', handshake([`${RUNNER_KEY_HEADER}: ${runnerKey}`, `Origin: ${FOREIGN}`])), FOREIGN);
    });

    it('refuses a ws client that sets an origin', async () => {
      expect(await wsOutcome('/mcp', { origin: FOREIGN })).toBe(403);
      expect(onConnection).not.toHaveBeenCalled();
    });

    it('logs a truncated origin and never echoes it to the client', async () => {
      const long = `https://${'a'.repeat(300)}.example`;
      expectRefused(await rawUpgrade('/ws', handshake([`Origin: ${long}`])), long.slice(0, 40));
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ origin: long.slice(0, 120) }), REFUSAL_LOG);
    });

    it('fails closed with 403 when the check throws', async () => {
      httpServer.prependListener('upgrade', (req: IncomingMessage) => {
        Object.defineProperty(req, 'headersDistinct', { get: () => { throw new Error('header read failed'); }, configurable: true });
      });
      expectRefused(await rawUpgrade('/ws', handshake([])));
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ remoteAddress: '127.0.0.1' }),
        'Refused WebSocket upgrade: Origin check failed');
    });
  });

  describe('accepted: real clients send no Origin', () => {
    it.each(['/ws', '/mcp'])("opens 'ws' with no options on %s (moe-proxy, VS Code, wrapper RPC)", async (endpoint) => {
      expect(await wsOutcome(endpoint)).toBe('open');
      expect(onConnection).toHaveBeenCalledTimes(1);
    });

    // packages/moe-claude-plugin/src/daemonClient.ts: its raw handshake, byte for byte.
    it.each(['/mcp', '/ws'])('upgrades the claude-plugin raw handshake on %s', async (endpoint) => {
      const response = await rawUpgrade(endpoint, [
        `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey()}`, 'Sec-WebSocket-Version: 13',
      ]);
      expect(response.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    });

    // scripts/local-runner/vm-control.mjs mcpCaller: `new globalThis.WebSocket('ws://127.0.0.1:<port>/mcp')`.
    const globalWebSocket = (globalThis as { WebSocket?: new (url: string) => EventTarget & { close(): void } }).WebSocket;
    (globalWebSocket ? it : it.skip)("opens Node's global WebSocket on /mcp (vm-control)", async () => {
      const Impl = globalWebSocket!;
      const outcome = await within(new Promise<string>((resolve) => {
        const socket = new Impl(`ws://127.0.0.1:${port}/mcp`);
        cleanups.push(() => socket.close());
        socket.addEventListener('open', () => resolve('open'));
        socket.addEventListener('error', () => resolve('error'));
      }), 'global WebSocket open');
      expect(outcome).toBe('open');
      expect(onConnection).toHaveBeenCalledTimes(1);
    });

    // moe-jetbrains pins org.java-websocket:Java-WebSocket:1.6.0 (build.gradle.kts) and builds
    // `WebSocketClient(URI("ws://127.0.0.1:<port>/ws"))` with no extra headers. In 1.6.0,
    // WebSocketClient.sendHandshake puts Host; Draft_6455.postProcessHandshakeRequestAsClient puts
    // Upgrade, Connection, Sec-WebSocket-Key and Sec-WebSocket-Version (Extensions and Protocol only
    // when non-default); HandshakedataImpl1 keeps them in a TreeMap(CASE_INSENSITIVE_ORDER), so
    // Draft.createHandshake writes them alphabetically. The 1.6.0 jar contains no "Origin" string.
    it('upgrades the Java-WebSocket 1.6.0 header set on /ws (JetBrains)', async () => {
      const response = await rawUpgrade('/ws', [
        'Connection: Upgrade', `Host: 127.0.0.1:${port}`, `Sec-WebSocket-Key: ${wsKey()}`,
        'Sec-WebSocket-Version: 13', 'Upgrade: websocket',
      ]);
      expect(response.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
    });

    it('still authenticates /runner by its key when no Origin is sent', async () => {
      const closed = (ws: WebSocket) => within(new Promise<number>((resolve) => {
        ws.on('error', () => undefined);
        ws.on('close', (code) => resolve(code));
      }), 'runner close');
      const keyless = new WebSocket(`ws://127.0.0.1:${port}/runner`);
      cleanups.push(() => keyless.terminate());
      expect(await closed(keyless)).toBe(1008);
      expect(await wsOutcome('/runner', { headers: { [RUNNER_KEY_HEADER]: runnerKey } })).toBe('open');
      expect(internals.mcpClients.size).toBe(1);
    });
  });
});
