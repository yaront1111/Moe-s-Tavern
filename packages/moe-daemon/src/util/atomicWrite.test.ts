import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { atomicWriteJson, atomicWriteJsonAsync, atomicWriteText, atomicWriteTextAsync } from './atomicWrite.js';
import { writeJsonAtomic } from '../accounts/registry.js';
import { StateManager } from '../state/StateManager.js';
import { initProjectTool } from '../tools/initProject.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { acquireLock, initProject, writeDaemonInfo } from '../index.js';

describe('atomicWriteText — synchronous rename backoff (L3)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-atomicwrite-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('writes successfully on the happy path', () => {
    const target = path.join(testDir, 'out.json');
    atomicWriteText(target, 'hello');
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  it('backs off between retries instead of burning all attempts instantly', () => {
    const target = path.join(testDir, 'retry.json');
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      calls += 1;
      // Fail the first two attempts with a retryable Windows-style lock error,
      // then let the real rename through.
      if (calls <= 2) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realRename(from as string, to as string);
    }) as typeof fs.renameSync);

    const start = Date.now();
    atomicWriteText(target, 'world');
    const elapsed = Date.now() - start;

    spy.mockRestore();

    expect(calls).toBe(3);
    expect(fs.readFileSync(target, 'utf-8')).toBe('world');
    // Two failures → ~10ms + ~20ms of backoff. Assert a conservative lower
    // bound that the zero-backoff implementation could never satisfy.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it('still throws after exhausting retries (cleaning up the temp file)', () => {
    const target = path.join(testDir, 'always-fail.json');
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((() => {
      const err = new Error('EBUSY: resource busy or locked, rename') as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    }) as typeof fs.renameSync);

    expect(() => atomicWriteText(target, 'nope')).toThrowError(/EBUSY/);
    // 5 attempts, all failing.
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();

    // Temp file must be cleaned up, target must not exist.
    expect(fs.existsSync(target)).toBe(false);
    const leftovers = fs.readdirSync(testDir).filter((f) => f.includes('always-fail.json'));
    expect(leftovers).toEqual([]);
  });
});

// Numeric code points only: the tool layer decodes escape text, so no raw
// target character may ever appear in this file's bytes.
const slash = String.fromCharCode(92);
const TARGET_CPS = [
  0x061c,
  ...Array.from({ length: 5 }, (_, i) => 0x200b + i),
  ...Array.from({ length: 7 }, (_, i) => 0x2028 + i),
  ...Array.from({ length: 16 }, (_, i) => 0x2060 + i),
  0xfeff,
];
const hidden = String.fromCodePoint(...TARGET_CPS);
const esc = (cp: number): string => slash + 'u' + cp.toString(16).padStart(4, '0');
const neighbors = [0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0x2070, 0xfefe, 0xff00]
  .map((cp) => String.fromCodePoint(cp)).join('');
const ordinary = [
  String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd), // Hebrew
  String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627), // Arabic
  'caf' + String.fromCodePoint(0xe9), // accented
  String.fromCodePoint(0x1f600), // emoji (surrogate pair)
].join(' ');

function expectEscaped(raw: string): void {
  for (const cp of TARGET_CPS) {
    expect(raw.includes(String.fromCodePoint(cp)), `raw U+${cp.toString(16)} present`).toBe(false);
    expect(raw, `escape for U+${cp.toString(16)}`).toContain(esc(cp));
  }
}

function sample() {
  return {
    [hidden]: 'value-' + hidden,
    nested: { list: [hidden, 'a' + hidden + 'b', { deep: [hidden], [hidden + 'k']: null }], empty: {}, none: [] },
    literal: slash + 'u202e',
    backslashed: slash + hidden, // a real backslash directly before a target char
    quotes: 'q"uote' + slash + 'back\nline\ttab',
    ordinary,
    neighbors,
  };
}

describe.each([
  ['atomicWriteJson', async (f: string, o: unknown) => atomicWriteJson(f, o)],
  ['atomicWriteJsonAsync', atomicWriteJsonAsync],
] as const)('%s — hidden format characters', (_name, write) => {
  let testDir: string;
  beforeEach(() => { testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-atomicjson-')); });
  afterEach(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  it('escapes every target code point (keys, nested, arrays) and keeps values identical', async () => {
    const target = path.join(testDir, 'out.json');
    const input = sample();
    for (let i = 0; i < 3; i++) {
      await write(target, input);
      const raw = fs.readFileSync(target, 'utf-8');
      expectEscaped(raw);
      expect(JSON.parse(raw)).toEqual(input);
      expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(input)));
    }
    expect(fs.readdirSync(testDir)).toEqual(['out.json']);
  });

  it('leaves non-target Unicode raw and does not re-escape literal escape text', async () => {
    const target = path.join(testDir, 'plain.json');
    const input = { ordinary, neighbors, literal: slash + 'u202e', quote: 'a"b' };
    await write(target, input);
    const raw = fs.readFileSync(target, 'utf-8');
    expect(raw).toBe(JSON.stringify(input, null, 2));
    expect(raw).toContain(ordinary);
    expect(raw).toContain(neighbors);
    expect(JSON.parse(raw)).toEqual(input);
  });

  it('keeps large values intact and survives concurrent writes', async () => {
    const big = { text: 'x'.repeat(200_000) + hidden + 'y'.repeat(200_000) + hidden };
    const files = Array.from({ length: 6 }, (_, i) => path.join(testDir, `c${i}.json`));
    await Promise.all(files.map((f) => write(f, big)));
    for (const f of files) {
      const raw = fs.readFileSync(f, 'utf-8');
      expectEscaped(raw);
      expect(JSON.parse(raw)).toEqual(big);
    }
  });

  it('rejects circular and BigInt input, leaving the target and directory untouched', async () => {
    const target = path.join(testDir, 'keep.json');
    await write(target, { ok: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of [circular, { n: BigInt(1) }]) {
      await expect(write(target, bad)).rejects.toThrow();
    }
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ ok: true });
    expect(fs.readdirSync(testDir)).toEqual(['keep.json']);
  });
});

