import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  comparableProjectPath,
  getDaemonHost,
  readDaemonInfo,
  readDaemonInfoResult,
  getProjectPath,
  formatError,
  isValidJson,
  parseJsonLines,
  injectRunnerIdentity,
  injectWorkerId,
  toolNameStyleFromEnv,
  exposeToolName,
  rewriteToolsListResult,
  resolveToolCallName,
  stampExecutionIdentity,
  type DaemonInfo,
} from './utils.js';

describe('utils', () => {
  describe('readDaemonInfo', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-proxy-test-'));
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('returns null if .moe folder does not exist', () => {
      const result = readDaemonInfo(testDir);
      expect(result).toBeNull();
    });

    it('returns null if daemon.json does not exist', () => {
      fs.mkdirSync(path.join(testDir, '.moe'));
      const result = readDaemonInfo(testDir);
      expect(result).toBeNull();
    });

    it('returns daemon info when valid', () => {
      const moePath = path.join(testDir, '.moe');
      fs.mkdirSync(moePath);

      const daemonInfo: DaemonInfo = {
        port: 3000,
        pid: 12345,
        startedAt: '2024-01-01T00:00:00Z',
        projectPath: testDir,
      };
      fs.writeFileSync(path.join(moePath, 'daemon.json'), JSON.stringify(daemonInfo));

      const result = readDaemonInfo(testDir);
      expect(result).toEqual(daemonInfo);
    });

    it('returns null for projectPath mismatch', () => {
      const moePath = path.join(testDir, '.moe');
      fs.mkdirSync(moePath);
      fs.writeFileSync(path.join(moePath, 'daemon.json'), JSON.stringify({
        port: 3000,
        pid: 12345,
        startedAt: '2024-01-01T00:00:00Z',
        projectPath: path.join(os.tmpdir(), 'other-project'),
      }));

      expect(readDaemonInfo(testDir)).toBeNull();
      expect(readDaemonInfoResult(testDir)).toMatchObject({
        info: null,
        retryable: false,
        error: 'daemon.json belongs to a different project',
      });
    });

    describe('size cap (64 KiB)', () => {
      const OVERSIZE = {
        info: null,
        retryable: false,
        error: 'daemon.json is larger than 64 KiB',
      };

      /** Valid daemon.json padded with trailing spaces to exactly `bytes`. */
      function writePadded(bytes: number): string {
        const moePath = path.join(testDir, '.moe');
        fs.mkdirSync(moePath, { recursive: true });
        const info: DaemonInfo = {
          port: 3000,
          pid: 12345,
          startedAt: '2024-01-01T00:00:00Z',
          projectPath: testDir,
        };
        const body = JSON.stringify(info);
        const file = path.join(moePath, 'daemon.json');
        fs.writeFileSync(file, body + ' '.repeat(bytes - Buffer.byteLength(body)));
        expect(fs.statSync(file).size).toBe(bytes);
        return file;
      }

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('parses a valid 65536-byte daemon.json', () => {
        writePadded(65536);
        expect(readDaemonInfo(testDir)).toEqual({
          port: 3000,
          pid: 12345,
          startedAt: '2024-01-01T00:00:00Z',
          projectPath: testDir,
        });
      });

      it('refuses a 65537-byte daemon.json as non-retryable', () => {
        writePadded(65537);
        expect(readDaemonInfoResult(testDir)).toEqual(OVERSIZE);
        expect(readDaemonInfo(testDir)).toBeNull();
      });

      it('never takes more than 65537 bytes from an 8 MiB file and closes the descriptor once', () => {
        const file = writePadded(8 * 1024 * 1024);
        const readFileSpy = vi.spyOn(fs, 'readFileSync');
        const openSpy = vi.spyOn(fs, 'openSync');
        const readSpy = vi.spyOn(fs, 'readSync');
        const closeSpy = vi.spyOn(fs, 'closeSync');

        expect(readDaemonInfoResult(testDir)).toEqual(OVERSIZE);

        expect(readFileSpy.mock.calls.some((c) => String(c[0]) === file)).toBe(false);
        const opened = openSpy.mock.calls.findIndex((c) => String(c[0]) === file);
        expect(opened).toBeGreaterThanOrEqual(0);
        expect(openSpy.mock.calls.filter((c) => String(c[0]) === file)).toHaveLength(1);
        const fd = openSpy.mock.results[opened].value as number;
        const total = readSpy.mock.calls.reduce((sum, call, i) => (
          call[0] === fd ? sum + (readSpy.mock.results[i].value as number) : sum
        ), 0);
        expect(total).toBe(65537);
        expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
      });

      it('closes the descriptor and reports invalid details when the read throws', () => {
        writePadded(200);
        const openSpy = vi.spyOn(fs, 'openSync');
        const closeSpy = vi.spyOn(fs, 'closeSync');
        vi.spyOn(fs, 'readSync').mockImplementation(() => {
          throw Object.assign(new Error('boom'), { code: 'EIO' });
        });

        expect(readDaemonInfoResult(testDir)).toEqual({
          info: null,
          retryable: false,
          error: 'daemon.json contains invalid daemon connection details',
        });
        const fd = openSpy.mock.results[openSpy.mock.results.length - 1].value as number;
        expect(closeSpy.mock.calls.filter((c) => c[0] === fd)).toHaveLength(1);
      });
    });

    it('returns null for malformed port and pid', () => {
      const moePath = path.join(testDir, '.moe');
      fs.mkdirSync(moePath);
      fs.writeFileSync(path.join(moePath, 'daemon.json'), JSON.stringify({
        port: 0,
        pid: -1,
        startedAt: '2024-01-01T00:00:00Z',
        projectPath: testDir,
      }));

      expect(readDaemonInfo(testDir)).toBeNull();
      expect(readDaemonInfoResult(testDir)).toMatchObject({
        info: null,
        retryable: false,
        error: 'daemon.json contains invalid daemon connection details',
      });
    });

    it('returns null for invalid JSON', () => {
      const moePath = path.join(testDir, '.moe');
      fs.mkdirSync(moePath);
      fs.writeFileSync(path.join(moePath, 'daemon.json'), 'not valid json');

      const result = readDaemonInfo(testDir);
      expect(result).toBeNull();
    });

    it('accepts a Windows-daemon daemon.json read from the WSL mount of the same project', () => {
      // WSL agent scenario: the Windows daemon recorded D:\... while the
      // WSL-side proxy resolves the same directory as /mnt/d/...
      const moePath = path.join(testDir, '.moe');
      fs.mkdirSync(moePath);
      fs.writeFileSync(path.join(moePath, 'daemon.json'), JSON.stringify({
        port: 9876,
        pid: 12345,
        startedAt: '2024-01-01T00:00:00Z',
        projectPath: 'D:\\projexts\\px4swarm',
      }));

      // Can't chdir into /mnt/d in this test env, so exercise the comparison
      // directly and via a daemon.json whose recorded path is the WSL form.
      expect(comparableProjectPath('D:\\projexts\\px4swarm'))
        .toBe(comparableProjectPath('/mnt/d/projexts/px4swarm'));
    });
  });

  describe('comparableProjectPath', () => {
    it('maps Windows and WSL forms of the same directory to one canonical form', () => {
      expect(comparableProjectPath('D:\\projexts\\px4swarm')).toBe('d:/projexts/px4swarm');
      expect(comparableProjectPath('D:/projexts/px4swarm')).toBe('d:/projexts/px4swarm');
      expect(comparableProjectPath('/mnt/d/projexts/px4swarm')).toBe('d:/projexts/px4swarm');
    });

    it('is case-insensitive for drive-letter paths', () => {
      expect(comparableProjectPath('d:\\Projexts\\PX4swarm')).toBe('d:/projexts/px4swarm');
      expect(comparableProjectPath('/mnt/D/Projexts/PX4swarm')).toBe('d:/projexts/px4swarm');
    });

    it('handles drive roots and trailing separators', () => {
      expect(comparableProjectPath('D:\\')).toBe('d:');
      expect(comparableProjectPath('/mnt/d')).toBe('d:');
      expect(comparableProjectPath('/mnt/d/')).toBe('d:');
      expect(comparableProjectPath('D:\\projexts\\')).toBe(comparableProjectPath('/mnt/d/projexts'));
    });

    it('normalizes dot segments in Windows paths', () => {
      expect(comparableProjectPath('D:\\projexts\\sub\\..\\px4swarm')).toBe('d:/projexts/px4swarm');
    });

    it('does not equate different projects', () => {
      expect(comparableProjectPath('/mnt/d/projexts/px4swarm'))
        .not.toBe(comparableProjectPath('D:\\projexts\\other'));
      expect(comparableProjectPath('/mnt/c/projexts/px4swarm'))
        .not.toBe(comparableProjectPath('D:\\projexts\\px4swarm'));
    });
  });

  describe('getDaemonHost', () => {
    const original = process.env.MOE_DAEMON_HOST;

    afterEach(() => {
      if (original === undefined) delete process.env.MOE_DAEMON_HOST;
      else process.env.MOE_DAEMON_HOST = original;
    });

    it('defaults to loopback', () => {
      delete process.env.MOE_DAEMON_HOST;
      expect(getDaemonHost()).toBe('127.0.0.1');
    });

    it('honors MOE_DAEMON_HOST override', () => {
      process.env.MOE_DAEMON_HOST = '172.29.16.1';
      expect(getDaemonHost()).toBe('172.29.16.1');
    });
  });

  describe('getProjectPath', () => {
    const originalEnv = process.env.MOE_PROJECT_PATH;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.MOE_PROJECT_PATH;
      } else {
        process.env.MOE_PROJECT_PATH = originalEnv;
      }
    });

    it('returns MOE_PROJECT_PATH if set', () => {
      process.env.MOE_PROJECT_PATH = '/custom/path';
      expect(getProjectPath()).toBe('/custom/path');
    });

    it('returns cwd if MOE_PROJECT_PATH not set', () => {
      delete process.env.MOE_PROJECT_PATH;
      expect(getProjectPath()).toBe(process.cwd());
    });
  });

  describe('formatError', () => {
    it('formats error as JSON-RPC error response', () => {
      const result = formatError('Something went wrong');
      const parsed = JSON.parse(result);

      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBeNull();
      expect(parsed.error.code).toBe(-32000);
      expect(parsed.error.message).toBe('Something went wrong');
    });

    it('handles special characters in message', () => {
      const result = formatError('Error with "quotes" and\nnewlines');
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });

  describe('isValidJson', () => {
    it('returns true for valid JSON object', () => {
      expect(isValidJson('{"key": "value"}')).toBe(true);
    });

    it('returns true for valid JSON array', () => {
      expect(isValidJson('[1, 2, 3]')).toBe(true);
    });

    it('returns true for valid JSON primitives', () => {
      expect(isValidJson('"string"')).toBe(true);
      expect(isValidJson('123')).toBe(true);
      expect(isValidJson('true')).toBe(true);
      expect(isValidJson('null')).toBe(true);
    });

    it('returns false for invalid JSON', () => {
      expect(isValidJson('not json')).toBe(false);
      expect(isValidJson('{invalid}')).toBe(false);
      expect(isValidJson('')).toBe(false);
    });

    it('returns false for partial JSON', () => {
      expect(isValidJson('{"key":')).toBe(false);
      expect(isValidJson('[1, 2,')).toBe(false);
    });
  });

  describe('parseJsonLines', () => {
    it('parses single line', () => {
      const result = parseJsonLines('{"id": 1}\n');
      expect(result.lines).toEqual(['{"id": 1}']);
      expect(result.remaining).toBe('');
    });

    it('parses multiple lines', () => {
      const result = parseJsonLines('{"id": 1}\n{"id": 2}\n{"id": 3}\n');
      expect(result.lines).toEqual(['{"id": 1}', '{"id": 2}', '{"id": 3}']);
      expect(result.remaining).toBe('');
    });

    it('keeps incomplete line in remaining', () => {
      const result = parseJsonLines('{"id": 1}\n{"incomplete');
      expect(result.lines).toEqual(['{"id": 1}']);
      expect(result.remaining).toBe('{"incomplete');
    });

    it('handles empty input', () => {
      const result = parseJsonLines('');
      expect(result.lines).toEqual([]);
      expect(result.remaining).toBe('');
    });

    it('skips empty lines', () => {
      const result = parseJsonLines('{"id": 1}\n\n{"id": 2}\n');
      expect(result.lines).toEqual(['{"id": 1}', '{"id": 2}']);
    });

    it('trims whitespace from lines', () => {
      const result = parseJsonLines('  {"id": 1}  \n');
      expect(result.lines).toEqual(['{"id": 1}']);
    });

    it('handles Windows line endings', () => {
      const result = parseJsonLines('{"id": 1}\r\n{"id": 2}\r\n');
      // After splitting on \n, we get {"id": 1}\r and {"id": 2}\r
      // trim() removes \r
      expect(result.lines).toEqual(['{"id": 1}', '{"id": 2}']);
    });

    it('handles no newline at end', () => {
      const result = parseJsonLines('{"id": 1}');
      expect(result.lines).toEqual([]);
      expect(result.remaining).toBe('{"id": 1}');
    });
  });

  describe('injectWorkerId', () => {
    it('injects workerId for tools/call when missing and env is set', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'moe.start_step', arguments: { taskId: 't1', stepId: 's1' } },
      };
      const mutated = injectWorkerId(parsed, 'worker-abc');
      expect(mutated).toBe(true);
      expect((parsed.params.arguments as Record<string, unknown>).workerId).toBe('worker-abc');
    });

    it('does not overwrite explicit workerId', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'moe.start_step', arguments: { taskId: 't1', workerId: 'qa-x' } },
      };
      const mutated = injectWorkerId(parsed, 'worker-abc');
      expect(mutated).toBe(false);
      expect((parsed.params.arguments as Record<string, unknown>).workerId).toBe('qa-x');
    });

    it('is a no-op when envWorkerId is undefined', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'moe.start_step', arguments: { taskId: 't1' } },
      };
      expect(injectWorkerId(parsed, undefined)).toBe(false);
      expect((parsed.params.arguments as Record<string, unknown>).workerId).toBeUndefined();
    });

    // The grok MCP config pins `MOE_WORKER_ID = "${MOE_WORKER_ID:-}"`, which grok
    // expands to "" when a human runs `grok` by hand (no wrapper, no seat). An
    // empty id must behave exactly like an unset one — never `workerId: ""`.
    it('treats an EMPTY envWorkerId as unset (grok expands ${MOE_WORKER_ID:-} to "")', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'moe.start_step', arguments: { taskId: 't1' } },
      };
      expect(injectWorkerId(parsed, '')).toBe(false);
      expect((parsed.params.arguments as Record<string, unknown>).workerId).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(parsed.params.arguments, 'workerId')).toBe(false);
    });

    it('treats a whitespace-only envWorkerId as unset', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'moe.start_step', arguments: { taskId: 't1' } },
      };
      expect(injectWorkerId(parsed, '   ')).toBe(false);
      expect((parsed.params.arguments as Record<string, unknown>).workerId).toBeUndefined();
    });

    it('injects workerId into tools/list params, creating params when absent', () => {
      const withParams = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'c' } } as Record<string, unknown>;
      expect(injectWorkerId(withParams, 'worker-abc')).toBe(true);
      expect(withParams.params).toEqual({ cursor: 'c', workerId: 'worker-abc' });
      const bare = { jsonrpc: '2.0', id: 2, method: 'tools/list' } as Record<string, unknown>;
      expect(injectWorkerId(bare, 'worker-abc')).toBe(true);
      expect(bare.params).toEqual({ workerId: 'worker-abc' });
      expect(injectWorkerId({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, '')).toBe(false);
    });

    it('does nothing for non-tool methods', () => {
      const cases = [
        { method: 'initialize', params: {} },
        { method: 'ping' },
      ];
      for (const c of cases) {
        const parsed = { jsonrpc: '2.0', id: 1, ...c } as Record<string, unknown>;
        expect(injectWorkerId(parsed, 'worker-abc')).toBe(false);
      }
    });

    it('is a no-op when params.arguments is missing', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'moe.start_step' },
      };
      expect(injectWorkerId(parsed, 'worker-abc')).toBe(false);
    });

    it('is a no-op when arguments is an array (malformed)', () => {
      const parsed = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'x', arguments: [1, 2] },
      };
      expect(injectWorkerId(parsed, 'worker-abc')).toBe(false);
    });

    it('survives malformed params without throwing', () => {
      expect(injectWorkerId({ method: 'tools/call', params: 'bad' }, 'worker-abc')).toBe(false);
      expect(injectWorkerId(null, 'worker-abc')).toBe(false);
      expect(injectWorkerId(42, 'worker-abc')).toBe(false);
    });
  });
});

