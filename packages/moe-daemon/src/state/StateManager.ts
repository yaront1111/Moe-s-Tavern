// =============================================================================
// StateManager - loads and updates .moe state
// =============================================================================

import fs from 'fs';
import path from 'path';
import type {
  ActivityEvent,
  ActivityEventType,
  Epic,
  MoeStateSnapshot,
  Project,
  ProjectSettings,
  RailProposal,
  Task,
  TaskPriority,
  Worker
} from '../types/schema.js';
import { CURRENT_SCHEMA_VERSION, ACTIVITY_EVENT_TYPES } from '../types/schema.js';
import { generateId } from '../util/ids.js';
import { computeOrderBetween, sortByOrder } from '../util/order.js';
import { logger, createContextLogger } from '../util/logger.js';
import { runMigrations } from '../migrations/index.js';
import { LogRotator } from '../util/LogRotator.js';
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

// Configurable timeout for state load operations (default 30 seconds)
const STATE_LOAD_TIMEOUT_MS = parseInt(process.env.MOE_STATE_LOAD_TIMEOUT_MS || '30000', 10);

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
  | { type: 'WORKER_UPDATED'; payload: Worker }
  | { type: 'PROPOSAL_CREATED'; payload: RailProposal }
  | { type: 'PROPOSAL_UPDATED'; payload: RailProposal }
  | { type: 'SETTINGS_UPDATED'; payload: Project };

export interface StateManagerOptions {
  projectPath: string;
}

export class StateManager {
  readonly projectPath: string;
  readonly moePath: string;

  project: Project | null = null;
  epics = new Map<string, Epic>();
  tasks = new Map<string, Task>();
  workers = new Map<string, Worker>();
  proposals = new Map<string, RailProposal>();

  private emitter?: (event: StateChangeEvent) => void;
  private readonly mutex = new AsyncMutex();
  private readonly activityMutex = new AsyncMutex();
  private logRotator?: LogRotator;
  private pendingActivityWrites = 0;
  private activityFlushResolvers: Array<() => void> = [];

  constructor(options: StateManagerOptions) {
    this.projectPath = options.projectPath;
    this.moePath = path.join(this.projectPath, '.moe');
  }

  setEmitter(fn: (event: StateChangeEvent) => void) {
    this.emitter = fn;
  }

  /**
   * Clear the event emitter to prevent memory leaks during shutdown.
   */
  clearEmitter(): void {
    this.emitter = undefined;
  }

  /**
   * Check if the state manager has loaded project data.
   * Used for health checks.
   */
  isLoaded(): boolean {
    return this.project !== null;
  }

  /**
   * Wait for all pending activity log writes to complete.
   * Call this during shutdown to ensure no events are lost.
   */
  async flushActivityLog(): Promise<void> {
    if (this.pendingActivityWrites === 0) {
      return;
    }
    return new Promise((resolve) => {
      this.activityFlushResolvers.push(resolve);
    });
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
      }

      const normalized = this.normalizeProject(rawProject as Partial<Project>);
      this.project = normalized;
      if (JSON.stringify(rawProject) !== JSON.stringify(normalized)) {
        fs.writeFileSync(projectFile, JSON.stringify(normalized, null, 2));
      }

      this.epics = this.loadEntities<Epic>(path.join(this.moePath, 'epics'));
      this.tasks = this.loadEntities<Task>(path.join(this.moePath, 'tasks'));
      // Backfill priority for existing tasks that predate the priority field
      for (const [id, task] of this.tasks) {
        if (!task.priority) {
          this.tasks.set(id, { ...task, priority: 'MEDIUM' as TaskPriority });
        }
      }
      this.workers = this.loadEntities<Worker>(path.join(this.moePath, 'workers'));
      this.proposals = this.loadEntities<RailProposal>(path.join(this.moePath, 'proposals'));

