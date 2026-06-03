import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import net from 'net';
import { runDoctor } from './doctor.js';

// Minimal .moe scaffold so the role-doc / channel probes don't short-circuit
// before we reach the daemon health probe under test.
function scaffoldMoe(projectPath: string): string {
  const moePath = path.join(projectPath, '.moe');
  fs.mkdirSync(path.join(moePath, 'roles'), { recursive: true });
  for (const f of ['architect.md', 'worker.md', 'qa.md', 'governor.md']) {
    fs.writeFileSync(path.join(moePath, 'roles', f), '# role');
  }
  fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
  for (const name of ['general', 'workers', 'architects', 'qa', 'governors']) {
    fs.writeFileSync(path.join(moePath, 'channels', `${name}.json`), JSON.stringify({ name }));
  }
  return moePath;
}

function line(output: string[], label: string): string | undefined {
  return output.find((l) => l.includes(label));
}

describe('runDoctor — daemon health reachability', () => {
  let testDir: string;
  let moePath: string;
  const servers: Array<http.Server | net.Server> = [];
  const openSockets = new Set<net.Socket>();

  function track(server: http.Server | net.Server): void {
    server.on('connection', (sock: net.Socket) => {
      openSockets.add(sock);
      sock.on('close', () => openSockets.delete(sock));
    });
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-doctor-'));
    moePath = scaffoldMoe(testDir);
  });

  afterEach(async () => {
    // Forcibly drop any lingering keep-alive sockets so server.close() resolves.
    for (const sock of openSockets) sock.destroy();
    openSockets.clear();
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    servers.length = 0;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function startHealthServer(body: unknown, statusCode = 200): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    track(server);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  async function startRawTcpServer(): Promise<number> {
    const server = net.createServer((sock) => {
      sock.on('error', () => { /* ignore */ });
      // Accept the connection, then emit non-HTTP bytes and hang up — mimics an
      // unrelated process that grabbed the reused port. The HTTP client treats
      // this as a parse error and bails fast (no long /health timeout wait), and
      // closing the socket lets server.close() complete in afterEach.
      sock.write('not-http\r\n');
      sock.end();
    });
    track(server);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  function writeDaemonJson(port: number, pid = process.pid): void {
    fs.writeFileSync(
      path.join(moePath, 'daemon.json'),
      JSON.stringify({ port, pid, projectPath: testDir, startedAt: new Date().toISOString() }),
    );
  }

  it('passes when /health confirms a healthy daemon for this project', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir, pid: process.pid });
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toBeDefined();
    expect(reach).toContain('[OK]');
    expect(result.exitCode).toBe(0);
  });

  it('does NOT report green when pid is alive and TCP listens but /health never answers (pid/port reuse)', async () => {
    // Raw socket: pid is alive (our own pid) and the port accepts TCP, but it is
    // not a Moe daemon. The old code reported [OK]; now this must be a warning.
    const port = await startRawTcpServer();
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toBeDefined();
    expect(reach).not.toContain('[OK]');
    expect(reach).toContain('[WARN]');
    // A warning must not flip exit code to non-zero on its own.
    expect(result.exitCode).toBe(0);
  });

  it('fails when /health reports a different project (port reused by another daemon)', async () => {
    const otherProject = path.join(os.tmpdir(), 'some-other-project');
    const port = await startHealthServer({ status: 'healthy', projectPath: otherProject, pid: process.pid });
    writeDaemonJson(port);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toContain('[FAIL]');
    expect(result.exitCode).toBe(1);
  });

  it('fails when /health reports a different pid than daemon.json (pid reuse)', async () => {
    const port = await startHealthServer({ status: 'healthy', projectPath: testDir, pid: process.pid + 1 });
    writeDaemonJson(port, process.pid);

    const result = await runDoctor(testDir);

    const reach = line(result.output, 'daemon health reachability');
    expect(reach).toContain('[FAIL]');
    expect(result.exitCode).toBe(1);
  });
});
