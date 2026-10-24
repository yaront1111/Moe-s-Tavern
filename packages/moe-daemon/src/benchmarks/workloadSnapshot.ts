// =============================================================================
// Frozen workload snapshot contract, version 1 (CQ-M03a)
// =============================================================================
//
// Test-only benchmark scaffolding: no production module imports this file. It
// defines the data contract the CQ-M03 category datasets (maintenance, defect,
// refactor, non-routine) are authored against, its strict validation, the
// deterministic digests and fresh owned temp-directory snapshots. It neither
// runs benchmarks nor ranks outcomes.
//
// A workload is a REDUCED fixture overlay: `initialFiles` are bytes adapted from
// Moe source at the immutable FROZEN_STARTING_COMMIT (provenance in `source`),
// never a claim that a snapshot equals a whole-repository checkout.
// `assessmentFiles` are held-out executable black-box acceptance tests and are
// never written into a coding snapshot.
//
// Digest framing (digestFiles): SHA-256 over the UTF-8 bytes
//   "moe-workload-files-v1\0" + u32be(count) + for each entry, sorted by
//   Buffer.compare of its UTF-8 path bytes:
//   u32be(pathBytes) + path + u32be(contentBytes) + content
// rendered "sha256:" + 64 lowercase hex. digestWorkload hashes
// "moe-workload-v1\0" + JSON.stringify of a positional array of every field.
//
// Assessment convention: each `*.test.mjs` assessment file runs as
// `node --test <file>` with the assessment snapshot root as cwd and
// WORKLOAD_CANDIDATE_ROOT_ENV naming the coding snapshot root, from which it
// imports candidate modules by file URL.
//
// Reset is a NEW snapshot: nothing is reset in place, the API accepts no
// destination, and no Git operation is ever involved.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invalidInput, notAllowed } from '../util/errors.js';

export const WORKLOAD_CONTRACT_VERSION = 1;
export const FROZEN_STARTING_COMMIT = '35cf53c8444ebe1ca27e68bfbe8c5ca4896bac71';
export const SOURCE_REPOSITORY = 'github.com/yaront1111/Moe-s-Tavern';
export const WORKLOAD_CATEGORIES = Object.freeze(['maintenance', 'defect', 'refactor', 'non-routine'] as const);
/** Shared coverage-tag spelling for the category datasets; validation accepts any kebab tag. */
export const CORPUS_COVERAGE_TAGS = Object.freeze([
  'reusable-helper',
  'stale-positive-context',
  'stale-negative-context',
  'changed-caller',
  'changed-requirements',
  'recipe-mismatch',
] as const);
export const WORKLOAD_CANDIDATE_ROOT_ENV = 'MOE_WORKLOAD_CANDIDATE_ROOT';
export const WORKLOAD_LIMITS = Object.freeze({
  pathBytes: 160,
  pathSegments: 12,
  segmentBytes: 64,
  filesPerMap: 64,
  fileBytes: 256 * 1024,
  mapBytes: 1024 * 1024,
  idLength: 80,
  sourcePaths: 16,
  noteLength: 1000,
  intendedBehaviorLength: 4000,
  criteria: 16,
  descriptionLength: 1000,
  coverageTags: 16,
  kebabLength: 64,
  workloads: 64,
  readDepth: 32,
  readEntries: 4096,
});

export type WorkloadCategory = (typeof WORKLOAD_CATEGORIES)[number];
export type WorkloadAdaptation = 'verbatim' | 'reduced' | 'adapted';
export type WorkloadFiles = Readonly<Record<string, string>>;
export interface WorkloadSource {
  readonly repository: string;
  readonly paths: readonly string[];
  readonly adaptation: WorkloadAdaptation;
  readonly note: string;
}
export interface WorkloadCriterion {
  readonly id: string;
  readonly description: string;
}
export interface WorkloadRubric {
  readonly criteria: readonly WorkloadCriterion[];
  readonly coverageTags: readonly string[];
}
export interface Workload {
  readonly contractVersion: typeof WORKLOAD_CONTRACT_VERSION;
  readonly id: string;
  readonly category: WorkloadCategory;
  readonly startingCommit: string;
  readonly source: WorkloadSource;
  readonly intendedBehavior: string;
  readonly initialFiles: WorkloadFiles;
  readonly assessmentFiles: WorkloadFiles;
  readonly rubric: WorkloadRubric;
  readonly snapshotDigest: string;
  readonly assessmentDigest: string;
}

