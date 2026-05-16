// =============================================================================
// Git working-tree state snapshot
// =============================================================================
//
// Workers attach a snapshot of `git status --short` to their release handoff.
// When the next worker tries to claim, claim_next_task recomputes the snapshot
// and compares — if the prior refusal cited "280 dirty files" but the tree is
// now clean, the daemon can flag the stored handoff as stale so the worker
// doesn't refuse on outdated assumptions.
//
// All operations are best-effort. If git isn't installed, isn't a repo, or
// fails for any reason, we return null and the freshness check is skipped.
// We never throw — claim/release paths must remain robust.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { HandoffDiskState } from '../types/schema.js';

/**
 * Capture a snapshot of the current working-tree state under `rootPath`.
 * Returns null on any failure (no git, not a repo, etc.). Signature is the
 * SHA-256 prefix of `git status --short` output; dirtyFileCount is the line
 * count of that output (zero for a clean tree).
 */
export function captureDiskState(rootPath: string): HandoffDiskState | null {
  try {
    const out = execFileSync('git', ['status', '--short'], {
      cwd: rootPath,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5000,
    });
    const trimmed = out.replace(/\r\n/g, '\n').trim();
    const dirtyFileCount = trimmed.length === 0 ? 0 : trimmed.split('\n').length;
    const signature = createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
    return {
      dirtyFileCount,
      signature,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Compare current disk state against a stored handoff snapshot. Returns:
 *   - 'unchanged' — signatures match; prior refusal reason likely still valid
 *   - 'changed'   — signatures differ; prior refusal reason may be stale
 *   - 'unknown'   — couldn't compute either side; caller should treat as no-op
 */
export function compareDiskState(
  current: HandoffDiskState | null,
  stored: HandoffDiskState | undefined
): 'unchanged' | 'changed' | 'unknown' {
  if (!current || !stored) return 'unknown';
  if (!current.signature || !stored.signature) return 'unknown';
  return current.signature === stored.signature ? 'unchanged' : 'changed';
}
