// =============================================================================
// StateManager - loads and updates .moe state
// =============================================================================
//
// THE INVARIANT, if you are about to add code here: StateManager owns the STATE
// - the entity maps, the mutexes, the timer handles, the subscriber list. The
// modules beside it are stateless collections of functions that operate on a
// StateManager handle passed as their first argument. Keep it that way. Moving
// a map or a mutex into a module re-scatters ownership and quietly breaks the
// things that depend on there being exactly one of each (mutex identity, the
// activity-log backpressure counters, per-instance interval handles).
//
// The concerns live in:
//   ./validators.ts   - validate*/sanitize* helpers and the field ALLOWLISTS
//   ./persistence.ts  - disk IO, bootstrap, file-system migrations
//   ./activityLog.ts  - activity append/flush and bounded tail reads
//   ./chatStore.ts    - channels, messages, pins, unread counters, decisions
//   ./teamStore.ts    - teams, roles, membership
//   ./sweeps.ts       - blocked-timeout, proposal-purge and stale-worker timers
//   ./taskStore.ts    - task CRUD and lifecycle transitions
//   ./workerStore.ts  - worker records, presence, task claimability
//
// What stays here: the maps, load() as orchestrator, getSnapshot, the
// subscriber/emit plumbing, rail proposals, and a delegating method for every
// public API those modules implement (97 files import this class, so the
// surface is frozen). Modules import `type { StateManager }` only - the runtime
// import graph inside src/state must stay acyclic, and
// ./stateModules.test.ts fails the build if that or the size budget regresses.

import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import type {
  ActivityEvent,
  ActivityEventType,
  ChatChannel,
  ChatMessage,
  Decision,
  DecisionStatus,
  Epic,
  ImplementationStep,
  MoeStateSnapshot,
  PinEntry,
  Project,
  ProjectSettings,
  RailProposal,
  ResourceLease,
  ResourceState,
  StepAmendment,
  StepStatus,
  Task,
  TaskStatus,
  TaskComment,
  TaskPriority,
  Team,
  TeamRole,
  Worker,
  WorkerStatus
} from '../types/schema.js';
import { CURRENT_SCHEMA_VERSION, ACTIVITY_EVENT_TYPES } from '../types/schema.js';
import { invalidInput } from '../util/errors.js';
import { generateId } from '../util/ids.js';
import { computeOrderBetween, sortByOrder } from '../util/order.js';
import { logger, createContextLogger } from '../util/logger.js';
import { runMigrations } from '../migrations/index.js';
import { LogRotator } from '../util/LogRotator.js';
import { cancelSpeedModeTimeout } from '../tools/submitPlan.js';
import { cleanupStaleWaiters } from '../tools/waitForTask.js';
import { MentionRouter } from '../util/mentionRouter.js';
import {
  sanitizeString,
  sanitizeNumber,
  sanitizePatternPreservingPlaceholders,
  sanitizeStringArray,
  sanitizeBoolean,
  sanitizeEnum,
  sanitizeUrl,
  validateEntityId
} from '../util/sanitize.js';
import { nextStatusForRelease } from './workerLifecycle.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';
import { readLastLinesWithMetadata } from '../util/reverseReader.js';
import { atomicWriteJson, atomicWriteJsonAsync } from '../util/atomicWrite.js';
import { normalizeAffectedFiles } from '../util/affectedFiles.js';
import {
  createWorker,
  deleteWorker,
  getActiveTasksAssignedToWorker,
  getTasksAssignedToWorker,
  getWorkersByEpic,
  hasActiveTaskAssignment,
  isTaskAssignedToDeadWorker,
  isTaskAssignedToInactiveWorker,
  isTaskAssignedToMissingWorker,
  isTaskClaimable,
  purgeAllWorkers,
  touchWorker,
  updateWorker,
  updateWorkerCursors,
} from './workerStore.js';
import {
  approveTask,
  createTask,
  deleteTask,
  nextTaskOrder,
  rejectTask,
  reopenTask,
  reorderTask,
  updateTask,
} from './taskStore.js';
import {
  checkBlockedTimeouts,
  checkStaleWorkers,
  isStaleResolvedProposal,
  purgeResolvedProposals,
  PROPOSAL_PURGE_INTERVAL_MS,
  PROPOSAL_SNAPSHOT_RETENTION_MS,
  startBlockedTimeoutCheck,
  startProposalPurgeInterval,
  startStaleWorkerWatcher,
  stopBlockedTimeoutCheck,
  stopProposalPurgeInterval,
  stopStaleWorkerWatcher,
} from './sweeps.js';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  getTeamByName,
  getTeamByNameAndRole,
  getTeamForWorker,
  removeTeamMember,
  updateTeam,
} from './teamStore.js';
import {
  approveDecision,
  clearUnread,
  createChannel,
  createDecision,
  deleteChannel,
  getChannel,
  getChannels,
  getDecision,
  getDecisions,
  getMessages,
  getPins,
  getUnreadSummary,
  incrementUnread,
  messageExistsInChannel,
  pinMessage,
  postSystemMessage,
  postToGeneral,
  postToRoleChannel,
  rejectDecision,
  sendMessage,
  togglePinDone,
  unpinMessage,
} from './chatStore.js';
import {
  acquireResource,
  getResource,
  grantNextLeases,
  reapResources,
  releaseResource,
  resolveResourceConfig,
  type AcquireParams,
  type AcquireResult,
  type ReleaseParams,
  type ReleaseResourceResult,
  type ResourceConfig,
} from './resourceStore.js';
import {
  appendActivity,
  appendActivityAsync,
  flushActivityLog,
  getActivityLog,
  getActivityLogWindow,
  notifyActivityFlushed,
} from './activityLog.js';
import {
  ensureChatInfrastructure,
  loadEntities,
  migrateToV5FileSystem,
  migrateToV6FileSystem,
  normalizeProject,
  readJson,
  tryLoadWorkerFromDisk,
  verifyWritePermissions,
  writeEntity,
} from './persistence.js';
import {
  MAX_COMMENTS_PER_TASK,
  epicCreatedActivityPayload,
  epicUpdatedActivityPayload,
  requirePlainObject,
  rejectUnknownFields,
  sanitizeImplementationPlan,
  sanitizeStringIdArray,
  trimComments,
  validateBooleanValue,
  validateCreateTeamInput,
  validateEnumValue,
  validateEpicUpdates,
  validateIntegerValue,
  validateMemberIds,
  validatePatternSetting,
  validateSettingsUpdate,
  validateStringArrayValue,
  validateStringValue,
  validateTeamMaxSize,
  validateTeamName,
  validateTeamRole,
  validateTeamUpdates,
} from './validators.js';
import { MAX_AMENDMENTS_PER_STEP } from '../util/planAmendments.js';