const LIMITS = WORKLOAD_LIMITS;
const ADAPTATIONS: readonly string[] = ['verbatim', 'reduced', 'adapted'];
const WORKLOAD_KEYS = [
  'contractVersion', 'id', 'category', 'startingCommit', 'source', 'intendedBehavior',
  'initialFiles', 'assessmentFiles', 'rubric', 'snapshotDigest', 'assessmentDigest',
] as const;
const FILES_DIGEST_TAG = 'moe-workload-files-v1\0';
const WORKLOAD_DIGEST_TAG = 'moe-workload-v1\0';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// Backslash, drive/stream colon, Windows-reserved, C0/DEL/C1 control, bidi-control (ALM, LRM/RLM, LRE-RLO,
// LRI-PDI), zero-width and BOM characters. Keep them escaped: literal ones in source are Trojan Source.
const FORBIDDEN_CHAR = /[\\<>:"|?*\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

const utf8Length = (s: string): number => Buffer.byteLength(s, 'utf8');
/** True when the string has no lone surrogates (Node 18 lacks String.prototype.isWellFormed). */
const wellFormed = (s: string): boolean => Buffer.from(s, 'utf8').toString('utf8') === s;
/** Quotes a value for an error message as printable ASCII, so hidden or bidi characters never reach logs raw. */
const quoted = (s: string): string =>
  JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/**
 * Case key for collision checks. Upper-then-lower also folds the NTFS upcase
 * aliases plain toLowerCase misses (dotless i -> I, long s -> S), so a name that
 * aliases on Windows is rejected on every platform. Over-strict is acceptable.
 */
const foldCase = (s: string): string => s.toUpperCase().toLowerCase();
/** Whole-token occurrence: `converts` is not mentioned by `converts-backslashes`. */
const mentionsToken = (text: string, token: string): boolean =>
  new RegExp(`(?<![a-z0-9-])${token}(?![a-z0-9-])`).test(text);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads a plain object holding exactly `keys`; each property is read once. */
function readRecord<K extends string>(raw: unknown, field: string, keys: readonly K[]): Record<K, unknown> {
  if (!isPlainObject(raw)) throw invalidInput(field, 'must be a plain object');
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key === 'string' && (keys as readonly string[]).includes(key)) continue;
    const shown = typeof key === 'symbol' ? 'a symbol key' : key.length <= 64 ? quoted(key) : 'an over-long key';
    throw invalidInput(field, `unknown key ${shown}`);
  }
  const out = {} as Record<K, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) throw invalidInput(`${field}.${key}`, 'is required');
    out[key] = raw[key];
  }
  return out;
}

function readArray(raw: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) throw invalidInput(field, 'must be an array');
  if (raw.length < min || raw.length > max) throw invalidInput(field, `must hold ${min}-${max} entries`);
  return Array.prototype.slice.call(raw) as unknown[];
}

function readText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string') throw invalidInput(field, 'must be a non-blank string');
  if (raw.length > max) throw invalidInput(field, `must be at most ${max} characters`);
  if (raw.trim() === '') throw invalidInput(field, 'must be a non-blank string');
  if (!wellFormed(raw)) throw invalidInput(field, 'must be well-formed text (no lone surrogates)');
  return raw;
}

function readKebab(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length > LIMITS.kebabLength || !KEBAB.test(raw)) {
    throw invalidInput(field, `must be lowercase kebab-case of at most ${LIMITS.kebabLength} characters`);
  }
  return raw;
}

