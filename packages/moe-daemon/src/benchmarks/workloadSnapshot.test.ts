// Contract tests for the frozen workload snapshot (CQ-M03a). Test-only benchmark
// scaffolding: nothing here runs a benchmark or ranks outcomes. The single spawn
// test proves the assessment convention category datasets rely on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MoeError } from '../util/errors.js';
import * as ws from './workloadSnapshot.js';

// <fixture> (plain JS: the pinned digests below were computed from these bytes)
const ORIGINAL = `// Reduced from normalizeAffectedFile in packages/moe-daemon/src/util/affectedFiles.ts.
export function normalizePath(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === '') throw new Error('entry cannot be empty');
  return trimmed;
}
`;
const NOTES = '\uFEFFReduced fixture: path normalization only.\n';
const ACCEPTANCE = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.MOE_WORKLOAD_CANDIDATE_ROOT;
if (!root) throw new Error('MOE_WORKLOAD_CANDIDATE_ROOT is not set');
const { normalizePath } = await import(pathToFileURL(join(root, 'src', 'normalizePath.mjs')).href);

test('converts-backslashes: Windows separators become forward slashes', () => {
  assert.equal(normalizePath('src\\\\util\\\\a.ts'), 'src/util/a.ts');
});

test('strips-dot-prefix: a leading ./ or .\\\\ is removed', () => {
  assert.equal(normalizePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('.\\\\src\\\\a.ts'), 'src/a.ts');
});

test('unchanged behavior: trimming and empty-entry rejection stay', () => {
  assert.equal(normalizePath('  docs/a.md '), 'docs/a.md');
  assert.throws(() => normalizePath('   '));
});
`;
const SAMPLE_FIELDS = {
  contractVersion: 1,
  id: 'maintenance-sample-path-normalize',
  category: 'maintenance',
  startingCommit: '35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71',
  source: {
    repository: 'github.com/yaront1111/Moe-s-Tavern',
    paths: ['packages/moe-daemon/src/util/affectedFiles.ts'],
    adaptation: 'reduced',
    note: 'Contract-test sample, not a corpus workload: normalizeAffectedFile reduced to separator and dot-prefix handling.',
  },
  intendedBehavior:
    'normalizePath(raw) must convert backslashes to forward slashes and strip a leading ./ or .\\ prefix, keeping trimming and empty-entry rejection.',
  initialFiles: { 'src/normalizePath.mjs': ORIGINAL, 'docs/notes with space/caf\u00e9.md': NOTES },
  assessmentFiles: { 'acceptance.test.mjs': ACCEPTANCE },
  rubric: {
    criteria: [
      { id: 'converts-backslashes', description: 'Backslash separators become forward slashes.' },
      { id: 'strips-dot-prefix', description: 'A leading ./ or .\\ prefix is removed.' },
    ],
    coverageTags: ['reusable-helper'],
  },
};
// </fixture>

const SNAPSHOT_DIGEST = 'sha256:ee65e37dd800fbdb29da3bd220849af8f15013026bfb45f902c0a7bd06b4301f';
const ASSESSMENT_DIGEST = 'sha256:83a69d1daa5662694b0c949faefcf00f768124c7a6877e92f567f2202d115157';
const WORKLOAD_DIGEST = 'sha256:b98237819ddab1aee72926aa3d3069528188ce27c9a81c5da4c53b402b2c80c5';
const KAT_DIGEST = 'sha256:fcbe7963225be2a311f79e59b1e4ac5e8fa2e48281dd4519758cd278ed81f7d6';

// Test-only candidate variants: never part of a workload object.
const FIXED = ORIGINAL.replace('return trimmed;', "return trimmed.replace(/\\\\/g, '/').replace(/^\\.\\//, '');");
const WRONG = ORIGINAL.replace('return trimmed;', "return trimmed.replace(/\\\\/g, '/');");

type Files = Record<string, string>;
interface Sample {
  contractVersion: number;
  id: string;
  category: string;
  startingCommit: string;
  source: { repository: string; paths: string[]; adaptation: string; note: string };
  intendedBehavior: string;
  initialFiles: Files;
  assessmentFiles: Files;
  rubric: { criteria: { id: string; description: string }[]; coverageTags: string[] };
  snapshotDigest: string;
  assessmentDigest: string;
}

const sample = (): Sample =>
  structuredClone({ ...SAMPLE_FIELDS, snapshotDigest: SNAPSHOT_DIGEST, assessmentDigest: ASSESSMENT_DIGEST });

function edit(mutate: (s: Sample) => void): Sample {
  const s = sample();
  mutate(s);
  return s;
}

const REMOVE = Symbol('remove');
function withField(field: string, value: unknown): unknown {
  const root = sample() as unknown as Record<string, unknown>;
  const keys = field.split('.');
  let cur = root;
  for (const key of keys.slice(0, -1)) cur = cur[key] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (value === REMOVE) delete cur[last];
  else cur[last] = value;
  return root;
}

interface Rejection {
  code: string;
  field: string;
  reason: string;
}
function rejectionOf(fn: () => unknown): Rejection {
  try {
    fn();
  } catch (err) {
    if (err instanceof MoeError) {
      return { code: err.codeName, field: String(err.context?.field), reason: String(err.context?.reason) };
    }
    throw err;
  }
  throw new Error('expected a MoeError rejection');
}
function expectInvalid(raw: unknown, field: string): Rejection {
  const r = rejectionOf(() => ws.validateWorkload(raw));
  expect(r.code).toBe('INVALID_INPUT');
  expect(r.field.slice(0, field.length)).toBe(field);
  return r;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
/** Independent implementation of the documented framing (UTF-8 byte order by default). */
function referenceDigest(files: Files, order: 'utf8' | 'utf16' = 'utf8'): string {
  const entries = Object.entries(files).map(([p, c]) => ({ p, pb: Buffer.from(p, 'utf8'), cb: Buffer.from(c, 'utf8') }));
  entries.sort(order === 'utf8' ? (a, b) => Buffer.compare(a.pb, b.pb) : (a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const parts = [Buffer.from('moe-workload-files-v1\0', 'utf8'), u32(entries.length)];
  for (const e of entries) parts.push(u32(e.pb.length), e.pb, u32(e.cb.length), e.cb);
  return `sha256:${crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
}

