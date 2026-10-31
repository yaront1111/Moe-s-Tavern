import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CheckRun, Task } from '../types/schema.js';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { submitPlanTool } from '../tools/submitPlan.js';
import { recordCheckRunTool } from '../tools/recordCheckRun.js';
import { recordCheckDispatchTool } from '../tools/recordCheckDispatch.js';
import { recordCheckObservationTool } from '../tools/recordCheckObservation.js';
import { openAttempt } from '../state/attemptStore.js';
import { recordCandidate } from '../state/candidateStore.js';
import { getCheckDispatch, isAuthenticatedCheckRun } from '../state/checkObservationStore.js';
import { StateManager } from '../state/StateManager.js';
import { updateTask } from '../state/taskStore.js';
import { MoeErrorCode } from '../util/errors.js';
import * as validators from '../state/validators.js';
import { requiredCheckGit } from './requiredChecks.js';

const kinds = ['configs', 'scripts', 'assertionRoots'] as const;
const definition = () => ({ id: 'check-1', command: '  npm test -- שלום 😀  ',
  configs: ['z.json', 'a.json'], scripts: ['check.sh'], assertionRoots: ['tests'] });
const validate = (requiredChecks: unknown) => validators.validateExecutionContract({ requiredChecks });
const field = 'executionContract.requiredChecks';
const invalid = (field: string) => ({ code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT',
  context: expect.objectContaining({ field }) });
const reversed = (value: object) => Object.fromEntries(Object.entries(value).reverse());

describe('requiredChecks validation', () => {
  it('keeps exact values in detached canonical objects and first-seen path order', () => {
    const d = definition(); const input = reversed({ ...d, configs: ['z.json', 'a.json', 'z.json'] });
    const actual = validate([input]);
    expect(actual).toStrictEqual({ requiredChecks: [d] });
    expect(Object.keys(actual!.requiredChecks![0])).toEqual(['id', 'command', ...kinds]);
    (input.configs as string[]).push('extra'); input.command = 'changed';
    expect(actual).toStrictEqual({ requiredChecks: [d] });
  });
  it.each([[], null, undefined])('omits an empty checks value %j', value => {
    expect(validate(value)).toBeUndefined();
  });
  it.each([[], null, undefined])('omits empty path lists %j', value => {
    expect(validate([{ id: 'a', command: 'test', configs: value, scripts: value, assertionRoots: value }]))
      .toStrictEqual({ requiredChecks: [{ id: 'a', command: 'test' }] });
  });
  it('accepts all exact limits, unicode paths and the full 20x3x50 path surface', () => {
    const defs = Array.from({ length: 20 }, (_, i) => ({ id: String(i).padEnd(64, 'x'),
      command: 'x'.repeat(1000), ...Object.fromEntries(kinds.map(k =>
        [k, Array.from({ length: 50 }, (_, j) => `${j}/שלום 😀.ts`)])) }));
    expect(validate(defs)).toStrictEqual({ requiredChecks: defs });
    expect([validators.MAX_REQUIRED_CHECKS, validators.MAX_REQUIRED_CHECK_PATHS,
      validators.MAX_REQUIRED_CHECK_COMMAND_CHARS]).toEqual([20, 50, 1000]);
  });
  it.each([
    ['text', field], [21, field], [Array(21).fill(definition()), field],
    [[null], `${field}[0]`], [[[]], `${field}[0]`], [[42], `${field}[0]`],
    [[new Date()], `${field}[0]`], [Array(1), `${field}[0]`],
    [[{ ...definition(), extra: true }], `${field}[0].extra`],
    [[definition(), definition()], `${field}[1].id`],
  ])('refuses invalid shape %j at %s', (value, key) => {
    expect(() => validate(value)).toThrowError(expect.objectContaining(invalid(key as string)));
  });
  it.each([undefined, null, 12, '', 'x'.repeat(65), '.a', 'a b', 'שלום', 'a\0'])('refuses id %j', id => {
    expect(() => validate([{ ...definition(), id }]))
      .toThrowError(expect.objectContaining(invalid(`${field}[0].id`)));
  });
  it.each([undefined, 12, '', '  ', 'a\nb', 'a\rb', 'x'.repeat(1001), 'a\0b', 'a\tb', 'a\x1bb', 'a\x7fb'])
    ('refuses command %j', command => {
      expect(() => validate([{ ...definition(), command }]))
        .toThrowError(expect.objectContaining(invalid(`${field}[0].command`)));
    });
  describe.each(kinds)('%s paths', kind => {
    it.each([42, '', './a', 'a//b', 'a\\b', '/abs', 'C:/x', 'a/../b',
      'a/*.ts', 'a?', '[x]', 'a]', ':(glob)x', 'a\0b', 'a\nb', 'a\tb', 'a ', 'a/./b'])
      ('refuses %j with the exact element field', entry => {
        expect(() => validate([definition(), { ...definition(), id: 'second', [kind]: [entry] }]))
          .toThrowError(expect.objectContaining(invalid(`${field}[1].${kind}[0]`)));
      });
    it.each(['path', Array(51).fill('a')])('refuses invalid list %j', value => {
      expect(() => validate([{ ...definition(), [kind]: value }]))
        .toThrowError(expect.objectContaining(invalid(`${field}[0].${kind}`)));
    });
    it('rejects sparse lists and deduplicates every kind', () => {
      expect(() => validate([{ ...definition(), [kind]: Array(1) }]))
        .toThrowError(expect.objectContaining(invalid(`${field}[0].${kind}[0]`)));
      expect(validate([{ ...definition(), [kind]: ['z', 'a', 'z'] }])?.requiredChecks?.[0][kind]).toEqual(['z', 'a']);
    });
  });
  it('preserves a custom field prefix', () => {
    expect(() => validators.validateExecutionContract({ requiredChecks: [{ ...definition(), typo: 1 }] }, 'custom'))
      .toThrowError(expect.objectContaining(invalid('custom.requiredChecks[0].typo')));
  });
});