// Configurable timeout for state load operations (default 30 seconds)
const STATE_LOAD_TIMEOUT_MS = parseInt(process.env.MOE_STATE_LOAD_TIMEOUT_MS || '30000', 10);
const DAY_IN_MS = 24 * 60 * 60 * 1000;
// Definition moved to ./validators.ts; re-exported because external code imports it from here.
export { MAX_COMMENTS_PER_TASK } from './validators.js';

/**
 * Wraps a promise with a timeout.
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation for error messages
 * @returns The promise result or throws on timeout
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Simple async mutex to serialize state operations.
 * Prevents race conditions when multiple operations try to modify state concurrently.
 */
/** Exported so the extracted state/* modules can type the shared mutex instances. */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];
  // Tracks whether the current async context already holds the lock, so that
  // nested runExclusive calls (e.g. a tool serialized at the MCP dispatch layer
  // that itself calls runExclusive, like claim_next_task or submit_plan's
  // speed-mode auto-approve) re-enter instead of deadlocking on a non-reentrant
  // re-acquire.
  private readonly holding = new AsyncLocalStorage<boolean>();

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /** True if the calling async context is already inside runExclusive. */
  isHeld(): boolean {
    return this.holding.getStore() === true;
  }

  /**
   * Run fn OUTSIDE the held-lock async context. Timers (setTimeout/setInterval)
   * created inside holding.run(true, …) inherit the AsyncLocalStorage context,
   * so their callbacks' runExclusive would short-circuit as "reentrant" and
   * mutate state WITHOUT the lock long after the arming call released it. Every
   * timer whose callback uses runExclusive must be armed through this.
   */
  exit<T>(fn: () => T): T {
    return this.holding.exit(fn);
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Reentrant: a context that already holds the lock runs fn directly.
    if (this.holding.getStore()) {
      return fn();
    }
    await this.acquire();
    try {
      return await this.holding.run(true, fn);
    } finally {
      this.release();
    }
  }
}

export type StateChangeEvent =
  | { type: 'STATE_SNAPSHOT'; payload: MoeStateSnapshot }
  | { type: 'TASK_UPDATED'; payload: Task }
  | { type: 'TASK_CREATED'; payload: Task }
  | { type: 'TASK_DELETED'; payload: Task }
  | { type: 'EPIC_UPDATED'; payload: Epic }
  | { type: 'EPIC_CREATED'; payload: Epic }
  | { type: 'EPIC_DELETED'; payload: Epic }
  | { type: 'WORKER_CREATED'; payload: Worker }
  | { type: 'WORKER_UPDATED'; payload: Worker }
  | { type: 'WORKER_DELETED'; payload: Worker }
  | { type: 'PROPOSAL_CREATED'; payload: RailProposal }
  | { type: 'PROPOSAL_UPDATED'; payload: RailProposal }
  | { type: 'SETTINGS_UPDATED'; payload: Project }
  | { type: 'TEAM_CREATED'; payload: Team }
  | { type: 'TEAM_UPDATED'; payload: Team }
  | { type: 'TEAM_DELETED'; payload: Team }
  | { type: 'MESSAGE_CREATED'; payload: ChatMessage; routingTargets?: string[] }
  | { type: 'CHANNEL_CREATED'; payload: ChatChannel }
  | { type: 'CHANNEL_DELETED'; payload: ChatChannel }
  | { type: 'PINS_UPDATED'; payload: { channel: string; pins: PinEntry[] } }
  | { type: 'DECISION_PROPOSED'; payload: Decision }
  | { type: 'DECISION_RESOLVED'; payload: Decision }
  | { type: 'RESOURCE_UPDATED'; payload: ResourceState };

type StateSubscriber = (event: StateChangeEvent) => void;

export interface StateManagerOptions {
  projectPath: string;
  blockedTimeoutMs?: number;
  staleWorkerTimeoutMs?: number;
  /**
   * How long a REVIEW task's owner may be silent before the task is released
   * (unassigned, status unchanged) so another QA agent can claim it. Scoped to
   * REVIEW only — WORKING/PLANNING assignments are never yanked by staleness
   * (that was 3d2cb16's fix for stealing tasks off long-running coders).
   * Defaults to staleWorkerTimeoutMs.
   */
  reviewStaleTimeoutMs?: number;
}

export class StateManager {
  readonly projectPath: string;
  readonly moePath: string;