describe('injectWorkerId: tools where workerId is a filter', () => {
  // Regression, 2026-09-02: `get_activity_log { taskId }` from a governor seat
  // returned 0 events while 12 matched, because the proxy injected
  // workerId: "governor-..." and the daemon ANDs taskId with workerId. A task
  // audit came back empty and looked authoritative — a wrong answer, not an error.
  it('does NOT inject into moe_get_activity_log, whose workerId is a query filter', () => {
    const msg = {
      method: 'tools/call',
      params: { name: 'moe_get_activity_log', arguments: { taskId: 'task-1' } },
    };
    const mutated = injectWorkerId(msg, 'governor-1');
    expect(mutated).toBe(false);
    expect(msg.params.arguments).toEqual({ taskId: 'task-1' });
  });

  it('still injects into an ordinary tool that omits workerId', () => {
    const msg = {
      method: 'tools/call',
      params: { name: 'moe_complete_step', arguments: { taskId: 'task-1' } },
    };
    const mutated = injectWorkerId(msg, 'worker-1');
    expect(mutated).toBe(true);
    expect((msg.params.arguments as Record<string, unknown>).workerId).toBe('worker-1');
  });

  it('still respects an explicit workerId on a filter tool', () => {
    const msg = {
      method: 'tools/call',
      params: { name: 'moe_get_activity_log', arguments: { workerId: 'worker-9' } },
    };
    expect(injectWorkerId(msg, 'governor-1')).toBe(false);
    expect((msg.params.arguments as Record<string, unknown>).workerId).toBe('worker-9');
  });
  describe('tool-name style', () => {
    it('reads the style from the env, defaulting to dot', () => {
      expect(toolNameStyleFromEnv(undefined)).toBe('dot');
      expect(toolNameStyleFromEnv('')).toBe('dot');
      expect(toolNameStyleFromEnv('dot')).toBe('dot');
      expect(toolNameStyleFromEnv('underscore')).toBe('underscore');
      expect(toolNameStyleFromEnv(' UNDERSCORE ')).toBe('underscore');
      expect(toolNameStyleFromEnv('camel')).toBe('dot');
    });

    it('exposes moe.<name> as moe_<name> only in underscore style', () => {
      expect(exposeToolName('moe.submit_plan', 'underscore')).toBe('moe_submit_plan');
      expect(exposeToolName('moe.submit_plan', 'dot')).toBe('moe.submit_plan');
      expect(exposeToolName('plain', 'underscore')).toBe('plain');
    });

    it('rewrites a tools/list result in place and records the aliases', () => {
      const aliases = new Map<string, string>();
      const msg = { jsonrpc: '2.0', id: 7, result: { tools: [
        { name: 'moe.get_context', description: 'd', inputSchema: {} },
        { name: 'moe.wait_for_task', description: 'd', inputSchema: {} },
        { name: 'plain', description: 'd', inputSchema: {} },
      ] } };
      expect(rewriteToolsListResult(msg, 'underscore', aliases)).toBe(true);
      expect(msg.result.tools.map((t) => t.name)).toEqual(['moe_get_context', 'moe_wait_for_task', 'plain']);
      expect(aliases.get('moe_get_context')).toBe('moe.get_context');
      expect(aliases.get('moe_wait_for_task')).toBe('moe.wait_for_task');
      expect(aliases.has('plain')).toBe(false);
    });

    it('leaves a tools/list result alone in dot style and on odd shapes', () => {
      const aliases = new Map<string, string>();
      const msg = { jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'moe.get_context' }] } };
      expect(rewriteToolsListResult(msg, 'dot', aliases)).toBe(false);
      expect(msg.result.tools[0].name).toBe('moe.get_context');
      expect(rewriteToolsListResult({ jsonrpc: '2.0', id: 7, error: { code: -1, message: 'x' } }, 'underscore', aliases)).toBe(false);
      expect(rewriteToolsListResult(null, 'underscore', aliases)).toBe(false);
      expect(rewriteToolsListResult({ result: { tools: 'nope' } }, 'underscore', aliases)).toBe(false);
    });

    it('the activity-log filter guard holds for the daemon spelling, reached via the alias', () => {
      // The daemon dispatches exactly `moe.get_activity_log`; index.ts runs
      // resolveToolCallName BEFORE injectWorkerId, so the guard must match
      // the wire name or a governor's { taskId } audit gets its own seat ANDed in.
      for (const sent of ['moe_get_activity_log', 'moe.get_activity_log']) {
        const msg = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: sent, arguments: { taskId: 'task-1' } } };
        resolveToolCallName(msg, new Map());
        expect(msg.params.name).toBe('moe.get_activity_log');
        expect(injectWorkerId(msg, 'governor-1')).toBe(false);
        expect(msg.params.arguments).toEqual({ taskId: 'task-1' });
      }
      // …while an ordinary tool still gets the seat injected after the alias hop.
      const other = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'moe_get_context', arguments: {} } };
      resolveToolCallName(other, new Map());
      expect(injectWorkerId(other, 'governor-1')).toBe(true);
      expect(other.params.arguments).toEqual({ workerId: 'governor-1' });
    });

    it('maps a recorded alias back on tools/call, and moe_<name> by prefix rule otherwise', () => {
      const aliases = new Map<string, string>([['moe_get_context', 'moe.get_context']]);
      const recorded = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'moe_get_context', arguments: {} } };
      expect(resolveToolCallName(recorded, aliases)).toBe(true);
      expect(recorded.params.name).toBe('moe.get_context');

      const guessed = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'moe_submit_plan', arguments: {} } };
      expect(resolveToolCallName(guessed, aliases)).toBe(true);
      expect(guessed.params.name).toBe('moe.submit_plan');

      const daemonName = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'moe.submit_plan', arguments: {} } };
      expect(resolveToolCallName(daemonName, aliases)).toBe(false);
      expect(daemonName.params.name).toBe('moe.submit_plan');

      const other = { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'serena_read', arguments: {} } };
      expect(resolveToolCallName(other, aliases)).toBe(false);
      expect(resolveToolCallName({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, aliases)).toBe(false);
      expect(resolveToolCallName(null, aliases)).toBe(false);
    });
  });
});