describe('pure required check helpers', () => {
  it('hashes canonical tuples independently of key insertion order', async () => {
    const { definitionDigest } = await import('./requiredChecks.js');
    const d = definition(); const digest = definitionDigest([d]);
    const canonical = JSON.stringify([[d.id, d.command, d.configs, d.scripts, d.assertionRoots]]);
    expect(digest).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionDigest([reversed(d) as typeof d])).toBe(digest);
    expect(definitionDigest([{ id: 'a', command: 'test' }])).toBe(
      definitionDigest([{ id: 'a', command: 'test', configs: [], scripts: [], assertionRoots: [] }]));
  });
  it.each(['id', 'command', ...kinds])('binds every %s value', async key => {
    const { definitionDigest } = await import('./requiredChecks.js');
    const changed = { ...definition(), [key]: kinds.includes(key as typeof kinds[number]) ? ['changed'] : 'changed' };
    expect(definitionDigest([changed])).not.toBe(definitionDigest([definition()]));
  });
  it('binds path kind and list order without mutating inputs', async () => {
    const { definitionDigest } = await import('./requiredChecks.js');
    const a = { id: 'a', command: 'test', configs: ['x', 'y'] };
    expect(definitionDigest([a])).not.toBe(definitionDigest([{ ...a, configs: ['y', 'x'] }]));
    expect(definitionDigest([{ id: 'a', command: 'test', configs: ['x'] }])).not.toBe(
      definitionDigest([{ id: 'a', command: 'test', scripts: ['x'] }]));
    expect(a.configs).toEqual(['x', 'y']);
  });
  it('returns unique pairs sorted by path then kind, without changing definitions', async () => {
    const { protectedPaths } = await import('./requiredChecks.js');
    const defs = [{ id: 'a', command: 'test', configs: ['z', 'a'], scripts: ['a'], assertionRoots: ['a'] },
      { id: 'b', command: 'test', configs: ['a'] }];
    const before = structuredClone(defs);
    expect(protectedPaths(defs)).toEqual([
      { path: 'a', kind: 'assertionRoots' }, { path: 'a', kind: 'configs' },
      { path: 'a', kind: 'scripts' }, { path: 'z', kind: 'configs' },
    ]);
    expect(defs).toEqual(before); expect(protectedPaths([])).toEqual([]);
  });
});

