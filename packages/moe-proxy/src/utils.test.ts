import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readDaemonInfo,
  getProjectPath,
  formatError,
  isValidJson,
  parseJsonLines,
  injectWorkerId,
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

    it('returns null for invalid JSON', () => {
      const moePath = path.join(testDir, '.moe');
      fs.mkdirSync(moePath);
      fs.writeFileSync(path.join(moePath, 'daemon.json'), 'not valid json');

      const result = readDaemonInfo(testDir);
      expect(result).toBeNull();
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
