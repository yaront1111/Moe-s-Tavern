import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolTestHarness } from './toolTestHarness.js';
import { getTools, type ToolDefinition } from './index.js';
import { McpAdapter, type JsonRpcResponse } from '../server/McpAdapter.js';
import { openAttempt, setAttemptPhase } from '../state/attemptStore.js';
import { recordCandidate } from '../state/candidateStore.js';
import { MAX_CHECK_LOG_BYTES, listCheckRunsForCandidate } from '../state/checkRunStore.js';
import { MoeError } from '../util/errors.js';
import { CURRENT_SCHEMA_VERSION, type CheckRun, type TaskVerification } from '../types/schema.js';

const TOOL = 'moe.record_check_run';
const SHA = { base: 'a1'.repeat(20), treeA: 'c3'.repeat(20), treeB: 'd4'.repeat(20) };
const GATE = 'node gate.cjs';
const T1 = '2026-09-13T03:00:00.000Z';
const T2 = '2026-09-13T03:05:00.000Z';
const EMOJI = '\u{1F600}';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));

/** The held-out acceptance payloads (delivery/acceptance.test.ts), verbatim: no task, attempt or worker identity. */
const AGENT_PASS = {
  id: 'check-P-current-agent-pass',
  candidateId: 'cand-P-current',
  treeSha: SHA.treeA,
  command: GATE,
  exitCode: 0,
  outputTail: 'gate ok (reported by the coding agent)',
  runnerId: 'runner-pilot',
  source: 'agent-reported',
};
const RUNNER_PASS = { ...AGENT_PASS, id: 'check-P-current-runner-pass', outputTail: 'gate ok', source: 'runner-observed' };

/** The legacy evidence the REVIEW task already carries; recording a check run must not touch it. */
const VERIFICATION: TaskVerification = { command: GATE, exitCode: 0, outputTail: 'ok', reportedAt: T1, source: 'agent-reported' };

interface RecordCheckRunResponse {
  success: boolean;
  checkRun: CheckRun;
  duplicate: boolean;
}

interface Refusal {
  code: number;
  codeName: string;
  message: string;
  context: unknown;
}