describe('injectRunnerIdentity', () => {
  const STARTED = '4242@133729817190000000';
  const HOST = 'build-box';
  const claim = (args: Record<string, unknown>, name = 'moe.claim_next_task') =>
    ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

  // An architect plans up to 10 rows in one session, each claimed in-session.
  // Without the pair those attempts could never be reattached after a daemon
  // restart, and the reconcile sweep released the row under the live session.
  it('adds the pair to a claim that carries neither key', () => {
    const msg = claim({ statuses: ['PLANNING'], workerId: 'architect-1' });
    expect(injectRunnerIdentity(msg, STARTED, HOST)).toBe(true);
    expect(msg.params.arguments).toEqual({ statuses: ['PLANNING'], workerId: 'architect-1', processStartedAt: STARTED, host: HOST });
  });

  it('matches every spelling of the claim tool, and the daemon name reached via the alias', () => {
    for (const name of ['moe_claim_next_task', 'claim_next_task']) {
      const msg = claim({}, name);
      expect(injectRunnerIdentity(msg, STARTED, HOST)).toBe(true);
    }
    const aliased = claim({}, 'moe_claim_next_task');
    resolveToolCallName(aliased, new Map());
    expect(aliased.params.name).toBe('moe.claim_next_task');
    expect(injectRunnerIdentity(aliased, STARTED, HOST)).toBe(true);
  });

  it('leaves a claim that names either key alone (the wrapper pre-flight sends its own)', () => {
    const both = claim({ processStartedAt: 'x@1', host: 'h' });
    expect(injectRunnerIdentity(both, STARTED, HOST)).toBe(false);
    expect(both.params.arguments).toEqual({ processStartedAt: 'x@1', host: 'h' });
    // Half a pair is the caller's to own: the daemon refuses it either way.
    const half = claim({ host: 'h' });
    expect(injectRunnerIdentity(half, STARTED, HOST)).toBe(false);
    expect(half.params.arguments).toEqual({ host: 'h' });
  });

  it('needs both env values: one alone, blank or whitespace counts as unset', () => {
    for (const [started, host] of [[undefined, HOST], [STARTED, undefined], ['', HOST], [STARTED, ''], ['  ', HOST], [STARTED, ' ']]) {
      const msg = claim({});
      expect(injectRunnerIdentity(msg, started, host)).toBe(false);
      expect(msg.params.arguments).toEqual({});
    }
  });

  it('sends the values verbatim, because the daemon compares exact strings', () => {
    const msg = claim({});
    expect(injectRunnerIdentity(msg, ' 4242@1 ', 'Host.Local')).toBe(true);
    expect(msg.params.arguments).toEqual({ processStartedAt: ' 4242@1 ', host: 'Host.Local' });
  });

  it('touches no other tool and no other method', () => {
    for (const name of ['moe.wait_for_task', 'moe.get_context', 'moe.reattach_attempt', 'serena_find_symbol']) {
      const msg = claim({}, name);
      expect(injectRunnerIdentity(msg, STARTED, HOST)).toBe(false);
      expect(msg.params.arguments).toEqual({});
    }
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    expect(injectRunnerIdentity(list, STARTED, HOST)).toBe(false);
    expect(list.params).toEqual({});
  });

  it('survives malformed messages without throwing', () => {
    expect(injectRunnerIdentity(null, STARTED, HOST)).toBe(false);
    expect(injectRunnerIdentity(42, STARTED, HOST)).toBe(false);
    expect(injectRunnerIdentity({ method: 'tools/call', params: 'bad' }, STARTED, HOST)).toBe(false);
    expect(injectRunnerIdentity({ method: 'tools/call', params: { name: 'moe.claim_next_task' } }, STARTED, HOST)).toBe(false);
    expect(injectRunnerIdentity({ method: 'tools/call', params: { name: 'moe.claim_next_task', arguments: [1] } }, STARTED, HOST)).toBe(false);
    expect(injectRunnerIdentity({ method: 'tools/call', params: { name: 7, arguments: {} } }, STARTED, HOST)).toBe(false);
  });
});