describe('text writers stay byte-exact', () => {
  it('writes hidden characters unchanged to a .txt target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-atomictext-'));
    try {
      const syncFile = path.join(dir, 'a.txt');
      const asyncFile = path.join(dir, 'b.txt');
      atomicWriteText(syncFile, hidden);
      await atomicWriteTextAsync(asyncFile, hidden);
      expect(fs.readFileSync(syncFile, 'utf-8')).toBe(hidden);
      expect(fs.readFileSync(asyncFile, 'utf-8')).toBe(hidden);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('task record persistence', () => {
  const h = new ToolTestHarness();
  beforeEach(() => h.init());
  afterEach(() => h.cleanup());

  it('writes a note/summary carrying U+202E without the raw character and reads it back identical', async () => {
    h.setupMoeFolder();
    h.createEpic();
    const task = h.createTask({ status: 'WORKING' });
    await h.state.load();
    const rlo = String.fromCodePoint(0x202e);
    const note = 'note-before' + rlo + 'note-after';
    const summary = 'summary-before' + rlo + 'summary-after';

    await h.state.updateTask(task.id, {
      implementationPlan: [{ stepId: 'step-1', description: 'persist note', status: 'COMPLETED', affectedFiles: [], note }],
      completionSummary: summary,
    });

    const raw = fs.readFileSync(path.join(h.moePath, 'tasks', `${task.id}.json`), 'utf-8');
    expect(raw.includes(rlo)).toBe(false);
    expect(raw).toContain(esc(0x202e));
    const parsed = JSON.parse(raw);
    expect(parsed.implementationPlan[0].note).toBe(note);
    expect(parsed.completionSummary).toBe(summary);

    await h.state.load();
    const reloaded = h.state.getTask(task.id);
    expect(reloaded?.implementationPlan[0].note).toBe(note);
    expect(reloaded?.completionSummary).toBe(summary);
  });
});

describe('JSON writers outside the atomic helpers', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-jsonbypass-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it('accounts writeJsonAtomic escapes, keeps the trailing newline and POSIX 0600 mode', () => {
    const file = path.join(root, 'acct', 'claude-accounts.json');
    const input = sample();
    writeJsonAtomic(file, input);
    const raw = fs.readFileSync(file, 'utf-8');
    expectEscaped(raw);
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(input);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('moe.init_project escapes an RLO-bearing project name', async () => {
    const projectPath = path.join(root, 'tool-project');
    fs.mkdirSync(projectPath);
    const state = new StateManager({ projectPath });
    await initProjectTool(state).handler({ projectPath, name: 'name' + hidden }, state);
    const raw = fs.readFileSync(path.join(projectPath, '.moe', 'project.json'), 'utf-8');
    expectEscaped(raw);
    expect(JSON.parse(raw).name).toBe('name' + hidden);
  });

  it('index initProject escapes project.json and a pre-existing global config value', () => {
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.moe'), { recursive: true });
    fs.writeFileSync(path.join(home, '.moe', 'config.json'), JSON.stringify({ extra: 'x' + hidden }));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    // writeGlobalConfig skips unless run from a built checkout; force that branch.
    const realExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).endsWith(path.join('packages', 'moe-daemon', 'dist', 'index.js')) || realExists(p));
    const projectPath = path.join(root, 'index-project');
    fs.mkdirSync(projectPath);

    initProject(projectPath, 'name' + hidden);

    const project = fs.readFileSync(path.join(projectPath, '.moe', 'project.json'), 'utf-8');
    expectEscaped(project);
    expect(JSON.parse(project).name).toBe('name' + hidden);
    const config = fs.readFileSync(path.join(home, '.moe', 'config.json'), 'utf-8');
    expectEscaped(config);
    expect(JSON.parse(config).extra).toBe('x' + hidden);
    expect(typeof JSON.parse(config).installPath).toBe('string');
  });

  it('writeDaemonInfo escapes an RLO-bearing projectPath', () => {
    fs.mkdirSync(path.join(root, '.moe'));
    const info = { port: 1, pid: 2, startedAt: new Date().toISOString(), projectPath: root + hidden };
    writeDaemonInfo(root, info);
    const raw = fs.readFileSync(path.join(root, '.moe', 'daemon.json'), 'utf-8');
    expectEscaped(raw);
    expect(JSON.parse(raw)).toEqual(info);
  });

  it('acquireLock escapes the compact lock payload', () => {
    const projectPath = path.join(root, 'lock' + String.fromCodePoint(0x202e, 0xfeff));
    fs.mkdirSync(path.join(projectPath, '.moe'), { recursive: true });
    expect(acquireLock(projectPath)).toBe(true);
    const raw = fs.readFileSync(path.join(projectPath, '.moe', 'daemon.lock'), 'utf-8');
    for (const cp of [0x202e, 0xfeff]) {
      expect(raw.includes(String.fromCodePoint(cp))).toBe(false);
      expect(raw).toContain(esc(cp));
    }
    expect(raw).not.toContain('\n');
    expect(JSON.parse(raw).projectPath).toBe(path.resolve(projectPath));
  });
});
