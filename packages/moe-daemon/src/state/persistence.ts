// =============================================================================
// State persistence - disk IO, bootstrap and file-system migrations
// =============================================================================
//
// Extracted verbatim from StateManager. `load()` and `applySettingsTimeouts`
// stay there as the orchestrator; everything below is the layer they call.
//
// Error handling here is load-bearing and deliberately asymmetric:
//   - loadEntities logs and SKIPS an unparseable entity file rather than
//     aborting the whole load - one corrupt task must not brick the daemon.
//     On a reload (reloadEntities) such a file keeps the record already in
//     memory instead: a git checkout rewrites tracked files in place, so a
//     reload can catch one empty, and dropping it would drop a live task.
//   - tryLoadWorkerFromDisk swallows every throw and returns null by design.
//   - verifyWritePermissions, by contrast, throws: an unwritable .moe is fatal
//     and must surface at startup, not at the first failed write.
//
// writeEntity's ordering is also load-bearing: validate the id, resolve and
// prefix-check the path, THEN register the FileWatcher ignore, then write.
// Registering the ignore before the write is what stops the watcher echoing
// the daemon's own writes back as external changes.

import fs from 'fs';
import path from 'path';
import type { StateManager } from './StateManager.js';
import type { ChatChannel, Project, Worker } from '../types/schema.js';
import { CURRENT_SCHEMA_VERSION } from '../types/schema.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { atomicWriteJson, atomicWriteJsonAsync } from '../util/atomicWrite.js';
import {
  sanitizeString,
  sanitizeNumber,
  sanitizePatternPreservingPlaceholders,
  sanitizeStringArray,
  sanitizeBoolean,
  sanitizeEnum,
  validateEntityId,
} from '../util/sanitize.js';

/** The size and mtime each record was read at (see loadEntities' `reuse`). */
const readAt = new WeakMap<object, string>();