const handles: ws.WorkloadSnapshotHandle[] = [];
const scratch: string[] = [];
async function coding(raw: unknown = sample()): Promise<ws.WorkloadSnapshotHandle> {
  const h = await ws.createCodingSnapshot(raw);
  handles.push(h);
  return h;
}
async function assessment(raw: unknown = sample()): Promise<ws.WorkloadSnapshotHandle> {
  const h = await ws.createAssessmentSnapshot(raw);
  handles.push(h);
  return h;
}
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `moe-wstest-${prefix}-`));
  scratch.push(dir);
  return dir;
}
/** Directory link that needs no admin on Windows; the type is ignored on POSIX. */
const link = (target: string, at: string): void => fs.symlinkSync(target, at, 'junction');
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

let userTree = '';
let userTreeState = '';
function treeState(dir: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        out.push(`${r}/:${st.mtimeMs}`);
        walk(full, r);
      } else {
        out.push(`${r}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir, '');
  return out.join('\n');
}
const expectUserTreeIntact = (): void => expect(treeState(userTree)).toBe(userTreeState);

beforeAll(() => {
  userTree = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-wstest-user-'));
  fs.mkdirSync(path.join(userTree, 'nested'));
  fs.writeFileSync(path.join(userTree, 'keep.txt'), 'user bytes\n');
  fs.writeFileSync(path.join(userTree, 'nested', 'keep.mjs'), 'export const keep = 1;\n');
  userTreeState = treeState(userTree);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) await h.dispose().catch(() => undefined);
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(userTree, { recursive: true, force: true });
});

describe('contract constants', () => {
  it('pins the frozen v1 constants', () => {
    expect(ws.WORKLOAD_CONTRACT_VERSION).toBe(1);
    expect(ws.FROZEN_STARTING_COMMIT).toBe('35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71');
    expect(ws.SOURCE_REPOSITORY).toBe('github.com/yaront1111/Moe-s-Tavern');
    expect(ws.WORKLOAD_CATEGORIES).toEqual(['maintenance', 'defect', 'refactor', 'non-routine']);
    expect(ws.CORPUS_COVERAGE_TAGS).toEqual([
      'reusable-helper',
      'stale-positive-context',
      'stale-negative-context',
      'changed-caller',
      'changed-requirements',
      'recipe-mismatch',
    ]);
    expect(Object.isFrozen(ws.WORKLOAD_CATEGORIES)).toBe(true);
    expect(Object.isFrozen(ws.CORPUS_COVERAGE_TAGS)).toBe(true);
    expect(ws.WORKLOAD_CANDIDATE_ROOT_ENV).toBe('MOE_WORKLOAD_CANDIDATE_ROOT');
  });
});

describe('validateWorkload accepts', () => {
  it('returns a new deep-frozen copy with null-prototype file maps', () => {
    const input = sample();
    const w = ws.validateWorkload(input);
    expect(w).not.toBe(input);
    expect(w).toEqual(input);
    const parts = [w, w.source, w.source.paths, w.rubric, w.rubric.criteria, w.rubric.criteria[0], w.rubric.coverageTags];
    for (const part of [...parts, w.initialFiles, w.assessmentFiles]) expect(Object.isFrozen(part)).toBe(true);
    expect(Object.getPrototypeOf(w.initialFiles)).toBeNull();
    expect(Object.getPrototypeOf(w.assessmentFiles)).toBeNull();
    const before = JSON.stringify(w);
    input.id = 'maintenance-changed';
    input.source.paths.push('extra.ts');
    input.initialFiles['src/normalizePath.mjs'] = 'changed';
    input.rubric.criteria[0].id = 'changed';
    expect(JSON.stringify(w)).toBe(before);
  });

  it('accepts a null-prototype top-level object', () => {
    const w = ws.validateWorkload(Object.assign(Object.create(null) as object, sample()));
    expect(w.id).toBe('maintenance-sample-path-normalize');
    expect(w.snapshotDigest).toBe(SNAPSHOT_DIGEST);
  });
});

describe('validateWorkload rejects malformed metadata', () => {
  const huge = (n: number): string => 'x'.repeat(n);
  const crit = (id: string): { id: string; description: string } => ({ id, description: `Criterion ${id}.` });
  class SampleBox {
    constructor() {
      Object.assign(this, sample());
    }
  }
  class Box {
    constructor(src: object) {
      Object.assign(this, src);
    }
  }
  const manyFiles = (count: number, size: number): Files =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.txt`, huge(size)]));
  const cases: [string, unknown, string][] = [
    ['an unknown solution key', { ...sample(), solution: 'export const fixed = true;' }, 'workload'],
    ['a missing rubric', withField('rubric', REMOVE), 'workload.rubric'],
    ['a missing startingCommit', withField('startingCommit', REMOVE), 'workload.startingCommit'],
    ['contractVersion 0', withField('contractVersion', 0), 'workload.contractVersion'],
    ['contractVersion 2', withField('contractVersion', 2), 'workload.contractVersion'],
    ["contractVersion '1'", withField('contractVersion', '1'), 'workload.contractVersion'],
    ['an unknown category', withField('category', 'chore'), 'workload.category'],
    ['an id without the category prefix', withField('id', 'sample-path-normalize'), 'workload.id'],
    ['an id with another category prefix', withField('id', 'defect-sample'), 'workload.id'],
    ['a bare category id', withField('id', 'maintenance'), 'workload.id'],
    ['an uppercase id', withField('id', 'maintenance-Sample'), 'workload.id'],
    ['an id with bad characters', withField('id', 'maintenance-sample_x'), 'workload.id'],
    ['an id with an empty segment', withField('id', 'maintenance--x'), 'workload.id'],
    ['an over-long id', withField('id', `maintenance-${huge(80)}`), 'workload.id'],
    ['an abbreviated commit', withField('startingCommit', '35cf53c'), 'workload.startingCommit'],
    ['an uppercase commit', withField('startingCommit', '35CF53C8444EBE1CA27E68BFBE8C5CA4896BAC71'), 'workload.startingCommit'],
    ['another full commit', withField('startingCommit', 'a'.repeat(40)), 'workload.startingCommit'],
    ['a non-hex commit', withField('startingCommit', 'z'.repeat(40)), 'workload.startingCommit'],
    ['another repository', withField('source.repository', 'github.com/other/repo'), 'workload.source.repository'],
    ['a missing repository', withField('source.repository', REMOVE), 'workload.source.repository'],
    ['empty source paths', withField('source.paths', []), 'workload.source.paths'],
    ['case-duplicate source paths', withField('source.paths', ['a.ts', 'A.ts']), 'workload.source.paths'],
    ['a traversal source path', withField('source.paths', ['../x.ts']), 'workload.source.paths'],
    ['non-array source paths', withField('source.paths', 'a.ts'), 'workload.source.paths'],
    ['too many source paths', withField('source.paths', Array.from({ length: 17 }, (_, i) => `f${i}.ts`)), 'workload.source.paths'],
    ['an unknown adaptation', withField('source.adaptation', 'copied'), 'workload.source.adaptation'],
    ['a blank note', withField('source.note', '  '), 'workload.source.note'],
    ['an over-long note', withField('source.note', huge(1001)), 'workload.source.note'],
    ['an extra source key', withField('source.commit', 'abc'), 'workload.source'],
    ['a class-instance source', withField('source', new Box(sample().source)), 'workload.source'],
    ['a blank intendedBehavior', withField('intendedBehavior', ' \n'), 'workload.intendedBehavior'],
    ['an over-long intendedBehavior', withField('intendedBehavior', huge(4001)), 'workload.intendedBehavior'],
    ['a lone-surrogate intendedBehavior', withField('intendedBehavior', 'bad \uD800'), 'workload.intendedBehavior'],
    ['empty criteria', withField('rubric.criteria', []), 'workload.rubric.criteria'],
    ['duplicate criteria ids', withField('rubric.criteria', [crit('strips-dot-prefix'), crit('strips-dot-prefix')]), 'workload.rubric.criteria'],
    ['too many criteria', withField('rubric.criteria', Array.from({ length: 17 }, (_, i) => crit(`c-${i}`))), 'workload.rubric.criteria'],
    ['a non-kebab criterion id', withField('rubric.criteria.0.id', 'Converts_Backslashes'), 'workload.rubric.criteria'],
    ['a blank criterion description', withField('rubric.criteria.0.description', ' '), 'workload.rubric.criteria'],
    ['an over-long criterion description', withField('rubric.criteria.0.description', huge(1001)), 'workload.rubric.criteria'],
    ['an extra criterion key', withField('rubric.criteria.0.weight', 2), 'workload.rubric.criteria'],
    ['a criterion no assessment test mentions', withField('rubric.criteria.0.id', 'never-mentioned'), 'workload.rubric.criteria'],
    ['a criterion only embedded in a longer token', withField('rubric.criteria.0.id', 'converts'), 'workload.rubric.criteria'],
    [
      'a criterion mentioned only by a non-test helper',
      edit((s) => {
        s.assessmentFiles['helper.mjs'] = '// never-mentioned\n';
        s.rubric.criteria[0].id = 'never-mentioned';
      }),
      'workload.rubric.criteria',
    ],
    ['empty coverage tags', withField('rubric.coverageTags', []), 'workload.rubric.coverageTags'],
    ['duplicate coverage tags', withField('rubric.coverageTags', ['reusable-helper', 'reusable-helper']), 'workload.rubric.coverageTags'],
    ['a non-kebab coverage tag', withField('rubric.coverageTags', ['Not_Kebab']), 'workload.rubric.coverageTags'],
    ['too many coverage tags', withField('rubric.coverageTags', Array.from({ length: 17 }, (_, i) => `tag-${i}`)), 'workload.rubric.coverageTags'],
    ['a malformed snapshotDigest', withField('snapshotDigest', 'sha256:ABC'), 'workload.snapshotDigest'],
    ['an uppercase-hex assessmentDigest', withField('assessmentDigest', `sha256:${'A'.repeat(64)}`), 'workload.assessmentDigest'],
    ['a non-sha256 digest', withField('snapshotDigest', `md5:${'0'.repeat(32)}`), 'workload.snapshotDigest'],
    ['a missing assessmentDigest', withField('assessmentDigest', REMOVE), 'workload.assessmentDigest'],
    ['empty initialFiles', withField('initialFiles', {}), 'workload.initialFiles'],
    ['array assessmentFiles', withField('assessmentFiles', ['acceptance.test.mjs']), 'workload.assessmentFiles'],
    ['string initialFiles', withField('initialFiles', 'src/a.mjs'), 'workload.initialFiles'],
    ['null assessmentFiles', withField('assessmentFiles', null), 'workload.assessmentFiles'],
    ['a class-instance file map', withField('initialFiles', new Box(sample().initialFiles)), 'workload.initialFiles'],
    ['non-string content', withField('initialFiles', { 'src/a.mjs': 42 }), 'workload.initialFiles'],
    ['lone-surrogate content', withField('initialFiles', { 'src/a.mjs': 'x \uDC00' }), 'workload.initialFiles'],
    ['an oversize file', withField('initialFiles', { 'big.txt': huge(256 * 1024 + 1) }), 'workload.initialFiles'],
    ['an oversize map', withField('initialFiles', manyFiles(5, 256 * 1024)), 'workload.initialFiles'],
    ['too many files', withField('initialFiles', manyFiles(65, 1)), 'workload.initialFiles'],
    ['no *.test.mjs assessment file', withField('assessmentFiles', { 'acceptance.mjs': ACCEPTANCE }), 'workload.assessmentFiles'],
    ['a path in both maps', edit((s) => { s.assessmentFiles['src/normalizePath.mjs'] = 'export {};\n'; }), 'workload.initialFiles'],
    ['a case-folded path in both maps', edit((s) => { s.assessmentFiles['SRC/normalizePath.mjs'] = 'export {};\n'; }), 'workload.initialFiles'],
    ['assessment content copied into initialFiles', edit((s) => { s.initialFiles['copy.mjs'] = ACCEPTANCE; }), 'workload.initialFiles'],
    ['a prototype-inherited object', Object.create(sample()) as object, 'workload'],
    ['a class instance', new SampleBox(), 'workload'],
    ['an array', [sample()], 'workload'],
    ['null', null, 'workload'],
    ['a string', 'maintenance-sample-path-normalize', 'workload'],
  ];
  it.each(cases)('rejects %s', (_label, raw, field) => {
    expectInvalid(raw, field);
  });

  it('names the computed digest when a pinned digest does not match', () => {
    const snap = expectInvalid(withField('snapshotDigest', `sha256:${'0'.repeat(64)}`), 'workload.snapshotDigest');
    expect(snap.reason).toContain(SNAPSHOT_DIGEST);
    const held = expectInvalid(withField('assessmentDigest', SNAPSHOT_DIGEST), 'workload.assessmentDigest');
    expect(held.reason).toContain(ASSESSMENT_DIGEST);
    expectInvalid(edit((s) => { s.initialFiles['src/normalizePath.mjs'] += ' '; }), 'workload.snapshotDigest');
    expectInvalid(edit((s) => { s.assessmentFiles['acceptance.test.mjs'] += ' '; }), 'workload.assessmentDigest');
  });

  it('never echoes file contents or unbounded paths in rejection reasons', () => {
    const surrogate = expectInvalid(withField('initialFiles', { 'a.txt': 'SECRET-MARKER \uD800' }), 'workload.initialFiles');
    expect(surrogate.reason.includes('SECRET-MARKER')).toBe(false);
    const copied = expectInvalid(edit((s) => { s.initialFiles['copy.mjs'] = ACCEPTANCE; }), 'workload.initialFiles');
    expect(copied.reason.includes('node:test')).toBe(false);
    const longPath = 'y'.repeat(400);
    const long = expectInvalid(edit((s) => { s.initialFiles[longPath] = 'x'; }), 'workload.initialFiles');
    expect(`${long.field} ${long.reason}`.includes('y'.repeat(100))).toBe(false);
  });
});

