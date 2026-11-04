import { describe, expect, it } from 'vitest';
import {
  SPAWN_PROOF_ENV, healthProofFields, parseHealthRequest, spawnProofFor, takeSpawnProofKey,
} from './spawnProof.js';

const keyHex = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
const challenge = 'ab'.repeat(32);
const expectedProof = '583630234f7e60ecfa2a6ae2e98ee37876e3ff6344457723cb4b42fcf77f7fc0';

describe('takeSpawnProofKey', () => {
  it('uses the IDE environment contract name', () => {
    expect(SPAWN_PROOF_ENV).toBe('MOE_SPAWN_PROOF_KEY');
  });

  it.each([keyHex, keyHex.toUpperCase()])('takes a valid 32-byte key (%#)', (value) => {
    const env = { [SPAWN_PROOF_ENV]: value, OTHER: 'preserved' };
    const result = takeSpawnProofKey(env);
    expect(result).toEqual({ key: Buffer.from(keyHex, 'hex') });
    expect(result.key?.length).toBe(32);
    expect(env).toEqual({ OTHER: 'preserved' });
  });

  it.each([
    ['short', 'a'.repeat(63)], ['long', 'a'.repeat(65)],
    ['non-hex', 'g' + 'a'.repeat(63)], ['empty', ''], ['newline', keyHex + '\n'],
  ])('discards an invalid %s key without disclosing it', (_, value) => {
    const env = { [SPAWN_PROOF_ENV]: value };
    const result = takeSpawnProofKey(env);
    expect(result.key).toBeNull();
    expect(result.problem).toBe('MOE_SPAWN_PROOF_KEY is not 64 hex characters');
    if (value) expect(result.problem).not.toContain(value);
    expect(env).not.toHaveProperty(SPAWN_PROOF_ENV);
  });

  it('leaves an absent key absent without a warning', () => {
    const env = { OTHER: 'preserved' };
    expect(takeSpawnProofKey(env)).toEqual({ key: null });
    expect(env).toEqual({ OTHER: 'preserved' });
  });
});

describe('spawnProofFor', () => {
  it('pins HMAC-SHA256 over the ASCII challenge, shared with the VS Code client', () => {
    expect(spawnProofFor(Buffer.from(keyHex, 'hex'), challenge)).toBe(expectedProof);
  });
});

describe('parseHealthRequest', () => {
  it('routes plain health without a challenge', () => {
    expect(parseHealthRequest('/health')).toEqual({ health: true });
  });

  it('accepts exactly one lowercase hex challenge', () => {
    expect(parseHealthRequest(`/health?challenge=${challenge}`)).toEqual({ health: true, challenge });
  });

  it.each([
    `challenge=${challenge.toUpperCase()}`, `challenge=${'a'.repeat(63)}`,
    `challenge=${'a'.repeat(65)}`, `challenge=${'z'.repeat(64)}`,
    `challenge=${challenge}&challenge=${challenge}`, `challenge=${challenge}&x=1`,
    'x=1', '', 'challenge=', `Challenge=${challenge}`, `challenge=${challenge}%0a`,
    'challenge=%zz', `challenge=${'a'.repeat(100_000)}`,
  ])('routes invalid query %# without proof', (query) => {
    expect(parseHealthRequest(`/health?${query}`)).toEqual({ health: true });
  });

  it.each(['/healthz', '/health/', '/', undefined, 'http://127.0.0.1/health', '/%68ealth'])
  ('does not route other request targets (%#)', (url) => {
    expect(parseHealthRequest(url)).toEqual({ health: false });
  });
});

describe('healthProofFields', () => {
  it('adds only the proof when both key and challenge are present', () => {
    expect(healthProofFields(parseHealthRequest(`/health?challenge=${challenge}`), Buffer.from(keyHex, 'hex')))
      .toEqual({ spawnProof: expectedProof });
  });

  it('omits the field entirely when no key is held', () => {
    expect(healthProofFields(parseHealthRequest(`/health?challenge=${challenge}`), null)).toEqual({});
  });

  it.each(['/health', '/health?x=1', '/x'])('omits the field for a request without a challenge (%#)', (url) => {
    expect(healthProofFields(parseHealthRequest(url), Buffer.from(keyHex, 'hex'))).toEqual({});
  });
});