function readUniqueKebabs(raw: unknown, field: string, max: number): readonly string[] {
  const values = readArray(raw, field, 1, max).map((value, i) => readKebab(value, `${field}[${i}]`));
  if (new Set(values).size !== values.length) throw invalidInput(field, 'must not repeat an entry');
  return Object.freeze(values);
}

/**
 * The one portable-path rule, for file maps and source.paths alike. Deliberately
 * stricter than util/affectedFiles: it rejects non-canonical forms instead of
 * normalizing them, and it is platform-independent.
 */
function checkPortablePath(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw === '') throw invalidInput(field, 'must be a non-empty relative path');
  if (utf8Length(raw) > LIMITS.pathBytes) throw invalidInput(field, `path exceeds ${LIMITS.pathBytes} UTF-8 bytes`);
  const shown = quoted(raw);
  if (!wellFormed(raw) || raw.normalize('NFC') !== raw) throw invalidInput(field, `${shown} must be well-formed NFC text`);
  if (FORBIDDEN_CHAR.test(raw)) {
    throw invalidInput(field, `${shown} contains a backslash, colon, reserved, control or invisible character`);
  }
  if (raw.startsWith('/')) throw invalidInput(field, `${shown} must be relative`);
  const segments = raw.split('/');
  if (segments.length > LIMITS.pathSegments) throw invalidInput(field, `${shown} exceeds ${LIMITS.pathSegments} segments`);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw invalidInput(field, `${shown} has an empty, '.' or '..' segment`);
    if (utf8Length(segment) > LIMITS.segmentBytes) throw invalidInput(field, `${shown} has a segment over ${LIMITS.segmentBytes} UTF-8 bytes`);
    if (segment.startsWith(' ') || segment.endsWith(' ') || segment.endsWith('.')) {
      throw invalidInput(field, `${shown} has a segment with a leading space or a trailing dot or space`);
    }
    const folded = foldCase(segment);
    if (DEVICE_NAME.test(folded)) throw invalidInput(field, `${shown} uses a Windows device name`);
    if (folded === '.git' || folded === 'git~1') throw invalidInput(field, `${shown} contains a .git segment`);
  }
  return raw;
}

function checkContent(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw invalidInput(field, 'content must be a string');
  if (utf8Length(raw) > LIMITS.fileBytes) throw invalidInput(field, `content exceeds ${LIMITS.fileBytes} UTF-8 bytes`);
  if (!wellFormed(raw)) throw invalidInput(field, 'content must be well-formed text (no lone surrogates)');
  return raw;
}

/** Validates a path -> content map into a null-prototype copy (not yet frozen). */
function checkFiles(raw: unknown, field: string): Record<string, string> {
  if (!isPlainObject(raw)) throw invalidInput(field, 'must be a plain object mapping paths to strings');
  const keys = Reflect.ownKeys(raw);
  if (keys.length === 0 || keys.length > LIMITS.filesPerMap) throw invalidInput(field, `must hold 1-${LIMITS.filesPerMap} files`);
  const files = Object.create(null) as Record<string, string>;
  const folded = new Map<string, string>();
  let total = 0;
  keys.forEach((key, index) => {
    const entry = `${field}[#${index}]`;
    if (typeof key !== 'string') throw invalidInput(entry, 'symbol keys are not allowed');
    const file = checkPortablePath(key, entry);
    const content = checkContent(raw[key], entry);
    total += utf8Length(content);
    if (total > LIMITS.mapBytes) throw invalidInput(field, `total content exceeds ${LIMITS.mapBytes} UTF-8 bytes`);
    const prior = folded.get(foldCase(file));
    if (prior !== undefined) throw invalidInput(entry, `${quoted(file)} collides with ${quoted(prior)} ignoring case`);
    folded.set(foldCase(file), file);
    files[file] = content;
  });
  for (const [fold, file] of folded) {
    const segments = fold.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      const asFile = folded.get(segments.slice(0, i).join('/'));
      if (asFile !== undefined) throw invalidInput(field, `${quoted(asFile)} is both a file and a directory of ${quoted(file)}`);
    }
  }
  return files;
}