describe('moe.record_check_run', () => {
  const h = new ToolTestHarness();

  beforeEach(async () => {
    h.init();
    h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
    h.createEpic();
    // QA already holds the REVIEW task, and the coding attempt that offered its candidates has closed.
    h.createTask({ id: 'task-P', status: 'REVIEW', assignedWorkerId: 'qa-1', verification: VERIFICATION });
    await h.state.load();
    await openAttempt(h.state, { id: 'attempt-P', taskId: 'task-P', workerId: 'worker-1', runnerId: 'runner-pilot', workspace: 'D:/wt/p' });
    await setAttemptPhase(h.state, 'attempt-P', 'finalizing');
    const candidate = { attemptId: 'attempt-P', taskId: 'task-P', baseRevision: SHA.base, deliveryTarget: 'refs/heads/wave1-pilot' };
    await recordCandidate(h.state, { ...candidate, id: 'cand-P-old', treeSha: SHA.treeB });
    await recordCandidate(h.state, { ...candidate, id: 'cand-P-current', treeSha: SHA.treeA });
    await setAttemptPhase(h.state, 'attempt-P', 'closed');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  const checksDir = (): string => path.join(h.moePath, 'checks');
  const checkFile = (id: string): string => path.join(checksDir(), `${id}.json`);
  const readRecord = (id: string): CheckRun => JSON.parse(fs.readFileSync(checkFile(id), 'utf8')) as CheckRun;
  const textOf = (response: JsonRpcResponse): string => (response.result as { content: Array<{ text: string }> }).content[0].text;

  /** The tool exactly as getTools() registers it; a missing registration fails here as an assertion. */
  function registered(): ToolDefinition {
    const tool = getTools(h.state).find((t) => t.name === TOOL);
    expect(tool, `${TOOL} must be registered in getTools()`).toBeDefined();
    return tool!;
  }

  /** The registered production handler, serialized under the state mutex as MCP dispatch runs it. */
  async function call(args: unknown): Promise<RecordCheckRunResponse> {
    const tool = registered();
    return (await h.state.runExclusive(() => tool.handler(args, h.state))) as RecordCheckRunResponse;
  }

  function mcpCall(adapter: McpAdapter, id: number, args: unknown): Promise<JsonRpcResponse> {
    return adapter.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: TOOL, arguments: args } }) as Promise<JsonRpcResponse>;
  }

  async function refusal(promise: Promise<unknown>): Promise<Refusal> {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof MoeError)) throw error;
      return { code: error.code, codeName: error.codeName, message: error.message, context: error.context };
    }
    throw new Error('expected a MoeError refusal, but the call succeeded');
  }

  /** Date-only fake clock: faking timers would stall atomicWriteJsonAsync's rename retry. */
  function clockAt(iso: string): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  /** Everything a refusal must leave alone: the check-run map and every check, candidate, attempt and task file. */
  function snapshot(): Record<string, string> {
    const files: Record<string, string> = { map: JSON.stringify([...h.state.checkRuns.entries()]) };
    for (const kind of ['checks', 'candidates', 'attempts', 'tasks']) {
      const dir = path.join(h.moePath, kind);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).sort()) files[`${kind}/${name}`] = fs.readFileSync(path.join(dir, name), 'utf8');
    }
    return files;
  }

  it('is registered exactly once in getTools() and is not blocking, so dispatch serializes it', () => {
    const matches = getTools(h.state).filter((t) => t.name === TOOL);
    expect(matches).toHaveLength(1);
    expect(matches[0].blocking ?? false).toBe(false);
  });

  it('advertises the report shape: an explicit source enum with no default, a signed integer exitCode, no createdAt', () => {
    const schema = registered().inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: unknown;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'candidateId', 'command', 'exitCode', 'id', 'outputTail', 'runnerId', 'source', 'treeSha', 'workerId',
    ]);
    expect(schema.required).toEqual(['candidateId', 'treeSha', 'command', 'exitCode', 'runnerId', 'source']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.source).toMatchObject({ type: 'string', enum: ['runner-observed', 'agent-reported'] });
    expect(schema.properties.source).not.toHaveProperty('default');
    expect(schema.properties.exitCode).toMatchObject({ type: 'integer' });
    expect(schema.properties.exitCode).not.toHaveProperty('minimum');
    for (const name of ['id', 'candidateId', 'treeSha', 'command', 'outputTail', 'runnerId', 'workerId']) {
      expect(schema.properties[name], name).toMatchObject({ type: 'string' });
    }
  });

  it('is served by the real MCP adapter: listed with its schema, called, and refused with its codeName', async () => {
    const adapter = new McpAdapter(h.state);
    const listed = (await adapter.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as JsonRpcResponse;
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools.filter((t) => t.name === TOOL);
    expect(tools).toEqual([{ name: TOOL, description: expect.any(String), inputSchema: registered().inputSchema }]);

    const ok = await mcpCall(adapter, 2, { ...RUNNER_PASS, workerId: 'worker-1' });
    expect(ok.error).toBeUndefined();
    expect(JSON.parse(textOf(ok))).toEqual({ success: true, checkRun: readRecord(RUNNER_PASS.id), duplicate: false });

    const refused = await mcpCall(adapter, 3, { ...RUNNER_PASS, id: 'check-x', candidateId: 'cand-ghost' });
    expect(refused.error).toEqual({
      code: -32001,
      message: '[CANDIDATE_NOT_FOUND] Candidate not found: cand-ghost',
      data: { tool: TOOL, codeName: 'CANDIDATE_NOT_FOUND' },
    });
    expect(fs.existsSync(checkFile('check-x'))).toBe(false);
  });

  it('records the held-out payloads verbatim for a closed attempt whose REVIEW task QA holds, touching nothing else', async () => {
    const before = snapshot();

    const results = [await call(AGENT_PASS), await call(RUNNER_PASS)];

    [AGENT_PASS, RUNNER_PASS].forEach((payload, index) => {
      const expected = { ...payload, createdAt: results[index].checkRun.createdAt };
      expect(results[index]).toStrictEqual({ success: true, checkRun: expected, duplicate: false });
      expect(readRecord(payload.id)).toStrictEqual(expected);
    });
    const after = snapshot();
    expect(Object.keys(after).filter((key) => !(key in before))).toEqual([
      'checks/check-P-current-agent-pass.json',
      'checks/check-P-current-runner-pass.json',
    ]);
    for (const key of Object.keys(before).filter((k) => k !== 'map')) expect(after[key], key).toBe(before[key]);
    expect(h.state.getTask('task-P')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-1', verification: VERIFICATION });
    expect(h.state.attempts.get('attempt-P')?.phase).toBe('closed');
  });

  const acknowledged: Array<[string, Record<string, unknown>]> = [
    ['an agent-reported pass', { source: 'agent-reported', exitCode: 0 }],
    ['a runner-observed failure', { source: 'runner-observed', exitCode: 1 }],
    ['an agent-reported negative exit code', { source: 'agent-reported', exitCode: -1 }],
    ['a runner-observed signal exit', { source: 'runner-observed', exitCode: 137 }],
  ];

  it.each(acknowledged)('acknowledges %s as recorded exactly as reported, never as an approval', async (_label, report) => {
    const result = await call({ ...RUNNER_PASS, id: 'check-1', ...report });

    const expected = { ...RUNNER_PASS, id: 'check-1', ...report, createdAt: result.checkRun.createdAt };
    expect(result).toStrictEqual({ success: true, checkRun: expected, duplicate: false });
    expect(readRecord('check-1')).toStrictEqual(expected);
    expect(h.state.getTask('task-P')).toMatchObject({ status: 'REVIEW', assignedWorkerId: 'qa-1' });
  });

  it('keeps command and runnerId as reported, records an absent tail as empty, generates the id, ignores a caller createdAt', async () => {
    clockAt(T2);
    const command = '  node  gate.cjs --grep "a b"  ';
    const { checkRun } = await call({
      candidateId: 'cand-P-current', treeSha: SHA.treeA, command, exitCode: 2, runnerId: 'runner-not-a-worker',
      source: 'agent-reported', workerId: 'worker-1', createdAt: '1999-01-01T00:00:00.000Z',
    });

    expect(checkRun.id).toMatch(/^check-[0-9a-f]{32}$/);
    expect(readRecord(checkRun.id)).toStrictEqual({
      id: checkRun.id, candidateId: 'cand-P-current', treeSha: SHA.treeA, command, exitCode: 2, outputTail: '',
      runnerId: 'runner-not-a-worker', source: 'agent-reported', createdAt: T2,
    });
    expect(fs.readdirSync(checksDir())).toEqual([`${checkRun.id}.json`]);
  });

  it.each([undefined, 'runner-pilot', 'worker-1'])('never infers or defaults a missing source (workerId %s)', async (workerId) => {
    const { source: _omitted, ...unsourced } = RUNNER_PASS;
    const before = snapshot();

    expect(await refusal(call({ ...unsourced, workerId }))).toEqual({
      code: -32602, codeName: 'MISSING_REQUIRED', message: '[MISSING_REQUIRED] Missing required field: source', context: { field: 'source' },
    });
    expect(snapshot()).toEqual(before);
  });

  const bindingRefusals: Array<[string, Record<string, unknown>, Refusal]> = [
    ['a candidate that does not exist', { candidateId: 'cand-ghost' }, {
      code: -32001, codeName: 'CANDIDATE_NOT_FOUND', message: '[CANDIDATE_NOT_FOUND] Candidate not found: cand-ghost', context: { candidateId: 'cand-ghost' },
    }],
    ["another candidate's tree", { treeSha: SHA.treeB }, {
      code: -32002,
      codeName: 'CHECK_RUN_TREE_MISMATCH',
      message: `[CHECK_RUN_TREE_MISMATCH] Check run reports tree ${SHA.treeB}, but candidate cand-P-current is tree ${SHA.treeA}; ` +
        'a check run must name the exact tree of the candidate it checked',
      context: { candidateId: 'cand-P-current', expectedTreeSha: SHA.treeA, actualTreeSha: SHA.treeB },
    }],
  ];

  it.each(bindingRefusals)('refuses %s by name, writing nothing', async (_label, report, expected) => {
    const before = snapshot();
    expect(await refusal(call({ ...RUNNER_PASS, ...report }))).toEqual(expected);
    expect(snapshot()).toEqual(before);
  });

  const malformed: Array<[string, string, unknown]> = [
    ['no arguments at all', 'INVALID_INPUT', undefined],
    ['an array of reports', 'INVALID_INPUT', [RUNNER_PASS]],
    ['a source in another spelling', 'INVALID_INPUT', { ...RUNNER_PASS, source: 'runner_observed' }],
    ['a source in another case', 'INVALID_INPUT', { ...RUNNER_PASS, source: 'Runner-Observed' }],
    ['a path-escaping id', 'INVALID_INPUT', { ...RUNNER_PASS, id: '../../escaped' }],
    ['a blank runnerId', 'INVALID_INPUT', { ...RUNNER_PASS, runnerId: ' ' }],
    ['a missing candidateId', 'MISSING_REQUIRED', { ...RUNNER_PASS, candidateId: undefined }],
    ['a short treeSha', 'INVALID_INPUT', { ...RUNNER_PASS, treeSha: 'abc123' }],
    ['a string exitCode', 'INVALID_INPUT', { ...RUNNER_PASS, exitCode: '0' }],
    ['a fractional exitCode', 'INVALID_INPUT', { ...RUNNER_PASS, exitCode: 0.5 }],
    ['a 501-character command', 'INVALID_INPUT', { ...RUNNER_PASS, command: 'x'.repeat(501) }],
    ['a null outputTail', 'INVALID_INPUT', { ...RUNNER_PASS, outputTail: null }],
  ];

  it.each(malformed)('refuses %s as %s without coercing or writing', async (_label, codeName, args) => {
    const before = snapshot();
    const error = await refusal(call(args));
    expect([error.code, error.codeName]).toEqual([-32602, codeName]);
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(h.testDir, 'escaped.json'))).toBe(false);
  });

  it('replays an identical same-id retry: duplicate, original createdAt and bytes, no second write', async () => {
    clockAt(T1);
    const first = await call(RUNNER_PASS);
    const bytes = fs.readFileSync(checkFile(RUNNER_PASS.id));
    clockAt(T2);
    const write = vi.spyOn(h.state, 'writeEntity');

    // The injected workerId is not part of the report, so a different one is still the same report.
    const replay = await call({ ...RUNNER_PASS, workerId: 'worker-2' });

    expect(replay).toStrictEqual({ success: true, checkRun: first.checkRun, duplicate: true });
    expect(replay.checkRun.createdAt).toBe(T1);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(checkFile(RUNNER_PASS.id)).equals(bytes)).toBe(true);
  });

  it('refuses a changed same-id report as CHECK_RUN_IMMUTABLE, while a fresh id records a second run', async () => {
    await call(RUNNER_PASS);
    const before = snapshot();

    expect(await refusal(call({ ...RUNNER_PASS, exitCode: 1, source: 'agent-reported' }))).toEqual({
      code: -32002,
      codeName: 'CHECK_RUN_IMMUTABLE',
      message: `[CHECK_RUN_IMMUTABLE] Check run ${RUNNER_PASS.id} already exists and differs in exitCode, source; ` +
        'check runs are immutable, so a different result needs a new check-run id',
      context: { checkRunId: RUNNER_PASS.id, differingFields: ['exitCode', 'source'] },
    });
    expect(snapshot()).toEqual(before);

    const rerun = await call({ ...RUNNER_PASS, id: 'check-P-current-rerun', exitCode: 1, source: 'agent-reported' });
    expect(rerun.duplicate).toBe(false);
    expect(listCheckRunsForCandidate(h.state, 'cand-P-current').map((run) => [run.id, run.exitCode, run.source]).sort()).toEqual([
      ['check-P-current-rerun', 1, 'agent-reported'],
      ['check-P-current-runner-pass', 0, 'runner-observed'],
    ]);
  });

  it('serializes concurrent identical calls through the dispatch mutex: one write, one replay', async () => {
    const adapter = new McpAdapter(h.state);
    const write = vi.spyOn(h.state, 'writeEntity');

    const responses = await Promise.all([mcpCall(adapter, 1, RUNNER_PASS), mcpCall(adapter, 2, RUNNER_PASS)]);

    expect(responses.map((response) => response.error)).toEqual([undefined, undefined]);
    const results = responses.map((response) => JSON.parse(textOf(response)) as RecordCheckRunResponse);
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(results[1].checkRun).toEqual(results[0].checkRun);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('hands a failed write to the caller unchanged, over MCP too, leaving no record and no success', async () => {
    const injected = new Error('Injected check write failure');
    const write = vi.spyOn(h.state, 'writeEntity').mockImplementation(async () => {
      throw injected;
    });
    const before = snapshot();

    await expect(call(RUNNER_PASS)).rejects.toBe(injected);
    const wire = await mcpCall(new McpAdapter(h.state), 7, RUNNER_PASS);

    expect(wire).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Injected check write failure', data: { tool: TOOL } } });
    expect(write).toHaveBeenCalledTimes(2);
    expect(snapshot()).toEqual(before);
  });

  const tails: Array<[string, string, string]> = [
    ['an ASCII log one byte over the cap', `X${'a'.repeat(MAX_CHECK_LOG_BYTES)}`, 'a'.repeat(MAX_CHECK_LOG_BYTES)],
    ['an emoji log whose cut lands mid-emoji', `${EMOJI.repeat(5000)}z`, `${EMOJI.repeat(4095)}z`],
  ];

  it.each(tails)('stores %s as its final whole-character 16384 UTF-8 bytes through the handler', async (_label, raw, kept) => {
    const result = await call({ ...RUNNER_PASS, outputTail: raw });
    const persisted = readRecord(RUNNER_PASS.id).outputTail;

    expect(Buffer.byteLength(persisted, 'utf8')).toBe(Buffer.byteLength(kept, 'utf8'));
    expect(Buffer.byteLength(persisted, 'utf8')).toBeLessThanOrEqual(16384);
    expect(persisted === kept, 'the persisted tail is not the exact suffix').toBe(true);
    expect(result.checkRun.outputTail === kept, 'the returned tail is not the exact suffix').toBe(true);
    // A retry whose raw log differs only before the kept suffix normalizes identically, so it replays.
    expect((await call({ ...RUNNER_PASS, outputTail: `another preamble ${raw}` })).duplicate).toBe(true);
  });

  it('never runs the reported command: no child process in the tool', () => {
    const file = path.join(toolsDir, 'recordCheckRun.ts');
    expect(fs.existsSync(file), 'tools/recordCheckRun.ts must exist').toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|\bfork\(/);
  });
});
