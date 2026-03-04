// =============================================================================
// StateManager - loads and updates .moe state
// =============================================================================

import fs from 'fs';
import path from 'path';
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
  StepStatus,
  Task,
  TaskComment,
  TaskPriority,
  Team,
  TeamRole,
  Worker
} from '../types/schema.js';
import { CURRENT_SCHEMA_VERSION, ACTIVITY_EVENT_TYPES } from '../types/schema.js';
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
  sanitizePattern,
  sanitizeStringArray,
  sanitizeBoolean,
  sanitizeEnum,
  sanitizeUrl,
  validateEntityId
} from '../util/sanitize.js';
import { readLastLines } from '../util/reverseReader.js';

// Configurable timeout for state load operations (default 30 seconds)
const STATE_LOAD_TIMEOUT_MS = parseInt(process.env.MOE_STATE_LOAD_TIMEOUT_MS || '30000', 10);
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const PROPOSAL_PURGE_AGE_MS = parseInt(process.env.MOE_PROPOSAL_PURGE_AGE_MS || `${7 * DAY_IN_MS}`, 10);
const PROPOSAL_PURGE_INTERVAL_MS = parseInt(process.env.MOE_PROPOSAL_PURGE_INTERVAL_MS || `${DAY_IN_MS}`, 10);
const PROPOSAL_SNAPSHOT_RETENTION_MS = parseInt(process.env.MOE_PROPOSAL_SNAPSHOT_RETENTION_MS || `${DAY_IN_MS}`, 10);
const MAX_COMMENTS_PER_TASK_DEFAULT = 200;
const MAX_COMMENTS_PER_TASK_ENV = parseInt(process.env.MOE_MAX_COMMENTS_PER_TASK || `${MAX_COMMENTS_PER_TASK_DEFAULT}`, 10);
export const MAX_COMMENTS_PER_TASK = Number.isFinite(MAX_COMMENTS_PER_TASK_ENV) && MAX_COMMENTS_PER_TASK_ENV > 0
  ? MAX_COMMENTS_PER_TASK_ENV
  : MAX_COMMENTS_PER_TASK_DEFAULT;

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
class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

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

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
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
  | { type: 'DECISION_RESOLVED'; payload: Decision };

type StateSubscriber = (event: StateChangeEvent) => void;

export interface StateManagerOptions {
  projectPath: string;
  blockedTimeoutMs?: number;
  staleWorkerTimeoutMs?: number;
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

  private emitter?: (event: StateChangeEvent) => void;
  private subscribers = new Set<StateSubscriber>();
  private subscriberErrorCounts = new Map<StateSubscriber, number>();
  private readonly mutex = new AsyncMutex();
  private readonly activityMutex = new AsyncMutex();
  private readonly messageMutexes = new Map<string, AsyncMutex>();
  private logRotator?: LogRotator;
  private pendingActivityWrites = 0;
  private activityFlushResolvers: Array<() => void> = [];
  private blockedTimeoutInterval?: NodeJS.Timeout;
  private proposalPurgeInterval?: NodeJS.Timeout;
  private readonly blockedTimeoutMs: number;
  private readonly staleWorkerTimeoutMs: number;
  private mentionRouter: MentionRouter;
  private fileWatcher?: import('./FileWatcher.js').FileWatcher;

  constructor(options: StateManagerOptions) {
    this.projectPath = options.projectPath;
    this.moePath = path.join(this.projectPath, '.moe');
    this.blockedTimeoutMs = options.blockedTimeoutMs ?? 3600000; // default 1 hour
    this.staleWorkerTimeoutMs = options.staleWorkerTimeoutMs ?? 1800000; // default 30 min
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
   * Check if the state manager has loaded project data.
   * Used for health checks.
   */
  isLoaded(): boolean {
    return this.project !== null;
  }

  /**
   * Start periodic check for blocked worker timeouts.
   * Runs every 5 minutes by default.
   */
  startBlockedTimeoutCheck(intervalMs = 300000): void {
    this.stopBlockedTimeoutCheck();
    this.blockedTimeoutInterval = setInterval(() => {
      this.checkBlockedTimeouts().catch((err) => {
        logger.error({ error: err }, 'Error checking blocked worker timeouts');
      });
    }, intervalMs);
    // Don't prevent process exit
    if (this.blockedTimeoutInterval.unref) {
      this.blockedTimeoutInterval.unref();
    }
  }

  /**
   * Stop the periodic blocked timeout check.
   */
  stopBlockedTimeoutCheck(): void {
    if (this.blockedTimeoutInterval) {
      clearInterval(this.blockedTimeoutInterval);
      this.blockedTimeoutInterval = undefined;
    }
  }

  /**
   * Start periodic purge of resolved proposals.
   * Runs every 24 hours by default.
   */
  startProposalPurgeInterval(intervalMs = PROPOSAL_PURGE_INTERVAL_MS): void {
    this.stopProposalPurgeInterval();
    this.proposalPurgeInterval = setInterval(() => {
      this.purgeResolvedProposals()
        .then((purgedCount) => {
          if (purgedCount > 0) {
            this.emit({ type: 'STATE_SNAPSHOT', payload: this.getSnapshot() });
          }
        })
        .catch((error) => {
          logger.error({ error }, 'Error purging resolved proposals');
        });
    }, intervalMs);

    // Don't prevent process exit
    if (this.proposalPurgeInterval.unref) {
      this.proposalPurgeInterval.unref();
    }
  }

  /**
   * Stop periodic resolved proposal purge.
   */
  stopProposalPurgeInterval(): void {
    if (this.proposalPurgeInterval) {
      clearInterval(this.proposalPurgeInterval);
      this.proposalPurgeInterval = undefined;
    }
  }

  /**
   * Scan workers with status=BLOCKED and auto-timeout if lastActivityAt exceeds threshold.
   */
  async checkBlockedTimeouts(): Promise<void> {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (worker.status !== 'BLOCKED') continue;

      const lastActivity = worker.lastActivityAt ? new Date(worker.lastActivityAt).getTime() : 0;
      if (isNaN(lastActivity) || lastActivity === 0) continue;

      if (now - lastActivity > this.blockedTimeoutMs) {
        logger.info({ workerId: worker.id, blockedSince: worker.lastActivityAt }, 'Auto-timing out blocked worker');

        await this.updateWorker(worker.id, {
          status: 'IDLE',
          lastError: null,
          currentTaskId: null,
        }, 'WORKER_TIMEOUT');
      }
    }

    // Layer 3: Sweep stale workers whose lastActivityAt exceeds threshold
    let deletedCount = 0;
    for (const worker of Array.from(this.workers.values())) {
      const lastActivity = worker.lastActivityAt ? new Date(worker.lastActivityAt).getTime() : 0;
      if (isNaN(lastActivity) || lastActivity === 0) continue;

      if (now - lastActivity > this.staleWorkerTimeoutMs) {
        logger.info({ workerId: worker.id, lastActivityAt: worker.lastActivityAt }, 'Deleting stale worker (exceeded timeout)');
        await this.deleteWorker(worker.id);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      this.emit({ type: 'STATE_SNAPSHOT', payload: this.getSnapshot() });
    }

    try {
      const staleWaitersCleaned = cleanupStaleWaiters(this);
      if (staleWaitersCleaned > 0) {
        logger.info({ staleWaitersCleaned }, 'Cleaned stale wait_for_task waiters');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to clean stale wait_for_task waiters');
    }
  }

  private isStaleResolvedProposal(proposal: RailProposal, ageMs: number, nowMs: number): boolean {
    if (proposal.status !== 'APPROVED' && proposal.status !== 'REJECTED') {
      return false;
    }

    if (!proposal.resolvedAt) {
      return false;
    }

    const resolvedAtMs = Date.parse(proposal.resolvedAt);
    if (Number.isNaN(resolvedAtMs)) {
      return false;
    }

    return nowMs - resolvedAtMs > ageMs;
  }

  async purgeResolvedProposals(nowMs = Date.now()): Promise<number> {
    let purgedCount = 0;
    const proposalEntries = Array.from(this.proposals.entries());

    for (const [proposalId, proposal] of proposalEntries) {
      if (!this.isStaleResolvedProposal(proposal, PROPOSAL_PURGE_AGE_MS, nowMs)) {
        continue;
      }

      const filePath = path.join(this.moePath, 'proposals', `${proposalId}.json`);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        const fsError = error as NodeJS.ErrnoException;
        if (fsError.code !== 'ENOENT') {
          logger.warn({ error, proposalId }, 'Failed to delete stale proposal file');
          continue;
        }
      }

      this.proposals.delete(proposalId);
      this.appendActivity('PROPOSAL_PURGED', {
        proposalId,
        status: proposal.status,
        resolvedAt: proposal.resolvedAt
      });
      purgedCount++;
    }

    return purgedCount;
  }

  /**
   * Wait for all pending activity log writes to complete.
   * Call this during shutdown to ensure no events are lost.
   */
  async flushActivityLog(): Promise<void> {
    if (this.pendingActivityWrites === 0) {
      return;
    }
    const FLUSH_TIMEOUT_MS = 5000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Safety timeout — don't block shutdown forever
        const idx = this.activityFlushResolvers.indexOf(resolve);
        if (idx >= 0) this.activityFlushResolvers.splice(idx, 1);
        logger.warn({ pending: this.pendingActivityWrites }, 'Activity log flush timed out');
        resolve();
      }, FLUSH_TIMEOUT_MS);
      this.activityFlushResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private getMessageMutex(channelId: string): AsyncMutex {
    let m = this.messageMutexes.get(channelId);
    if (!m) {
      m = new AsyncMutex();
      this.messageMutexes.set(channelId, m);
    }
    return m;
  }

