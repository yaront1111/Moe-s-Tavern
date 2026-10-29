// Pure, IO-free core of acknowledged get_context deltas (CQ-C06a).
// A delta is a list of JSON-Pointer (RFC 6901) changes plus explicit removals between
// two served packets; decideDelta says whether one may be served at all.
import { invalidInput } from '../util/errors.js';

export type DeltaRefusal =
  | 'no-base'
  | 'base-unavailable'
  | 'base-mismatch'
  | 'session-mismatch'
  | 'attempt-mismatch'
  | 'phase-changed'
  | 'runner-changed'
  | 'epoch-missing'
  | 'epoch-changed';

export interface DeltaBase {
  readonly packetId: string;
  readonly text: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly lastPhaseAt: string;
  /** `<processStartedAt>@<host>` from the attempt, or null. */
  readonly runner: string | null;
  readonly contextEpoch: number;
}

export interface ContextDelta {
  readonly basePacketId: string;
  readonly packetId: string;
  readonly changed: readonly { readonly pointer: string; readonly value: unknown }[];
  readonly removed: readonly string[];
}

type Obj = Record<string, unknown>;

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const escapeSegment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapeSegment = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Own data property write: a plain assignment to the prototype-accessor key would swap the prototype.
function setOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function parseRoot(label: string, text: string): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalidInput(label, `not valid JSON (${err instanceof Error ? err.message : 'parse failure'})`);
  }
  if (!isPlainObject(parsed)) throw invalidInput(label, 'must be a JSON object');
  return parsed;
}

function walk(base: Obj, result: Obj, prefix: string, changed: { pointer: string; value: unknown }[], removed: string[]): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(result)]);
  for (const key of keys) {
    const pointer = `${prefix}/${escapeSegment(key)}`;
    if (!hasOwn(result, key)) {
      removed.push(pointer);
    } else if (!hasOwn(base, key)) {
      changed.push({ pointer, value: result[key] });
    } else if (isPlainObject(base[key]) && isPlainObject(result[key])) {
      walk(base[key], result[key], pointer, changed, removed);
    } else if (!deepEqual(base[key], result[key])) {
      changed.push({ pointer, value: result[key] });
    }
  }
}

export function diffPackets(basePacketId: string, baseText: string, packetId: string, resultText: string): ContextDelta {
  const base = parseRoot('base packet', baseText);
  const result = parseRoot('result packet', resultText);
  const changed: { pointer: string; value: unknown }[] = [];
  const removed: string[] = [];
  try {
    walk(base, result, '', changed, removed);
  } catch (err) {
    if (err instanceof RangeError) throw invalidInput('packet', 'nesting too deep to diff');
    throw err;
  }
  changed.sort((a, b) => byCodeUnit(a.pointer, b.pointer));
  removed.sort(byCodeUnit);
  return { basePacketId, packetId, changed, removed };
}

function splitPointer(pointer: string): string[] {
  if (!pointer.startsWith('/')) throw invalidInput('pointer', `must start with '/': ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeSegment);
}

function parentOf(root: Obj, segments: string[], pointer: string): Obj {
  let node: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(node) || !hasOwn(node, segment)) throw invalidInput('pointer', `missing parent for ${pointer}`);
    node = node[segment];
  }
  if (!isPlainObject(node)) throw invalidInput('pointer', `missing parent for ${pointer}`);
  return node;
}

function cloneJson(value: unknown, field: string): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) throw invalidInput(field, 'value is not JSON-serializable');
  return JSON.parse(text);
}

export function applyDelta(base: unknown, delta: ContextDelta): unknown {
  if (!isPlainObject(base)) throw invalidInput('base', 'must be a JSON object');
  try {
    const root = cloneJson(base, 'base') as Obj;
    for (const pointer of delta.removed) {
      const segments = splitPointer(pointer);
      delete parentOf(root, segments, pointer)[segments[segments.length - 1]];
    }
    for (const { pointer, value } of delta.changed) {
      const segments = splitPointer(pointer);
      setOwn(parentOf(root, segments, pointer), segments[segments.length - 1], cloneJson(value, 'delta value'));
    }
    return root;
  } catch (err) {
    if (err instanceof RangeError) throw invalidInput('delta', 'nesting too deep to apply');
    throw err;
  }
}

export function deltaBaseKey(attemptId: string, generation: number, sessionId: string): string {
  return JSON.stringify([attemptId, generation, sessionId]);
}

/** In-memory, bounded, least-recently-set store. Never persisted: a restart misses every lookup. */
export class DeltaBaseStore {
  private readonly entries = new Map<string, DeltaBase>();

  constructor(private readonly maxEntries = 256) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw invalidInput('maxEntries', 'must be a positive safe integer');
    }
  }

  get(key: string): DeltaBase | undefined {
    return this.entries.get(key);
  }

  set(key: string, base: DeltaBase): void {
    this.entries.delete(key);
    this.entries.set(key, Object.freeze({ ...base }));
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export function decideDelta(
  request: { basePacketId?: string; contextEpoch?: number },
  current: { attemptId: string; generation: number; sessionId: string; lastPhaseAt: string; runner: string | null },
  stored: DeltaBase | undefined,
): { delta: true } | { delta: false; reason: DeltaRefusal } {
  const refuse = (reason: DeltaRefusal): { delta: false; reason: DeltaRefusal } => ({ delta: false, reason });
  if (!request.basePacketId) return refuse('no-base');
  if (!stored) return refuse('base-unavailable');
  if (stored.packetId !== request.basePacketId) return refuse('base-mismatch');
  if (stored.sessionId !== current.sessionId) return refuse('session-mismatch');
  if (stored.attemptId !== current.attemptId || stored.generation !== current.generation) return refuse('attempt-mismatch');
  if (stored.lastPhaseAt !== current.lastPhaseAt) return refuse('phase-changed');
  if (stored.runner !== current.runner) return refuse('runner-changed');
  if (request.contextEpoch === undefined) return refuse('epoch-missing');
  if (stored.contextEpoch !== request.contextEpoch) return refuse('epoch-changed');
  return { delta: true };
}