describe('portable paths', () => {
  const BAD_PATHS: [string, string][] = [
    ['absolute', '/etc/x'],
    ['drive', 'C:/x'],
    ['drive-relative', 'C:x'],
    ['UNC', '//srv/share/x'],
    ['backslash', 'a\\b'],
    ['parent', '../x'],
    ['inner parent', 'a/../b'],
    ['dot prefix', './a'],
    ['inner dot', 'a/./b'],
    ['empty segment', 'a//b'],
    ['trailing slash', 'a/'],
    ['empty', ''],
    ['leading space', ' a'],
    ['trailing space', 'a '],
    ['trailing-dot segment', 'a./b'],
    ['trailing-space segment', 'a /b'],
    ['colon stream', 'a:b'],
    ['less-than', 'a<b'],
    ['greater-than', 'a>b'],
    ['pipe', 'a|b'],
    ['question mark', 'a?b'],
    ['star', 'a*b'],
    ['double quote', 'a"b'],
    ['control char', 'a\u0001b'],
    ['DEL char', 'a\u007fb'],
    ['NUL char', 'a\u0000b'],
    ['zero-width char', '.g\u200cit/config'],
    ['right-to-left mark', 'a\u200fb.mjs'],
    ['right-to-left override', 'src/doc\u202esjm.txt'],
    ['left-to-right isolate', 'a\u2066b.mjs'],
    ['leading byte order mark', '\ufeffindex.mjs'],
    ['Arabic letter mark', 'a\u061cb.mjs'],
    ['C1 control', 'a\u009bb.mjs'],
    ['CON device', 'CON'],
    ['aux device with extension', 'aux.txt'],
    ['nested LPT1 device', 'x/LPT1.js'],
    ['com9 device', 'com9'],
    ['superscript COM device', 'COM\u00b9.txt'],
    ['CONIN$ device', 'CONIN$'],
    ['.git', '.git/config'],
    ['nested .GIT', 'x/.GIT/hooks/pre-commit'],
    ['git short name', 'GIT~1/config'],
    ['dotless-i .git alias', '.g\u0131t/config'],
    ['NFD', 'e\u0301.mjs'],
    ['lone surrogate', 'a\uD800.txt'],
    ['over-long', `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}`],
    ['over-long segment', 'x'.repeat(65)],
    ['multi-byte over-long segment', '\u00e9'.repeat(33)],
    ['too many segments', Array.from({ length: 13 }, () => 'a').join('/')],
  ];
  it.each(BAD_PATHS)('rejects a %s path in every placement', (_label, bad) => {
    expectInvalid(edit((s) => { s.initialFiles[bad] = 'x\n'; }), 'workload.initialFiles');
    expectInvalid(edit((s) => { s.assessmentFiles[bad] = 'y\n'; }), 'workload.assessmentFiles');
    expectInvalid(edit((s) => { s.source.paths = [bad]; }), 'workload.source.paths');
    const direct = rejectionOf(() => ws.digestFiles({ [bad]: 'x' }));
    expect(direct.code).toBe('INVALID_INPUT');
    expect(direct.field.slice(0, 'workload.files'.length)).toBe('workload.files');
  });

  it('forbids exactly the documented characters across the BMP', () => {
    // Independent oracle: the forbidden code point ranges, plus lone surrogates and anything NFC rewrites.
    const forbidden: [number, number][] = [
      [0x00, 0x1f], [0x22, 0x22], [0x2a, 0x2a], [0x3a, 0x3a], [0x3c, 0x3c], [0x3e, 0x3f], [0x5c, 0x5c], [0x7c, 0x7c],
      [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
    ];
    const mismatched: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      const name = `a${String.fromCharCode(cp)}b`;
      const expected = forbidden.some(([lo, hi]) => cp >= lo && cp <= hi)
        || (cp >= 0xd800 && cp <= 0xdfff) || name.normalize('NFC') !== name;
      let rejected = false;
      try {
        ws.digestFiles({ [name]: 'x' });
      } catch (err) {
        if (!(err instanceof MoeError) || err.codeName !== 'INVALID_INPUT') throw err;
        rejected = true;
      }
      if (rejected !== expected) mismatched.push(`U+${cp.toString(16).padStart(4, '0')}`);
    }
    expect(mismatched).toEqual([]);
  });

  it('quotes rejected paths and keys as printable ASCII', () => {
    const bidiPath = rejectionOf(() => ws.digestFiles({ 'src/doc\u202esjm.txt': 'x' }));
    expect(bidiPath.reason).toBe('"src/doc\\u202esjm.txt" contains a backslash, colon, reserved, control or invisible character');
    const bidiKey = expectInvalid({ ...sample(), 'id\u2066x': 1 }, 'workload');
    expect(bidiKey.reason).toBe('unknown key "id\\u2066x"');
    const nfd = expectInvalid(edit((s) => { s.initialFiles['e\u0301.mjs'] = 'x\n'; }), 'workload.initialFiles');
    expect(nfd.reason).toBe('"e\\u0301.mjs" must be well-formed NFC text');
  });

  it('keeps literal hidden characters out of the contract sources (Trojan Source)', () => {
    // C0/C1 controls other than tab/LF/CR, line/paragraph separators and format characters (bidi controls, BOM).
    const hidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu;
    for (const name of ['workloadSnapshot.ts', 'workloadSnapshot.test.ts']) {
      const text = fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      const hits = [...text.matchAll(hidden)]
        .map((m) => `${name}:${text.slice(0, m.index).split('\n').length}:U+${(m[0].codePointAt(0) ?? 0).toString(16)}`);
      expect(hits).toEqual([]);
    }
  });

  it('accepts paths exactly at the length and depth bounds', () => {
    const atBounds: Files = {
      [`${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(30)}`]: '',
      [Array.from({ length: 12 }, () => 'd').join('/')]: 'deep',
      ['\u00e9'.repeat(32)]: 'two-byte segment of 64 bytes',
    };
    expect(ws.digestFiles(atBounds)).toBe(referenceDigest(atBounds));
  });

  it('rejects case-folded duplicates, file/directory conflicts and symbol keys', () => {
    expectInvalid(edit((s) => { s.initialFiles['Src/normalizePath.mjs'] = 'x\n'; }), 'workload.initialFiles');
    expectInvalid(edit((s) => { s.initialFiles.src = 'x\n'; }), 'workload.initialFiles');
    expectInvalid(edit((s) => { s.initialFiles.SRC = 'x\n'; }), 'workload.initialFiles');
    expectInvalid(edit((s) => { s.initialFiles['src/normalizePath.mjs/inner.mjs'] = 'x\n'; }), 'workload.initialFiles');
    const aliases = [{ 'i.txt': '1', '\u0131.txt': '2' }, { 's.txt': '1', '\u017f.txt': '2' }];
    for (const files of [{ a: '1', 'a/b': '2' }, { 'Src/a.mjs': '1', 'src/a.mjs': '2' }, ...aliases, { [Symbol('s')]: 'x', 'a.txt': 'y' }]) {
      expect(rejectionOf(() => ws.digestFiles(files)).code).toBe('INVALID_INPUT');
    }
  });
});

