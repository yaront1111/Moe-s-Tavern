import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import type { Task, TaskCommit, TaskCommitKind, TaskCommitOutcome } from '../types/schema.js';
import { invalidInput, missingRequired, notFound } from '../util/errors.js';
import { PathSet, unionPaths } from '../util/attributionTiers.js';
import { UNIDENTIFIED_RELEASER } from '../util/claimGuards.js';
import { trimCommits } from '../state/validators.js';

const OUTCOMES = ['committed', 'nothing', 'refused', 'failed'] as const;
const KINDS = ['completion', 'checkpoint', 'rescue'] as const;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const MAX_PATHS = 500;
const MAX_SKIPPED = 100;
const MAX_CONTESTED = 100;
const MAX_MESSAGE_CHARS = 2000;
const MAX_SHORT_STRING = 255;
const MAX_ROLE_CHARS = 64;
const UNRESOLVED_PATHS_SHOWN = 20;
/** #governors gets at most one commit alert per task per window; the task channel gets every line. */
const GOVERNOR_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

// In-memory (resets on daemon restart, which is the conservative direction:
// a restart re-alerts once rather than staying silent for up to a day).
const governorAlertAt = new Map<string, number>();

/** Test seam: clear the per-task #governors alert window. */
export function resetRecordCommitGovernorRateLimit(): void {
  governorAlertAt.clear();
}

interface PathListRead {
  paths: string[];
  truncated: boolean;
  dropped: string[];
}

/**
 * Lenient path-list reader for wrapper-fed input: invalid entries (absolute,
 * traversal, non-string) are dropped and reported in `warning` instead of
 * failing the whole record — the commit already exists in git, and losing the
 * ledger entry over one bad path would be the worse outcome.
 */
function readPathList(raw: unknown, field: string, cap: number): PathListRead {
  if (raw === undefined || raw === null) return { paths: [], truncated: false, dropped: [] };
  if (!Array.isArray(raw)) throw invalidInput(field, 'must be an array of strings');
  const set = new PathSet();
  const dropped: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      dropped.push(String(entry));
      continue;
    }
    if (set.add(entry) === null) dropped.push(entry);
  }
  const all = set.values();
  return { paths: all.slice(0, cap), truncated: all.length > cap, dropped };
}

