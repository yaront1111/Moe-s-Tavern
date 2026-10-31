import { describe, expect, it } from 'vitest';
import {
  DeltaBaseStore,
  applyDelta,
  decideDelta,
  deltaBaseKey,
  diffPackets,
  type DeltaBase,
} from './contextDelta.js';

const j = (value: unknown): string => JSON.stringify(value);
const PROTO_KEY = '_'.repeat(2) + 'proto' + '_'.repeat(2);

describe('diffPackets / applyDelta', () => {
  type C = { pointer: string; value: unknown };
  const rows: [string, unknown, unknown, C[], string[]][] = [
    ['a: nested removal', { task: { id: 't', rejectionDetails: { reason: 'x', n: 1 } } }, { task: { id: 't', rejectionDetails: { n: 1 } } }, [], ['/task/rejectionDetails/reason']],
    ['b: array replaced wholesale', { steps: [1, 2, 3], keep: true }, { steps: [1, 9, 3, 4], keep: true }, [{ pointer: '/steps', value: [1, 9, 3, 4] }], []],
    ['c: addition', { a: 1 }, { a: 1, b: { c: 2 } }, [{ pointer: '/b', value: { c: 2 } }], []],
    ['d: escaped keys', { 'a/b': 1, 'c~d': 2, 'x~/y': 3 }, { 'a/b': 5, 'c~d': 6, 'x~/y': 7 },
      [{ pointer: '/a~1b', value: 5 }, { pointer: '/c~0d', value: 6 }, { pointer: '/x~0~1y', value: 7 }], []],
    ['e: unchanged', { a: { b: [1, { c: 2 }] }, d: null }, { a: { b: [1, { c: 2 }] }, d: null }, [], []],
    ['g1: primitive replaced by object', { a: 1 }, { a: { b: 2 } }, [{ pointer: '/a', value: { b: 2 } }], []],
    ['g2: object replaced by primitive', { a: { b: 2 } }, { a: 'x' }, [{ pointer: '/a', value: 'x' }], []],
    ['g3: null and array are not plain objects', { a: { b: 1 }, n: null, r: [] }, { a: null, n: { z: 1 }, r: { 0: 1 } },
      [{ pointer: '/a', value: null }, { pointer: '/n', value: { z: 1 } }, { pointer: '/r', value: { 0: 1 } }], []],
    ['sorted by code unit, mixed changes and removals', { b: 1, a: 1, B: 1, z: { y: 1, x: 1 } }, { b: 2, a: 2, c: 1, z: { x: 2 } },
      [{ pointer: '/a', value: 2 }, { pointer: '/b', value: 2 }, { pointer: '/c', value: 1 }, { pointer: '/z/x', value: 2 }], ['/B', '/z/y']],
  ];

  it.each(rows)('%s', (_name, base, result, changed, removed) => {
    const delta = diffPackets('p0', j(base), 'p1', j(result));
    expect(delta).toEqual({ basePacketId: 'p0', packetId: 'p1', changed, removed });
    expect(applyDelta(base, delta)).toEqual(result);
  });

  it('f: key order only gives empty lists', () => {
    const delta = diffPackets('p0', '{"a":1,"b":{"c":1,"d":[{"x":1,"y":2}]}}', 'p1', '{"b":{"d":[{"y":2,"x":1}],"c":1},"a":1}');
    expect(delta).toEqual({ basePacketId: 'p0', packetId: 'p1', changed: [], removed: [] });
  });

  it('h: a key named like the prototype accessor is an ordinary own key', () => {
    const baseText = `{"${PROTO_KEY}":{"a":1},"keep":1}`;
    const resultText = `{"${PROTO_KEY}":{"a":2},"keep":1,"added":{"${PROTO_KEY}":3}}`;
    const delta = diffPackets('p0', baseText, 'p1', resultText);
    expect(delta.changed).toEqual([
      { pointer: `/${PROTO_KEY}/a`, value: 2 },
      { pointer: '/added', value: JSON.parse(`{"${PROTO_KEY}":3}`) },
    ]);
    const applied = applyDelta(JSON.parse(baseText), delta) as Record<string, unknown>;
    expect(Object.getPrototypeOf(applied)).toBe(Object.prototype);
    expect(Object.keys(applied).sort()).toEqual([PROTO_KEY, 'added', 'keep']);
    expect(Object.getOwnPropertyDescriptor(applied, PROTO_KEY)?.value).toEqual({ a: 2 });
    expect(applied.polluted).toBeUndefined();
  });

  it('h2: applying a changed entry at the accessor key creates an own property', () => {
    const delta = { basePacketId: 'p0', packetId: 'p1', changed: [{ pointer: `/${PROTO_KEY}`, value: { polluted: 1 } }], removed: [] };
    const applied = applyDelta({ a: 1 }, delta) as Record<string, unknown>;
    expect(Object.getPrototypeOf(applied)).toBe(Object.prototype);
    expect(Object.keys(applied)).toEqual(['a', PROTO_KEY]);
    expect((applied as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('applyDelta does not mutate its input', () => {
    const base = { a: { b: 1, c: 2 }, d: [1] };
    const snapshot = JSON.parse(JSON.stringify(base));
    const delta = diffPackets('p0', j(base), 'p1', j({ a: { b: 5 }, d: [2] }));
    applyDelta(base, delta);
    expect(base).toEqual(snapshot);
  });

  it.each([
    ['missing parent on change', { a: 1 }, { changed: [{ pointer: '/x/y', value: 1 }], removed: [] }],
    ['missing parent on removal', { a: 1 }, { changed: [], removed: ['/x/y'] }],
    ['pointer without a leading slash', { a: 1 }, { changed: [{ pointer: 'a', value: 1 }], removed: [] }],
    ['array base', [1], { changed: [], removed: [] }],
    ['null base', null, { changed: [], removed: [] }],
  ])('applyDelta throws INVALID_INPUT: %s', (_name, base, parts) => {
    expect(() => applyDelta(base, { basePacketId: 'p0', packetId: 'p1', ...parts })).toThrowError(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
  });

  it.each([['array', '[1]'], ['null', 'null'], ['number', '5'], ['string', '"x"'], ['malformed', '{']])('non-object JSON root (%s) throws INVALID_INPUT', (_name, text) => {
    expect(() => diffPackets('p0', text, 'p1', '{}')).toThrowError(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
    expect(() => diffPackets('p0', '{}', 'p1', text)).toThrowError(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
  });

  it('hostile nesting depth becomes INVALID_INPUT, never a raw RangeError', () => {
    const depth = 200000;
    const deep = (leaf: number): string => '{"a":'.repeat(depth) + leaf + '}'.repeat(depth);
    expect(() => diffPackets('p0', deep(1), 'p1', deep(2))).toThrowError(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
  });
});

describe('decideDelta', () => {
  const stored = (): DeltaBase => ({
    packetId: 'sha256:p0',
    text: '{}',
    attemptId: 'attempt-1',
    generation: 2,
    sessionId: 'sess-1',
    lastPhaseAt: '2026-10-29T10:00:00.000Z',
    runner: '123@host',
    contextEpoch: 4,
  });
  const current = { attemptId: 'attempt-1', generation: 2, sessionId: 'sess-1', lastPhaseAt: '2026-10-29T10:00:00.000Z', runner: '123@host' as string | null };
  const request = { basePacketId: 'sha256:p0', contextEpoch: 4 as number | undefined };

  it('exact match gives delta:true', () => {
    expect(decideDelta(request, current, stored())).toEqual({ delta: true });
  });

  it.each([
    ['no-base', { ...request, basePacketId: undefined }, current, stored()],
    ['base-unavailable', request, current, undefined],
    ['base-mismatch', { ...request, basePacketId: 'sha256:other' }, current, stored()],
    ['session-mismatch', request, { ...current, sessionId: 'sess-2' }, stored()],
    ['attempt-mismatch', request, { ...current, attemptId: 'attempt-2' }, stored()],
    ['attempt-mismatch', request, { ...current, generation: 3 }, stored()],
    ['phase-changed', request, { ...current, lastPhaseAt: '2026-10-29T10:00:01.000Z' }, stored()],
    ['runner-changed', request, { ...current, runner: '999@host' }, stored()],
    ['runner-changed', request, { ...current, runner: null }, stored()],
    ['runner-changed', request, current, { ...stored(), runner: null }],
    ['epoch-missing', { ...request, contextEpoch: undefined }, current, stored()],
    ['epoch-changed', { ...request, contextEpoch: 5 }, current, stored()],
  ] as const)('%s', (reason, req, cur, base) => {
    expect(decideDelta(req, cur, base)).toEqual({ delta: false, reason });
  });

  it('several mismatches give the earliest rule in order', () => {
    const all = { ...current, sessionId: 's', attemptId: 'a', lastPhaseAt: 'x', runner: 'r' };
    const reason = (req: typeof request, cur: typeof all): unknown => decideDelta(req, cur, stored());
    expect(reason({ basePacketId: 'sha256:other', contextEpoch: undefined }, all)).toEqual({ delta: false, reason: 'base-mismatch' });
    expect(reason(request, all)).toEqual({ delta: false, reason: 'session-mismatch' });
    expect(reason(request, { ...all, sessionId: 'sess-1' })).toEqual({ delta: false, reason: 'attempt-mismatch' });
    expect(reason(request, { ...all, sessionId: 'sess-1', attemptId: 'attempt-1' })).toEqual({ delta: false, reason: 'phase-changed' });
    expect(reason({ ...request, contextEpoch: undefined }, { ...current, runner: 'r' })).toEqual({ delta: false, reason: 'runner-changed' });
  });
});

describe('DeltaBaseStore', () => {
  const base = (packetId: string): DeltaBase => ({
    packetId, text: '{}', attemptId: 'a', generation: 1, sessionId: 's', lastPhaseAt: 't', runner: null, contextEpoch: 0,
  });

  it('evicts the least recently set entry past maxEntries', () => {
    const store = new DeltaBaseStore(2);
    store.set('a', base('pa'));
    store.set('b', base('pb'));
    store.set('c', base('pc'));
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')?.packetId).toBe('pb');
    expect(store.get('c')?.packetId).toBe('pc');
  });

  it('setting an existing key again moves it to newest', () => {
    const store = new DeltaBaseStore(2);
    store.set('a', base('pa'));
    store.set('b', base('pb'));
    store.set('a', base('pa2'));
    store.set('c', base('pc'));
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')?.packetId).toBe('pa2');
    expect(store.get('c')?.packetId).toBe('pc');
  });

  it('get does not refresh recency, delete removes', () => {
    const store = new DeltaBaseStore(2);
    store.set('a', base('pa'));
    store.set('b', base('pb'));
    store.get('a');
    store.set('c', base('pc'));
    expect(store.get('a')).toBeUndefined();
    store.delete('b');
    store.delete('missing');
    expect(store.get('b')).toBeUndefined();
  });

  it('a fresh store (restart) answers base-unavailable through decideDelta', () => {
    const store = new DeltaBaseStore();
    const key = deltaBaseKey('attempt-1', 2, 'sess-1');
    const cur = { attemptId: 'attempt-1', generation: 2, sessionId: 'sess-1', lastPhaseAt: 't', runner: null };
    expect(decideDelta({ basePacketId: 'p', contextEpoch: 0 }, cur, store.get(key))).toEqual({ delta: false, reason: 'base-unavailable' });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('maxEntries %s throws INVALID_INPUT', (n) => {
    expect(() => new DeltaBaseStore(n)).toThrowError(expect.objectContaining({ codeName: 'INVALID_INPUT' }));
  });

  it('hands out frozen copies: mutating the source or the result cannot change the store', () => {
    const store = new DeltaBaseStore();
    const source = base('pa');
    store.set('a', source);
    (source as { packetId: string }).packetId = 'mutated';
    const got = store.get('a');
    expect(got?.packetId).toBe('pa');
    expect(Object.isFrozen(got)).toBe(true);
    expect(() => { (got as { packetId: string }).packetId = 'x'; }).toThrow(TypeError);
    expect(store.get('a')?.packetId).toBe('pa');
  });

  it('deltaBaseKey is unambiguous', () => {
    expect(deltaBaseKey('a', 1, 'b|c')).not.toBe(deltaBaseKey('a|b', 1, 'c'));
    expect(deltaBaseKey('a', 1, 'b')).toBe(deltaBaseKey('a', 1, 'b'));
    expect(deltaBaseKey('a', 1, 'b')).not.toBe(deltaBaseKey('a', 2, 'b'));
  });
});