describe('stampExecutionIdentity', () => {
  const SESSION = 'worker-t@2026-10-26T00:00:00Z';
  const FULL = { MOE_SESSION_ID: SESSION, MOE_ATTEMPT_ID: 'attempt-0123', MOE_ATTEMPT_GENERATION: '7' };
  const IDENTITY = { attemptId: 'attempt-0123', generation: 7, sessionId: SESSION };
  const MARK = 'Qz7Marker';
  const call = (name: string, args: unknown = { taskId: 't1', stepId: 's1' }) =>
    ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const refusal = (code: number, codeName: string) => expect.objectContaining({ code, codeName });
  const messageOf = (result: unknown) => String((result as { message?: unknown }).message);

  it('is the legacy proxy when the session carries no identity, even for presented fields', () => {
    for (const env of [{}, { MOE_SESSION_ID: '', MOE_ATTEMPT_ID: '  ', MOE_ATTEMPT_GENERATION: '' }]) {
      for (const args of [{ taskId: 't1' }, { taskId: 't1', attemptId: 'x' }, { taskId: 't1', generation: '7' }]) {
        for (const name of ['moe.get_context', 'moe.start_step']) {
          const msg = call(name, { ...args });
          expect(stampExecutionIdentity(msg, env)).toBe(false);
          expect(msg.params.arguments).toEqual(args);
        }
      }
    }
  });

  it('stamps only sessionId from a session-only env', () => {
    for (const name of ['moe.get_context', 'moe.start_step']) {
      const msg = call(name, { taskId: 't1' });
      expect(stampExecutionIdentity(msg, { MOE_SESSION_ID: SESSION })).toBe(true);
      expect(msg.params.arguments).toEqual({ taskId: 't1', sessionId: SESSION });
    }
  });

  it('stamps all three onto start_step, with generation a number, and only sessionId onto get_context', () => {
    const step = call('moe.start_step');
    expect(stampExecutionIdentity(step, FULL)).toBe(true);
    expect(step.params.arguments).toEqual({ taskId: 't1', stepId: 's1', ...IDENTITY });
    const ctx = call('moe.get_context', { taskId: 't1' });
    expect(stampExecutionIdentity(ctx, FULL)).toBe(true);
    expect(ctx.params.arguments).toEqual({ taskId: 't1', sessionId: SESSION });
  });

  it('accepts presented values equal to the env and completes the rest', () => {
    for (const presented of [IDENTITY, { attemptId: 'attempt-0123' }, { generation: 7 }, { sessionId: SESSION }]) {
      const msg = call('moe.start_step', { taskId: 't1', stepId: 's1', ...presented });
      expect(stampExecutionIdentity(msg, FULL)).toBe(true);
      expect(msg.params.arguments).toEqual({ taskId: 't1', stepId: 's1', ...IDENTITY });
    }
  });

  it('refuses a substituted field without coercing or mutating', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['moe.start_step', { attemptId: 'attempt-other' }], ['moe.start_step', { attemptId: null }],
      ['moe.start_step', { generation: '7' }], ['moe.start_step', { generation: 8 }], ['moe.start_step', { generation: null }],
      ['moe.start_step', { sessionId: `${SESSION} ` }], ['moe.get_context', { sessionId: 'worker-t@other' }],
    ];
    for (const [name, presented] of cases) {
      const msg = call(name, { taskId: 't1', ...presented });
      const result = stampExecutionIdentity(msg, FULL);
      expect(result).toEqual(refusal(-32003, 'EXECUTION_IDENTITY_SUBSTITUTED'));
      expect(msg.params.arguments).toEqual({ taskId: 't1', ...presented });
      expect(messageOf(result)).not.toContain('attempt-');
    }
  });

  it('refuses start_step on a partial attempt env, while get_context still gets sessionId', () => {
    for (const env of [{ MOE_SESSION_ID: SESSION, MOE_ATTEMPT_ID: 'attempt-0123' }, { MOE_SESSION_ID: SESSION, MOE_ATTEMPT_GENERATION: '7', MOE_ATTEMPT_ID: ' ' }]) {
      const step = call('moe.start_step');
      expect(stampExecutionIdentity(step, env)).toEqual(refusal(-32602, 'EXECUTION_IDENTITY_INVALID'));
      expect(step.params.arguments).toEqual({ taskId: 't1', stepId: 's1' });
      const ctx = call('moe.get_context', { taskId: 't1' });
      expect(stampExecutionIdentity(ctx, env)).toBe(true);
      expect(ctx.params.arguments).toEqual({ taskId: 't1', sessionId: SESSION });
    }
  });

  it('refuses a malformed env value, adding nothing and echoing nothing', () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ...['0', '07', '+7', '7.0', '1e3', ' 7', '7 ', '7\n', '-1', 'abc', '9007199254740992']
        .map((g): [string, Record<string, string>, string] => ['moe.start_step', { ...FULL, MOE_ATTEMPT_GENERATION: g }, g]),
      ...[`a b${MARK}`, `a/b${MARK}`, `\u00e9${MARK}`, MARK + 'a'.repeat(129 - MARK.length)]
        .map((a): [string, Record<string, string>, string] => ['moe.start_step', { ...FULL, MOE_ATTEMPT_ID: a }, a]),
      ...[MARK + 'x'.repeat(256 - MARK.length), `${MARK}\nx`, `${MARK}\rx`, `${MARK}\u0000x`]
        .flatMap((s): Array<[string, Record<string, string>, string]> =>
          ['moe.start_step', 'moe.get_context'].map((name): [string, Record<string, string>, string] => [name, { ...FULL, MOE_SESSION_ID: s }, s])),
    ];
    for (const [name, env, bad] of cases) {
      const msg = call(name, { taskId: 't1' });
      const result = stampExecutionIdentity(msg, env);
      expect(result).toEqual(refusal(-32602, 'EXECUTION_IDENTITY_INVALID'));
      expect(msg.params.arguments).toEqual({ taskId: 't1' });
      expect(messageOf(result)).not.toContain(bad.trim());
      expect(messageOf(result)).not.toContain(MARK);
    }
  });

  it('accepts the boundary values', () => {
    const env = { MOE_SESSION_ID: 's'.repeat(255), MOE_ATTEMPT_ID: 'a'.repeat(128), MOE_ATTEMPT_GENERATION: '9007199254740991' };
    const msg = call('moe.start_step', {});
    expect(stampExecutionIdentity(msg, env)).toBe(true);
    expect(msg.params.arguments).toEqual({ attemptId: 'a'.repeat(128), generation: 9007199254740991, sessionId: 's'.repeat(255) });
  });

  it('fails closed when an argument cannot be read', () => {
    const args = { taskId: 't1' };
    Object.defineProperty(args, 'attemptId', { enumerable: true, get() { throw new Error('boom'); } });
    expect(stampExecutionIdentity(call('moe.start_step', args), FULL)).toEqual(refusal(-32602, 'EXECUTION_IDENTITY_INVALID'));
  });

  it('matches every spelling of the carried tools and nothing else', () => {
    const aliased = call('moe_start_step');
    expect(resolveToolCallName(aliased, new Map())).toBe(true);
    for (const msg of [call('moe_start_step'), call('start_step'), aliased]) {
      expect(stampExecutionIdentity(msg, FULL)).toBe(true);
      expect(msg.params.arguments).toEqual({ taskId: 't1', stepId: 's1', ...IDENTITY });
    }
    for (const name of ['moe.claim_next_task', 'moe.heartbeat', 'moe.complete_steps', 'moe.complete', 'moe.qa_approve',
      'moe.submit_plan', 'moe.report_blocked', 'moe.get_activity_log', 'moe.reattach_attempt', 'constructor', 'toString',
      'hasOwnProperty']) {
      const msg = call(name);
      expect(stampExecutionIdentity(msg, FULL)).toBe(false);
      expect(msg.params.arguments).toEqual({ taskId: 't1', stepId: 's1' });
    }
    const odd: unknown[] = [null, 42, 'x', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { method: 'tools/call', params: null }, { method: 'tools/call', params: { name: 7, arguments: {} } },
      call('moe.start_step', null), call('moe.start_step', []), { method: 'tools/call', params: { name: 'moe.start_step' } }];
    for (const shape of odd) {
      const before = JSON.stringify(shape);
      expect(stampExecutionIdentity(shape, FULL)).toBe(false);
      expect(JSON.stringify(shape)).toBe(before);
    }
  });

  // CQ-F12a: the completion tools carry the same attempt + session groups as start_step.
  describe.each([
    ['complete_step', { taskId: 't1', stepId: 's1' }],
    ['complete_task', { taskId: 't1' }],
  ])('%s', (tool, base) => {
    const msgFor = (name: string, extra: Record<string, unknown> = {}) => call(name, { ...base, ...extra });

    it('stamps the full identity under every spelling, with generation a number', () => {
      const aliased = msgFor(`moe_${tool}`);
      expect(resolveToolCallName(aliased, new Map())).toBe(true);
      for (const msg of [msgFor(`moe.${tool}`), msgFor(`moe_${tool}`), msgFor(tool), aliased]) {
        expect(stampExecutionIdentity(msg, FULL)).toBe(true);
        expect(msg.params.arguments).toEqual({ ...base, ...IDENTITY });
        expect(typeof (msg.params.arguments as { generation: unknown }).generation).toBe('number');
      }
    });

    it('stamps only sessionId from a session-only env', () => {
      const msg = msgFor(`moe.${tool}`);
      expect(stampExecutionIdentity(msg, { MOE_SESSION_ID: SESSION })).toBe(true);
      expect(msg.params.arguments).toEqual({ ...base, sessionId: SESSION });
    });

    it('is the legacy passthrough when the session carries no identity, even for presented fields', () => {
      for (const env of [{}, { MOE_SESSION_ID: '', MOE_ATTEMPT_ID: '  ', MOE_ATTEMPT_GENERATION: '' }]) {
        for (const extra of [{}, { attemptId: 'x' }, { generation: '7' }]) {
          const msg = msgFor(`moe.${tool}`, extra);
          expect(stampExecutionIdentity(msg, env)).toBe(false);
          expect(msg.params.arguments).toEqual({ ...base, ...extra });
        }
      }
    });

    it('accepts presented values equal to the env and completes the rest', () => {
      for (const presented of [IDENTITY, { attemptId: 'attempt-0123' }, { generation: 7 }, { sessionId: SESSION }]) {
        const msg = msgFor(`moe.${tool}`, presented);
        expect(stampExecutionIdentity(msg, FULL)).toBe(true);
        expect(msg.params.arguments).toEqual({ ...base, ...IDENTITY });
      }
    });

    it('refuses a substituted field under every spelling without coercing, mutating or echoing', () => {
      const cases: Array<Record<string, unknown>> = [
        { attemptId: 'attempt-other' }, { attemptId: null }, { generation: '7' }, { generation: 8 },
        { generation: null }, { sessionId: `${SESSION} ` },
      ];
      for (const presented of cases) {
        for (const name of [`moe.${tool}`, `moe_${tool}`, tool]) {
          const msg = msgFor(name, presented);
          const result = stampExecutionIdentity(msg, FULL);
          expect(result).toEqual(refusal(-32003, 'EXECUTION_IDENTITY_SUBSTITUTED'));
          expect(msg.params.arguments).toEqual({ ...base, ...presented });
          expect(messageOf(result)).not.toContain('attempt-');
        }
      }
    });

    it('refuses a partial attempt env without mutating', () => {
      for (const env of [{ MOE_SESSION_ID: SESSION, MOE_ATTEMPT_ID: 'attempt-0123' },
        { MOE_SESSION_ID: SESSION, MOE_ATTEMPT_GENERATION: '7', MOE_ATTEMPT_ID: ' ' }]) {
        const msg = msgFor(`moe.${tool}`);
        expect(stampExecutionIdentity(msg, env)).toEqual(refusal(-32602, 'EXECUTION_IDENTITY_INVALID'));
        expect(msg.params.arguments).toEqual(base);
      }
    });

    it('refuses a malformed env value, adding nothing and echoing nothing', () => {
      const cases: Array<[Record<string, string>, string]> = [
        ...['0', '07', '1e3', '9007199254740992']
          .map((g): [Record<string, string>, string] => [{ ...FULL, MOE_ATTEMPT_GENERATION: g }, g]),
        [{ ...FULL, MOE_ATTEMPT_ID: `a b${MARK}` }, `a b${MARK}`],
        [{ ...FULL, MOE_SESSION_ID: `${MARK}\nx` }, `${MARK}\nx`],
        [{ ...FULL, MOE_SESSION_ID: MARK + 'x'.repeat(256 - MARK.length) }, MARK + 'x'.repeat(256 - MARK.length)],
      ];
      for (const [env, bad] of cases) {
        const msg = msgFor(`moe.${tool}`);
        const result = stampExecutionIdentity(msg, env);
        expect(result).toEqual(refusal(-32602, 'EXECUTION_IDENTITY_INVALID'));
        expect(msg.params.arguments).toEqual(base);
        expect(messageOf(result)).not.toContain(bad.trim());
        expect(messageOf(result)).not.toContain(MARK);
      }
    });
  });
});