describe('digests', () => {
  it('matches the documented framing in UTF-8 byte order, not UTF-16 order', () => {
    const files: Files = { '\uFF5E.txt': 'tilde\n', '\u{1F600}.txt': 'emoji\n', 'a/b.mjs': '', 'Z.md': 'caf\u00e9' };
    const utf16 = Object.keys(files).sort();
    const utf8 = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(utf16).not.toEqual(utf8);
    expect(ws.digestFiles(files)).toBe(referenceDigest(files));
    expect(ws.digestFiles(files)).not.toBe(referenceDigest(files, 'utf16'));
  });

  it('is insertion-order independent and changes on any path, content or empty-file change', () => {
    const base: Files = { 'a.txt': 'one', 'b/c.txt': 'two' };
    const digest = ws.digestFiles(base);
    expect(ws.digestFiles({ 'b/c.txt': 'two', 'a.txt': 'one' })).toBe(digest);
    const variants: Files[] = [
      { 'a.txt': 'one ', 'b/c.txt': 'two' },
      { 'a.txt': 'one', 'b/d.txt': 'two' },
      { ...base, 'empty.txt': '' },
      { 'a.txt': 'onetwo', 'b/c.txt': '' },
      { ab: 'c' },
      { a: 'bc' },
    ];
    const seen = new Set([digest, ...variants.map((v) => ws.digestFiles(v))]);
    expect(seen.size).toBe(variants.length + 1);
  });

  it('pins known-answer vectors', () => {
    expect(ws.digestFiles({ 'a.txt': 'hello\n', 'dir/empty.mjs': '' })).toBe(KAT_DIGEST);
    expect(referenceDigest({ 'a.txt': 'hello\n', 'dir/empty.mjs': '' })).toBe(KAT_DIGEST);
    expect(ws.digestFiles(sample().initialFiles)).toBe(SNAPSHOT_DIGEST);
    expect(referenceDigest(sample().assessmentFiles)).toBe(ASSESSMENT_DIGEST);
  });

  it('pins digestWorkload and ignores key order', () => {
    expect(ws.digestWorkload(sample())).toBe(WORKLOAD_DIGEST);
    const s = sample();
    const reordered: Record<string, unknown> = Object.fromEntries(Object.entries(s).reverse());
    reordered.source = Object.fromEntries(Object.entries(s.source).reverse());
    reordered.rubric = {
      coverageTags: s.rubric.coverageTags,
      criteria: s.rubric.criteria.map((c) => ({ description: c.description, id: c.id })),
    };
    expect(ws.digestWorkload(reordered)).toBe(WORKLOAD_DIGEST);
  });

  it('changes digestWorkload when any frozen field changes', () => {
    const variants = [
      edit((s) => { s.source.note += '.'; }),
      edit((s) => { s.source.adaptation = 'adapted'; }),
      edit((s) => { s.source.paths.push('packages/moe-daemon/src/util/errors.ts'); }),
      edit((s) => { s.rubric.criteria[1].description += '.'; }),
      edit((s) => { s.rubric.criteria.reverse(); }),
      edit((s) => { s.rubric.coverageTags.push('changed-caller'); }),
      edit((s) => { s.intendedBehavior += '.'; }),
      edit((s) => { s.category = 'defect'; s.id = 'defect-sample-path-normalize'; }),
      edit((s) => { s.id = 'maintenance-sample-renamed'; }),
    ];
    const digests = new Set(variants.map((v) => ws.digestWorkload(v)));
    expect(digests.size).toBe(variants.length);
    expect(digests.has(WORKLOAD_DIGEST)).toBe(false);
    expect(rejectionOf(() => ws.digestWorkload({ ...sample(), solution: 'x' })).code).toBe('INVALID_INPUT');
  });
});