const h = new ToolTestHarness();
beforeEach(() => h.init());
afterEach(() => { vi.restoreAllMocks(); h.cleanup(); });
async function boot(): Promise<void> {
  // These cases test definition/rail semantics; real Git identity is covered in
  // requiredChecks.snapshot.test.ts. Supply blobs for each requested path.
  vi.spyOn(requiredCheckGit, 'run').mockImplementation(async args => {
    if (args.includes('--show-toplevel')) return h.testDir;
    if (args[0] === 'config') return '';
    if (args.includes('--verify')) return 'a'.repeat(40);
    return args.slice(args.indexOf('--') + 1).map(p => `100644 blob ${'b'.repeat(40)}\t${p}\0`).join('');
  });
  h.setupMoeFolder(); h.createEpic();
  h.createWorker({ currentTaskId: 'task-1', status: 'CODING' });
  h.createTask({ status: 'PLANNING', assignedWorkerId: 'worker-1', contextFetchedBy: ['worker-1'], planRevision: 7 });
  await h.state.load();
}
const bytes = () => fs.readFileSync(path.join(h.moePath, 'tasks/task-1.json'), 'utf8');
const update = (requiredChecks: unknown) => h.state.runExclusive(() => h.state.updateTask('task-1',
  { executionContract: { requiredChecks } } as Partial<Task>));
const submit = (requiredChecks: unknown) => submitPlanTool(h.state).handler({ taskId: 'task-1', workerId: 'worker-1',
  steps: [{ description: 'implement and test', affectedFiles: ['file.ts'] }], executionContract: { requiredChecks } }, h.state);

describe('requiredChecks approval binding', () => {
  it('declares the structured input schema and persists canonical checks through reload', async () => {
    await boot();
    const schema = submitPlanTool(h.state).inputSchema;
    expect(schema).toMatchObject({ properties: { executionContract: { properties: { requiredChecks: {
      type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id', 'command'],
        properties: { id: { type: 'string', maxLength: 64 }, command: { type: 'string', maxLength: 1000 },
          ...Object.fromEntries(kinds.map(k => [k, { type: 'array', maxItems: 50, items: { type: 'string' } }])) } },
    } } } } });
    expect(await submit([reversed(definition())])).toMatchObject({ success: true, planRevision: 8 });
    const disk = JSON.parse(bytes()) as Task;
    expect(disk.executionContract).toEqual({ requiredChecks: [definition()] });
    await h.state.load(); expect(h.state.getTask('task-1')?.executionContract).toEqual(disk.executionContract);
  });
  it('revises changes exactly once but not equal reordered definitions or duplicate paths', async () => {
    await boot();
    expect((await update([definition()])).planRevision).toBe(8);
    expect((await update([reversed(definition())])).planRevision).toBe(8);
    expect((await update([{ ...definition(), configs: ['z.json', 'a.json', 'z.json'] }])).planRevision).toBe(8);
    expect((await update([{ ...definition(), command: 'npm run test:unit' }])).planRevision).toBe(9);
    expect((await update([])).planRevision).toBe(10);
    expect((JSON.parse(bytes()) as Task).executionContract).toBeUndefined();
  });
  it.each(['id', 'command', ...kinds])('rejects forbidden text only in %s without writing', async key => {
    await boot(); const before = bytes();
    // "rm -rf" cannot be an id; give it a legal, independently forbidden token.
    h.state.project!.globalRails.forbiddenPatterns = ['forbidden'];
    const bad = { ...definition(), [key]: kinds.includes(key as typeof kinds[number]) ? ['forbidden.ts'] : 'forbidden' };
    await expect(submit([bad])).rejects.toMatchObject({ codeName: 'CONSTRAINT_VIOLATION' });
    expect(bytes()).toBe(before);
  });
  it('validates every writer before any durable or in-memory change', async () => {
    await boot(); const before = bytes(); const current = structuredClone(h.state.getTask('task-1'));
    await expect(update([{ ...definition(), command: 'x'.repeat(1001) }])).rejects.toMatchObject(invalid(`${field}[0].command`));
    await expect(submit([{ ...definition(), configs: ['./a'] }])).rejects.toMatchObject(invalid(`${field}[0].configs[0]`));
    expect(bytes()).toBe(before); expect(h.state.getTask('task-1')).toEqual(current);
  });
});