function fileSignature(fullPath: string): string | null {
  try {
    const stat = fs.statSync(fullPath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Every `<id>.json` entity in `dir`. `previous` (the map a reload replaces) keeps
 * a record whose file cannot be read or parsed right now; `skip` drops a file
 * unread; `reuse` takes a record already in `previous` without reading its file
 * when the file has the size and mtime that record was read at. The stat comes
 * before the read, so a file changed in between is read again next time.
 */
export function loadEntities<T>(
  dir: string,
  previous?: ReadonlyMap<string, T>,
  skip?: (fullPath: string) => boolean,
  reuse = false
): Map<string, T> {
  const map = new Map<string, T>();
  if (!fs.existsSync(dir)) return map;

  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of entries) {
    const fullPath = path.join(dir, file);
    if (skip?.(fullPath)) continue;
    const fileId = file.slice(0, -'.json'.length);
    const known = previous?.get(fileId);
    const signature = reuse ? fileSignature(fullPath) : null;
    if (signature !== null && typeof known === 'object' && known !== null && readAt.get(known) === signature) {
      map.set(fileId, known);
      continue;
    }
    try {
      const entity = readJson<T>(fullPath);
      const id = (entity as { id?: string }).id;
      if (id) {
        map.set(id, entity);
        if (signature !== null) readAt.set(entity as object, signature);
      }
    } catch (error) {
      if (known === undefined) {
        logger.warn({ error, file: fullPath }, 'Failed to load entity file, skipping');
      } else {
        map.set(fileId, known);
        logger.warn({ error, file: fullPath }, 'Failed to reload entity file; keeping the record in memory');
      }
    }
  }

  return map;
}

/**
 * loadEntities for StateManager.load(): `previous` is the map being replaced and
 * a tombstoned file is skipped. `reuse` is for the delivery records (attempts,
 * candidates, checks, reviews, receipts), which only grow: a reload stats each
 * file and reads only one that is new or changed since its record was read (a
 * record the daemon wrote since is read once more), not the whole history.
 */
export function reloadEntities<T>(state: StateManager, kind: string, previous: ReadonlyMap<string, T>, reuse = false): Map<string, T> {
  return loadEntities(path.join(state.moePath, kind), previous, (file) => tombstoned(state, file), reuse);
}

/**
 * Entity files whose record is gone from memory but whose unlink failed
 * (removeEntityFile). Every load skips them and retries the unlink, so a reload
 * never resurrects the record; writeEntity clears its own path. Per process: a
 * restart reads the file again, and the startup purge decides it afresh.
 */
const tombstones = new WeakMap<StateManager, Set<string>>();

function tombstoned(state: StateManager, filePath: string): boolean {
  if (!tombstones.get(state)?.has(filePath)) return false;
  removeEntityFile(state, filePath);
  return true;
}

const UNLINK_RETRIES = 5;
const RETRYABLE_UNLINK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * fs.unlinkSync with atomicWrite's rename retry: Windows briefly refuses a file an
 * AV scanner or watcher holds (EPERM/EBUSY/EACCES), so retry with a short blocking
 * backoff. A missing file counts as removed. Throws the last error.
 */
export function unlinkWithRetry(filePath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.unlinkSync(filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (attempt >= UNLINK_RETRIES - 1 || code === undefined || !RETRYABLE_UNLINK_CODES.has(code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

/**
 * Delete the file of a record the caller drops from memory, the watcher echo
 * suppressed. False when it still will not go: the path is then tombstoned.
 */
export function removeEntityFile(state: StateManager, filePath: string): boolean {
  state.fileWatcher?.ignorePath(filePath);
  try {
    unlinkWithRetry(filePath);
    tombstones.get(state)?.delete(filePath);
    return true;
  } catch (error) {
    let paths = tombstones.get(state);
    if (!paths) tombstones.set(state, (paths = new Set()));
    paths.add(filePath);
    logger.warn({ error, file: filePath }, 'Failed to delete entity file; tombstoned so no reload restores its record');
    return false;
  }
}

/** @internal — reached by the extracted state/* modules; not part of the supported API. */
export function readJson<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

/**
 * Verify that we have write permissions to the .moe directory.
 * Called during load() to fail fast if permissions are insufficient.
 */
export function verifyWritePermissions(moePath: string): void {
  try {
    fs.accessSync(moePath, fs.constants.W_OK);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(
      `Cannot write to .moe directory at ${moePath}. ` +
      `Please ensure the daemon process has write permissions. ` +
      `Details: ${errMsg}`
    );
  }
}

export function normalizeProject(projectPath: string, project: Partial<Project>): Project {
  const now = new Date().toISOString();

  // Validate approvalMode using centralized sanitization
  const validApprovalModes = ['CONTROL', 'SPEED', 'TURBO'] as const;
  const approvalMode = sanitizeEnum(project.settings?.approvalMode, validApprovalModes, 'CONTROL');
  // Bounded [1 min, 24h]: floor guards against a typo thrashing claims;
  // ceiling keeps the REVIEW self-heal safety net meaningful even if
  // someone sets an extreme value.
  const staleWorkerTimeoutMs = sanitizeNumber(project.settings?.staleWorkerTimeoutMs, 1800000, 60000, 86400000);

  return {
    id: project.id || generateId('proj'),
    schemaVersion: project.schemaVersion || CURRENT_SCHEMA_VERSION,
    name: sanitizeString(project.name, 'projectName', 256, path.basename(projectPath)),
    rootPath: projectPath,
    globalRails: {
      techStack: sanitizeStringArray(project.globalRails?.techStack, 50, 256),
      forbiddenPatterns: sanitizeStringArray(project.globalRails?.forbiddenPatterns, 100, 1000),
      requiredPatterns: sanitizeStringArray(project.globalRails?.requiredPatterns, 100, 1000),
      formatting: sanitizeString(project.globalRails?.formatting, 'formatting', 10000, ''),
      testing: sanitizeString(project.globalRails?.testing, 'testing', 10000, ''),
      // These are approved policy, not preview text. Reload must not silently
      // truncate a rule (possibly dropping its safety qualifiers) or its list.
      customRules: sanitizeStringArray(project.globalRails?.customRules, Infinity, Infinity)
    },
    settings: {
      // Spread the persisted settings first so user keys that aren't part of
      // this validated allowlist (autoCommit, the launcher-read models block,
      // and any forward-compatible additions) survive a load/normalize/write
      // cycle instead of being silently stripped on the next persist.
      ...project.settings,
      approvalMode,
      speedModeDelayMs: sanitizeNumber(project.settings?.speedModeDelayMs, 2000, 0, 60000),
      autoCreateBranch: sanitizeBoolean(project.settings?.autoCreateBranch, true),
      branchPattern: sanitizePatternPreservingPlaceholders(project.settings?.branchPattern, 'moe/{epicId}/{taskId}'),
      commitPattern: sanitizePatternPreservingPlaceholders(project.settings?.commitPattern, 'feat({epicId}): {taskTitle}'),
      agentCommand: sanitizeString(project.settings?.agentCommand, 'agentCommand', 256, 'claude'),
      enableAgentTeams: sanitizeBoolean(project.settings?.enableAgentTeams, false),
      columnLimits: project.settings?.columnLimits as Record<string, number> | undefined,
      chatEnabled: sanitizeBoolean(project.settings?.chatEnabled, true),
      chatMaxAgentHops: sanitizeNumber(project.settings?.chatMaxAgentHops, 4, 1, 20),
      // [10 s, 24h]: the loop guard's sliding window (MentionRouter.setHopWindowMs).
      chatAgentHopWindowMs: sanitizeNumber(project.settings?.chatAgentHopWindowMs, 120000, 10000, 86400000),
      staleWorkerTimeoutMs,
      reviewStaleTimeoutMs: sanitizeNumber(project.settings?.reviewStaleTimeoutMs, staleWorkerTimeoutMs, 60000, 86400000),
    },
    createdAt: project.createdAt || now,
    updatedAt: project.updatedAt || now
  };
}

/**
 * Post-migration file system setup for v5 (chat channels and messages).
 * Creates directories, default general channel, and backfills worker chatCursors.
 */
export function migrateToV5FileSystem(moePath: string): void {
  // Create channels/ and messages/ directories. These are ESSENTIAL: without
  // them chat is unusable. Let a failure PROPAGATE out of load() so the bumped
  // schemaVersion is NOT persisted (it's written only after migrations return)
  // — otherwise the version sticks at the new value and this FS step never
  // reruns, permanently breaking chat. (Non-essential per-file copies below
  // stay tolerant.)
  fs.mkdirSync(path.join(moePath, 'channels'), { recursive: true });
  fs.mkdirSync(path.join(moePath, 'messages'), { recursive: true });

  // Create default general channel if no channels exist yet
  const channelsDir = path.join(moePath, 'channels');
  try {
    const existing = fs.readdirSync(channelsDir).filter(f => f.endsWith('.json'));
    if (existing.length === 0) {
      const channelId = generateId('chan');
      const generalChannel = {
        id: channelId,
        name: 'general',
        type: 'general',
        linkedEntityId: null,
        createdAt: new Date().toISOString()
      };
      atomicWriteJson(
        path.join(channelsDir, `${channelId}.json`),
        generalChannel
      );
      // Create empty JSONL message file
      fs.writeFileSync(path.join(moePath, 'messages', `${channelId}.jsonl`), '');
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to create general channel during migration');
  }


  // Backfill chatCursors on existing worker files
  const workersDir = path.join(moePath, 'workers');
  try {
    if (fs.existsSync(workersDir)) {
      const workerFiles = fs.readdirSync(workersDir).filter(f => f.endsWith('.json'));
      for (const file of workerFiles) {
        try {
          const filePath = path.join(workersDir, file);
          const worker = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (!worker.chatCursors) {
            worker.chatCursors = {};
            atomicWriteJson(filePath, worker);
          }
        } catch (error) {
          logger.warn({ error, file }, 'Failed to backfill chatCursors for worker');
        }
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to backfill worker chatCursors during migration');
  }
}

/**
 * Post-migration file system setup for v6 (role-based channels).
 * Deletes task/epic channels and creates role channels (#workers, #architects, #qa).
 */
export function migrateToV6FileSystem(moePath: string): void {
  const channelsDir = path.join(moePath, 'channels');
  const messagesDir = path.join(moePath, 'messages');

  // Delete task/epic channels and their message files
  try {
    if (fs.existsSync(channelsDir)) {
      for (const file of fs.readdirSync(channelsDir).filter(f => f.endsWith('.json'))) {
        try {
          const filePath = path.join(channelsDir, file);
          const channel = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (channel.type === 'task' || channel.type === 'epic') {
            fs.unlinkSync(filePath);
            const msgFile = path.join(messagesDir, `${channel.id}.jsonl`);
            if (fs.existsSync(msgFile)) {
              fs.unlinkSync(msgFile);
            }
          }
        } catch (error) {
          logger.warn({ error, file }, 'Failed to delete task/epic channel during v6 migration');
        }
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to clean up task/epic channels during v6 migration');
  }

  // Create role channels if they don't already exist
  const existingNames = new Set<string>();
  try {
    for (const file of fs.readdirSync(channelsDir).filter(f => f.endsWith('.json'))) {
      try {
        const channel = JSON.parse(fs.readFileSync(path.join(channelsDir, file), 'utf-8'));
        existingNames.add(channel.name);
      } catch { /* skip unreadable */ }
    }
  } catch { /* directory may not exist */ }

  for (const roleName of ['workers', 'architects', 'qa', 'governors']) {
    if (existingNames.has(roleName)) continue;
    try {
      const channelId = generateId('chan');
      const channel = {
        id: channelId,
        name: roleName,
        type: 'role',
        linkedEntityId: null,
        createdAt: new Date().toISOString()
      };
      atomicWriteJson(path.join(channelsDir, `${channelId}.json`), channel);
      fs.writeFileSync(path.join(messagesDir, `${channelId}.jsonl`), '');
    } catch (error) {
      logger.warn({ error, roleName }, 'Failed to create role channel during v6 migration');
    }
  }
}

/**
 * Idempotently ensure the chat infrastructure exists, independent of
 * schemaVersion. Called on EVERY load() after channels are loaded into memory.
 *
 * This is the self-heal for masked FS migrations: if a v5/v6 migration bumped
 * schemaVersion but its file-system side-effects failed (dirs/role channels
 * never created), the bumped version means the migration never reruns and chat
 * stays broken ("Channel not found"). Recreating the canonical channels here
 * fixes that on the next load without touching schemaVersion. No-op when
 * everything already exists.
 */
export function ensureChatInfrastructure(state: StateManager): void {
  // Essential directories — these MUST exist for chat to work at all.
  fs.mkdirSync(path.join(state.moePath, 'channels'), { recursive: true });
  fs.mkdirSync(path.join(state.moePath, 'messages'), { recursive: true });

  // Default #general channel (by name/type), then the role channels.
  const hasGeneral = Array.from(state.channels.values()).some(
    (ch) => ch.type === 'general' || ch.name === 'general'
  );
  if (!hasGeneral) {
    seedCanonicalChannel(state, 'general', 'general');
  }
  ensureRoleChannels(state);
}

/**
 * Ensure the canonical role channels (#workers, #architects, #qa, #governors)
 * exist, creating any that are missing. Idempotent — keys on channel name.
 */
export function ensureRoleChannels(state: StateManager): void {
  const existingNames = new Set(
    Array.from(state.channels.values()).map((ch) => ch.name)
  );
  for (const roleName of ['workers', 'architects', 'qa', 'governors']) {
    if (existingNames.has(roleName)) continue;
    seedCanonicalChannel(state, roleName, 'role');
  }
}

/**
 * Create a canonical channel (file + empty messages JSONL + in-memory entry)
 * if it isn't already present. Best-effort: a per-channel failure is logged but
 * does not abort load(). The watcher echo is suppressed so the fresh file does
 * not re-trigger a reload.
 */
export function seedCanonicalChannel(state: StateManager, name: string, type: ChatChannel['type']): void {
  try {
    const channel: ChatChannel = {
      id: generateId('chan'),
      name,
      type,
      linkedEntityId: null,
      createdAt: new Date().toISOString(),
    };
    const channelFile = path.join(state.moePath, 'channels', `${channel.id}.json`);
    state.fileWatcher?.ignorePath(channelFile);
    atomicWriteJson(channelFile, channel);
    const messagesFile = path.join(state.moePath, 'messages', `${channel.id}.jsonl`);
    if (!fs.existsSync(messagesFile)) {
      fs.writeFileSync(messagesFile, '');
    }
    state.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id, name, type }, 'Self-healed missing canonical chat channel');
  } catch (error) {
    logger.warn({ error, name, type }, 'Failed to self-heal canonical chat channel');
  }
}

/** @internal — reached by the extracted state/* modules; not part of the supported API. */
export async function writeEntity(state: StateManager, kind: string, id: string, entity: unknown): Promise<void> {
  // Validate ID to prevent path traversal attacks using centralized validation
  validateEntityId(id);

  const dir = path.join(state.moePath, kind);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${id}.json`);

  // Double-check the resolved path is within .moe directory
  const resolvedPath = path.resolve(filePath);
  const resolvedMoePath = path.resolve(state.moePath);
  if (!resolvedPath.startsWith(resolvedMoePath)) {
    throw new Error(`Path traversal detected: ${id}`);
  }

  if (state.fileWatcher) {
    state.fileWatcher.ignorePath(filePath);
  }
  // Async variant: its rename-retry backoff awaits a timer instead of the sync
  // path's Atomics.wait, so a contended write (Windows AV/watcher briefly holds
  // the file) no longer freezes the whole event loop — WS heartbeats, the proxy
  // bridge and other I/O keep progressing while this entity persists. writeEntity
  // is the hot path for every task/epic/worker/team write under the state mutex.
  await atomicWriteJsonAsync(filePath, entity);
  tombstones.get(state)?.delete(filePath);
  // After the bytes, never before: a poll that reads a bumped version with the old
  // record would keep the stale board until the next write.
  state.stateVersion++;
  if (BOARD_KINDS.has(kind)) state.boardVersion++;
}

/** Entity kinds the plugins' board snapshot (tasks, epics, delivery projection) is built from. */
const BOARD_KINDS: ReadonlySet<string> = new Set(['tasks', 'epics', 'attempts', 'candidates', 'checks', 'receipts']);

/**
 * Fallback: try loading a worker directly from disk when not found in memory.
 * Handles race conditions where the in-memory state hasn't reloaded yet.
 */
export function tryLoadWorkerFromDisk(state: StateManager, workerId: string): Worker | null {
  try {
    validateEntityId(workerId);
    const filePath = path.join(state.moePath, 'workers', `${workerId}.json`);
    if (!tombstoned(state, filePath) && fs.existsSync(filePath)) {
      const worker = readJson<Worker>(filePath);
      if (worker && worker.id) {
        state.workers.set(worker.id, worker);
        return worker;
      }
    }
  } catch {
    // Fall through to null
  }
  return null;
}
