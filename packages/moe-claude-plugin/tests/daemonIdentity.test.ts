import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { comparableProjectPath, probeDaemonIdentity } from '../src/daemonIdentity.js';
// The original this file twins; the plugin ships without it, so only tests import it.
import { comparableProjectPath as proxyComparableProjectPath } from '../../moe-proxy/src/utils.js';

// Rows of the shared contract (scripts/tests/daemon-json-cap.test.mjs): input, key.
const ROWS: Array<[string, string]> = [
  ['D:\\proj', 'd:/proj'], ['d:/Proj/', 'd:/proj'], ['D:\\', 'd:'], ['D:/../proj', 'd:/proj'],
  ['/mnt/d/proj', 'd:/proj'], ['/mnt/D/Proj/', 'd:/proj'], ['/mnt/d', 'd:'], ['/mnt/dd/x', '/mnt/dd/x'], ['/MNT/d/x', '/MNT/d/x'],
  ['/home/qa/OtherProject', '/home/qa/OtherProject'], ['/home//u/./x/../p/', '/home/u/p'],
  ['\\\\srv\\share\\proj', '//srv/share/proj'], ['//SRV/SHARE/PROJ/', '//srv/share/proj'], ['//srv/share/../../b', '//srv/share/b'],
  ['\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', '/home/u/proj'], ['//wsl$/Ubuntu/home/u/proj', '/home/u/proj'],
  ['//WSL$/Ubuntu/mnt/d/proj', 'd:/proj'], ['//wsl$/Ubuntu', '/'], ['//wsl$/Ubuntu/MNT/d/Proj', '/MNT/d/Proj'],
  ['//wsl.localhost.evil/Ubuntu/Proj', '//wsl.localhost.evil/ubuntu/proj'], ['//wsl$//home/u/Proj', '//wsl$/home/u/proj'],
];

describe('comparableProjectPath twin', () => {
  it.each(ROWS)('keys %s as %s, the same key moe-proxy computes', (input, key) => {
    expect(comparableProjectPath(input)).toBe(key);
    expect(proxyComparableProjectPath(input)).toBe(key);
  });

  it('treats the Windows and WSL spellings of one project as the same', () => {
    expect(comparableProjectPath('D:\\projexts\\moes')).toBe(comparableProjectPath('/mnt/d/projexts/moes'));
    expect(comparableProjectPath('D:\\projexts\\moes')).not.toBe(comparableProjectPath('/mnt/d/projexts/other'));
  });
});

describe('probeDaemonIdentity', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function healthServer(status: number, body: string): Promise<number> {
    server = createServer((req, res) => {
      res.writeHead(req.url === '/health' ? status : 426, { 'Content-Type': 'application/json' });
      res.end(req.url === '/health' ? body : '');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it.each([
    ['same', 200, { projectPath: '/mnt/d/projexts/moes' }],
    ['same', 503, { projectPath: 'D:\\projexts\\moes\\' }],
    ['foreign', 200, { projectPath: '/home/qa/other' }],
    ['unknown', 200, { status: 'healthy' }],
    ['unknown', 200, { projectPath: 'relative/moes' }],
    ['unknown', 404, { projectPath: '/home/qa/other' }],
  ] as const)('answers %s for a %i reply %j', async (expected, status, body) => {
    const port = await healthServer(status, JSON.stringify(body));
    expect(await probeDaemonIdentity('127.0.0.1', port, 'D:\\projexts\\moes', 1000)).toBe(expected);
  });

  it('answers unknown for a body that is not JSON', async () => {
    const port = await healthServer(200, 'not json');
    expect(await probeDaemonIdentity('127.0.0.1', port, '/p', 1000)).toBe('unknown');
  });

  it('answers unknown within its timeout when /health never replies', async () => {
    server = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    expect(await probeDaemonIdentity('127.0.0.1', port, '/p', 300)).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2000);
    server.closeAllConnections();
  });

  it('answers unknown when nothing listens', async () => {
    expect(await probeDaemonIdentity('127.0.0.1', 1, '/p', 1000)).toBe('unknown');
  });
});
