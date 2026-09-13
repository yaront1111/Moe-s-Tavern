import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolTestHarness } from '../tools/toolTestHarness.js';
import { getTools, type ToolDefinition } from '../tools/index.js';
import { McpAdapter, type JsonRpcResponse } from '../server/McpAdapter.js';
import {
  MAX_PUSH_RESULT_CHARS,
  getDeliveryReceipt,
  getDeliveryReceiptForCandidate,
  recordDeliveryReceipt,
  validateDeliveryReceiptParams,
  type RecordDeliveryReceiptParams,
} from './receiptStore.js';
import { recordCandidate } from './candidateStore.js';
import { openAttempt } from './attemptStore.js';
import { StateManager } from './StateManager.js';
import { MoeError } from '../util/errors.js';
import { CURRENT_SCHEMA_VERSION, type DeliveryReceipt } from '../types/schema.js';

const stateDir = path.dirname(fileURLToPath(import.meta.url));
const TOOL = 'moe.record_delivery_receipt';
const TARGET = 'refs/heads/wave1-pilot';
const SHA = { base: 'a1'.repeat(20), landed: 'b2'.repeat(20), treeA: 'c3'.repeat(20), treeB: 'd4'.repeat(20), other: 'e5'.repeat(20) };
const RECEIPT_ID = /^receipt-[0-9a-f]{32}$/;
/** The persisted shape frozen by the held-out acceptance fixture, in its key order. */
const CONTRACT_FIELDS = ['id', 'candidateId', 'target', 'targetBefore', 'targetAfter', 'landedRevision', 'pushResult'];
const NO_PROCESS = /child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|\bfork\(/;

/** The landing the held-out acceptance test reports: local-branch policy, so no push. */
const LANDING: Omit<DeliveryReceipt, 'id'> = {
  candidateId: 'cand-a',
  target: TARGET,
  targetBefore: SHA.base,
  targetAfter: SHA.landed,
  landedRevision: SHA.landed,
  pushResult: null,
};

type Override = Partial<Record<keyof RecordDeliveryReceiptParams | 'id' | 'createdAt' | 'workerId', unknown>>;

interface Refusal {
  code: number;
  codeName: string;
  message: string;
  context: unknown;
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

/** A loaded project with one task, one attempt and two candidates on disk. */
async function seed(h: ToolTestHarness): Promise<void> {
  h.init();
  h.setupMoeFolder({ schemaVersion: CURRENT_SCHEMA_VERSION });
  h.createEpic();
  h.createTask({ id: 'task-1', status: 'WORKING', assignedWorkerId: 'worker-1' });
  await h.state.load();
  await openAttempt(h.state, { id: 'attempt-1', taskId: 'task-1', workerId: 'worker-1', runnerId: 'runner-1', workspace: 'D:/wt/a' });
  const candidate = { attemptId: 'attempt-1', taskId: 'task-1', baseRevision: SHA.base, deliveryTarget: TARGET };
  await recordCandidate(h.state, { ...candidate, id: 'cand-a', treeSha: SHA.treeA });
  await recordCandidate(h.state, { ...candidate, id: 'cand-b', treeSha: SHA.treeB });
}

/** Disk-side helpers over one harness's .moe/receipts directory, resolved lazily after init(). */
function receiptsOf(h: ToolTestHarness) {
  const dir = (): string => path.join(h.moePath, 'receipts');
  const files = (): string[] => (fs.existsSync(dir()) ? fs.readdirSync(dir()).sort() : []);
  const bytes = (id: string): Buffer => fs.readFileSync(path.join(dir(), `${id}.json`));
  const read = (id: string): Record<string, unknown> => JSON.parse(bytes(id).toString('utf8')) as Record<string, unknown>;
  /** Everything a refusal must leave alone: every receipt file's bytes, and the in-memory map. */
  const snapshot = (): { files: Record<string, string>; map: string } => {
    const out: Record<string, string> = {};
    for (const file of files()) out[file] = fs.readFileSync(path.join(dir(), file)).toString('hex');
    return { files: out, map: JSON.stringify([...h.state.receipts.entries()]) };
  };
  /** A record placed on disk the way acceptance.test.ts writeRecord places its fixtures. */
  const place = (record: { id: string }): void => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${record.id}.json`), JSON.stringify(record, null, 2));
  };
  return { dir, files, bytes, read, snapshot, place };
}

describe('receiptStore', () => {
  const h = new ToolTestHarness();
  const disk = receiptsOf(h);

  beforeEach(async () => {
    await seed(h);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  const record = (override: Override = {}): Promise<{ receipt: DeliveryReceipt; duplicate: boolean }> =>
    recordDeliveryReceipt(h.state, { ...LANDING, ...override } as unknown as RecordDeliveryReceiptParams);

  /** A daemon restarted over the same folder. The caller must clearEmitter() it. */
  async function restart(): Promise<StateManager> {
    const restarted = new StateManager({ projectPath: h.testDir });
    await restarted.load();
    return restarted;
  }

  // ---------------------------------------------------------------------------
  // recording and reading back
  // ---------------------------------------------------------------------------

  it('persists one file under .moe/receipts holding exactly the seven contract fields, pushResult null included', async () => {
    const result = await record();

    expect(result.receipt.id).toMatch(RECEIPT_ID);
    const expected: DeliveryReceipt = { id: result.receipt.id, ...LANDING };
    expect(result).toStrictEqual({ receipt: expected, duplicate: false });
    expect(disk.files()).toEqual([`${expected.id}.json`]);
    expect(disk.read(expected.id)).toStrictEqual(expected);
    expect(Object.keys(disk.read(expected.id))).toEqual(CONTRACT_FIELDS);
    expect(disk.read(expected.id).pushResult).toBeNull();
    expect(h.state.receipts.get(expected.id)).toStrictEqual(expected);
    expect(getDeliveryReceipt(h.state, expected.id)).toStrictEqual(expected);
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')).toStrictEqual(expected);
  });

  it('stores an omitted pushResult as an explicit null, not as a missing field', async () => {
    const { pushResult: _omitted, ...unpushed } = LANDING;
    const { receipt } = await recordDeliveryReceipt(h.state, unpushed);

    expect(receipt.pushResult).toBeNull();
    expect(Object.keys(disk.read(receipt.id))).toEqual(CONTRACT_FIELDS);
    expect(disk.read(receipt.id).pushResult).toBeNull();
  });

  const pushed: Array<[string, string]> = [
    ['a multi-line git summary with surrounding spaces', '  To origin\n   a1b2c3d..b2b2b2b  wave1-pilot -> wave1-pilot  '],
    ['a rejected push the wrapper reported', '! [rejected] wave1-pilot -> wave1-pilot (non-fast-forward)'],
    ['a push result of exactly the maximum length', 'p'.repeat(2000)],
  ];

  it.each(pushed)('preserves %s verbatim as the push result', async (_label, pushResult) => {
    const { receipt } = await record({ pushResult });

    expect(receipt.pushResult === pushResult, 'the returned push result is not verbatim').toBe(true);
    expect(disk.read(receipt.id).pushResult === pushResult, 'the persisted push result is not verbatim').toBe(true);
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')?.pushResult === pushResult).toBe(true);
  });

  const verbatim: Array<[string, Override]> = [
    ['upper-case revisions', { targetAfter: SHA.landed.toUpperCase(), landedRevision: SHA.landed.toUpperCase() }],
    ['the zero revision git reports for a target that did not exist before', { targetBefore: '0'.repeat(40) }],
    ['a target that had already moved past the landed revision', { targetAfter: SHA.other }],
    ["a target other than the candidate's deliveryTarget", { target: 'refs/heads/main' }],
  ];

  it.each(verbatim)('records %s exactly as reported, never refusing a landing that happened', async (_label, override) => {
    const { receipt } = await record(override);

    const expected = { id: receipt.id, ...LANDING, ...override };
    expect(receipt).toStrictEqual(expected);
    expect(disk.read(receipt.id)).toStrictEqual(expected);
  });

  it('generates the id itself and stores no caller id, createdAt or workerId', async () => {
    const { receipt } = await record({ id: 'receipt-mine', createdAt: '1999-01-01T00:00:00.000Z', workerId: 'worker-1' });

    expect(receipt.id).toMatch(RECEIPT_ID);
    expect(disk.files()).toEqual([`${receipt.id}.json`]);
    expect(disk.read(receipt.id)).toStrictEqual({ id: receipt.id, ...LANDING });
  });

  it('gives each candidate its own receipt and finds each by id and by candidate', async () => {
    const a = await record();
    const b = await record({ candidateId: 'cand-b', targetBefore: SHA.landed, targetAfter: SHA.other, landedRevision: SHA.other, pushResult: 'pushed' });

    expect(b.duplicate).toBe(false);
    expect(disk.files()).toEqual([`${a.receipt.id}.json`, `${b.receipt.id}.json`].sort());
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')).toStrictEqual(a.receipt);
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-b')).toStrictEqual(b.receipt);
    expect(getDeliveryReceipt(h.state, b.receipt.id)).toStrictEqual(b.receipt);
    expect(getDeliveryReceipt(h.state, 'receipt-missing')).toBeNull();
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-none')).toBeNull();
  });

  it('hands out copies, so no caller can edit a stored receipt in memory', async () => {
    const { receipt } = await record();
    // The fields are readonly in the type; the casts model a caller that edits anyway.
    (receipt as { landedRevision: string }).landedRevision = SHA.other;
    (getDeliveryReceipt(h.state, receipt.id) as { landedRevision: string }).landedRevision = SHA.other;
    (getDeliveryReceiptForCandidate(h.state, 'cand-a') as { landedRevision: string }).landedRevision = SHA.other;

    expect(h.state.receipts.get(receipt.id)?.landedRevision).toBe(SHA.landed);
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')?.landedRevision).toBe(SHA.landed);
  });

  it('exports a recorder and two readers, and no update or delete path', async () => {
    const store = await import('./receiptStore.js');
    expect(Object.keys(store).sort()).toEqual([
      'MAX_PUSH_RESULT_CHARS',
      'getDeliveryReceipt',
      'getDeliveryReceiptForCandidate',
      'recordDeliveryReceipt',
      'validateDeliveryReceiptParams',
    ]);
    expect(MAX_PUSH_RESULT_CHARS).toBe(2000);
  });

  it('never touches git or a process: no child process in the store', () => {
    expect(fs.readFileSync(path.join(stateDir, 'receiptStore.ts'), 'utf8')).not.toMatch(NO_PROCESS);
  });

  // ---------------------------------------------------------------------------
  // one receipt per candidate: replay, contradiction, ambiguity
  // ---------------------------------------------------------------------------

  it('replays an identical report for the same candidate: the stored receipt, duplicate, zero writes, identical bytes', async () => {
    const first = await record();
    const bytesBefore = disk.bytes(first.receipt.id);
    const write = vi.spyOn(h.state, 'writeEntity');

    const replay = await record();

    expect(replay).toStrictEqual({ receipt: first.receipt, duplicate: true });
    expect(write).not.toHaveBeenCalled();
    expect(disk.files()).toEqual([`${first.receipt.id}.json`]);
    expect(disk.bytes(first.receipt.id).equals(bytesBefore)).toBe(true);
    (replay.receipt as { target: string }).target = 'refs/heads/tampered';
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')).toStrictEqual(first.receipt);
  });

  it('treats an omitted and an explicit null pushResult as the same report', async () => {
    const { pushResult: _omitted, ...unpushed } = LANDING;
    const first = await recordDeliveryReceipt(h.state, unpushed);
    const write = vi.spyOn(h.state, 'writeEntity');

    expect(await record({ pushResult: null })).toStrictEqual({ receipt: first.receipt, duplicate: true });
    expect(await recordDeliveryReceipt(h.state, unpushed)).toStrictEqual({ receipt: first.receipt, duplicate: true });
    expect(write).not.toHaveBeenCalled();
  });

  /** [label, the contradicting report, the fields the refusal must name, in contract order] */
  const contradictions: Array<[string, Override, string[]]> = [
    ['a different landed revision', { landedRevision: SHA.other }, ['landedRevision']],
    ['a different target', { target: 'refs/heads/main' }, ['target']],
    ['a different targetBefore', { targetBefore: SHA.other }, ['targetBefore']],
    ['a different targetAfter', { targetAfter: SHA.other }, ['targetAfter']],
    ['a push result where none was recorded', { pushResult: 'pushed to origin' }, ['pushResult']],
    ['the same revisions in another case', { targetAfter: SHA.landed.toUpperCase(), landedRevision: SHA.landed.toUpperCase() }, ['targetAfter', 'landedRevision']],
    ['a second landing on top of the first', { targetBefore: SHA.landed, targetAfter: SHA.other, landedRevision: SHA.other }, ['targetBefore', 'targetAfter', 'landedRevision']],
  ];

  it.each(contradictions)('refuses %s by name for a candidate that already has a receipt, writing nothing', async (_label, override, differingFields) => {
    const { receipt } = await record();
    const before = disk.snapshot();

    expect(await refusal(record(override))).toEqual({
      code: -32002,
      codeName: 'DELIVERY_RECEIPT_CONFLICT',
      message:
        `[DELIVERY_RECEIPT_CONFLICT] Candidate cand-a already has delivery receipt ${receipt.id}, which differs in ${differingFields.join(', ')}; ` +
        'a delivery receipt is never rewritten, so a report that contradicts it is refused',
      context: { candidateId: 'cand-a', receiptId: receipt.id, differingFields },
    });
    expect(disk.snapshot()).toEqual(before);
  });

  it('refuses a report of no push once a push result was recorded', async () => {
    const { receipt } = await record({ pushResult: 'pushed to origin' });
    const before = disk.snapshot();

    const error = await refusal(record({ pushResult: null }));

    expect([error.code, error.codeName, error.context]).toEqual([
      -32002,
      'DELIVERY_RECEIPT_CONFLICT',
      { candidateId: 'cand-a', receiptId: receipt.id, differingFields: ['pushResult'] },
    ]);
    expect(disk.snapshot()).toEqual(before);
  });

  it('refuses to answer or record for a candidate that already has two receipts on disk', async () => {
    const twin = { ...LANDING };
    disk.place({ id: 'receipt-z', ...twin });
    disk.place({ id: 'receipt-m', ...twin, targetAfter: SHA.other, landedRevision: SHA.other });
    const bytesBefore = ['receipt-m', 'receipt-z'].map((id) => disk.bytes(id));
    const restarted = await restart();
    try {
      const expected: Refusal = {
        code: -32002,
        codeName: 'DELIVERY_RECEIPT_AMBIGUOUS',
        message:
          '[DELIVERY_RECEIPT_AMBIGUOUS] Candidate cand-a has 2 delivery receipts (receipt-m, receipt-z); ' +
          'a candidate lands at most once, so which receipt records its landing cannot be decided',
        context: { candidateId: 'cand-a', receiptIds: ['receipt-m', 'receipt-z'] },
      };
      expect(await refusal(Promise.resolve().then(() => getDeliveryReceiptForCandidate(restarted, 'cand-a')))).toEqual(expected);
      expect(await refusal(recordDeliveryReceipt(restarted, LANDING))).toEqual(expected);

      expect(restarted.receipts.size).toBe(2);
      expect(getDeliveryReceipt(restarted, 'receipt-z')).toStrictEqual({ id: 'receipt-z', ...twin });
      expect(disk.files()).toEqual(['receipt-m.json', 'receipt-z.json']);
      ['receipt-m', 'receipt-z'].forEach((id, index) => expect(disk.bytes(id).equals(bytesBefore[index])).toBe(true));
    } finally {
      restarted.clearEmitter();
    }
  });

  // ---------------------------------------------------------------------------
  // candidate binding and refusal order
  // ---------------------------------------------------------------------------

  it('refuses a new receipt for a candidate that does not exist, and fabricates none', async () => {
    await record();
    const before = disk.snapshot();

    expect(await refusal(record({ candidateId: 'cand-ghost' }))).toEqual({
      code: -32001,
      codeName: 'CANDIDATE_NOT_FOUND',
      message: '[CANDIDATE_NOT_FOUND] Candidate not found: cand-ghost',
      context: { candidateId: 'cand-ghost' },
    });
    expect(disk.snapshot()).toEqual(before);
    expect(h.state.candidates.has('cand-ghost')).toBe(false);
  });

  it('checks in order: the input, then an existing receipt for the candidate, then the candidate itself', async () => {
    await record();
    const before = disk.snapshot();
    const codeNameOf = async (override: Override): Promise<string> => (await refusal(record(override))).codeName;

    expect(await codeNameOf({ candidateId: 'cand-ghost', landedRevision: 'HEAD' })).toBe('INVALID_INPUT');
    expect(await codeNameOf({ landedRevision: 'HEAD' })).toBe('INVALID_INPUT');
    expect(await codeNameOf({ landedRevision: SHA.other })).toBe('DELIVERY_RECEIPT_CONFLICT');
    expect(await codeNameOf({ candidateId: 'cand-ghost', landedRevision: SHA.other })).toBe('CANDIDATE_NOT_FOUND');
    expect(disk.snapshot()).toEqual(before);
  });

  it('loads the held-out acceptance fixture verbatim and reconciles a replay of that landing to it, candidate record or not', async () => {
    // acceptance.test.ts criterion 2 places exactly this record; its candidate is not in this project.
    const fixture = {
      id: 'receipt-P-current',
      candidateId: 'cand-P-current',
      target: TARGET,
      targetBefore: SHA.base,
      targetAfter: SHA.landed,
      landedRevision: SHA.landed,
      pushResult: null,
    };
    disk.place(fixture);
    const bytesBefore = disk.bytes(fixture.id);
    const restarted = await restart();
    try {
      expect(getDeliveryReceipt(restarted, fixture.id)).toStrictEqual(fixture);
      const { id: _fixtureId, ...landing } = fixture;
      const write = vi.spyOn(restarted, 'writeEntity');

      expect(await recordDeliveryReceipt(restarted, landing)).toStrictEqual({ receipt: fixture, duplicate: true });
      const error = await refusal(recordDeliveryReceipt(restarted, { ...landing, target: 'refs/heads/main' }));

      expect([error.codeName, error.context]).toEqual([
        'DELIVERY_RECEIPT_CONFLICT',
        { candidateId: 'cand-P-current', receiptId: fixture.id, differingFields: ['target'] },
      ]);
      expect(write).not.toHaveBeenCalled();
      expect(disk.files()).toEqual(['receipt-P-current.json']);
      expect(disk.bytes(fixture.id).equals(bytesBefore)).toBe(true);
    } finally {
      restarted.clearEmitter();
    }
  });

  // ---------------------------------------------------------------------------
  // durability and reload
  // ---------------------------------------------------------------------------

  it('publishes nothing when the write fails, hands the caller that error, and a retry then records it', async () => {
    const injected = new Error('Injected receipt write failure');
    vi.spyOn(h.state, 'writeEntity').mockImplementationOnce(async () => {
      throw injected;
    });

    await expect(record()).rejects.toBe(injected);

    expect(h.state.receipts.size).toBe(0);
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')).toBeNull();
    expect(disk.files()).toEqual([]);
    const retried = await record();
    expect(retried.duplicate).toBe(false);
    expect(disk.files()).toEqual([`${retried.receipt.id}.json`]);
    expect(disk.read(retried.receipt.id)).toStrictEqual(retried.receipt);
  });

  it('loads persisted receipts into a fresh StateManager after a restart, where replay and refusal still hold', async () => {
    const a = await record();
    const b = await record({ candidateId: 'cand-b', pushResult: 'pushed to origin' });
    const restarted = await restart();
    try {
      expect(restarted.receipts.size).toBe(2);
      expect(getDeliveryReceipt(restarted, a.receipt.id)).toStrictEqual(a.receipt);
      expect(getDeliveryReceiptForCandidate(restarted, 'cand-a')).toStrictEqual(a.receipt);
      expect(getDeliveryReceiptForCandidate(restarted, 'cand-b')).toStrictEqual(b.receipt);

      const bytesBefore = disk.bytes(a.receipt.id);
      const write = vi.spyOn(restarted, 'writeEntity');
      expect(await recordDeliveryReceipt(restarted, LANDING)).toStrictEqual({ receipt: a.receipt, duplicate: true });
      const error = await refusal(recordDeliveryReceipt(restarted, { ...LANDING, landedRevision: SHA.other }));

      expect([error.code, error.codeName]).toEqual([-32002, 'DELIVERY_RECEIPT_CONFLICT']);
      expect(write).not.toHaveBeenCalled();
      expect(disk.bytes(a.receipt.id).equals(bytesBefore)).toBe(true);
      expect(disk.files()).toHaveLength(2);
    } finally {
      restarted.clearEmitter();
    }
  });

  it('loads an empty collection, and creates no receipts directory, when nothing ever landed', async () => {
    expect(fs.existsSync(disk.dir())).toBe(false);
    expect(h.state.receipts.size).toBe(0);
    expect(getDeliveryReceiptForCandidate(h.state, 'cand-a')).toBeNull();

    const restarted = await restart();
    try {
      expect(restarted.receipts.size).toBe(0);
      expect(fs.existsSync(disk.dir())).toBe(false);
    } finally {
      restarted.clearEmitter();
    }
  });

  // ---------------------------------------------------------------------------
  // input refusals — validated, never coerced, never written
  // ---------------------------------------------------------------------------

  /** [label, override, codeName, the refusal text after its "[CODENAME] " prefix, up to any rendered value] */
  const malformed: Array<[string, Override, string, string]> = [
    ['a missing candidateId', { candidateId: undefined }, 'MISSING_REQUIRED', 'Missing required field: candidateId'],
    ['a null candidateId', { candidateId: null }, 'MISSING_REQUIRED', 'Missing required field: candidateId'],
    ['a blank candidateId', { candidateId: '   ' }, 'INVALID_INPUT', 'Invalid candidateId: must be a non-blank string'],
    ['a numeric candidateId', { candidateId: 42 }, 'INVALID_INPUT', 'Invalid candidateId: must be a string (got 42)'],
    ['a path-escaping candidateId', { candidateId: '../../escaped' }, 'INVALID_INPUT', 'Invalid candidateId: must contain only alphanumeric characters, hyphens, and underscores'],
    ['an over-long candidateId', { candidateId: 'c'.repeat(129) }, 'INVALID_INPUT', 'Invalid candidateId: must be 128 characters or fewer'],
    ['a missing target', { target: undefined }, 'MISSING_REQUIRED', 'Missing required field: target'],
    ['a blank target', { target: '' }, 'INVALID_INPUT', 'Invalid target: must be a non-blank string'],
    ['a whitespace-only target', { target: ' \t' }, 'INVALID_INPUT', 'Invalid target: must be a non-blank string'],
    ['a padded target', { target: ` ${TARGET}` }, 'INVALID_INPUT', 'Invalid target: must not have leading or trailing whitespace'],
    ['a target with a control character', { target: 'refs/heads/a\nb' }, 'INVALID_INPUT', 'Invalid target: must not contain control characters'],
    ['a 256-character target', { target: `refs/heads/${'t'.repeat(245)}` }, 'INVALID_INPUT', 'Invalid target: must be 255 characters or fewer'],
    ['a non-string target', { target: [TARGET] }, 'INVALID_INPUT', 'Invalid target: must be a string (got a value of type object)'],
    ['a missing targetBefore', { targetBefore: undefined }, 'MISSING_REQUIRED', 'Missing required field: targetBefore'],
    ['a missing targetAfter', { targetAfter: undefined }, 'MISSING_REQUIRED', 'Missing required field: targetAfter'],
    ['a missing landedRevision', { landedRevision: undefined }, 'MISSING_REQUIRED', 'Missing required field: landedRevision'],
    ['a null landedRevision', { landedRevision: null }, 'MISSING_REQUIRED', 'Missing required field: landedRevision'],
    ['a blank landedRevision', { landedRevision: '' }, 'INVALID_INPUT', 'Invalid landedRevision: must be 40 hexadecimal characters, as reported by the wrapper (got "")'],
    ['a ref name as landedRevision', { landedRevision: 'HEAD' }, 'INVALID_INPUT', 'Invalid landedRevision: must be 40 hexadecimal characters, as reported by the wrapper (got "HEAD")'],
    ['an abbreviated landedRevision', { landedRevision: 'b2b2b2b' }, 'INVALID_INPUT', 'Invalid landedRevision: must be 40 hexadecimal characters'],
    ['a 41-character landedRevision', { landedRevision: `${SHA.landed}0` }, 'INVALID_INPUT', 'Invalid landedRevision: must be 40 hexadecimal characters'],
    ['a 64-character landedRevision', { landedRevision: 'b2'.repeat(32) }, 'INVALID_INPUT', 'Invalid landedRevision: must be 40 hexadecimal characters'],
    ['a padded targetAfter', { targetAfter: ` ${SHA.landed}` }, 'INVALID_INPUT', 'Invalid targetAfter: must be 40 hexadecimal characters'],
    ['a non-hex targetBefore', { targetBefore: 'g'.repeat(40) }, 'INVALID_INPUT', 'Invalid targetBefore: must be 40 hexadecimal characters'],
    ['a numeric targetAfter', { targetAfter: 1234567 }, 'INVALID_INPUT', 'Invalid targetAfter: must be a string (got 1234567)'],
    ['a numeric pushResult', { pushResult: 0 }, 'INVALID_INPUT', 'Invalid pushResult: must be a string, or null when no push was required (got 0)'],
    ['a boolean pushResult', { pushResult: true }, 'INVALID_INPUT', 'Invalid pushResult: must be a string, or null when no push was required (got true)'],
    ['an object pushResult', { pushResult: { ok: true } }, 'INVALID_INPUT', 'Invalid pushResult: must be a string, or null when no push was required (got a value of type object)'],
    ['a blank pushResult', { pushResult: '' }, 'INVALID_INPUT', 'Invalid pushResult: must be a non-blank string, or null when no push was required'],
    ['a whitespace-only pushResult', { pushResult: ' \n' }, 'INVALID_INPUT', 'Invalid pushResult: must be a non-blank string, or null when no push was required'],
    ['a 2001-character pushResult', { pushResult: 'p'.repeat(2001) }, 'INVALID_INPUT', 'Invalid pushResult: must be 2000 characters or fewer (got 2001)'],
  ];

  it.each(malformed)('refuses %s without writing', async (_label, override, codeName, text) => {
    const params = { ...LANDING, ...override };
    const error = await refusal(recordDeliveryReceipt(h.state, params as unknown as RecordDeliveryReceiptParams));

    expect([error.code, error.codeName]).toEqual([-32602, codeName]);
    expect(error.message.startsWith(`[${codeName}] ${text}`), error.message).toBe(true);
    expect(() => validateDeliveryReceiptParams(params)).toThrow(error.message);
    expect(h.state.receipts.size).toBe(0);
    expect(disk.files()).toEqual([]);
    expect(fs.existsSync(path.join(h.testDir, 'escaped.json'))).toBe(false);
  });

  it.each([
    ['a string', 'receipt'],
    ['null', null],
    ['an array', [LANDING]],
  ])('refuses %s in place of a report object', async (_label, raw) => {
    const error = await refusal(recordDeliveryReceipt(h.state, raw as unknown as RecordDeliveryReceiptParams));

    expect([error.code, error.codeName]).toEqual([-32602, 'INVALID_INPUT']);
    expect(error.message.startsWith('[INVALID_INPUT] Invalid receipt: must be an object'), error.message).toBe(true);
    expect(disk.files()).toEqual([]);
  });
});

describe('moe.record_delivery_receipt', () => {
  const h = new ToolTestHarness();
  const disk = receiptsOf(h);

  beforeEach(async () => {
    await seed(h);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    h.state.clearEmitter();
    h.cleanup();
  });

  const textOf = (response: JsonRpcResponse): string => (response.result as { content: Array<{ text: string }> }).content[0].text;

  /** The tool exactly as getTools() registers it; a missing registration fails here as an assertion. */
  function registered(): ToolDefinition {
    const tool = getTools(h.state).find((t) => t.name === TOOL);
    expect(tool, `${TOOL} must be registered in getTools()`).toBeDefined();
    return tool!;
  }

  function mcpCall(adapter: McpAdapter, id: number, args: unknown): Promise<JsonRpcResponse> {
    return adapter.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: TOOL, arguments: args } }) as Promise<JsonRpcResponse>;
  }

  it('is registered exactly once in getTools() and is not blocking', () => {
    const matches = getTools(h.state).filter((t) => t.name === TOOL);
    expect(matches).toHaveLength(1);
    expect(matches[0].blocking ?? false).toBe(false);
  });

  it('advertises exactly the contract fields: no id or createdAt, an optional pushResult, nothing else accepted', () => {
    const schema = registered().inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: unknown;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'candidateId', 'landedRevision', 'pushResult', 'target', 'targetAfter', 'targetBefore', 'workerId',
    ]);
    expect(schema.required).toEqual(['candidateId', 'target', 'targetBefore', 'targetAfter', 'landedRevision']);
    expect(schema.additionalProperties).toBe(false);
    for (const name of ['candidateId', 'target', 'targetBefore', 'targetAfter', 'landedRevision', 'pushResult', 'workerId']) {
      expect(schema.properties[name], name).toMatchObject({ type: 'string' });
    }
  });

  it('records the reported landing, says it created the receipt, and stores no caller identity', async () => {
    const result = (await registered().handler({ ...LANDING, workerId: 'worker-1' }, h.state)) as { receipt: DeliveryReceipt };

    expect(result.receipt.id).toMatch(RECEIPT_ID);
    expect(result).toStrictEqual({ success: true, receipt: { id: result.receipt.id, ...LANDING }, duplicate: false });
    expect(disk.read(result.receipt.id)).toStrictEqual({ id: result.receipt.id, ...LANDING });
  });

  it('is served by the real MCP adapter: a replayed payload changes no byte, and a contradiction is refused by codeName', async () => {
    const adapter = new McpAdapter(h.state);
    const listed = (await adapter.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as JsonRpcResponse;
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools.filter((t) => t.name === TOOL);
    expect(tools).toEqual([{ name: TOOL, description: expect.any(String), inputSchema: registered().inputSchema }]);

    const payload = { ...LANDING, workerId: 'worker-1' };
    const created = await mcpCall(adapter, 2, payload);
    expect(created.error).toBeUndefined();
    const { receipt } = JSON.parse(textOf(created)) as { receipt: DeliveryReceipt };
    expect(JSON.parse(textOf(created))).toEqual({ success: true, receipt: disk.read(receipt.id), duplicate: false });
    const bytes = disk.bytes(receipt.id);

    // The crash replay: the wrapper sends the very same payload again.
    const replayed = await mcpCall(adapter, 3, payload);
    expect(JSON.parse(textOf(replayed))).toEqual({ success: true, receipt, duplicate: true });
    expect(disk.files()).toEqual([`${receipt.id}.json`]);
    expect(disk.bytes(receipt.id).equals(bytes)).toBe(true);

    const contradicted = await mcpCall(adapter, 4, { ...payload, targetAfter: SHA.other, landedRevision: SHA.other });
    expect(contradicted.error).toEqual({
      code: -32002,
      message:
        `[DELIVERY_RECEIPT_CONFLICT] Candidate cand-a already has delivery receipt ${receipt.id}, which differs in targetAfter, landedRevision; ` +
        'a delivery receipt is never rewritten, so a report that contradicts it is refused',
      data: { tool: TOOL, codeName: 'DELIVERY_RECEIPT_CONFLICT' },
    });
    const unknown = await mcpCall(adapter, 5, { ...payload, candidateId: 'cand-ghost' });
    expect(unknown.error).toEqual({
      code: -32001,
      message: '[CANDIDATE_NOT_FOUND] Candidate not found: cand-ghost',
      data: { tool: TOOL, codeName: 'CANDIDATE_NOT_FOUND' },
    });
    expect(disk.files()).toEqual([`${receipt.id}.json`]);
    expect(disk.bytes(receipt.id).equals(bytes)).toBe(true);
  });

  it('serializes concurrent identical reports inside its own handler: one write, one duplicate, one file', async () => {
    const tool = registered();
    const write = vi.spyOn(h.state, 'writeEntity');

    // Deliberately NOT wrapped in runExclusive: the handler must hold the state mutex itself.
    const results = (await Promise.all([tool.handler(LANDING, h.state), tool.handler(LANDING, h.state)])) as Array<{
      receipt: DeliveryReceipt;
      duplicate: boolean;
    }>;

    expect(results.map((result) => result.duplicate)).toEqual([false, true]);
    expect(results[1].receipt).toStrictEqual(results[0].receipt);
    expect(write).toHaveBeenCalledTimes(1);
    expect(disk.files()).toEqual([`${results[0].receipt.id}.json`]);
  });

  it('hands a failed write to the caller unchanged, over MCP too, leaving no receipt and no success', async () => {
    const injected = new Error('Injected receipt write failure');
    const write = vi.spyOn(h.state, 'writeEntity').mockImplementation(async () => {
      throw injected;
    });

    await expect(registered().handler(LANDING, h.state)).rejects.toBe(injected);
    const wire = await mcpCall(new McpAdapter(h.state), 7, LANDING);

    expect(wire).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Injected receipt write failure', data: { tool: TOOL } } });
    expect(write).toHaveBeenCalledTimes(2);
    expect(h.state.receipts.size).toBe(0);
    expect(disk.files()).toEqual([]);
  });

  it.each([
    ['no arguments at all', 'INVALID_INPUT', undefined],
    ['a missing landedRevision', 'MISSING_REQUIRED', { ...LANDING, landedRevision: undefined }],
    ['a ref name as landedRevision', 'INVALID_INPUT', { ...LANDING, landedRevision: 'HEAD' }],
  ])('refuses %s through the handler as %s, writing nothing', async (_label, codeName, args) => {
    const error = await refusal(registered().handler(args, h.state));

    expect([error.code, error.codeName]).toEqual([-32602, codeName]);
    expect(disk.files()).toEqual([]);
  });

  it('never touches git or a process: no child process in the tool', () => {
    const file = path.join(stateDir, '..', 'tools', 'recordDeliveryReceipt.ts');
    expect(fs.existsSync(file), 'tools/recordDeliveryReceipt.ts must exist').toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(NO_PROCESS);
  });
});