describe('validateWorkloads', () => {
  it('validates a corpus into a frozen array and rejects duplicates or bad shapes', () => {
    const second = edit((s) => {
      s.id = 'maintenance-second';
      s.initialFiles['src/extra.mjs'] = 'export {};\n';
      s.snapshotDigest = referenceDigest(s.initialFiles);
    });
    const corpus = ws.validateWorkloads([sample(), second]);
    expect(corpus.map((w) => w.id)).toEqual(['maintenance-sample-path-normalize', 'maintenance-second']);
    expect(Object.isFrozen(corpus)).toBe(true);
    const dupId = rejectionOf(() => ws.validateWorkloads([sample(), edit((s) => { s.intendedBehavior += ' Again.'; })]));
    expect([dupId.code, dupId.field]).toEqual(['INVALID_INPUT', 'workloads[1].id']);
    const dupSnap = rejectionOf(() => ws.validateWorkloads([sample(), edit((s) => { s.id = 'maintenance-copy'; })]));
    expect([dupSnap.code, dupSnap.field]).toEqual(['INVALID_INPUT', 'workloads[1].snapshotDigest']);
    expect(rejectionOf(() => ws.validateWorkloads([sample(), { ...sample(), solution: 1 }])).field).toBe('workloads[1]');
    expect(rejectionOf(() => ws.validateWorkloads([])).field).toBe('workloads');
    expect(rejectionOf(() => ws.validateWorkloads('x')).field).toBe('workloads');
    expect(rejectionOf(() => ws.validateWorkloads(Array.from({ length: 65 }, () => sample()))).field).toBe('workloads');
  });
});