// The one required-check command limit: MAX_REQUIRED_CHECK_COMMAND_CHARS UTF-16 units. The daemon constant is canonical;
// the standalone host (guest-bridge.mjs checkFrame) and guest (guest-supervisor.py read_check) keep numeric mirrors that
// these tests pin to it by behavior, so a drifted mirror fails here instead of refusing an approved check at runtime.
const LIMIT = validators.MAX_REQUIRED_CHECK_COMMAND_CHARS;
const EMOJI = '\u{1F600}';
const AT_LIMIT: Array<[string, string]> = [
  ['500 ASCII', 'x'.repeat(500)], ['501 ASCII', 'x'.repeat(501)], ['1000 ASCII', 'x'.repeat(LIMIT)],
  ['1000 with outer whitespace', ` ${'x'.repeat(LIMIT - 2)} `], ['500 emoji (1000 units)', EMOJI.repeat(LIMIT / 2)],
];
const OVER: Array<[string, string]> = [
  ['1001 ASCII', 'x'.repeat(LIMIT + 1)], ['500 emoji plus 1 unit', `${EMOJI.repeat(LIMIT / 2)}x`],
  ['1001 with outer whitespace', ` ${'x'.repeat(LIMIT - 1)} `],
];
const RUNNER = { runnerId: 'runner-0123456789abcdef' };
const TREE = 'c3'.repeat(20);
const ENV = 'ubuntu-24.04/node-24';
const checksDir = () => path.join(h.moePath, 'checks');
const checksWritten = () => (fs.existsSync(checksDir()) ? fs.readdirSync(checksDir(), { recursive: true, encoding: 'utf8' }) : []);