  private notifyActivityFlushed(): void {
    if (this.pendingActivityWrites === 0) {
      const resolvers = this.activityFlushResolvers;
      this.activityFlushResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  private emit(event: StateChangeEvent) {
    if (this.emitter) {
      try {
        this.emitter(event);
      } catch (error) {
        logger.error({ error }, 'Error in state emitter');
      }
    }
    for (const sub of this.subscribers) {
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

  private trimComments(comments: TaskComment[] | null | undefined): TaskComment[] {
    if (!Array.isArray(comments) || comments.length === 0) {
      return [];
    }

    if (comments.length <= MAX_COMMENTS_PER_TASK) {
      return comments;
    }

    return comments.slice(-MAX_COMMENTS_PER_TASK);
  }

  private sanitizeImplementationPlan(plan: unknown): ImplementationStep[] {
    if (!Array.isArray(plan)) return [];
    const VALID_STEP_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'];
    const capped = plan.slice(0, 50);
    const result: ImplementationStep[] = [];
    for (const step of capped) {
      if (!step || typeof step !== 'object') continue;
      const s = step as Record<string, unknown>;
      if (!s.description || typeof s.description !== 'string') continue;
      result.push({
        stepId: typeof s.stepId === 'string' ? s.stepId : `step-${result.length + 1}`,
        description: s.description.slice(0, 5000),
        status: (typeof s.status === 'string' && VALID_STEP_STATUSES.includes(s.status) ? s.status : 'PENDING') as StepStatus,
        affectedFiles: Array.isArray(s.affectedFiles) ? (s.affectedFiles as string[]).filter(f => typeof f === 'string').slice(0, 50) : [],
        ...(s.modifiedFiles !== undefined ? { modifiedFiles: Array.isArray(s.modifiedFiles) ? (s.modifiedFiles as string[]).filter(f => typeof f === 'string').slice(0, 50) : [] } : {}),
        ...(typeof s.note === 'string' ? { note: s.note.slice(0, 5000) } : {}),
        ...(typeof s.startedAt === 'string' ? { startedAt: s.startedAt } : {}),
        ...(typeof s.completedAt === 'string' ? { completedAt: s.completedAt } : {}),
      });
    }
    return result;
  }

  async load(): Promise<void> {
    // Wrap the entire load operation with a timeout to prevent hangs on corrupted files
    const loadOperation = this.mutex.runExclusive(async () => {
      if (!fs.existsSync(this.moePath)) {
        throw new Error(`.moe folder not found at ${this.moePath}`);
      }

      // Verify write permissions before proceeding
      this.verifyWritePermissions();

      const projectFile = path.join(this.moePath, 'project.json');
      let rawProject = this.readJson<Record<string, unknown>>(projectFile);

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
          this.migrateToV5FileSystem();
        }

        // Post-migration file system operations for v6 (role-based channels)
        if (migrationResult.fromVersion < 6) {
          this.migrateToV6FileSystem();
        }
      }

      const normalized = this.normalizeProject(rawProject as Partial<Project>);
      this.project = normalized;
      if (JSON.stringify(rawProject) !== JSON.stringify(normalized)) {
        fs.writeFileSync(projectFile, JSON.stringify(normalized, null, 2));
      }

      this.epics = this.loadEntities<Epic>(path.join(this.moePath, 'epics'));
      this.tasks = this.loadEntities<Task>(path.join(this.moePath, 'tasks'));
      // Backfill priority and comments for existing tasks
      for (const [id, task] of this.tasks) {
        const updates: Partial<Task> = {};
        if (!task.priority) updates.priority = 'MEDIUM' as TaskPriority;
        if (!Array.isArray(task.comments)) updates.comments = [];
        if (Object.keys(updates).length > 0) {
          this.tasks.set(id, { ...task, ...updates });
        }
      }
      this.workers = this.loadEntities<Worker>(path.join(this.moePath, 'workers'));
      // Backfill teamId for workers that predate the teams feature
      for (const [id, worker] of this.workers) {
        if (worker.teamId === undefined) {
          this.workers.set(id, { ...worker, teamId: null });
        }
      }
      this.teams = this.loadEntities<Team>(path.join(this.moePath, 'teams'));
      this.channels = this.loadEntities<ChatChannel>(path.join(this.moePath, 'channels'));
      this.decisions = this.loadEntities<Decision>(path.join(this.moePath, 'decisions'));
      this.proposals = this.loadEntities<RailProposal>(path.join(this.moePath, 'proposals'));
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

      // Start periodic blocked worker timeout check
      this.startBlockedTimeoutCheck();
      this.startProposalPurgeInterval();
    });

    return withTimeout(loadOperation, STATE_LOAD_TIMEOUT_MS, 'State load');
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
      workers: Array.from(this.workers.values()),
      proposals: Array.from(this.proposals.values()).filter(
        (proposal) => !this.isStaleResolvedProposal(proposal, PROPOSAL_SNAPSHOT_RETENTION_MS, nowMs)
      ),
      teams: Array.from(this.teams.values()),
      channels: Array.from(this.channels.values()).sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt)
      ),
      decisions: Array.from(this.decisions.values()).sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt)
      )
    };
  }

  getStats(): { tasks: number; epics: number; workers: number; proposals: number } {
    return {
      tasks: this.tasks.size,
      epics: this.epics.size,
      workers: this.workers.size,
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

  /**
   * Get all workers that are currently assigned to tasks in a specific epic.
   */
  getWorkersByEpic(epicId: string): Worker[] {
    const workerIds = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.epicId === epicId && task.assignedWorkerId) {
        workerIds.add(task.assignedWorkerId);
      }
    }
    return Array.from(workerIds)
      .map((id) => this.workers.get(id))
      .filter((w): w is Worker => w !== undefined);
  }

  // ---- Chat methods ----

  getChannel(channelId: string): ChatChannel | null {
    return this.channels.get(channelId) || null;
  }

  getChannels(): ChatChannel[] {
    return Array.from(this.channels.values()).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt)
    );
  }



  async createChannel(opts: {
    name: string;
    type: ChatChannel['type'];
    linkedEntityId?: string;
  }): Promise<ChatChannel> {
    if (!this.project) throw new Error('Project not loaded');

    const name = opts.name?.trim();
    if (!name) throw new Error('Channel name is required');

    const validTypes = ['general', 'role', 'custom'] as const;
    if (!validTypes.includes(opts.type)) {
      throw new Error(`Invalid channel type: ${opts.type}`);
    }

    // Check for duplicate channels
    for (const existing of this.channels.values()) {
      if (existing.name === name && existing.type === opts.type) {
        throw new Error('Channel with this name and type already exists');
      }
    }

    const channel: ChatChannel = {
      id: generateId('chan'),
      name,
      type: opts.type,
      linkedEntityId: opts.linkedEntityId ?? null,
      createdAt: new Date().toISOString()
    };

    await this.writeEntity('channels', channel.id, channel);

    // Create empty messages JSONL file
    const messagesDir = path.join(this.moePath, 'messages');
    if (!fs.existsSync(messagesDir)) {
      fs.mkdirSync(messagesDir, { recursive: true });
    }
    const messagesFile = path.join(messagesDir, `${channel.id}.jsonl`);
    fs.writeFileSync(messagesFile, '');

    this.channels.set(channel.id, channel);
    this.emit({ type: 'CHANNEL_CREATED', payload: channel });
    this.appendActivity('CHANNEL_CREATED', { channelId: channel.id, name: channel.name, channelType: channel.type });

    return channel;
  }

  async sendMessage(opts: {
    channel: string;
    sender: string;
    content: string;
    replyTo?: string;
    decisionId?: string;
  }): Promise<{ message: ChatMessage; routingTargets: string[] }> {
    const channel = this.channels.get(opts.channel);
    if (!channel) throw new Error(`Channel not found: ${opts.channel}`);

    const content = opts.content;
    if (!content || typeof content !== 'string') {
      throw new Error('Message content is required');
    }
    if (Buffer.byteLength(content, 'utf-8') > 10240) {
      throw new Error('Message content exceeds 10KB limit');
    }

    // Parse raw @mentions from text content
    const rawMentions: string[] = [];
    const mentionRegex = /@(\w[\w-]*)/g;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(content)) !== null) {
      if (!rawMentions.includes(match[1])) {
        rawMentions.push(match[1]);
      }
    }

    // Compute routing targets via MentionRouter (expands @all, applies loop guards)
    let routingTargets: string[];
    try {
      const allWorkers = Array.from(this.workers.values());
      const allTeams = Array.from(this.teams.values());
      const tempMessage: ChatMessage = {
        id: '', channel: opts.channel, sender: opts.sender,
        content, replyTo: opts.replyTo ?? null, mentions: rawMentions, timestamp: ''
      };
      const routingResult = this.mentionRouter.route(tempMessage, allWorkers, allTeams);
      routingTargets = routingResult.targets;
    } catch {
      // Fall back to raw mentions on MentionRouter errors
      routingTargets = rawMentions;
    }

    const message: ChatMessage = {
      id: generateId('msg'),
      channel: opts.channel,
      sender: opts.sender,
      content,
      replyTo: opts.replyTo ?? null,
      mentions: rawMentions,
      timestamp: new Date().toISOString(),
      ...(opts.decisionId ? { decisionId: opts.decisionId } : {})
    };

    const messagesFile = path.join(this.moePath, 'messages', `${opts.channel}.jsonl`);
    const channelMutex = this.getMessageMutex(opts.channel);
    await channelMutex.runExclusive(async () => {
      try {
        fs.appendFileSync(messagesFile, JSON.stringify(message) + '\n');
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        throw new Error(`Failed to write message: ${err.message}`);
      }
    });

    this.emit({ type: 'MESSAGE_CREATED', payload: message, routingTargets });
    this.appendActivity('MESSAGE_CREATED', {
      channelId: opts.channel,
      messageId: message.id,
      sender: opts.sender
    });

    return { message, routingTargets };
  }

  async getMessages(
    channelId: string,
    opts?: { sinceId?: string; limit?: number }
  ): Promise<ChatMessage[]> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    const messagesFile = path.join(this.moePath, 'messages', `${channelId}.jsonl`);
    if (!fs.existsSync(messagesFile)) return [];

    let raw: string;
    try {
      raw = fs.readFileSync(messagesFile, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw error;
    }

    const lines = raw.split('\n').filter((line) => line.trim());
    const messages: ChatMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        logger.warn({ channelId, line: line.substring(0, 100) }, 'Skipping malformed message line');
      }
    }

    let result = messages;
    if (opts?.sinceId) {
      const idx = messages.findIndex((m) => m.id === opts.sinceId);
      if (idx >= 0) {
        result = messages.slice(idx + 1);
      } else {
        // Stale/invalid cursor — return empty so clients re-sync explicitly
        result = [];
      }
    }

    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    return result.slice(-limit);
  }

  /**
   * Check if a message exists in a channel's JSONL file.
   * Scans line-by-line and returns early on match.
   */
  messageExistsInChannel(channelId: string, messageId: string): boolean {
    const messagesFile = path.join(this.moePath, 'messages', `${channelId}.jsonl`);
    if (!fs.existsSync(messagesFile)) return false;

    let raw: string;
    try {
      raw = fs.readFileSync(messagesFile, 'utf-8');
    } catch {
      return false;
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as ChatMessage;
        if (msg.id === messageId) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  /**
   * Post a system message to the #general channel.
   * Silently skips if no general channel is found. Never throws.
   */
  async postSystemMessage(_entityId: string, content: string): Promise<void> {
    await this.postToGeneral(content);
  }

  /**
   * Post a system message to the 'general' channel. Never throws.
   */
  async postToGeneral(content: string): Promise<void> {
    try {
      let generalChannel: ChatChannel | null = null;
      for (const ch of this.channels.values()) {
        if (ch.type === 'general' || ch.name === 'general') {
          generalChannel = ch;
          break;
        }
      }
      if (!generalChannel) return;
      await this.sendMessage({ channel: generalChannel.id, sender: 'system', content });
    } catch (error) {
      logger.warn({ error }, 'Failed to post to general channel');
    }
  }

  async deleteChannel(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    // Remove channel JSON file
    const channelFile = path.join(this.moePath, 'channels', `${channelId}.json`);
    try {
      fs.unlinkSync(channelFile);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
    }

    // Remove messages JSONL file
    const messagesFile = path.join(this.moePath, 'messages', `${channelId}.jsonl`);
    try {
      fs.unlinkSync(messagesFile);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw error;
    }

    // Remove pins file for this channel
    const pinsFile = path.join(this.moePath, 'pins', `${channelId}.json`);
    try {
      if (fs.existsSync(pinsFile)) fs.unlinkSync(pinsFile);
    } catch {
      // Silently ignore if pins file doesn't exist
    }

    this.channels.delete(channelId);
    this.emit({ type: 'CHANNEL_DELETED', payload: channel });
    this.appendActivity('CHANNEL_DELETED', { channelId, name: channel.name });
  }

  // ---- Pin methods ----

  private getPinsFilePath(channelId: string): string {
    return path.join(this.moePath, 'pins', `${channelId}.json`);
  }

  private readPins(channelId: string): PinEntry[] {
    try {
      const filePath = this.getPinsFilePath(channelId);
      if (!fs.existsSync(filePath)) return [];
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as PinEntry[];
    } catch {
      return [];
    }
  }

  private writePins(channelId: string, pins: PinEntry[]): void {
    const pinsDir = path.join(this.moePath, 'pins');
    if (!fs.existsSync(pinsDir)) {
      fs.mkdirSync(pinsDir, { recursive: true });
    }
    fs.writeFileSync(this.getPinsFilePath(channelId), JSON.stringify(pins, null, 2));
  }

  getPins(channelId: string): PinEntry[] {
    return this.readPins(channelId);
  }

  async pinMessage(channelId: string, messageId: string, pinnedBy: string): Promise<PinEntry> {
    return this.mutex.runExclusive(async () => {
      const channel = this.channels.get(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      // Validate messageId exists in channel (scans full JSONL, no limit)
      if (!this.messageExistsInChannel(channelId, messageId)) {
        throw new Error(`Message not found in channel: ${messageId}`);
      }

      const pins = this.readPins(channelId);
      if (pins.some(p => p.messageId === messageId)) {
        throw new Error('Message already pinned');
      }

      const pin: PinEntry = {
        messageId,
        pinnedBy,
        pinnedAt: new Date().toISOString(),
        done: false,
        doneAt: null
      };
      pins.push(pin);
      this.writePins(channelId, pins);
      this.emit({ type: 'PINS_UPDATED', payload: { channel: channelId, pins } });
      this.appendActivity('PIN_CREATED', { channelId, messageId, pinnedBy });
      return pin;
    });
  }

  async unpinMessage(channelId: string, messageId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const channel = this.channels.get(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      const pins = this.readPins(channelId);
      const idx = pins.findIndex(p => p.messageId === messageId);
      if (idx === -1) throw new Error('Pin not found');

      pins.splice(idx, 1);
      this.writePins(channelId, pins);
      this.emit({ type: 'PINS_UPDATED', payload: { channel: channelId, pins } });
      this.appendActivity('PIN_REMOVED', { channelId, messageId });
    });
  }

  async togglePinDone(channelId: string, messageId: string): Promise<PinEntry> {
    return this.mutex.runExclusive(async () => {
      const channel = this.channels.get(channelId);
      if (!channel) throw new Error(`Channel not found: ${channelId}`);

      const pins = this.readPins(channelId);
      const pin = pins.find(p => p.messageId === messageId);
      if (!pin) throw new Error('Pin not found');

      pin.done = !pin.done;
      pin.doneAt = pin.done ? new Date().toISOString() : null;
      this.writePins(channelId, pins);
      this.emit({ type: 'PINS_UPDATED', payload: { channel: channelId, pins } });
      this.appendActivity('PIN_TOGGLED', { channelId, messageId, done: pin.done });
      return pin;
    });
  }

  // ---- Decision methods ----

  getDecision(id: string): Decision | null {
    return this.decisions.get(id) || null;
  }

  getDecisions(): Decision[] {
    return Array.from(this.decisions.values()).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt)
    );
  }

  async createDecision(opts: {
    content: string;
    proposedBy: string;
    channel?: string;
  }): Promise<Decision> {
    const content = sanitizeString(opts.content, 'content', 10240);
    if (!content) throw new Error('Decision content is required');

    const decision: Decision = {
      id: generateId('dec'),
      proposedBy: opts.proposedBy,
      content,
      status: 'proposed',
      approvedBy: null,
      channel: opts.channel ?? null,
      messageId: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };

    const decisionsDir = path.join(this.moePath, 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });
    const decisionFile = path.join(decisionsDir, `${decision.id}.json`);
    fs.writeFileSync(decisionFile, JSON.stringify(decision, null, 2));
    this.decisions.set(decision.id, decision);

    // Post a system message to the channel if provided
    if (opts.channel && this.channels.has(opts.channel)) {
      const { message: msg } = await this.sendMessage({
        channel: opts.channel,
        sender: opts.proposedBy,
        content: `[Decision Proposed] ${content}`,
        decisionId: decision.id
      });
      decision.messageId = msg.id;
      // Re-write with messageId linked
      fs.writeFileSync(decisionFile, JSON.stringify(decision, null, 2));
      this.decisions.set(decision.id, decision);
    }

    this.emit({ type: 'DECISION_PROPOSED', payload: decision });
    this.appendActivity('DECISION_PROPOSED', {
      decisionId: decision.id,
      proposedBy: decision.proposedBy,
      content: decision.content
    });

    return decision;
  }

  async approveDecision(id: string, approvedBy: string): Promise<Decision> {
    const decision = this.decisions.get(id);
    if (!decision) throw new Error(`Decision not found: ${id}`);
    if (decision.status !== 'proposed') throw new Error(`Decision is already ${decision.status}`);

    const updated: Decision = {
      ...decision,
      status: 'approved' as DecisionStatus,
      approvedBy,
      resolvedAt: new Date().toISOString()
    };

    const decisionFile = path.join(this.moePath, 'decisions', `${id}.json`);
    fs.writeFileSync(decisionFile, JSON.stringify(updated, null, 2));
    this.decisions.set(id, updated);

    this.emit({ type: 'DECISION_RESOLVED', payload: updated });
    this.appendActivity('DECISION_APPROVED', {
      decisionId: id,
      approvedBy
    });

    return updated;
  }

  async rejectDecision(id: string): Promise<Decision> {
    const decision = this.decisions.get(id);
    if (!decision) throw new Error(`Decision not found: ${id}`);
    if (decision.status !== 'proposed') throw new Error(`Decision is already ${decision.status}`);

    const updated: Decision = {
      ...decision,
      status: 'rejected' as DecisionStatus,
      resolvedAt: new Date().toISOString()
    };

    const decisionFile = path.join(this.moePath, 'decisions', `${id}.json`);
    fs.writeFileSync(decisionFile, JSON.stringify(updated, null, 2));
    this.decisions.set(id, updated);

    this.emit({ type: 'DECISION_RESOLVED', payload: updated });
    this.appendActivity('DECISION_REJECTED', {
      decisionId: id
    });

    return updated;
  }

  // ---- Team methods ----

  getTeam(teamId: string): Team | null {
    return this.teams.get(teamId) || null;
  }

  getTeamByNameAndRole(name: string, role: TeamRole): Team | null {
    for (const team of this.teams.values()) {
      if (team.name === name && team.role === role) return team;
    }
    return null;
  }

  getTeamByName(name: string): Team | null {
    for (const team of this.teams.values()) {
      if (team.name === name) return team;
    }
    return null;
  }

  getTeamForWorker(workerId: string): Team | null {
    const worker = this.workers.get(workerId);
    if (!worker?.teamId) return null;
    return this.teams.get(worker.teamId) || null;
  }

  async createTeam(input: { name: string; role?: TeamRole | null; maxSize?: number }): Promise<Team> {
    if (!this.project) throw new Error('Project not loaded');

    const now = new Date().toISOString();
    const team: Team = {
      id: generateId('team'),
      projectId: this.project.id,
      name: input.name,
      role: input.role ?? null,
      memberIds: [],
      maxSize: input.maxSize ?? 10,
      createdAt: now,
      updatedAt: now
    };

    await this.writeEntity('teams', team.id, team);
    this.teams.set(team.id, team);
    this.appendActivity('TEAM_CREATED', { name: team.name, role: team.role });
    this.emit({ type: 'TEAM_CREATED', payload: team });
    return team;
  }

  async updateTeam(teamId: string, updates: Partial<Team>): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const updated: Team = {
      ...team,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await this.writeEntity('teams', teamId, updated);
    this.teams.set(teamId, updated);
    this.appendActivity('TEAM_UPDATED', updates as Record<string, unknown>);
    this.emit({ type: 'TEAM_UPDATED', payload: updated });
    return updated;
  }

  async deleteTeam(teamId: string): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    // Clear teamId on all members
    for (const memberId of team.memberIds) {
      const worker = this.workers.get(memberId);
      if (worker) {
        await this.updateWorker(memberId, { teamId: null });
      }
    }

    const filePath = path.join(this.moePath, 'teams', `${teamId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') {
        throw error;
      }
    }
    this.teams.delete(teamId);

    this.appendActivity('TEAM_DELETED', { name: team.name });
    this.emit({ type: 'TEAM_DELETED', payload: team });
    return team;
  }

  async addTeamMember(teamId: string, workerId: string): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    if (team.memberIds.includes(workerId)) {
      return team; // Already a member, idempotent
    }

    if (team.memberIds.length >= team.maxSize) {
      throw new Error(`Team ${team.name} is full (max ${team.maxSize} members)`);
    }

    const updated = await this.updateTeam(teamId, {
      memberIds: [...team.memberIds, workerId]
    });

    // Set worker's teamId
    const worker = this.workers.get(workerId);
    if (worker) {
      await this.updateWorker(workerId, { teamId });
    }

    this.appendActivity('TEAM_MEMBER_ADDED', { teamId, workerId });
    return updated;
  }

  async removeTeamMember(teamId: string, workerId: string): Promise<Team> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    if (!team.memberIds.includes(workerId)) {
      return team; // Not a member, idempotent
    }

    const updated = await this.updateTeam(teamId, {
      memberIds: team.memberIds.filter((id) => id !== workerId)
    });

    // Clear worker's teamId
    const worker = this.workers.get(workerId);
    if (worker) {
      await this.updateWorker(workerId, { teamId: null });
    }

    this.appendActivity('TEAM_MEMBER_REMOVED', { teamId, workerId });
    return updated;
  }

  async createWorker(input: {
    id: string;
    type: Worker['type'];
    projectId: string;
    epicId: string;
    currentTaskId: string | null;
    status: Worker['status'];
  }): Promise<Worker> {
    // Validate worker doesn't already exist
    if (this.workers.has(input.id)) {
      throw new Error(`Worker already exists: ${input.id}`);
    }

    const now = new Date().toISOString();
    const worker: Worker = {
      id: input.id,
      type: input.type,
      projectId: input.projectId,
      epicId: input.epicId,
      currentTaskId: input.currentTaskId,
      status: input.status,
      branch: '',
      modifiedFiles: [],
      startedAt: now,
      lastActivityAt: now,
      lastError: null,
      errorCount: 0,
      teamId: null
    };

    await this.writeEntity('workers', worker.id, worker);
    this.workers.set(worker.id, worker);
    this.appendActivity('WORKER_CREATED', { workerId: worker.id, type: worker.type }, undefined, worker);
    this.emit({ type: 'WORKER_CREATED', payload: worker });
    return worker;
  }

  async createTask(input: Partial<Task>): Promise<Task> {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    if (!input.epicId) {
      throw new Error('epicId is required');
    }

    // Validate epicId exists
    if (!this.epics.has(input.epicId)) {
      throw new Error(`Epic not found: ${input.epicId}`);
    }

    // Validate and sanitize inputs using centralized sanitization
    const title = sanitizeString(input.title, 'title', 500, 'Untitled task');
    const description = sanitizeString(input.description, 'description', 10000, '');

    // Validate definitionOfDone using centralized sanitization
    let definitionOfDone = sanitizeStringArray(input.definitionOfDone, 50, 1000);
    if (definitionOfDone.length === 0) {
      definitionOfDone = ['Task completed as described'];
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: generateId('task'),
      epicId: input.epicId,
      title,
      description,
      definitionOfDone,
      taskRails: Array.isArray(input.taskRails) ? input.taskRails.slice(0, 100) : [],
      implementationPlan: this.sanitizeImplementationPlan(input.implementationPlan),
      status: input.status || 'BACKLOG',
      assignedWorkerId: input.assignedWorkerId || null,
      branch: input.branch || null,
      prLink: input.prLink || null,
      reopenCount: typeof input.reopenCount === 'number' ? Math.max(0, input.reopenCount) : 0,
      reopenReason: input.reopenReason || null,
      createdBy: input.createdBy === 'WORKER' ? 'WORKER' : 'HUMAN',
      parentTaskId: input.parentTaskId || null,
      priority: (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(input.priority as string) ? input.priority : 'MEDIUM') as TaskPriority,
      order: input.order ?? this.nextTaskOrder(input.epicId),
      comments: this.trimComments(Array.isArray(input.comments) ? input.comments : []),
      hasPendingQuestion: false,
      createdAt: now,
      updatedAt: now
    };

    await this.writeEntity('tasks', task.id, task);
    this.tasks.set(task.id, task);
    this.appendActivity('TASK_CREATED', { title: task.title }, task);
    this.emit({ type: 'TASK_CREATED', payload: task });

    return task;
  }

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
    this.emit({ type: 'EPIC_CREATED', payload: epic });

    return epic;
  }

  async updateTask(taskId: string, updates: Partial<Task>, event?: ActivityEventType): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Sanitize provided fields (B27)
    const sanitized: Partial<Task> = { ...updates };
    if (sanitized.title !== undefined) {
      sanitized.title = sanitizeString(sanitized.title, 'title', 500);
    }
    if (sanitized.description !== undefined) {
      sanitized.description = sanitizeString(sanitized.description, 'description', 10000);
    }
    if (sanitized.priority !== undefined) {
      if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(sanitized.priority)) {
        throw new Error(`Invalid priority: ${sanitized.priority}`);
      }
    }
    if (sanitized.reopenCount !== undefined) {
      if (typeof sanitized.reopenCount !== 'number' || sanitized.reopenCount < 0 || !Number.isInteger(sanitized.reopenCount)) {
        throw new Error('reopenCount must be a non-negative integer');
      }
    }
    if (sanitized.definitionOfDone !== undefined) {
      sanitized.definitionOfDone = sanitizeStringArray(sanitized.definitionOfDone, 50, 1000);
    }
    if (sanitized.implementationPlan !== undefined) {
      sanitized.implementationPlan = this.sanitizeImplementationPlan(sanitized.implementationPlan);
    }

    const hasCommentsUpdate = Object.prototype.hasOwnProperty.call(sanitized, 'comments');
    let normalizedUpdates: Partial<Task> = sanitized;
    if (hasCommentsUpdate) {
      const rawComments = (sanitized as Partial<Task> & { comments?: TaskComment[] | null }).comments;
      const rawCommentCount = Array.isArray(rawComments) ? rawComments.length : 0;
      const trimmedComments = this.trimComments(rawComments);
      if (rawCommentCount > trimmedComments.length) {
        logger.info(
          {
            taskId,
            rawCommentCount,
            trimmedCommentCount: trimmedComments.length,
            droppedCommentCount: rawCommentCount - trimmedComments.length,
            maxCommentsPerTask: MAX_COMMENTS_PER_TASK,
          },
          'Trimmed task comments to configured maximum'
        );
      }
      normalizedUpdates = { ...sanitized, comments: trimmedComments };
    }

    // Optimistic concurrency check: prevent double-assignment
    if (normalizedUpdates.assignedWorkerId && normalizedUpdates.assignedWorkerId !== task.assignedWorkerId) {
      // Re-read from in-memory map to catch races
      const freshTask = this.tasks.get(taskId);
      if (freshTask && freshTask.assignedWorkerId && freshTask.assignedWorkerId !== normalizedUpdates.assignedWorkerId) {
        throw new Error(`Task already assigned to ${freshTask.assignedWorkerId}`);
      }
    }

    // Only clear assignedWorkerId on transitions where a new role should claim the task (B29)
    const CLEAR_WORKER_STATUSES = new Set(['BACKLOG', 'PLANNING', 'ARCHIVED']);
    const statusChanged = normalizedUpdates.status !== undefined && normalizedUpdates.status !== task.status;
    const shouldClearWorker = statusChanged && CLEAR_WORKER_STATUSES.has(normalizedUpdates.status!) && normalizedUpdates.assignedWorkerId === undefined;
    const finalUpdates = shouldClearWorker
      ? { ...normalizedUpdates, assignedWorkerId: null }
      : normalizedUpdates;

    const updated: Task = {
      ...task,
      ...finalUpdates,
      updatedAt: new Date().toISOString()
    };

    await this.writeEntity('tasks', taskId, updated);
    this.tasks.set(taskId, updated);
    if (event) {
      this.appendActivity(event, updates, updated);
    } else {
      this.appendActivity('TASK_UPDATED', updates, updated);
    }
    this.emit({ type: 'TASK_UPDATED', payload: updated });

    // Post system message for status changes
    if (updates.status && updates.status !== task.status) {
      const actor = updated.assignedWorkerId || 'unknown';
      this.postSystemMessage(taskId, `Task moved to ${updates.status} by ${actor}`).catch(() => {});
    }

    return updated;
  }

  async deleteTask(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    try {
      cancelSpeedModeTimeout(taskId);
    } catch (error) {
      logger.warn({ taskId, error }, 'Failed to cancel speed mode timeout while deleting task');
    }

    const filePath = path.join(this.moePath, 'tasks', `${taskId}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') {
        throw error;
      }
    }

    this.tasks.delete(taskId);

    // Clear orphaned parentTaskId references (B30)
    for (const t of this.tasks.values()) {
      if (t.parentTaskId === taskId) {
        try {
          const updated = { ...t, parentTaskId: null, updatedAt: new Date().toISOString() };
          this.tasks.set(t.id, updated);
          await this.writeEntity('tasks', t.id, updated);
        } catch (error) {
          logger.warn({ taskId: t.id, parentTaskId: taskId, error }, 'Failed to clear orphaned parentTaskId');
        }
      }
    }

    for (const worker of this.workers.values()) {
      if (worker.currentTaskId === taskId) {
        await this.updateWorker(worker.id, { currentTaskId: null, status: 'IDLE' });
      }
    }

    this.appendActivity('TASK_DELETED', { title: task.title }, task);
    this.emit({ type: 'TASK_DELETED', payload: task });
    return task;
  }

  async updateEpic(epicId: string, updates: Partial<Epic>): Promise<Epic> {
    const epic = this.epics.get(epicId);
    if (!epic) {
      throw new Error(`Epic not found: ${epicId}`);
    }

    const updated: Epic = {
      ...epic,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await this.writeEntity('epics', epicId, updated);
    this.epics.set(epicId, updated);
    this.emit({ type: 'EPIC_UPDATED', payload: updated });
    return updated;
  }

  async updateSettings(settings: Partial<ProjectSettings>): Promise<Project> {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    // Sanitize columnLimits: merge with existing, validate values are positive integers
    let columnLimits = this.project.settings.columnLimits;
    if (settings.columnLimits !== undefined) {
      const incoming = settings.columnLimits || {};
      const merged: Record<string, number> = { ...(columnLimits || {}) };
      for (const [key, value] of Object.entries(incoming)) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid column limit for ${key}: must be a positive integer`);
        }
        merged[key] = value;
      }
      columnLimits = merged;
    }

    const updatedSettings: ProjectSettings = {
      ...this.project.settings,
      ...settings,
      columnLimits
    };

    const updatedProject: Project = {
      ...this.project,
      settings: updatedSettings,
      updatedAt: new Date().toISOString()
    };

    await fs.promises.writeFile(
      path.join(this.moePath, 'project.json'),
      JSON.stringify(updatedProject, null, 2)
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

  async approveTask(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'AWAITING_APPROVAL') {
      throw new Error(`Cannot approve task in ${task.status} status, must be AWAITING_APPROVAL`);
    }
    cancelSpeedModeTimeout(taskId);
    const updated = await this.updateTask(taskId, { status: 'WORKING', planApprovedAt: new Date().toISOString() }, 'PLAN_APPROVED');
    return updated;
  }

  async rejectTask(taskId: string, reason: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'AWAITING_APPROVAL') {
      throw new Error(`Cannot reject task in ${task.status} status, must be AWAITING_APPROVAL`);
    }
    cancelSpeedModeTimeout(taskId);
    const updated = await this.updateTask(
      taskId,
      { status: 'PLANNING', reopenReason: reason },
      'PLAN_REJECTED'
    );
    return updated;
  }

  async reopenTask(taskId: string, reason: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'DONE' && task.status !== 'REVIEW') {
      throw new Error(`Cannot reopen task in ${task.status} status, must be DONE or REVIEW`);
    }
    const updated = await this.updateTask(
      taskId,
      {
        status: 'BACKLOG',
        reopenCount: task.reopenCount + 1,
        reopenReason: reason
      },
      'TASK_REOPENED'
    );
    return updated;
  }

  async updateWorker(workerId: string, updates: Partial<Worker>, event?: ActivityEventType): Promise<Worker> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    const updated: Worker = {
      ...worker,
      ...updates,
      lastActivityAt: new Date().toISOString()
    };

    await this.writeEntity('workers', workerId, updated);
    this.workers.set(workerId, updated);
    if (event) {
      this.appendActivity(event, updates, undefined, updated);
    }
    this.emit({ type: 'WORKER_UPDATED', payload: updated });
    return updated;
  }

  /**
   * Atomically merge cursor updates into a worker's chatCursors.
   * Reads current cursors, merges, and writes back within the mutex.
   */
  async updateWorkerCursors(workerId: string, cursorUpdates: Record<string, string>): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const worker = this.workers.get(workerId);
      if (!worker) return; // Silently skip if worker doesn't exist

      const merged = { ...(worker.chatCursors || {}), ...cursorUpdates };
      const updated: Worker = {
        ...worker,
        chatCursors: merged,
        lastActivityAt: new Date().toISOString()
      };

      await this.writeEntity('workers', workerId, updated);
      this.workers.set(workerId, updated);
      this.emit({ type: 'WORKER_UPDATED', payload: updated });
    });
  }

  /**
   * Delete a worker: remove from memory, disk, clear references on tasks and teams.
   */
  async deleteWorker(workerId: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const worker = this.workers.get(workerId);
      if (!worker) return;

      // Remove from memory
      this.workers.delete(workerId);

      // Remove from disk
      const filePath = path.join(this.moePath, 'workers', `${workerId}.json`);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        logger.error({ error, workerId }, 'Failed to delete worker file');
      }

      // Clear assignedWorkerId on tasks referencing this worker (don't change task status)
      for (const task of this.tasks.values()) {
        if (task.assignedWorkerId === workerId) {
          const updated = { ...task, assignedWorkerId: null, updatedAt: new Date().toISOString() };
          this.tasks.set(task.id, updated);
          try {
            await this.writeEntity('tasks', task.id, updated);
          } catch (error) {
            logger.error({ error, taskId: task.id }, 'Failed to update task after worker deletion');
          }
        }
      }

      // Remove from team memberIds
      for (const team of this.teams.values()) {
        if (team.memberIds.includes(workerId)) {
          const updated = {
            ...team,
            memberIds: team.memberIds.filter((id) => id !== workerId),
            updatedAt: new Date().toISOString()
          };
          this.teams.set(team.id, updated);
          try {
            await this.writeEntity('teams', team.id, updated);
          } catch (error) {
            logger.error({ error, teamId: team.id }, 'Failed to update team after worker deletion');
          }
        }
      }

      this.appendActivity('WORKER_DISCONNECTED', { workerId: worker.id }, undefined, worker);
      this.emit({ type: 'WORKER_DELETED', payload: worker });
    });
  }

  /**
   * Purge all workers at startup. Since the daemon is (re)starting,
   * no workers are connected yet — all existing files are guaranteed stale.
   */
  async purgeAllWorkers(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const workersDir = path.join(this.moePath, 'workers');
      let deletedCount = 0;

      // Delete all worker files from disk
      try {
        if (fs.existsSync(workersDir)) {
          const files = fs.readdirSync(workersDir).filter((f) => f.endsWith('.json'));
          for (const file of files) {
            try {
              fs.unlinkSync(path.join(workersDir, file));
              deletedCount++;
            } catch (error) {
              logger.error({ error, file }, 'Failed to delete worker file during purge');
            }
          }
        }
      } catch (error) {
        logger.error({ error }, 'Failed to read workers directory during purge');
      }

      // Clear stale assignedWorkerId references on tasks
      const workerIds = new Set(Array.from(this.workers.keys()));
      if (workerIds.size > 0) {
        for (const task of this.tasks.values()) {
          if (task.assignedWorkerId && workerIds.has(task.assignedWorkerId)) {
            const updated = { ...task, assignedWorkerId: null, updatedAt: new Date().toISOString() };
            this.tasks.set(task.id, updated);
            try {
              await this.writeEntity('tasks', task.id, updated);
            } catch (error) {
              logger.error({ error, taskId: task.id }, 'Failed to clear task assignedWorkerId during purge');
            }
          }
        }

        // Clear stale memberIds from teams
        for (const team of this.teams.values()) {
          const cleanedMembers = team.memberIds.filter((id) => !workerIds.has(id));
          if (cleanedMembers.length !== team.memberIds.length) {
            const updated = { ...team, memberIds: cleanedMembers, updatedAt: new Date().toISOString() };
            this.teams.set(team.id, updated);
            try {
              await this.writeEntity('teams', team.id, updated);
            } catch (error) {
              logger.error({ error, teamId: team.id }, 'Failed to clear team memberIds during purge');
            }
          }
        }
      }

      // Clear workers map
      this.workers.clear();

      if (deletedCount > 0) {
        logger.info({ count: deletedCount }, 'Purged stale workers from previous run');
      }
    });
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
      await fs.promises.writeFile(
        path.join(this.moePath, 'project.json'),
        JSON.stringify(this.project, null, 2)
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
    this.emit({ type: 'PROPOSAL_UPDATED', payload: updated });
    return updated;
  }

  async reorderTask(taskId: string, beforeId: string | null, afterId: string | null): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const prev = beforeId ? this.getTask(beforeId)?.order ?? null : null;
    const next = afterId ? this.getTask(afterId)?.order ?? null : null;
    const order = computeOrderBetween(prev, next);
    const updated = { ...task, order, updatedAt: new Date().toISOString() };

    await this.writeEntity('tasks', taskId, updated);
    this.tasks.set(taskId, updated);
    this.appendActivity('TASK_UPDATED', { order }, updated);
    this.emit({ type: 'TASK_UPDATED', payload: updated });
    return updated;
  }

  nextTaskOrder(epicId: string): number {
    const tasks = Array.from(this.tasks.values()).filter((t) => t.epicId === epicId);
    if (tasks.length === 0) return 1;
    return Math.max(...tasks.map((t) => t.order)) + 1;
  }

  nextEpicOrder(): number {
    const epics = Array.from(this.epics.values());
    if (epics.length === 0) return 1;
    return Math.max(...epics.map((e) => e.order)) + 1;
  }

  /**
   * Append activity to the activity log.
   * This is fire-and-forget but uses mutex for ordering.
   */
  appendActivity(
    event: ActivityEventType,
    payload: Record<string, unknown>,
    task?: Task,
    worker?: Worker,
    proposal?: RailProposal
  ): void {
    // Track pending writes so flush can wait for all writes to complete
    this.pendingActivityWrites++;

    if (!this.project) {
      this.pendingActivityWrites--;
      this.notifyActivityFlushed();
      return;
    }

    const activity: ActivityEvent = {
      id: generateId('evt'),
      timestamp: new Date().toISOString(),
      projectId: this.project.id,
      epicId: task?.epicId,
      taskId: task?.id,
      workerId: worker?.id || proposal?.workerId,
      event,
      payload
    };

    const logPath = path.join(this.moePath, 'activity.log');
    const line = `${JSON.stringify(activity)}\n`;

    // Fire-and-forget but serialized through mutex
    // We don't await here intentionally - activity logging shouldn't block operations
    void this.activityMutex.runExclusive(async () => {
      try {
        // Rotate log if needed before appending
        if (this.logRotator) {
          await this.logRotator.rotateIfNeeded();
        }
        fs.appendFileSync(logPath, line, { flag: 'a' });
      } catch (error) {
        logger.error({ error }, 'Failed to append activity log');
      } finally {
        this.pendingActivityWrites--;
        this.notifyActivityFlushed();
      }
    });
  }

  /**
   * Append activity and wait for it to complete.
   * Use this when you need to ensure the activity is persisted before continuing.
   */
  async appendActivityAsync(
    event: ActivityEventType,
    payload: Record<string, unknown>,
    task?: Task,
    worker?: Worker,
    proposal?: RailProposal
  ): Promise<void> {
    if (!this.project) return;

    const activity: ActivityEvent = {
      id: generateId('evt'),
      timestamp: new Date().toISOString(),
      projectId: this.project.id,
      epicId: task?.epicId,
      taskId: task?.id,
      workerId: worker?.id || proposal?.workerId,
      event,
      payload
    };

    const logPath = path.join(this.moePath, 'activity.log');
    const line = `${JSON.stringify(activity)}\n`;

    await this.activityMutex.runExclusive(async () => {
      try {
        fs.appendFileSync(logPath, line, { flag: 'a' });
      } catch (error) {
        logger.error({ error }, 'Failed to append activity log');
      }
    });
  }

  /**
   * Validates that an object is a valid ActivityEvent.
   * Returns null if valid, or an error message if invalid.
   */
  private validateActivityEvent(obj: unknown): string | null {
    if (!obj || typeof obj !== 'object') {
      return 'Not an object';
    }
    const event = obj as Record<string, unknown>;

    // Check required string fields
    if (typeof event.id !== 'string' || !event.id) {
      return 'Missing or invalid id';
    }
    if (typeof event.timestamp !== 'string' || !event.timestamp) {
      return 'Missing or invalid timestamp';
    }
    if (typeof event.projectId !== 'string' || !event.projectId) {
      return 'Missing or invalid projectId';
    }

    // Check event type is valid
    if (typeof event.event !== 'string' || !ACTIVITY_EVENT_TYPES.includes(event.event as ActivityEventType)) {
      return `Invalid event type: ${event.event}`;
    }

    // Check payload is an object
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
      return 'Missing or invalid payload';
    }

    // Optional fields - validate type if present
    if (event.epicId !== undefined && typeof event.epicId !== 'string') {
      return 'Invalid epicId type';
    }
    if (event.taskId !== undefined && typeof event.taskId !== 'string') {
      return 'Invalid taskId type';
    }
    if (event.workerId !== undefined && typeof event.workerId !== 'string') {
      return 'Invalid workerId type';
    }

    return null;
  }

  /**
   * Read activity log entries.
   * Returns events in reverse chronological order (newest first).
   * Invalid entries are skipped with a warning log.
   */
  getActivityLog(limit = 100): ActivityEvent[] {
    const logPath = path.join(this.moePath, 'activity.log');
    if (!fs.existsSync(logPath)) {
      return [];
    }

    try {
      const safeLimit = Math.max(0, Math.trunc(limit));
      if (safeLimit === 0) {
        return [];
      }

      const lines = readLastLines(logPath, safeLimit);
      const events: ActivityEvent[] = [];
      let skippedCount = 0;

      for (const line of lines) {
        try {
          // Try to parse as JSON (new format)
          if (line.startsWith('{')) {
            const parsed = JSON.parse(line);
            const validationError = this.validateActivityEvent(parsed);
            if (validationError) {
              skippedCount++;
              logger.warn({ error: validationError, linePreview: line.substring(0, 100) }, 'Skipping invalid activity log entry');
              continue;
            }
            events.push(parsed as ActivityEvent);
          }
          // Skip old format lines for now
        } catch (parseError) {
          skippedCount++;
          logger.warn({ linePreview: line.substring(0, 50) }, 'Skipping malformed activity log entry');
        }
      }

      if (skippedCount > 0) {
        logger.info({ skippedCount, totalLines: lines.length }, 'Activity log parsing completed with skipped entries');
      }

      // readLastLines returns chronological order within the tail window.
      // Convert to reverse chronological order for API compatibility.
      return events.reverse().slice(0, safeLimit);
    } catch (error) {
      logger.error({ error }, 'Failed to read activity log');
      return [];
    }
  }

  private loadEntities<T>(dir: string): Map<string, T> {
    const map = new Map<string, T>();
    if (!fs.existsSync(dir)) return map;

    const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of entries) {
      const fullPath = path.join(dir, file);
      try {
        const entity = this.readJson<T>(fullPath);
        const id = (entity as { id?: string }).id;
        if (id) {
          map.set(id, entity);
        }
      } catch (error) {
        logger.warn({ error, file: fullPath }, 'Failed to load entity file, skipping');
      }
    }

    return map;
  }

  private readJson<T>(filePath: string): T {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  }

  /**
   * Post-migration file system setup for v5 (chat channels and messages).
   * Creates directories, default general channel, and backfills worker chatCursors.
   */
  private migrateToV5FileSystem(): void {
    // Create channels/ and messages/ directories
    try {
      fs.mkdirSync(path.join(this.moePath, 'channels'), { recursive: true });
      fs.mkdirSync(path.join(this.moePath, 'messages'), { recursive: true });
    } catch (error) {
      logger.warn({ error }, 'Failed to create chat directories during migration');
    }

    // Create default general channel if no channels exist yet
    const channelsDir = path.join(this.moePath, 'channels');
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
        fs.writeFileSync(
          path.join(channelsDir, `${channelId}.json`),
          JSON.stringify(generalChannel, null, 2)
        );
        // Create empty JSONL message file
        fs.writeFileSync(path.join(this.moePath, 'messages', `${channelId}.jsonl`), '');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to create general channel during migration');
    }


    // Backfill chatCursors on existing worker files
    const workersDir = path.join(this.moePath, 'workers');
    try {
      if (fs.existsSync(workersDir)) {
        const workerFiles = fs.readdirSync(workersDir).filter(f => f.endsWith('.json'));
        for (const file of workerFiles) {
          try {
            const filePath = path.join(workersDir, file);
            const worker = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!worker.chatCursors) {
              worker.chatCursors = {};
              fs.writeFileSync(filePath, JSON.stringify(worker, null, 2));
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
  private migrateToV6FileSystem(): void {
    const channelsDir = path.join(this.moePath, 'channels');
    const messagesDir = path.join(this.moePath, 'messages');

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

    for (const roleName of ['workers', 'architects', 'qa']) {
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
        fs.writeFileSync(path.join(channelsDir, `${channelId}.json`), JSON.stringify(channel, null, 2));
        fs.writeFileSync(path.join(messagesDir, `${channelId}.jsonl`), '');
      } catch (error) {
        logger.warn({ error, roleName }, 'Failed to create role channel during v6 migration');
      }
    }
  }

  /**
   * Verify that we have write permissions to the .moe directory.
   * Called during load() to fail fast if permissions are insufficient.
   */
  private verifyWritePermissions(): void {
    try {
      fs.accessSync(this.moePath, fs.constants.W_OK);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `Cannot write to .moe directory at ${this.moePath}. ` +
        `Please ensure the daemon process has write permissions. ` +
        `Details: ${errMsg}`
      );
    }
  }

  private normalizeProject(project: Partial<Project>): Project {
    const now = new Date().toISOString();

    // Validate approvalMode using centralized sanitization
    const validApprovalModes = ['CONTROL', 'SPEED', 'TURBO'] as const;
    const approvalMode = sanitizeEnum(project.settings?.approvalMode, validApprovalModes, 'CONTROL');

    return {
      id: project.id || generateId('proj'),
      schemaVersion: project.schemaVersion || CURRENT_SCHEMA_VERSION,
      name: sanitizeString(project.name, 'projectName', 256, path.basename(this.projectPath)),
      rootPath: project.rootPath || this.projectPath,
      globalRails: {
        techStack: sanitizeStringArray(project.globalRails?.techStack, 50, 256),
        forbiddenPatterns: sanitizeStringArray(project.globalRails?.forbiddenPatterns, 100, 1000),
        requiredPatterns: sanitizeStringArray(project.globalRails?.requiredPatterns, 100, 1000),
        formatting: sanitizeString(project.globalRails?.formatting, 'formatting', 10000, ''),
        testing: sanitizeString(project.globalRails?.testing, 'testing', 10000, ''),
        customRules: sanitizeStringArray(project.globalRails?.customRules, 100, 1000)
      },
      settings: {
        approvalMode,
        speedModeDelayMs: sanitizeNumber(project.settings?.speedModeDelayMs, 2000, 0, 60000),
        autoCreateBranch: sanitizeBoolean(project.settings?.autoCreateBranch, true),
        branchPattern: sanitizePattern(project.settings?.branchPattern, 'moe/{epicId}/{taskId}'),
        commitPattern: sanitizePattern(project.settings?.commitPattern, 'feat({epicId}): {taskTitle}'),
        agentCommand: sanitizeString(project.settings?.agentCommand, 'agentCommand', 256, 'claude'),
        enableAgentTeams: sanitizeBoolean(project.settings?.enableAgentTeams, false),
        columnLimits: project.settings?.columnLimits as Record<string, number> | undefined,
        chatEnabled: sanitizeBoolean(project.settings?.chatEnabled, true),
        chatMaxAgentHops: sanitizeNumber(project.settings?.chatMaxAgentHops, 4, 1, 20),
      },
      createdAt: project.createdAt || now,
      updatedAt: project.updatedAt || now
    };
  }

  private async writeEntity(kind: string, id: string, entity: unknown): Promise<void> {
    // Validate ID to prevent path traversal attacks using centralized validation
    validateEntityId(id);

    const dir = path.join(this.moePath, kind);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `${id}.json`);

    // Double-check the resolved path is within .moe directory
    const resolvedPath = path.resolve(filePath);
    const resolvedMoePath = path.resolve(this.moePath);
    if (!resolvedPath.startsWith(resolvedMoePath)) {
      throw new Error(`Path traversal detected: ${id}`);
    }

    if (this.fileWatcher) {
      this.fileWatcher.ignorePath(filePath);
    }
    fs.writeFileSync(filePath, JSON.stringify(entity, null, 2));
  }

  /**
   * Fallback: try loading a worker directly from disk when not found in memory.
   * Handles race conditions where the in-memory state hasn't reloaded yet.
   */
  tryLoadWorkerFromDisk(workerId: string): Worker | null {
    try {
      validateEntityId(workerId);
      const filePath = path.join(this.moePath, 'workers', `${workerId}.json`);
      if (fs.existsSync(filePath)) {
        const worker = this.readJson<Worker>(filePath);
        if (worker && worker.id) {
          this.workers.set(worker.id, worker);
          return worker;
        }
      }
    } catch {
      // Fall through to null
    }
    return null;
  }
}