interface FileEntry {
  readonly path: string;
  readonly pathBytes: Buffer;
  readonly content: string;
}
/** Entries in UTF-8 path byte order: the digest order and the write order. */
function sortedEntries(files: WorkloadFiles): FileEntry[] {
  return Object.keys(files)
    .map((p) => ({ path: p, pathBytes: Buffer.from(p, 'utf8'), content: files[p] }))
    .sort((a, b) => Buffer.compare(a.pathBytes, b.pathBytes));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function hashFiles(files: WorkloadFiles): string {
  const hash = createHash('sha256');
  const entries = sortedEntries(files);
  hash.update(Buffer.from(FILES_DIGEST_TAG, 'utf8')).update(u32(entries.length));
  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf8');
    hash.update(u32(entry.pathBytes.length)).update(entry.pathBytes).update(u32(content.length)).update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Validates a file map and returns its framed SHA-256 digest. */
export function digestFiles(files: unknown): string {
  return hashFiles(checkFiles(files, 'workload.files'));
}

function checkDigest(raw: unknown, files: WorkloadFiles, field: string): string {
  if (typeof raw !== 'string' || !DIGEST.test(raw)) throw invalidInput(field, 'must be "sha256:" followed by 64 lowercase hex characters');
  const computed = hashFiles(files);
  if (raw !== computed) throw invalidInput(field, `does not match the computed digest ${computed}`);
  return raw;
}

function checkSource(raw: unknown, field: string): WorkloadSource {
  const source = readRecord(raw, field, ['repository', 'paths', 'adaptation', 'note'] as const);
  if (source.repository !== SOURCE_REPOSITORY) throw invalidInput(`${field}.repository`, `must be ${SOURCE_REPOSITORY}`);
  const paths = readArray(source.paths, `${field}.paths`, 1, LIMITS.sourcePaths)
    .map((p, i) => checkPortablePath(p, `${field}.paths[${i}]`));
  if (new Set(paths.map(foldCase)).size !== paths.length) {
    throw invalidInput(`${field}.paths`, 'must not repeat a path (ignoring case)');
  }
  const adaptation = source.adaptation;
  if (typeof adaptation !== 'string' || !ADAPTATIONS.includes(adaptation)) {
    throw invalidInput(`${field}.adaptation`, `must be one of ${ADAPTATIONS.join(', ')}`);
  }
  const note = readText(source.note, `${field}.note`, LIMITS.noteLength);
  return Object.freeze({ repository: SOURCE_REPOSITORY, paths: Object.freeze(paths), adaptation: adaptation as WorkloadAdaptation, note });
}

/** Held-out assessment paths and bytes must never reach the coding inputs. */
function checkSeparation(initial: WorkloadFiles, assessment: WorkloadFiles, root: string): void {
  const initialPaths = new Set(Object.keys(initial).map(foldCase));
  const initialContents = new Set(Object.values(initial));
  for (const [file, content] of Object.entries(assessment)) {
    const shown = quoted(file);
    if (initialPaths.has(foldCase(file))) {
      throw invalidInput(`${root}.initialFiles`, `held-out assessment path ${shown} also appears in the coding inputs`);
    }
    if (initialContents.has(content)) {
      throw invalidInput(`${root}.initialFiles`, `the content of held-out assessment file ${shown} is copied into the coding inputs`);
    }
  }
  if (!Object.keys(assessment).some((p) => p.endsWith('.test.mjs'))) {
    throw invalidInput(`${root}.assessmentFiles`, 'must include at least one executable *.test.mjs acceptance test');
  }
}

function checkRubric(raw: unknown, field: string, assessment: WorkloadFiles): WorkloadRubric {
  const rubric = readRecord(raw, field, ['criteria', 'coverageTags'] as const);
  const tests = Object.keys(assessment).filter((p) => p.endsWith('.test.mjs')).map((p) => assessment[p]);
  const ids = new Set<string>();
  const criteria = readArray(rubric.criteria, `${field}.criteria`, 1, LIMITS.criteria).map((item, i) => {
    const at = `${field}.criteria[${i}]`;
    const criterion = readRecord(item, at, ['id', 'description'] as const);
    const id = readKebab(criterion.id, `${at}.id`);
    if (ids.has(id)) throw invalidInput(`${at}.id`, `duplicate criterion id ${quoted(id)}`);
    ids.add(id);
    if (!tests.some((test) => mentionsToken(test, id))) {
      throw invalidInput(`${at}.id`, `no *.test.mjs assessment file mentions ${quoted(id)}`);
    }
    const description = readText(criterion.description, `${at}.description`, LIMITS.descriptionLength);
    return Object.freeze({ id, description });
  });
  const coverageTags = readUniqueKebabs(rubric.coverageTags, `${field}.coverageTags`, LIMITS.coverageTags);
  return Object.freeze({ criteria: Object.freeze(criteria), coverageTags });
}

function checkIdentity(raw: Record<string, unknown>, root: string): { id: string; category: WorkloadCategory } {
  if (raw.contractVersion !== WORKLOAD_CONTRACT_VERSION) throw invalidInput(`${root}.contractVersion`, `must be ${WORKLOAD_CONTRACT_VERSION}`);
  const category = raw.category;
  if (typeof category !== 'string' || !(WORKLOAD_CATEGORIES as readonly string[]).includes(category)) {
    throw invalidInput(`${root}.category`, `must be one of ${WORKLOAD_CATEGORIES.join(', ')}`);
  }
  const id = raw.id;
  const prefix = `${category}-`;
  if (typeof id !== 'string' || id.length > LIMITS.idLength || !id.startsWith(prefix) || !KEBAB.test(id.slice(prefix.length))) {
    throw invalidInput(`${root}.id`, `must be "${prefix}" plus lowercase kebab-case, at most ${LIMITS.idLength} characters`);
  }
  if (raw.startingCommit !== FROZEN_STARTING_COMMIT) {
    throw invalidInput(`${root}.startingCommit`, `must be the full frozen commit ${FROZEN_STARTING_COMMIT}`);
  }
  return { id, category: category as WorkloadCategory };
}

function checkWorkload(raw: unknown, root: string): Workload {
  const w = readRecord(raw, root, WORKLOAD_KEYS);
  const { id, category } = checkIdentity(w, root);
  const source = checkSource(w.source, `${root}.source`);
  const intendedBehavior = readText(w.intendedBehavior, `${root}.intendedBehavior`, LIMITS.intendedBehaviorLength);
  const initialFiles = Object.freeze(checkFiles(w.initialFiles, `${root}.initialFiles`));
  const assessmentFiles = Object.freeze(checkFiles(w.assessmentFiles, `${root}.assessmentFiles`));
  checkSeparation(initialFiles, assessmentFiles, root);
  const rubric = checkRubric(w.rubric, `${root}.rubric`, assessmentFiles);
  const snapshotDigest = checkDigest(w.snapshotDigest, initialFiles, `${root}.snapshotDigest`);
  const assessmentDigest = checkDigest(w.assessmentDigest, assessmentFiles, `${root}.assessmentDigest`);
  return Object.freeze({
    contractVersion: WORKLOAD_CONTRACT_VERSION, id, category, startingCommit: FROZEN_STARTING_COMMIT, source,
    intendedBehavior, initialFiles, assessmentFiles, rubric, snapshotDigest, assessmentDigest,
  });
}

/** Strictly validates one workload and returns a NEW deep-frozen copy. */
export function validateWorkload(raw: unknown): Workload {
  return checkWorkload(raw, 'workload');
}

/** Validates a corpus: 1-64 workloads with unique ids and unique coding snapshots. */
export function validateWorkloads(raw: unknown): readonly Workload[] {
  const items = readArray(raw, 'workloads', 1, LIMITS.workloads);
  const ids = new Set<string>();
  const snapshots = new Set<string>();
  const workloads = items.map((item, i) => {
    const w = checkWorkload(item, `workloads[${i}]`);
    if (ids.has(w.id.toLowerCase())) throw invalidInput(`workloads[${i}].id`, `duplicate workload id ${quoted(w.id)}`);
    if (snapshots.has(w.snapshotDigest)) throw invalidInput(`workloads[${i}].snapshotDigest`, 'duplicates an earlier coding snapshot');
    ids.add(w.id.toLowerCase());
    snapshots.add(w.snapshotDigest);
    return w;
  });
  return Object.freeze(workloads);
}

/** Per-case identity over every frozen field, in authored order. */
export function digestWorkload(raw: unknown): string {
  const w = validateWorkload(raw);
  const fields = [
    w.contractVersion, w.id, w.category, w.startingCommit,
    [w.source.repository, w.source.paths, w.source.adaptation, w.source.note],
    w.intendedBehavior, w.snapshotDigest, w.assessmentDigest,
    w.rubric.criteria.map((c) => [c.id, c.description]), w.rubric.coverageTags,
  ];
  return `sha256:${createHash('sha256').update(`${WORKLOAD_DIGEST_TAG}${JSON.stringify(fields)}`, 'utf8').digest('hex')}`;
}

// -----------------------------------------------------------------------------
// Owned temporary snapshots
// -----------------------------------------------------------------------------

export type WorkloadSnapshotKind = 'coding' | 'assessment';
export interface WorkloadSnapshotHandle {
  readonly kind: WorkloadSnapshotKind;
  readonly workloadId: string;
  readonly root: string;
  readonly digest: string;
  dispose(): Promise<void>;
}

interface Ownership {
  readonly root: string;
  readonly dev: bigint;
  readonly ino: bigint;
  disposed: boolean;
  pending: Promise<void> | null;
}
/** Only handles minted here are keys; a copied or forged handle owns nothing. */
const owned = new WeakMap<object, Ownership>();

function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/** Writes ONLY the coding inputs (initialFiles) into a fresh owned temp root. Resetting = calling again. */
export function createCodingSnapshot(raw: unknown): Promise<WorkloadSnapshotHandle> {
  return materialize(raw, 'coding');
}

/** Writes ONLY the held-out assessment files into their own fresh owned temp root. */
export function createAssessmentSnapshot(raw: unknown): Promise<WorkloadSnapshotHandle> {
  return materialize(raw, 'assessment');
}

async function materialize(raw: unknown, kind: WorkloadSnapshotKind): Promise<WorkloadSnapshotHandle> {
  const workload = validateWorkload(raw);
  const files = kind === 'coding' ? workload.initialFiles : workload.assessmentFiles;
  const digest = kind === 'coding' ? workload.snapshotDigest : workload.assessmentDigest;
  let root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `moe-workload-${kind}-`));
  try {
    root = await fs.promises.realpath(root);
    const stat = await fs.promises.lstat(root, { bigint: true });
    for (const entry of sortedEntries(files)) {
      const target = path.join(root, ...entry.path.split('/'));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      // 'wx' = exclusive create: never overwrites and never follows a final-component link.
      await fs.promises.writeFile(target, entry.content, { encoding: 'utf8', flag: 'wx' });
    }
    return own(kind, workload.id, root, digest, stat);
  } catch (err) {
    return discard(root, err);
  }
}