  project: Project | null = null;
  epics = new Map<string, Epic>();
  tasks = new Map<string, Task>();
  workers = new Map<string, Worker>();
  proposals = new Map<string, RailProposal>();
  teams = new Map<string, Team>();
  channels = new Map<string, ChatChannel>();
  decisions = new Map<string, Decision>();
  resources = new Map<string, ResourceState>();

  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  emitter?: (event: StateChangeEvent) => void;
  private subscribers = new Set<StateSubscriber>();
  private subscriberErrorCounts = new Map<StateSubscriber, number>();
  // Lock ordering: this.mutex → channelMutex (per-channel, from messageMutexes)
  // Always acquire this.mutex first if both are needed.
  // Methods like claimNextTask hold this.mutex and call sendMessage which
  // acquires channelMutex — never reverse this order or deadlocks will occur.
  // activityMutex is independent and can be acquired in any order.
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  readonly mutex = new AsyncMutex();
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  readonly activityMutex = new AsyncMutex();
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  readonly messageMutexes = new Map<string, AsyncMutex>();
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  logRotator?: LogRotator;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  pendingActivityWrites = 0;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  activityFlushResolvers: Array<() => void> = [];
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  lastActivityBackpressureWarn = 0;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  droppedActivityWrites = 0;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  blockedTimeoutInterval?: NodeJS.Timeout;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  proposalPurgeInterval?: NodeJS.Timeout;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  staleWorkerInterval?: NodeJS.Timeout;
  // Memoization to avoid re-alerting on the same (workerId, taskId) tuple
  // until the staleness clears (worker becomes alive again) or the assignment
  // moves to a different task.
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  alertedStaleAssignments = new Set<string>();
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  readonly blockedTimeoutMs: number;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  staleWorkerTimeoutMs: number;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  reviewStaleTimeoutMs: number;
  // True when the constructor caller passed an explicit override (tests, mainly).
  // Explicit constructor options always win over .moe/project.json settings —
  // otherwise load() would silently clobber a test's chosen timeout with
  // whatever normalizeProject defaults to.
  private readonly staleWorkerTimeoutMsExplicit: boolean;
  private readonly reviewStaleTimeoutMsExplicit: boolean;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  mentionRouter: MentionRouter;
  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  fileWatcher?: import('./FileWatcher.js').FileWatcher;
  /**
   * In-memory per-worker per-channel unread message counts
   * @internal — reached by the extracted state/* modules; not part of the supported API.
   */
  unreadCounts = new Map<string, Map<string, number>>();

  constructor(options: StateManagerOptions) {
    this.projectPath = options.projectPath;
    this.moePath = path.join(this.projectPath, '.moe');
    this.blockedTimeoutMs = options.blockedTimeoutMs ?? 3600000; // default 1 hour
    this.staleWorkerTimeoutMsExplicit = options.staleWorkerTimeoutMs !== undefined;
    this.staleWorkerTimeoutMs = options.staleWorkerTimeoutMs ?? 1800000; // default 30 min
    // Defaults to the stale-worker timeout: never releases a REVIEW task faster
    // than the pre-existing record prune would, so this is purely additive.
    this.reviewStaleTimeoutMsExplicit = options.reviewStaleTimeoutMs !== undefined;
    this.reviewStaleTimeoutMs = options.reviewStaleTimeoutMs ?? this.staleWorkerTimeoutMs;
    this.mentionRouter = new MentionRouter(4);
  }

  setEmitter(fn: (event: StateChangeEvent) => void) {
    this.emitter = fn;
  }

  setFileWatcher(watcher: import('./FileWatcher.js').FileWatcher) {
    this.fileWatcher = watcher;
  }

  /**
   * Clear the event emitter to prevent memory leaks during shutdown.
   */
  clearEmitter(): void {
    this.stopBlockedTimeoutCheck();
    this.stopProposalPurgeInterval();
    this.stopStaleWorkerWatcher();
    this.subscribers.clear();
    this.subscriberErrorCounts.clear();
    this.emitter = undefined;
  }