describe('snapshot materialization', () => {
  it('writes exactly the coding inputs into a fresh owned temp root', async () => {
    const h = await coding();
    expect([h.kind, h.workloadId, h.digest]).toEqual(['coding', 'maintenance-sample-path-normalize', SNAPSHOT_DIGEST]);
    expect(Object.isFrozen(h)).toBe(true);
    expect(path.dirname(h.root)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(h.root).startsWith('moe-workload-coding-')).toBe(true);
    expect(isInside(process.cwd(), h.root)).toBe(false);
    const expected = sample().initialFiles;
    expect(listTree(h.root)).toEqual(Object.keys(expected).sort());
    for (const rel of listTree(h.root)) expect(fs.readFileSync(path.join(h.root, rel), 'utf8')).toBe(expected[rel]);
    const read = await ws.readSnapshotFiles(h);
    expect(read).toEqual(expected);
    expect(Object.isFrozen(read)).toBe(true);
    expect(ws.digestFiles(read)).toBe(SNAPSHOT_DIGEST);
  });

  it('keeps held-out assessment material out of the coding snapshot', async () => {
    const c = await coding();
    const a = await assessment();
    expect([a.kind, a.digest]).toEqual(['assessment', ASSESSMENT_DIGEST]);
    expect(path.basename(a.root).startsWith('moe-workload-assessment-')).toBe(true);
    expect(isInside(c.root, a.root) || isInside(a.root, c.root)).toBe(false);
    expect(listTree(a.root)).toEqual(['acceptance.test.mjs']);
    expect(await ws.readSnapshotFiles(a)).toEqual(sample().assessmentFiles);
    expect(listTree(c.root).some((rel) => rel.endsWith('.test.mjs'))).toBe(false);
    for (const rel of listTree(c.root)) {
      const text = fs.readFileSync(path.join(c.root, rel), 'utf8');
      expect([text.includes('node:test'), text.includes('converts-backslashes')]).toEqual([false, false]);
    }
  });

  it('rejects invalid workloads before creating any directory', async () => {
    const mkdtemp = vi.spyOn(fs.promises, 'mkdtemp');
    await expect(ws.createCodingSnapshot({ ...sample(), solution: 'leak' })).rejects.toThrow('[INVALID_INPUT]');
    await expect(ws.createAssessmentSnapshot(withField('snapshotDigest', 'bad'))).rejects.toThrow('[INVALID_INPUT]');
    expect(mkdtemp).toHaveBeenCalledTimes(0);
  });

  it('accepts no destination: an extra argument cannot redirect writes', async () => {
    const create = ws.createCodingSnapshot as (...args: unknown[]) => Promise<ws.WorkloadSnapshotHandle>;
    const h = await create(sample(), userTree);
    handles.push(h);
    expect(path.dirname(h.root)).toBe(fs.realpathSync(os.tmpdir()));
    expectUserTreeIntact();
  });
});