      // Initialize log rotator
      const activityLogPath = path.join(this.moePath, 'activity.log');
      this.logRotator = new LogRotator(activityLogPath);
    });

    return withTimeout(loadOperation, STATE_LOAD_TIMEOUT_MS, 'State load');
  }

  getSnapshot(): MoeStateSnapshot {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    return {
      project: this.project,
      epics: sortByOrder(Array.from(this.epics.values())),
      tasks: sortByOrder(Array.from(this.tasks.values())),
      workers: Array.from(this.workers.values()),
      proposals: Array.from(this.proposals.values())
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
      implementationPlan: Array.isArray(input.implementationPlan) ? input.implementationPlan : [],
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
      createdAt: now,
      updatedAt: now
    };

    this.tasks.set(task.id, task);
    await this.writeEntity('tasks', task.id, task);
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

    this.epics.set(epic.id, epic);
    await this.writeEntity('epics', epic.id, epic);
    this.emit({ type: 'EPIC_CREATED', payload: epic });
    return epic;
  }

  async updateTask(taskId: string, updates: Partial<Task>, event?: ActivityEventType): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Clear assignedWorkerId on any status change so the appropriate role can claim it
    const statusChanged = updates.status !== undefined && updates.status !== task.status;
    const finalUpdates = statusChanged && updates.assignedWorkerId === undefined
      ? { ...updates, assignedWorkerId: null }
      : updates;

    const updated: Task = {
      ...task,
      ...finalUpdates,
      updatedAt: new Date().toISOString()
    };

    this.tasks.set(taskId, updated);
    await this.writeEntity('tasks', taskId, updated);
    if (event) {
      this.appendActivity(event, updates, updated);
    } else {
      this.appendActivity('TASK_UPDATED', updates, updated);
    }
    this.emit({ type: 'TASK_UPDATED', payload: updated });
    return updated;
  }

  async deleteTask(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    this.tasks.delete(taskId);
    const filePath = path.join(this.moePath, 'tasks', `${taskId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
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

    this.epics.set(epicId, updated);
    await this.writeEntity('epics', epicId, updated);
    this.emit({ type: 'EPIC_UPDATED', payload: updated });
    return updated;
  }

  async updateSettings(settings: Partial<ProjectSettings>): Promise<Project> {
    if (!this.project) {
      throw new Error('Project not loaded');
    }

    const updatedSettings: ProjectSettings = {
      ...this.project.settings,
      ...settings
    };

    const updatedProject: Project = {
      ...this.project,
      settings: updatedSettings,
      updatedAt: new Date().toISOString()
    };

    this.project = updatedProject;
    await fs.promises.writeFile(
      path.join(this.moePath, 'project.json'),
      JSON.stringify(updatedProject, null, 2)
    );
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

    // Remove epic from memory
    this.epics.delete(epicId);

    // Delete epic file
    const filePath = path.join(this.moePath, 'epics', `${epicId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

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
    const updated = await this.updateTask(taskId, { status: 'WORKING' }, 'PLAN_APPROVED');
    return updated;
  }

  async rejectTask(taskId: string, reason: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'AWAITING_APPROVAL') {
      throw new Error(`Cannot reject task in ${task.status} status, must be AWAITING_APPROVAL`);
    }
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

    this.workers.set(workerId, updated);
    await this.writeEntity('workers', workerId, updated);
    if (event) {
      this.appendActivity(event, updates, undefined, updated);
    }
    this.emit({ type: 'WORKER_UPDATED', payload: updated });
    return updated;
  }

  async createProposal(input: RailProposal): Promise<RailProposal> {
    this.proposals.set(input.id, input);
    await this.writeEntity('proposals', input.id, input);
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

    // Apply the rail change
    await this.applyRailChange(proposal);

    const updated: RailProposal = {
      ...proposal,
      status: 'APPROVED',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'HUMAN'
    };

    this.proposals.set(proposalId, updated);
    await this.writeEntity('proposals', proposalId, updated);
    this.emit({ type: 'PROPOSAL_UPDATED', payload: updated });
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

    this.proposals.set(proposalId, updated);
    await this.writeEntity('proposals', proposalId, updated);
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

    this.tasks.set(taskId, updated);
    await this.writeEntity('tasks', taskId, updated);
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

    // Fire-and-forget but serialized through mutex
    // We don't await here intentionally - activity logging shouldn't block operations
    // Track pending writes so we can flush on shutdown
    this.pendingActivityWrites++;
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
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n').filter((line) => line.trim());
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

      // Return in reverse chronological order, limited
      return events.reverse().slice(0, limit);
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
      } catch {
        // Ignore invalid files for now
      }
    }

    return map;
  }

  private readJson<T>(filePath: string): T {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
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
        agentCommand: sanitizeString(project.settings?.agentCommand, 'agentCommand', 256, 'claude')
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

    fs.writeFileSync(filePath, JSON.stringify(entity, null, 2));
  }
}