  /**
   * Subscribe to state change events. Returns an unsubscribe function.
   */
  subscribe(fn: StateSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
      this.subscriberErrorCounts.delete(fn);
    };
  }

  /**
   * Expose mutex for external callers that need atomic multi-step operations
   * (e.g. claimNextTask read-then-write).
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(fn);
  }

  /**
   * Arm a timer (or run any sync fn) OUTSIDE the mutex's reentrancy context.
   * Required for every setTimeout/setInterval created from code that may run
   * under runExclusive (tool handlers are dispatched under it): an inherited
   * "holding" context makes the timer callback's runExclusive short-circuit
   * and mutate state without the lock. See AsyncMutex.exit.
   */
  detachFromMutexContext<T>(fn: () => T): T {
    return this.mutex.exit(fn);
  }

  /**
   * Check if the state manager has loaded project data.
   * Used for health checks.
   */
  /**
   * Append one audit event. Best-effort by contract: never throws into the
   * caller, because a failed audit write must not fail the state mutation that
   * produced it.
   */
  appendActivity(
    event: ActivityEventType,
    payload: Record<string, unknown>,
    task?: Task,
    worker?: Worker,
    proposal?: RailProposal,
    epic?: Epic
  ): void {
    appendActivity(this, event, payload, task, worker, proposal, epic);
  }

  async appendActivityAsync(
    event: ActivityEventType,
    payload: Record<string, unknown>,
    task?: Task,
    worker?: Worker,
    proposal?: RailProposal,
    epic?: Epic
  ): Promise<void> {
    return appendActivityAsync(this, event, payload, task, worker, proposal, epic);
  }

  getActivityLog(limit = 100): ActivityEvent[] {
    return getActivityLog(this, limit);
  }

  getActivityLogWindow(limit = 100): { events: ActivityEvent[]; hasMoreOlderLines: boolean; linesRead: number } {
    return getActivityLogWindow(this, limit);
  }

  async flushActivityLog(): Promise<void> {
    return flushActivityLog(this);
  }

  /** @internal - reached by the extracted state/* modules; not part of the supported API. */
  notifyActivityFlushed(): void {
    notifyActivityFlushed(this);
  }

  // ---------------------------------------------------------------------------
  // Worker delegating API (implementation in ./workerStore.ts). Signatures
  // generated from the extracted functions, never hand-written.
  // ---------------------------------------------------------------------------

  async createWorker(input: {
  id: string;
  type: Worker['type'];
  projectId: string;
  epicId: string;
  currentTaskId: string | null;
  status: Worker['status'];
}): Promise<Worker> {
    return createWorker(this, input);
  }

  async updateWorker(workerId: string, updates: Partial<Worker>, event?: ActivityEventType): Promise<Worker> {
    return updateWorker(this, workerId, updates, event);
  }

  async updateWorkerCursors(workerId: string, cursorUpdates: Record<string, string>): Promise<void> {
    return updateWorkerCursors(this, workerId, cursorUpdates);
  }

  async deleteWorker(workerId: string): Promise<void> {
    return deleteWorker(this, workerId);
  }

  async purgeAllWorkers(): Promise<void> {
    return purgeAllWorkers(this);
  }

  async touchWorker(workerId?: string | null, updates: Partial<Worker> = {}, event?: ActivityEventType): Promise<Worker | null> {
    return touchWorker(this, workerId, updates, event);
  }

  getWorkersByEpic(epicId: string): Worker[] {
    return getWorkersByEpic(this, epicId);
  }

  getTasksAssignedToWorker(workerId: string): Task[] {
    return getTasksAssignedToWorker(this, workerId);
  }

  getActiveTasksAssignedToWorker(workerId: string): Task[] {
    return getActiveTasksAssignedToWorker(this, workerId);
  }

  /** @internal - reached by the extracted state/* modules; not part of the supported API. */
  hasActiveTaskAssignment(workerId: string): boolean {
    return hasActiveTaskAssignment(this, workerId);
  }

  isTaskClaimable(task: Task): boolean {
    return isTaskClaimable(this, task);
  }

  isTaskAssignedToMissingWorker(task: Task): boolean {
    return isTaskAssignedToMissingWorker(this, task);
  }

  isTaskAssignedToDeadWorker(task: Task): boolean {
    return isTaskAssignedToDeadWorker(this, task);
  }

  isTaskAssignedToInactiveWorker(task: Task): boolean {
    return isTaskAssignedToInactiveWorker(this, task);
  }

  // ---------------------------------------------------------------------------
  // Task delegating API (implementation in ./taskStore.ts). Signatures
  // generated from the extracted functions, never hand-written.
  // ---------------------------------------------------------------------------

  async createTask(input: Partial<Task>): Promise<Task> {
    return createTask(this, input);
  }

  async updateTask(taskId: string, updates: Partial<Task>, event?: ActivityEventType): Promise<Task> {
    return updateTask(this, taskId, updates, event);
  }

  async deleteTask(taskId: string): Promise<Task> {
    return deleteTask(this, taskId);
  }

  async approveTask(taskId: string): Promise<Task> {
    return approveTask(this, taskId);
  }

  async rejectTask(taskId: string, reason: string): Promise<Task> {
    return rejectTask(this, taskId, reason);
  }

  async reopenTask(taskId: string, reason: string): Promise<Task> {
    return reopenTask(this, taskId, reason);
  }

  async reorderTask(taskId: string, beforeId: string | null, afterId: string | null): Promise<Task> {
    return reorderTask(this, taskId, beforeId, afterId);
  }

  nextTaskOrder(epicId: string): number {
    return nextTaskOrder(this, epicId);
  }

  // ---------------------------------------------------------------------------
  // Sweep delegating API (implementation in ./sweeps.ts). Signatures generated
  // from the extracted functions, never hand-written.
  // ---------------------------------------------------------------------------

  startBlockedTimeoutCheck(intervalMs = 300000): void {
    return startBlockedTimeoutCheck(this, intervalMs);
  }

  stopBlockedTimeoutCheck(): void {
    return stopBlockedTimeoutCheck(this);
  }

  startProposalPurgeInterval(intervalMs = PROPOSAL_PURGE_INTERVAL_MS): void {
    return startProposalPurgeInterval(this, intervalMs);
  }

  stopProposalPurgeInterval(): void {
    return stopProposalPurgeInterval(this);
  }

  startStaleWorkerWatcher(intervalMs = 60_000, livenessTimeoutMs = 120_000): void {
    return startStaleWorkerWatcher(this, intervalMs, livenessTimeoutMs);
  }

  stopStaleWorkerWatcher(): void {
    return stopStaleWorkerWatcher(this);
  }

  async checkStaleWorkers(livenessTimeoutMs: number): Promise<void> {
    return checkStaleWorkers(this, livenessTimeoutMs);
  }

  // ---------------------------------------------------------------------------
  // Resource delegating API (implementation in ./resourceStore.ts). Signatures
  // generated from the extracted functions, never hand-written.
  // ---------------------------------------------------------------------------

  getResource(resourceId: string): ResourceState | null {
    return getResource(this, resourceId);
  }

  resolveResourceConfig(resourceId: string): ResourceConfig {
    return resolveResourceConfig(this, resourceId);
  }

  async acquireResource(params: AcquireParams): Promise<AcquireResult> {
    return acquireResource(this, params);
  }

  async releaseResource(params: ReleaseParams): Promise<ReleaseResourceResult> {
    return releaseResource(this, params);
  }

  async grantNextLeases(resourceId: string): Promise<ResourceLease[]> {
    return grantNextLeases(this, resourceId);
  }

  async reapResources(nowMs?: number): Promise<number> {
    return reapResources(this, nowMs);
  }

  async checkBlockedTimeouts(): Promise<void> {
    return checkBlockedTimeouts(this);
  }

  async purgeResolvedProposals(nowMs = Date.now()): Promise<number> {
    return purgeResolvedProposals(this, nowMs);
  }

  // ---------------------------------------------------------------------------
  // Team delegating API (implementation in ./teamStore.ts). Signatures are
  // generated from the extracted functions, never hand-written.
  // ---------------------------------------------------------------------------

  getTeam(teamId: string): Team | null {
    return getTeam(this, teamId);
  }

  getTeamByNameAndRole(name: string, role: TeamRole | null): Team | null {
    return getTeamByNameAndRole(this, name, role);
  }

  getTeamByName(name: string): Team | null {
    return getTeamByName(this, name);
  }

  getTeamForWorker(workerId: string): Team | null {
    return getTeamForWorker(this, workerId);
  }

  async createTeam(input: { name: string; role?: TeamRole | null; maxSize?: number }): Promise<Team> {
    return createTeam(this, input);
  }

  async updateTeam(teamId: string, updates: Partial<Team>): Promise<Team> {
    return updateTeam(this, teamId, updates);
  }

  async deleteTeam(teamId: string): Promise<Team> {
    return deleteTeam(this, teamId);
  }

  async addTeamMember(teamId: string, workerId: string): Promise<Team> {
    return addTeamMember(this, teamId, workerId);
  }

  async removeTeamMember(teamId: string, workerId: string): Promise<Team> {
    return removeTeamMember(this, teamId, workerId);
  }

  // ---------------------------------------------------------------------------
  // Chat delegating API (implementation in ./chatStore.ts). Signatures are
  // generated from the extracted functions, never hand-written, so a public
  // signature cannot drift during the move.
  // ---------------------------------------------------------------------------

  getChannel(channelId: string): ChatChannel | null {
    return getChannel(this, channelId);
  }

  getChannels(): ChatChannel[] {
    return getChannels(this);
  }

  async createChannel(opts: {
  name: string;
  type: ChatChannel['type'];
  linkedEntityId?: string;
}): Promise<ChatChannel> {
    return createChannel(this, opts);
  }

  async sendMessage(opts: {
  channel: string;
  sender: string;
  content: string;
  replyTo?: string;
  decisionId?: string;
}): Promise<{ message: ChatMessage; routingTargets: string[] }> {
    return sendMessage(this, opts);
  }

  async getMessages(channelId: string,
  opts?: { sinceId?: string; limit?: number }): Promise<ChatMessage[]> {
    return getMessages(this, channelId, opts);
  }

  messageExistsInChannel(channelId: string, messageId: string): boolean {
    return messageExistsInChannel(this, channelId, messageId);
  }

  async postSystemMessage(_entityId: string, content: string): Promise<void> {
    return postSystemMessage(this, _entityId, content);
  }

  async postToGeneral(content: string): Promise<void> {
    return postToGeneral(this, content);
  }

  async postToRoleChannel(roleName: string, content: string): Promise<void> {
    return postToRoleChannel(this, roleName, content);
  }

  async deleteChannel(channelId: string): Promise<void> {
    return deleteChannel(this, channelId);
  }

  /**
   * Per-channel serialization for JSONL appends. Kept ON the class (not moved
   * to chatStore) for one reason: it is the only chat function that needs the
   * AsyncMutex CONSTRUCTOR, and importing that from chatStore would turn the
   * type-only edge into a real runtime import cycle. Identity matters — the
   * same channelId must always get the same instance.
   * @internal - reached by the extracted state/* modules; not part of the supported API.
   */
  getMessageMutex(channelId: string): AsyncMutex {
    let m = this.messageMutexes.get(channelId);
    if (!m) {
      m = new AsyncMutex();
      this.messageMutexes.set(channelId, m);
    }
    return m;
  }

  /** @internal - reached by the extracted state/* modules; not part of the supported API. */
  incrementUnread(workerId: string, channelId: string): void {
    return incrementUnread(this, workerId, channelId);
  }

  getUnreadSummary(workerId: string): { total: number; channels: Record<string, number> } | null {
    return getUnreadSummary(this, workerId);
  }

  clearUnread(workerId: string, channelId?: string): void {
    return clearUnread(this, workerId, channelId);
  }

  getPins(channelId: string): PinEntry[] {
    return getPins(this, channelId);
  }

  async pinMessage(channelId: string, messageId: string, pinnedBy: string): Promise<PinEntry> {
    return pinMessage(this, channelId, messageId, pinnedBy);
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    return unpinMessage(this, channelId, messageId);
  }

  async togglePinDone(channelId: string, messageId: string): Promise<PinEntry> {
    return togglePinDone(this, channelId, messageId);
  }

  getDecision(id: string): Decision | null {
    return getDecision(this, id);
  }

  getDecisions(): Decision[] {
    return getDecisions(this);
  }

  async createDecision(opts: {
  content: string;
  proposedBy: string;
  channel?: string;
}): Promise<Decision> {
    return createDecision(this, opts);
  }

  async approveDecision(id: string, approvedBy: string): Promise<Decision> {
    return approveDecision(this, id, approvedBy);
  }

  async rejectDecision(id: string): Promise<Decision> {
    return rejectDecision(this, id);
  }

  isLoaded(): boolean {
    return this.project !== null;
  }

  /**
   * Persist one entity to `.moe/<kind>/<id>.json`.
   *
   * Kept as a method (not a bare import) on purpose: StateManager.test.ts spies
   * on it to simulate a failed disk write, and existing callers must keep going
   * through the instance for that spy to intercept.
   */
  async writeEntity(kind: string, id: string, entity: unknown): Promise<void> {
    return writeEntity(this, kind, id, entity);
  }

  /**
   * Read a worker straight off disk when it is missing from the in-memory map
   * (a just-registered worker the FileWatcher has not surfaced yet). Never
   * throws — returns null when the record is absent or unreadable.
   */
  tryLoadWorkerFromDisk(workerId: string): Worker | null {
    return tryLoadWorkerFromDisk(this, workerId);
  }

  /** @internal — reached by the extracted state/* modules; not part of the supported API. */
  emit(event: StateChangeEvent) {
    if (this.emitter) {
      try {
        this.emitter(event);
      } catch (error) {
        logger.error({ error }, 'Error in state emitter');
      }
    }
    // Snapshot subscribers so a synchronous unsubscribe inside a handler
    // doesn't skip siblings.
    const subscribers = [...this.subscribers];
    for (const sub of subscribers) {
      // Skip subscribers that were removed during this dispatch.
      if (!this.subscribers.has(sub)) continue;
      try {
        sub(event);
        this.subscriberErrorCounts.delete(sub);
      } catch (error) {
        const consecutiveErrors = (this.subscriberErrorCounts.get(sub) ?? 0) + 1;
        this.subscriberErrorCounts.set(sub, consecutiveErrors);
        logger.error({ error, consecutiveErrors }, 'Error in subscriber');

        if (consecutiveErrors >= 3) {
          try {
            this.subscribers.delete(sub);
            this.subscriberErrorCounts.delete(sub);
            logger.warn({ consecutiveErrors }, 'Removed subscriber after repeated errors');
          } catch (removalError) {
            logger.error({ error: removalError }, 'Failed to remove broken subscriber');
          }
        }
      }
    }
  }

  async load(): Promise<void> {
    // Wrap the entire load operation with a timeout to prevent hangs on corrupted files
    const loadOperation = this.mutex.runExclusive(async () => {
      if (!fs.existsSync(this.moePath)) {
        throw new Error(`.moe folder not found at ${this.moePath}`);
      }

      // Verify write permissions before proceeding
      verifyWritePermissions(this.moePath);

      const projectFile = path.join(this.moePath, 'project.json');
      let rawProject = readJson<Record<string, unknown>>(projectFile);

      // Run migrations if needed
      const { data: migratedData, result: migrationResult } = runMigrations(rawProject);
      if (migrationResult.migrationsApplied.length > 0) {
        rawProject = migratedData;
        logger.info({
          from: migrationResult.fromVersion,
          to: migrationResult.toVersion,
          migrations: migrationResult.migrationsApplied
        }, 'Schema migrations applied');

        // Post-migration file system operations for v5 (chat support)
        if (migrationResult.fromVersion < 5) {
          migrateToV5FileSystem(this.moePath);
        }

        // Post-migration file system operations for v6 (role-based channels)
        if (migrationResult.fromVersion < 6) {
          migrateToV6FileSystem(this.moePath);
        }
      }

      const normalized = normalizeProject(this.projectPath, rawProject as Partial<Project>);
      this.project = normalized;
      this.applySettingsTimeouts(normalized);
      if (JSON.stringify(rawProject) !== JSON.stringify(normalized)) {
        try {
          atomicWriteJson(projectFile, normalized);
        } catch (error) {
          logger.error({ error, projectFile }, 'Failed to write normalized project.json');
        }
      }

      this.epics = loadEntities<Epic>(path.join(this.moePath, 'epics'));
      this.tasks = loadEntities<Task>(path.join(this.moePath, 'tasks'));
      // Backfill priority and comments for existing tasks
      for (const [id, task] of this.tasks) {
        const updates: Partial<Task> = {};
        if (!task.priority) updates.priority = 'MEDIUM' as TaskPriority;
        if (!Array.isArray(task.comments)) updates.comments = [];
        if (task.contextFetchedBy !== undefined && !Array.isArray(task.contextFetchedBy)) {
          updates.contextFetchedBy = [];
        }
        if (task.stepsCompleted !== undefined && !Array.isArray(task.stepsCompleted)) {
          updates.stepsCompleted = [];
        }
        if (Object.keys(updates).length > 0) {
          this.tasks.set(id, { ...task, ...updates });
        }
      }
      this.workers = loadEntities<Worker>(path.join(this.moePath, 'workers'));
      // Backfill teamId for workers that predate the teams feature
      for (const [id, worker] of this.workers) {
        if (worker.teamId === undefined) {
          this.workers.set(id, { ...worker, teamId: null });
        }
      }
      const orphanAssignedTasks = Array.from(this.tasks.values()).filter((task) => this.isTaskAssignedToMissingWorker(task));
      if (orphanAssignedTasks.length > 0) {
        logger.info(
          {
            count: orphanAssignedTasks.length,
            taskIds: orphanAssignedTasks.map((task) => task.id).slice(0, 20),
          },
          'Found task assignments for missing workers; treating them as claimable'
        );
      }
      this.teams = loadEntities<Team>(path.join(this.moePath, 'teams'));
      this.channels = loadEntities<ChatChannel>(path.join(this.moePath, 'channels'));
      // Self-heal chat infrastructure on EVERY load (not just on a schemaVersion
      // bump). A masked v5/v6 FS migration could persist the new schemaVersion
      // while leaving the channels/ dir or role channels missing — then chat is
      // permanently broken with the version already bumped so the migration never
      // reruns. This idempotently recreates missing dirs / canonical channels.
      ensureChatInfrastructure(this);
      this.decisions = loadEntities<Decision>(path.join(this.moePath, 'decisions'));
      this.proposals = loadEntities<RailProposal>(path.join(this.moePath, 'proposals'));
      this.resources = loadEntities<ResourceState>(path.join(this.moePath, 'resources'));
      try {
        await this.purgeResolvedProposals();
      } catch (error) {
        logger.error({ error }, 'Failed to purge resolved proposals during load');
      }

      // Initialize log rotator
      const activityLogPath = path.join(this.moePath, 'activity.log');
      this.logRotator = new LogRotator(activityLogPath);

      // Re-initialize MentionRouter with project-configured maxHops
      this.mentionRouter = new MentionRouter(this.project?.settings?.chatMaxAgentHops ?? 4);

    });

    await withTimeout(loadOperation, STATE_LOAD_TIMEOUT_MS, 'State load');

    // Arm the periodic sweeps OUTSIDE the locked section. Armed inside it,
    // the intervals inherit the mutex's AsyncLocalStorage "holding" context,
    // and every subsequent tick's runExclusive short-circuits as reentrant —
    // running the whole sweep unlocked and racing tool handlers (lost-update
    // windows: a sweep release clobbering a concurrent qa_approve, etc.).
    // The start* methods also arm detached (mutex.exit) as defense in depth.
    this.startBlockedTimeoutCheck();
    this.startProposalPurgeInterval();
    this.startStaleWorkerWatcher();
  }

  /**
   * Apply .moe/project.json settings.{staleWorkerTimeoutMs,reviewStaleTimeoutMs}
   * over the constructor defaults — but never over an EXPLICIT constructor
   * option (tests construct StateManager with specific timeouts and don't
   * expect a project.json's normalized defaults to override them).
   */
  private applySettingsTimeouts(project: Project): void {
    if (!this.staleWorkerTimeoutMsExplicit && typeof project.settings.staleWorkerTimeoutMs === 'number') {
      this.staleWorkerTimeoutMs = project.settings.staleWorkerTimeoutMs;
    }
    // reviewStaleTimeoutMs's constructor-time default chains off staleWorkerTimeoutMs
    // when neither is explicit. Preserve that chain here too — an explicit
    // staleWorkerTimeoutMs-only override (several tests do this) must not be
    // clobbered by the settings-derived reviewStaleTimeoutMs default.
    if (!this.reviewStaleTimeoutMsExplicit && !this.staleWorkerTimeoutMsExplicit
      && typeof project.settings.reviewStaleTimeoutMs === 'number') {
      this.reviewStaleTimeoutMs = project.settings.reviewStaleTimeoutMs;
    }
  }

  getSnapshot(): MoeStateSnapshot {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    const nowMs = Date.now();
    return {
      project: this.project,
      epics: sortByOrder(Array.from(this.epics.values())),
      tasks: sortByOrder(Array.from(this.tasks.values())),
      // DEAD workers are retained server-side (idempotent re-deregister + later
      // pruning) but never shown in the UI — exclude them from every snapshot.
      workers: Array.from(this.workers.values()).filter((w) => w.status !== 'DEAD'),
      proposals: Array.from(this.proposals.values()).filter(
        (proposal) => !isStaleResolvedProposal(proposal, PROPOSAL_SNAPSHOT_RETENTION_MS, nowMs)
      ),
      teams: Array.from(this.teams.values()),
      channels: Array.from(this.channels.values()).sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt)
      ),
      decisions: Array.from(this.decisions.values()).sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt)
      ),
      resources: Array.from(this.resources.values()).sort(
        (a, b) => a.id.localeCompare(b.id)
      )
    };
  }

  getStats(): { tasks: number; epics: number; workers: number; proposals: number } {
    return {
      tasks: this.tasks.size,
      epics: this.epics.size,
      // Exclude DEAD workers to match getSnapshot / list_workers (the UI never
      // shows them); they linger in the map only until the Layer-3 prune.
      workers: Array.from(this.workers.values()).filter((w) => w.status !== 'DEAD').length,
      proposals: this.proposals.size
    };
  }

  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId) || null;
  }

  getEpic(epicId: string): Epic | null {
    return this.epics.get(epicId) || null;
  }

  getWorker(workerId: string): Worker | null {
    return this.workers.get(workerId) || null;
  }

  // ---- Chat methods ----



  // ---- Pin methods ----

  // ---- Decision methods ----

  // ---- Team methods ----

  async createEpic(input: Partial<Epic>): Promise<Epic> {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    // Sanitize epic inputs
    const title = sanitizeString(input.title, 'epicTitle', 500, 'Untitled epic');
    const description = sanitizeString(input.description, 'epicDescription', 10000, '');
    const architectureNotes = sanitizeString(input.architectureNotes, 'architectureNotes', 50000, '');
    const epicRails = sanitizeStringArray(input.epicRails, 100, 1000);
    const validStatuses = ['PLANNED', 'ACTIVE', 'COMPLETED'] as const;
    const status = sanitizeEnum(input.status, validStatuses, 'PLANNED');

    const now = new Date().toISOString();
    const epic: Epic = {
      id: generateId('epic'),
      projectId: this.project.id,
      title,
      description,
      architectureNotes,
      epicRails,
      status,
      order: input.order ?? this.nextEpicOrder(),
      createdAt: now,
      updatedAt: now
    };

    await this.writeEntity('epics', epic.id, epic);
    this.epics.set(epic.id, epic);
    this.appendActivity('EPIC_CREATED', epicCreatedActivityPayload(epic), undefined, undefined, undefined, epic);
    this.emit({ type: 'EPIC_CREATED', payload: epic });

    return epic;
  }

  async updateEpic(epicId: string, updates: Partial<Epic>): Promise<Epic> {
    const epic = this.epics.get(epicId);
    if (!epic) {
      throw new Error(`Epic not found: ${epicId}`);
    }

    const sanitizedUpdates = validateEpicUpdates(updates);
    const updated: Epic = {
      ...epic,
      ...sanitizedUpdates,
      updatedAt: new Date().toISOString()
    };

    await this.writeEntity('epics', epicId, updated);
    this.epics.set(epicId, updated);
    this.appendActivity('EPIC_UPDATED', epicUpdatedActivityPayload(updated, sanitizedUpdates), undefined, undefined, undefined, updated);
    this.emit({ type: 'EPIC_UPDATED', payload: updated });
    return updated;
  }

  async updateSettings(settings: Partial<ProjectSettings>): Promise<Project> {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    const updatedSettings = validateSettingsUpdate(this.project, settings);

    const updatedProject: Project = {
      ...this.project,
      settings: updatedSettings,
      updatedAt: new Date().toISOString()
    };

    await atomicWriteJsonAsync(
      path.join(this.moePath, 'project.json'),
      updatedProject
    );
    this.project = updatedProject;
    this.emit({ type: 'SETTINGS_UPDATED', payload: updatedProject });
    return updatedProject;
  }

  async deleteEpic(epicId: string): Promise<Epic> {
    const epic = this.epics.get(epicId);
    if (!epic) {
      throw new Error(`Epic not found: ${epicId}`);
    }

    // Delete all tasks in this epic
    const tasksToDelete = Array.from(this.tasks.values()).filter((t) => t.epicId === epicId);
    for (const task of tasksToDelete) {
      await this.deleteTask(task.id);
    }

    // Delete epic file
    const filePath = path.join(this.moePath, 'epics', `${epicId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        // Suppress the watcher echo so our own delete doesn't re-trigger load().
        this.fileWatcher?.ignorePath(filePath);
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') {
        throw error;
      }
    }
    this.epics.delete(epicId);

    this.appendActivity('EPIC_DELETED' as ActivityEventType, { title: epic.title });
    this.emit({ type: 'EPIC_DELETED', payload: epic });
    return epic;
  }

  async createProposal(input: RailProposal): Promise<RailProposal> {
    await this.writeEntity('proposals', input.id, input);
    this.proposals.set(input.id, input);
    const task = this.tasks.get(input.taskId);
    this.appendActivity(
      'PROPOSAL_CREATED',
      input as unknown as Record<string, unknown>,
      task,
      undefined,
      input
    );
    this.emit({ type: 'PROPOSAL_CREATED', payload: input });
    return input;
  }

  async approveProposal(proposalId: string): Promise<RailProposal> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    const updated: RailProposal = {
      ...proposal,
      status: 'APPROVED',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'HUMAN'
    };

    await this.writeEntity('proposals', proposalId, updated);
    this.proposals.set(proposalId, updated);
    this.appendActivity(
      'PROPOSAL_APPROVED',
      { proposalType: updated.proposalType, targetScope: updated.targetScope, reason: updated.reason },
      this.tasks.get(updated.taskId),
      undefined,
      updated
    );
    this.emit({ type: 'PROPOSAL_UPDATED', payload: updated });

    try {
      await this.applyRailChange(updated);
    } catch (error) {
      logger.error({ error, proposalId }, 'Failed to apply rail change for approved proposal');
    }

    return updated;
  }

  private async applyRailChange(proposal: RailProposal): Promise<void> {
    const { proposalType, targetScope, currentValue, proposedValue, taskId } = proposal;

    if (targetScope === 'GLOBAL') {
      if (!this.project) throw new Error('Project not loaded');
      const rails = [...(this.project.globalRails.customRules || [])];

      if (proposalType === 'ADD_RAIL') {
        rails.push(proposedValue);
      } else if (proposalType === 'MODIFY_RAIL' && currentValue) {
        const idx = rails.indexOf(currentValue);
        if (idx !== -1) rails[idx] = proposedValue;
      } else if (proposalType === 'REMOVE_RAIL' && currentValue) {
        const idx = rails.indexOf(currentValue);
        if (idx !== -1) rails.splice(idx, 1);
      }

      this.project = {
        ...this.project,
        globalRails: { ...this.project.globalRails, customRules: rails },
        updatedAt: new Date().toISOString()
      };
      await atomicWriteJsonAsync(
        path.join(this.moePath, 'project.json'),
        this.project
      );
    } else if (targetScope === 'EPIC') {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      const epic = this.epics.get(task.epicId);
      if (!epic) throw new Error(`Epic not found: ${task.epicId}`);

      const rails = [...(epic.epicRails || [])];

      if (proposalType === 'ADD_RAIL') {
        rails.push(proposedValue);
      } else if (proposalType === 'MODIFY_RAIL' && currentValue) {
        const idx = rails.indexOf(currentValue);
        if (idx !== -1) rails[idx] = proposedValue;
      } else if (proposalType === 'REMOVE_RAIL' && currentValue) {
        const idx = rails.indexOf(currentValue);
        if (idx !== -1) rails.splice(idx, 1);
      }

      await this.updateEpic(epic.id, { epicRails: rails });
    } else if (targetScope === 'TASK') {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const rails = [...(task.taskRails || [])];

      if (proposalType === 'ADD_RAIL') {
        rails.push(proposedValue);
      } else if (proposalType === 'MODIFY_RAIL' && currentValue) {
        const idx = rails.indexOf(currentValue);
        if (idx !== -1) rails[idx] = proposedValue;
      } else if (proposalType === 'REMOVE_RAIL' && currentValue) {
        const idx = rails.indexOf(currentValue);
        if (idx !== -1) rails.splice(idx, 1);
      }

      await this.updateTask(taskId, { taskRails: rails });
    }
  }

  async rejectProposal(proposalId: string): Promise<RailProposal> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }

    const updated: RailProposal = {
      ...proposal,
      status: 'REJECTED',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'HUMAN'
    };

    await this.writeEntity('proposals', proposalId, updated);
    this.proposals.set(proposalId, updated);
    this.appendActivity(
      'PROPOSAL_REJECTED',
      { proposalType: updated.proposalType, targetScope: updated.targetScope, reason: updated.reason },
      this.tasks.get(updated.taskId),
      undefined,
      updated
    );
    this.emit({ type: 'PROPOSAL_UPDATED', payload: updated });
    return updated;
  }

  nextEpicOrder(): number {
    const epics = Array.from(this.epics.values());
    if (epics.length === 0) return 1;
    return Math.max(...epics.map((e) => e.order)) + 1;
  }
}
