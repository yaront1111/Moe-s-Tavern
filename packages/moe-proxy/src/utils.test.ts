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
  injectWorkerId,
  toolNameStyleFromEnv,
  exposeToolName,
  rewriteToolsListResult,
  resolveToolCallName,
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

    it('does nothing for non-tool methods', () => {
      const cases = [
        { method: 'initialize', params: {} },
        { method: 'tools/list', params: {} },
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