describe('required check command limit is one value on every daemon path', () => {
  it('pins the canonical constant and every tool schema to it', async () => {
    await boot();
    expect(LIMIT).toBe(1000);
    const commandOf = (tool: { inputSchema: unknown }) => (tool.inputSchema as { properties: { command: { maxLength?: number; description: string } } }).properties.command;
    for (const tool of [recordCheckRunTool(h.state), recordCheckDispatchTool(h.state)]) {
      const command = commandOf(tool);
      expect(command.maxLength).toBe(LIMIT);
      expect(command.description).toContain(`at most ${LIMIT} UTF-16 code units`);
      expect(command.description).not.toMatch(/\b500\b/);
    }
    const checks = (submitPlanTool(h.state).inputSchema as { properties: { executionContract: { properties: { requiredChecks: { items: { properties: { command: { maxLength: number } } } } } } } });
    expect(checks.properties.executionContract.properties.requiredChecks.items.properties.command.maxLength).toBe(LIMIT);
  });

  /** A task whose approved definition holds `command`, with a current candidate and an approved plan revision. */
  async function ready(command: string): Promise<number> {
    await boot();
    await submit([{ ...definition(), command }]);
    const planRevision = h.state.getTask('task-1')!.planRevision!;
    await h.state.runExclusive(() => updateTask(h.state, 'task-1', { status: 'WORKING', planApprovedAt: new Date().toISOString() },
      'PLAN_APPROVED', undefined, { approvedPlanRevision: planRevision }));
    await openAttempt(h.state, { id: 'attempt-1', taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-x', workspace: 'task-1' });
    await recordCandidate(h.state, { id: 'cand-1', attemptId: 'attempt-1', taskId: 'task-1', treeSha: TREE,
      baseRevision: 'a1'.repeat(20), deliveryTarget: 'refs/heads/moe/work' });
    return planRevision;
  }
  const dispatchArgs = (command: string, planRevision: number) => ({ id: 'dispatch-1', taskId: 'task-1', candidateId: 'cand-1', planRevision, command, environment: ENV });
  const runArgs = (command: string) => ({ id: 'check-direct', candidateId: 'cand-1', treeSha: TREE, command, exitCode: 0, runnerId: 'runner-x', source: 'agent-reported' });

  it.each(AT_LIMIT)('approves, dispatches, observes and reloads a %s command unchanged', async (_label, command) => {
    const planRevision = await ready(command);
    const approved = h.state.getTask('task-1')!.executionContract!.requiredChecks![0].command;
    expect(approved).toBe(command);
    const { dispatch } = await recordCheckDispatchTool(h.state).handler(dispatchArgs(command, planRevision), h.state, { runner: RUNNER }) as { dispatch: { command: string } };
    expect(dispatch.command).toBe(command);
    const { checkRun } = await recordCheckObservationTool(h.state).handler(
      { id: 'check-obs-1', dispatchId: 'dispatch-1', exitCode: 0, outcome: 'passed', outputTail: 'ok', environment: ENV }, h.state, { runner: RUNNER }) as { checkRun: CheckRun };
    expect(checkRun.command).toBe(command);
    const fresh = new StateManager({ projectPath: h.testDir }); await fresh.load();
    expect(getCheckDispatch(fresh, 'dispatch-1')?.command).toBe(command);
    expect(fresh.checkRuns.get('check-obs-1')?.command).toBe(command);
    expect(isAuthenticatedCheckRun(fresh, fresh.checkRuns.get('check-obs-1')!)).toBe(true);
    // The unauthenticated, declared-provenance tool stores the same bytes and never claims more than it declares.
    const direct = await recordCheckRunTool(h.state).handler(runArgs(command), h.state) as { checkRun: CheckRun };
    expect(direct.checkRun.command).toBe(command);
    expect([direct.checkRun.source, isAuthenticatedCheckRun(h.state, direct.checkRun)]).toEqual(['agent-reported', false]);
  });

  it.each(OVER)('refuses a %s command on approval, direct run and dispatch, writing nothing', async (_label, command) => {
    const planRevision = await ready('npm test');
    const before = bytes();
    await expect(submit([{ ...definition(), command }])).rejects.toMatchObject(invalid(`${field}[0].command`));
    await expect(recordCheckRunTool(h.state).handler(runArgs(command), h.state)).rejects.toMatchObject(invalid('command'));
    await expect(recordCheckDispatchTool(h.state).handler(dispatchArgs(command, planRevision), h.state, { runner: RUNNER })).rejects.toMatchObject(invalid('command'));
    expect(bytes()).toBe(before);
    expect(checksWritten()).toEqual([]);
    expect([h.state.checkRuns.size, getCheckDispatch(h.state, 'dispatch-1')]).toEqual([0, null]);
  });
});

// Host framing (guest-bridge.mjs checkFrame) and the guest's real read_check (guest-supervisor.py under python3 -I -B),
// loaded as local-runner-check.test.mjs C2 does. Nothing here runs a command string or starts a VM.
const runnerFile = (name: string) => fileURLToPath(new URL(`../../../../scripts/local-runner/${name}`, import.meta.url));
const framed = (body: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); };
const literalFrame = (command: string) => framed(Buffer.from(JSON.stringify({ kind: 'check', version: 1, id: 'check-1', command, protected: [] })));
const ROWS: Array<[string, string, boolean]> = [...AT_LIMIT.map(([l, c]) => [l, c, c.length <= LIMIT] as [string, string, boolean]),
  ...OVER.map(([l, c]) => [l, c, false] as [string, string, boolean])];
const PY = `import importlib.util, sys
spec = importlib.util.spec_from_file_location('moe_supervisor', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(m.MAX_CHECK_COMMAND)
for _ in range(int(sys.argv[2])):
    try:
        m.read_check(0)
        print('accepted')
    except ValueError:
        print('refused')
`;

describe('required check command limit is mirrored by the standalone host and guest', () => {
  const accepts = (run: () => unknown) => { try { run(); return true; } catch { return false; } };
  const host = async () => (await import(pathToFileURL(runnerFile('guest-bridge.mjs')).href)) as { checkFrame(check: unknown): Buffer };

  it('accepts and refuses the same commands at the limit as the daemon validator and host checkFrame', async () => {
    const { checkFrame } = await host();
    expect(ROWS.map(([label, c]) => [label, c.length]).filter(([, n]) => n === LIMIT + 1 || n === LIMIT).length).toBeGreaterThan(3);
    for (const [label, command, ok] of ROWS) {
      const daemon = accepts(() => validate([{ id: 'check-1', command }]));
      const bridge = accepts(() => checkFrame({ id: 'check-1', command, protected: [] }));
      expect([label, daemon, bridge]).toEqual([label, ok, ok]);
      if (bridge) expect(checkFrame({ id: 'check-1', command, protected: [] })).toEqual(literalFrame(command));
    }
  });

  it.skipIf(process.platform === 'win32')('has the guest read_check accept and refuse the same frames, with MAX_CHECK_COMMAND equal to the daemon constant', async () => {
    const { checkFrame } = await host();
    // Host-refused rows are framed by hand from the same JSON, so read_check judges the very input checkFrame refused.
    const input = Buffer.concat(ROWS.map(([, command]) => { try { return checkFrame({ id: 'check-1', command, protected: [] }); } catch { return literalFrame(command); } }));
    const run = spawnSync('python3', ['-I', '-B', '-c', PY, runnerFile('guest-supervisor.py'), String(ROWS.length)],
      { input, maxBuffer: 64 << 20, timeout: 30_000, killSignal: 'SIGKILL' });
    expect([run.error, run.status, String(run.stderr)]).toEqual([undefined, 0, '']);
    const [limit, ...answers] = String(run.stdout).trim().split('\n');
    expect(Number(limit)).toBe(LIMIT);
    expect(answers).toEqual(ROWS.map(([, , ok]) => (ok ? 'accepted' : 'refused')));
  });
});