function readOptionalString(raw: unknown, field: string, maxLength: number, opts: { truncate?: boolean } = {}): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw invalidInput(field, 'must be a string');
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    if (opts.truncate) return trimmed.slice(0, maxLength);
    throw invalidInput(field, `must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function readRecordList<T extends Record<string, string>>(
  raw: unknown,
  field: string,
  keys: readonly (keyof T & string)[],
  cap: number
): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalidInput(field, 'must be an array of objects');
  const out: T[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const built: Record<string, string> = {};
    let ok = true;
    for (const key of keys) {
      const value = rec[key];
      if (typeof value !== 'string' || value.trim().length === 0) { ok = false; break; }
      built[key] = value.trim().slice(0, MAX_SHORT_STRING);
    }
    if (!ok) continue;
    out.push(built as T);
    if (out.length >= cap) break;
  }
  return out;
}

/** Same commit when equal, or when one abbreviated sha is a prefix of the other. */
function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function recordCommitTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.record_commit',
    description: 'Record the outcome of the agent wrapper\'s git landing for a task — a completion commit (feat|fix on the shared branch), a wip checkpoint, or a rescue ref (refs/moe/rescue/<taskId>/<ts>) — including refused/failed/nothing outcomes. On committed: appends task.commits (idempotent by sha, capped, newest kept), unions the non-inferred paths into task.filesModified, and keeps task.inferredPaths / touchedFiles / unattributedPaths current; every outcome stamps task.lastCommitOutcome. Guard-exempt (runs after complete_task when QA may already own the REVIEW task, and on unassigned BLOCKED tasks) and allowed in every status. Posts one line to the task channel and a rate-limited #governors alert on unattributed paths, rescue refs, or refused/failed outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        outcome: { type: 'string', enum: [...OUTCOMES] },
        kind: { type: 'string', enum: [...KINDS] },
        sha: { type: 'string', description: 'Commit sha (7-40 hex). Required when outcome is committed.' },
        treeId: { type: 'string', description: 'rev-parse <sha>^{tree} — rebase-stable identity of the landed tree.' },
        ref: { type: 'string', description: 'Branch the commit landed on, or refs/moe/rescue/<taskId>/<ts>. Required when outcome is committed.' },
        status: { type: 'string', description: 'Task status the wrapper resolved at landing (REVIEW, DONE, BLOCKED, UNKNOWN, …).' },
        role: { type: 'string', description: 'Wrapper role: worker, architect, qa.' },
        workerId: { type: 'string', description: 'Caller worker ID (auto-injected by proxy); recorded as recordedBy.' },
        sessionId: { type: 'string', description: '<workerId>@<preflight-iso>, matching the commit\'s Moe-Session trailer.' },
        cliExitCode: { type: 'number' },
        pushed: { type: 'boolean' },
        recoveredBy: { type: 'string', description: 'Worker that landed another task\'s lingering baseline (orphan recovery).' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative paths the commit carried (≤500; extras are truncated and flagged).' },
        inferredPaths: { type: 'array', items: { type: 'string' }, description: 'Subset of paths attributed by measurement only (never promoted to filesModified).' },
        touchedPaths: { type: 'array', items: { type: 'string' }, description: 'Paths the agent\'s editing tools were observed writing this session.' },
        unattributedPaths: { type: 'array', items: { type: 'string' }, description: 'Dirty paths changed this session that policy left uncommitted (replaces task.unattributedPaths).' },
        skipped: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, code: { type: 'string' } }, required: ['path', 'code'] }, description: 'Per-path MOE_ATTR_* skip codes (≤100).' },
        contested: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, taskId: { type: 'string' } }, required: ['path', 'taskId'] } },
        code: { type: 'string', description: 'Refusal/failure code (MOE_COMMIT_REFUSED_*, MOE_COMMIT_FAILED_*) or rescue reason.' },
        message: { type: 'string' }
      },
      required: ['taskId', 'outcome', 'kind', 'role', 'sessionId'],
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        taskId?: string;
        outcome?: string;
        kind?: string;
        sha?: unknown;
        treeId?: unknown;
        ref?: unknown;
        status?: unknown;
        role?: unknown;
        workerId?: string;
        sessionId?: unknown;
        cliExitCode?: unknown;
        pushed?: unknown;
        recoveredBy?: unknown;
        paths?: unknown;
        inferredPaths?: unknown;
        touchedPaths?: unknown;
        unattributedPaths?: unknown;
        skipped?: unknown;
        contested?: unknown;
        code?: unknown;
        message?: unknown;
      };

      if (!params.taskId || typeof params.taskId !== 'string') throw missingRequired('taskId');
      if (params.outcome === undefined) throw missingRequired('outcome');
      if (!(OUTCOMES as readonly string[]).includes(params.outcome)) {
        throw invalidInput('outcome', `must be one of: ${OUTCOMES.join(', ')}`);
      }
      if (params.kind === undefined) throw missingRequired('kind');
      if (!(KINDS as readonly string[]).includes(params.kind)) {
        throw invalidInput('kind', `must be one of: ${KINDS.join(', ')}`);
      }
      const outcome = params.outcome as TaskCommitOutcome;
      const kind = params.kind as TaskCommitKind;

      const role = readOptionalString(params.role, 'role', MAX_ROLE_CHARS);
      if (!role) throw missingRequired('role');
      const sessionId = readOptionalString(params.sessionId, 'sessionId', MAX_SHORT_STRING);
      if (!sessionId) throw missingRequired('sessionId');

      const sha = readOptionalString(params.sha, 'sha', 40);
      if (sha !== undefined && !SHA_RE.test(sha)) throw invalidInput('sha', 'must be 7-40 hex characters');
      const treeId = readOptionalString(params.treeId, 'treeId', 40);
      if (treeId !== undefined && !SHA_RE.test(treeId)) throw invalidInput('treeId', 'must be 7-40 hex characters');
      const ref = readOptionalString(params.ref, 'ref', MAX_SHORT_STRING);
      if (outcome === 'committed') {
        if (!sha) throw missingRequired('sha');
        if (!ref) throw missingRequired('ref');
      }
      const status = readOptionalString(params.status, 'status', 32);
      const code = readOptionalString(params.code, 'code', 128);
      const message = readOptionalString(params.message, 'message', MAX_MESSAGE_CHARS, { truncate: true });
      const recoveredBy = readOptionalString(params.recoveredBy, 'recoveredBy', 128);
      if (params.cliExitCode !== undefined && params.cliExitCode !== null
        && (typeof params.cliExitCode !== 'number' || !Number.isInteger(params.cliExitCode))) {
        throw invalidInput('cliExitCode', 'must be an integer');
      }
      if (params.pushed !== undefined && params.pushed !== null && typeof params.pushed !== 'boolean') {
        throw invalidInput('pushed', 'must be a boolean');
      }
      const pushed = typeof params.pushed === 'boolean' ? params.pushed : undefined;

      const pathsRead = readPathList(params.paths, 'paths', MAX_PATHS);
      const inferredRead = readPathList(params.inferredPaths, 'inferredPaths', MAX_PATHS);
      const touchedRead = readPathList(params.touchedPaths, 'touchedPaths', MAX_PATHS);
      // `undefined` = no information (keep what is stored); an explicit array —
      // including [] — replaces task.unattributedPaths.
      const unattributedRead = params.unattributedPaths === undefined || params.unattributedPaths === null
        ? null
        : readPathList(params.unattributedPaths, 'unattributedPaths', MAX_PATHS);
      const skipped = readRecordList<{ path: string; code: string }>(params.skipped, 'skipped', ['path', 'code'], MAX_SKIPPED);
      const contested = readRecordList<{ path: string; taskId: string }>(params.contested, 'contested', ['path', 'taskId'], MAX_CONTESTED);

      const task = state.getTask(params.taskId);
      if (!task) throw notFound('Task', params.taskId);

      const now = new Date().toISOString();
      const recordedBy = params.workerId || UNIDENTIFIED_RELEASER;
      const updates: Partial<Task> = {};
      let commits: TaskCommit[] = Array.isArray(task.commits) ? [...task.commits] : [];
      let duplicate = false;
      let addedPaths: string[] = [];

      if (outcome === 'committed' && sha && ref) {
        const existingIdx = commits.findIndex((c) => typeof c?.sha === 'string' && sameSha(c.sha, sha));
        if (existingIdx >= 0) {
          // Idempotent re-record (resume relaunch, post-push re-report): keep
          // the original entry, only ever upgrade pushed/treeId.
          duplicate = true;
          const existing = commits[existingIdx];
          commits[existingIdx] = {
            ...existing,
            ...(existing.treeId === undefined && treeId !== undefined ? { treeId } : {}),
            ...(existing.pushed === true || pushed === true
              ? { pushed: true }
              : existing.pushed === undefined && pushed !== undefined ? { pushed } : {}),
          };
        } else {
          const entry: TaskCommit = {
            sha,
            ref,
            kind,
            role,
            sessionId,
            paths: pathsRead.paths,
            recordedBy,
            recordedAt: now,
            ...(treeId !== undefined ? { treeId } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(pathsRead.truncated ? { pathsTruncated: true } : {}),
            ...(inferredRead.paths.length > 0 ? { inferredPaths: inferredRead.paths } : {}),
            ...(contested.length > 0 ? { contested } : {}),
            ...(pushed !== undefined ? { pushed } : {}),
            ...(recoveredBy !== undefined ? { recoveredBy } : {}),
            ...(message !== undefined ? { message } : {}),
          };
          commits.push(entry);
          commits = trimCommits(commits);
        }
        updates.commits = commits;

        // ASSERTED tier grows by the committed paths minus the measured ones;
        // MEASURED paths are remembered separately and never promoted.
        const inferredSet = new PathSet().addAll(inferredRead.paths);
        const nonInferred = pathsRead.paths.filter((p) => !inferredSet.has(p));
        const filesModifiedUnion = unionPaths(task.filesModified, nonInferred);
        addedPaths = filesModifiedUnion.added;
        if (filesModifiedUnion.added.length > 0) updates.filesModified = filesModifiedUnion.merged;
        if (inferredRead.paths.length > 0) {
          const inferredUnion = unionPaths(task.inferredPaths, inferredRead.paths);
          if (inferredUnion.added.length > 0) updates.inferredPaths = inferredUnion.merged;
        }
      }

      if (touchedRead.paths.length > 0) {
        const touchedUnion = unionPaths(task.touchedFiles, touchedRead.paths);
        if (touchedUnion.added.length > 0) updates.touchedFiles = touchedUnion.merged;
      }
      if (unattributedRead !== null) {
        updates.unattributedPaths = unattributedRead.paths;
      }
      updates.lastCommitOutcome = {
        outcome,
        kind,
        ...(code !== undefined ? { code } : {}),
        sessionId,
        at: now,
      };

      const updated = await state.updateTask(task.id, updates, 'TASK_COMMIT_RECORDED');
      if (params.workerId) {
        await state.touchWorker(params.workerId);
      }

      // ---- warnings ----------------------------------------------------------
      const warnings: string[] = [];
      if (kind === 'completion' && pathsRead.paths.length === 0) {
        warnings.push(`completion landing recorded with no paths for ${task.id} — check the wrapper's [skip] lines and task.unattributedPaths`);
      }
      const droppedTotal = pathsRead.dropped.length + inferredRead.dropped.length + touchedRead.dropped.length
        + (unattributedRead?.dropped.length ?? 0);
      if (droppedTotal > 0) {
        warnings.push(`${droppedTotal} path entr${droppedTotal === 1 ? 'y' : 'ies'} dropped (absolute, traversal or non-string)`);
      }
      if (pathsRead.truncated) warnings.push(`paths truncated to ${MAX_PATHS}`);

      // ---- chat --------------------------------------------------------------
      const unattributed = unattributedRead?.paths ?? [];
      const lines: string[] = [];
      const shortSha = sha ? sha.slice(0, 12) : 'none';
      const pushedNote = pushed === false ? ', NOT pushed' : pushed === true ? ', pushed' : '';
      const detail = `${message ? ` — ${message}` : ''}`;
      switch (outcome) {
        case 'committed':
          lines.push(`📦 ${kind} commit recorded for ${task.id}: ${shortSha} on ${ref} — ${pathsRead.paths.length} path(s), ${inferredRead.paths.length} inferred, ${skipped.length} skipped, ${unattributed.length} unattributed${pushedNote}${duplicate ? ' (duplicate sha, merged)' : ''}`);
          break;
        case 'nothing':
          lines.push(`ℹ️ ${kind} landing for ${task.id}: nothing to commit${code ? ` (${code})` : ''}${detail}`);
          break;
        case 'refused':
          lines.push(`⛔ ${kind} landing REFUSED for ${task.id}: ${code ?? 'no code'}${detail}`);
          break;
        case 'failed':
          lines.push(`❌ ${kind} landing FAILED for ${task.id}: ${code ?? 'no code'}${detail}`);
          break;
      }
      const rescueLanded = kind === 'rescue' && outcome === 'committed';
      if (rescueLanded) {
        lines.push(`MOE_RESCUE_REF task=${task.id} ref=${ref} sha=${sha} reason=${code ?? message ?? 'unknown'}`);
      }
      if (unattributed.length > 0) {
        const shown = unattributed.slice(0, UNRESOLVED_PATHS_SHOWN);
        const more = unattributed.length > shown.length ? ` … (+${unattributed.length - shown.length} more)` : '';
        lines.push(`MOE_ATTRIBUTION_UNRESOLVED task=${task.id}: ${shown.join(', ')}${more}`);
      }
      try { await state.postSystemMessage(task.id, lines.join('\n')); } catch { /* never block tool */ }

      const alertGovernors = unattributed.length > 0 || rescueLanded || (outcome !== 'committed' && outcome !== 'nothing');
      if (alertGovernors) {
        const nowMs = Date.now();
        const last = governorAlertAt.get(task.id);
        if (last === undefined || nowMs - last >= GOVERNOR_ALERT_WINDOW_MS) {
          governorAlertAt.set(task.id, nowMs);
          try { await state.postToRoleChannel('governors', `⚠️ ${lines.join('\n')}`); } catch { /* never block tool */ }
        }
      }

      const finalCommits = Array.isArray(updated.commits) ? updated.commits : [];
      return {
        success: true,
        taskId: updated.id,
        ...(sha !== undefined ? { sha } : {}),
        kind,
        outcome,
        duplicate,
        commitCount: finalCommits.length,
        filesModified: updated.filesModified ?? [],
        addedPaths,
        ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
      };
    }
  };
}