describe('determinism and resets', () => {
  it('creates distinct equal snapshots concurrently, isolates mutations and resets fresh', async () => {
    const many = await Promise.all(Array.from({ length: 8 }, () => coding()));
    expect(new Set(many.map((h) => h.root)).size).toBe(8);
    for (const h of many) expect(ws.digestFiles(await ws.readSnapshotFiles(h))).toBe(SNAPSHOT_DIGEST);
    const [dirty, ...clean] = many;
    fs.writeFileSync(path.join(dirty.root, 'src', 'normalizePath.mjs'), FIXED);
    fs.writeFileSync(path.join(dirty.root, 'added.mjs'), 'export {};\n');
    fs.rmSync(path.join(dirty.root, 'docs'), { recursive: true });
    expect(ws.digestFiles(await ws.readSnapshotFiles(dirty))).not.toBe(SNAPSHOT_DIGEST);
    link(userTree, path.join(dirty.root, 'escape'));
    for (const h of clean) expect(ws.digestFiles(await ws.readSnapshotFiles(h))).toBe(SNAPSHOT_DIGEST);
    const reset = await coding();
    expect(many.some((h) => h.root === reset.root)).toBe(false);
    expect(await ws.readSnapshotFiles(reset)).toEqual(sample().initialFiles);
    await Promise.all(many.map((h) => h.dispose()));
    for (const h of many) expect(fs.existsSync(h.root)).toBe(false);
    expectUserTreeIntact();
  });
});

describe('cleanup ownership', () => {
  it('disposes only its own root, idempotently, and ignores this-rebinding', async () => {
    const a = await coding();
    const b = await coding();
    await (a.dispose as (this: unknown) => Promise<void>).call({ root: userTree });
    expect([fs.existsSync(a.root), fs.existsSync(b.root)]).toEqual([false, true]);
    await expect(a.dispose()).resolves.toBeUndefined();
    await Promise.all([b.dispose(), b.dispose()]);
    expect(fs.existsSync(b.root)).toBe(false);
    expectUserTreeIntact();
  });

  it('removes a planted junction as a link without following it', async () => {
    const h = await coding();
    link(userTree, path.join(h.root, 'src', 'escape'));
    expect(fs.readFileSync(path.join(h.root, 'src', 'escape', 'keep.txt'), 'utf8')).toBe('user bytes\n');
    await h.dispose();
    expect(fs.existsSync(h.root)).toBe(false);
    expectUserTreeIntact();
  });

  it('refuses to dispose or read a root swapped for a junction, then recovers once restored', async () => {
    const h = await coding();
    const parked = path.join(tempDir('park'), 'root');
    fs.renameSync(h.root, parked);
    link(userTree, h.root);
    await expect(h.dispose()).rejects.toThrow('[NOT_ALLOWED]');
    await expect(ws.readSnapshotFiles(h)).rejects.toThrow('[NOT_ALLOWED]');
    expectUserTreeIntact();
    expect(fs.existsSync(path.join(parked, 'src', 'normalizePath.mjs'))).toBe(true);
    fs.unlinkSync(h.root);
    fs.renameSync(parked, h.root);
    await h.dispose();
    expect(fs.existsSync(h.root)).toBe(false);
  });

  it('refuses to dispose a root replaced by a different real directory', async () => {
    const h = await coding();
    const impostor = tempDir('impostor');
    fs.writeFileSync(path.join(impostor, 'user.txt'), 'impostor\n');
    const parked = path.join(tempDir('park'), 'root');
    fs.renameSync(h.root, parked);
    fs.renameSync(impostor, h.root);
    await expect(h.dispose()).rejects.toThrow('[NOT_ALLOWED]');
    expect(fs.readFileSync(path.join(h.root, 'user.txt'), 'utf8')).toBe('impostor\n');
    fs.rmSync(h.root, { recursive: true });
    fs.renameSync(parked, h.root);
    await h.dispose();
    expect(fs.existsSync(h.root)).toBe(false);
  });
});