async function discard(root: string, cause: unknown): Promise<never> {
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch (cleanupErr) {
    throw new Error(
      `workload snapshot creation failed (${codeOf(cause)}) and cleanup failed (${codeOf(cleanupErr)}); leftover temp root: ${root}`,
      { cause },
    );
  }
  throw cause;
}

function own(
  kind: WorkloadSnapshotKind, workloadId: string, root: string, digest: string, stat: fs.BigIntStats,
): WorkloadSnapshotHandle {
  const state: Ownership = { root, dev: stat.dev, ino: stat.ino, disposed: false, pending: null };
  // dispose closes over the captured state and never reads `this`, so it cannot be redirected.
  const handle: WorkloadSnapshotHandle = Object.freeze({ kind, workloadId, root, digest, dispose: () => disposeOwned(state) });
  owned.set(handle, state);
  return handle;
}

/** False when the root is gone; NOT_ALLOWED when anything else now sits at the recorded path. */
async function rootIsOwned(state: Ownership, operation: string): Promise<boolean> {
  let stat: fs.BigIntStats;
  try {
    stat = await fs.promises.lstat(state.root, { bigint: true });
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return false;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== state.dev || stat.ino !== state.ino) {
    throw notAllowed(operation, `${state.root} is no longer the directory this snapshot created`);
  }
  return true;
}

