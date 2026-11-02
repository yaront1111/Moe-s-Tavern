/**
 * VS Code protected spawn provenance (task-648a5916): an IDE-provided 32-byte
 * hex key authenticates one lowercase 64-hex health challenge via HMAC-SHA256
 * over its ASCII text. Consume the environment entry; never return or log the key.
 */
import { createHmac } from 'node:crypto';

export const SPAWN_PROOF_ENV = 'MOE_SPAWN_PROOF_KEY';

export function takeSpawnProofKey(env: NodeJS.ProcessEnv): { key: Buffer | null; problem?: string } {
  const value = env[SPAWN_PROOF_ENV];
  delete env[SPAWN_PROOF_ENV];
  if (value === undefined) return { key: null };
  if (value.length === 64 && /^[0-9a-f]{64}$/i.test(value)) {
    return { key: Buffer.from(value, 'hex') };
  }
  return { key: null, problem: 'MOE_SPAWN_PROOF_KEY is not 64 hex characters' };
}

type HealthRoute = { health: false } | { health: true; challenge?: string };

export function parseHealthRequest(url: string | undefined): HealthRoute {
  if (url === undefined) return { health: false };
  const queryStart = url.indexOf('?');
  const pathname = queryStart < 0 ? url : url.slice(0, queryStart);
  if (pathname !== '/health') return { health: false };
  const params = new URLSearchParams(queryStart < 0 ? '' : url.slice(queryStart + 1));
  const challenge = params.get('challenge');
  if (params.size === 1 && challenge?.length === 64 && /^[0-9a-f]{64}$/.test(challenge)) {
    return { health: true, challenge };
  }
  return { health: true };
}

export function spawnProofFor(key: Buffer, challenge: string): string {
  return createHmac('sha256', key).update(challenge, 'ascii').digest('hex');
}

export function healthProofFields(route: HealthRoute, key: Buffer | null): { spawnProof?: string } {
  return route.health && route.challenge !== undefined && key !== null
    ? { spawnProof: spawnProofFor(key, route.challenge) }
    : {};
}