describe('readSnapshotFiles refusals', () => {
  it('refuses links, invalid UTF-8, oversize files, disposed and forged handles', async () => {
    const linked = await coding();
    link(userTree, path.join(linked.root, 'docs', 'escape'));
    await expect(ws.readSnapshotFiles(linked)).rejects.toThrow('[NOT_ALLOWED]');
    if (process.platform !== 'win32') {
      const fileLink = await coding();
      fs.symlinkSync(path.join(userTree, 'keep.txt'), path.join(fileLink.root, 'keep.txt'));
      await expect(ws.readSnapshotFiles(fileLink)).rejects.toThrow('[NOT_ALLOWED]');
    }
    const invalid = await coding();
    fs.writeFileSync(path.join(invalid.root, 'bad.txt'), Buffer.from([0xc3, 0x28]));
    await expect(ws.readSnapshotFiles(invalid)).rejects.toThrow('[NOT_ALLOWED]');
    const oversize = await coding();
    fs.writeFileSync(path.join(oversize.root, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
    await expect(ws.readSnapshotFiles(oversize)).rejects.toThrow('[NOT_ALLOWED]');
    const disposed = await coding();
    await disposed.dispose();
    await expect(ws.readSnapshotFiles(disposed)).rejects.toThrow('[NOT_ALLOWED]');
    const live = await coding();
    const forged = { kind: live.kind, workloadId: live.workloadId, root: live.root, digest: live.digest, dispose: live.dispose };
    await expect(ws.readSnapshotFiles(forged)).rejects.toThrow('[NOT_ALLOWED]');
    await expect(ws.readSnapshotFiles({ ...live, root: userTree })).rejects.toThrow('[NOT_ALLOWED]');
    expectUserTreeIntact();
  });

  it('names a refused candidate entry as printable ASCII', async () => {
    const h = await coding();
    link(userTree, path.join(h.root, 'a\u202ekl'));
    const refusal = await ws.readSnapshotFiles(h).then(() => null, (err: unknown) => err);
    expect(refusal).toBeInstanceOf(MoeError);
    expect((refusal as MoeError).context?.reason).toBe('"a\\u202ekl" is a link, junction or special file');
    expectUserTreeIntact();
  });

  it.runIf(process.platform !== 'win32')('returns candidate paths verbatim for digestFiles to reject', async () => {
    const h = await coding();
    fs.writeFileSync(path.join(h.root, 'a<b.txt'), 'candidate\n');
    fs.mkdirSync(path.join(h.root, 'empty-dir'));
    const read = await ws.readSnapshotFiles(h);
    expect(Object.keys(read).sort()).toEqual([...Object.keys(sample().initialFiles), 'a<b.txt'].sort());
    expect(rejectionOf(() => ws.digestFiles(read)).code).toBe('INVALID_INPUT');
  });
});

describe('partial IO', () => {
  it('removes the fresh root and keeps the IO error code when a write fails', async () => {
    const mkdtemp = vi.spyOn(fs.promises, 'mkdtemp');
    const realWrite = fs.promises.writeFile;
    let calls = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof realWrite>) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
      return realWrite(...args);
    });
    await expect(ws.createCodingSnapshot(sample())).rejects.toMatchObject({ code: 'ENOSPC' });
    expect([mkdtemp.mock.calls.length, calls]).toEqual([1, 2]);
    const created = await (mkdtemp.mock.results[0].value as Promise<string>);
    expect(fs.existsSync(created)).toBe(false);
  });

  it('names both codes and the leftover root when cleanup also fails', async () => {
    const mkdtemp = vi.spyOn(fs.promises, 'mkdtemp');
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('simulated'), { code: 'ENOSPC' }));
    vi.spyOn(fs.promises, 'rm').mockRejectedValue(Object.assign(new Error('simulated'), { code: 'EBUSY' }));
    const err = await ws.createCodingSnapshot(sample()).then(() => null, (e: unknown) => e);
    const created = await (mkdtemp.mock.results[0].value as Promise<string>);
    vi.restoreAllMocks();
    scratch.push(created);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect([message.includes('ENOSPC'), message.includes('EBUSY'), message.includes(path.basename(created))]).toEqual([true, true, true]);
    expect(fs.existsSync(created)).toBe(true);
  });
});

describe('assessment convention smoke (not benchmark execution)', () => {
  const runAssessment = (assessmentRoot: string, codingRoot: string | undefined): ReturnType<typeof spawnSync> => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
    delete env[ws.WORKLOAD_CANDIDATE_ROOT_ENV];
    if (codingRoot !== undefined) env[ws.WORKLOAD_CANDIDATE_ROOT_ENV] = codingRoot;
    return spawnSync(process.execPath, ['--test', 'acceptance.test.mjs'], { cwd: assessmentRoot, env, encoding: 'utf8', timeout: 60_000 });
  };

  it('fails the original, passes a fixed candidate and fails a plausible-wrong one', async () => {
    const a = await assessment();
    const c = await coding();
    const target = path.join(c.root, 'src', 'normalizePath.mjs');
    expect(runAssessment(a.root, undefined).status).toBe(1);
    expect(runAssessment(a.root, c.root).status).toBe(1);
    fs.writeFileSync(target, FIXED);
    const pass = runAssessment(a.root, c.root);
    expect(pass.status, `${String(pass.stdout)}${String(pass.stderr)}`).toBe(0);
    fs.writeFileSync(target, WRONG);
    expect(runAssessment(a.root, c.root).status).toBe(1);
    expect(await ws.readSnapshotFiles(a)).toEqual(sample().assessmentFiles);
  }, 120_000);
});

describe('user tree sentinel', () => {
  it('stays byte- and mtime-identical after every snapshot operation', () => {
    expectUserTreeIntact();
  });
});