function disposeOwned(state: Ownership): Promise<void> {
  if (state.pending) return state.pending;
  const run = async (): Promise<void> => {
    // rm removes links inside the tree as links (junctions included) and never follows them.
    if (await rootIsOwned(state, 'dispose snapshot')) await fs.promises.rm(state.root, { recursive: true, force: true });
    state.disposed = true;
  };
  state.pending = run().catch((err: unknown) => {
    state.pending = null;
    throw err;
  });
  return state.pending;
}

const describeEntry = (parts: readonly string[]): string => {
  const rel = parts.join('/');
  return utf8Length(rel) <= LIMITS.pathBytes ? quoted(rel) : `an entry at depth ${parts.length}`;
};

/** Reads an owned snapshot back without following links; bounded in depth, entries and file size. */
export async function readSnapshotFiles(handle: WorkloadSnapshotHandle): Promise<WorkloadFiles> {
  const state = typeof handle === 'object' && handle !== null ? owned.get(handle) : undefined;
  if (!state) throw notAllowed('read snapshot', 'the handle was not created by this module');
  if (state.disposed || state.pending) throw notAllowed('read snapshot', 'the snapshot is disposed');
  if (!(await rootIsOwned(state, 'read snapshot'))) throw notAllowed('read snapshot', 'the snapshot root no longer exists');
  const files = Object.create(null) as Record<string, string>;
  await readTree(state.root, [], files, { entries: 0 });
  return Object.freeze(files);
}

async function readTree(
  dir: string, rel: readonly string[], files: Record<string, string>, budget: { entries: number },
): Promise<void> {
  if (rel.length > LIMITS.readDepth) throw notAllowed('read snapshot', `directories nest deeper than ${LIMITS.readDepth}`);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > LIMITS.readEntries) throw notAllowed('read snapshot', `more than ${LIMITS.readEntries} entries`);
    const parts = [...rel, entry.name];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await readTree(full, parts, files, budget);
    else if (entry.isFile()) files[parts.join('/')] = await readRegularFile(full, parts);
    else throw notAllowed('read snapshot', `${describeEntry(parts)} is a link, junction or special file`);
  }
}

async function readRegularFile(full: string, parts: readonly string[]): Promise<string> {
  const file = await fs.promises.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw notAllowed('read snapshot', `${describeEntry(parts)} is not a regular file`);
    if (stat.size > LIMITS.fileBytes) throw notAllowed('read snapshot', `${describeEntry(parts)} exceeds ${LIMITS.fileBytes} bytes`);
    const bytes = await file.readFile();
    if (bytes.length > LIMITS.fileBytes) throw notAllowed('read snapshot', `${describeEntry(parts)} exceeds ${LIMITS.fileBytes} bytes`);
    try {
      // ignoreBOM keeps a leading U+FEFF so read-back bytes digest exactly as written.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw notAllowed('read snapshot', `${describeEntry(parts)} is not valid UTF-8`);
    }
  } finally {
    await file.close();
  }
}
