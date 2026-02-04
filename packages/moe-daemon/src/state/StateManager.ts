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
  RailProposal,
  Task,
  Worker
} from '../types/schema.js';
import { generateId } from '../util/ids.js';
import { computeOrderBetween, sortByOrder } from '../util/order.js';

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
  | { type: 'WORKER_UPDATED'; payload: Worker }
  | { type: 'PROPOSAL_CREATED'; payload: RailProposal }
  | { type: 'PROPOSAL_UPDATED'; payload: RailProposal };

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

  private emit(event: StateChangeEvent) {
    if (this.emitter) {
      try {
        this.emitter(event);
      } catch (error) {
        console.error('Error in state emitter:', error);
      }
    }
  }

  async load(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!fs.existsSync(this.moePath)) {
        throw new Error(`.moe folder not found at ${this.moePath}`);
      }

      const projectFile = path.join(this.moePath, 'project.json');
      const rawProject = this.readJson<Partial<Project>>(projectFile);
      const normalized = this.normalizeProject(rawProject);
      this.project = normalized;
      if (JSON.stringify(rawProject) !== JSON.stringify(normalized)) {
        fs.writeFileSync(projectFile, JSON.stringify(normalized, null, 2));
      }

      this.epics = this.loadEntities<Epic>(path.join(this.moePath, 'epics'));
      this.tasks = this.loadEntities<Task>(path.join(this.moePath, 'tasks'));
      this.workers = this.loadEntities<Worker>(path.join(this.moePath, 'workers'));
      this.proposals = this.loadEntities<RailProposal>(path.join(this.moePath, 'proposals'));
    });
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
   * Validates and truncates a string field to max length.
   */
  private validateStringField(value: string | undefined, fieldName: string, maxLength: number, defaultVal: string): string {
    if (!value || typeof value !== 'string') {
      return defaultVal;
    }
    if (value.length > maxLength) {
      console.warn(`${fieldName} truncated from ${value.length} to ${maxLength} chars`);
      return value.substring(0, maxLength);
    }
    return value;
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

    // Validate and sanitize inputs
    const title = this.validateStringField(input.title, 'title', 500, 'Untitled task');
    const description = this.validateStringField(input.description, 'description', 10000, '');

    // Validate definitionOfDone is a non-empty array of strings
    let definitionOfDone = input.definitionOfDone;
    if (!Array.isArray(definitionOfDone) || definitionOfDone.length === 0) {
      definitionOfDone = ['Task completed as described'];
    } else {
      // Filter to only strings and limit count
      definitionOfDone = definitionOfDone
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 50)
        .map((item) => item.substring(0, 1000));
      if (definitionOfDone.length === 0) {
        definitionOfDone = ['Task completed as described'];
      }
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

    const now = new Date().toISOString();
    const epic: Epic = {
      id: generateId('epic'),
      projectId: this.project.id,
      title: input.title || 'Untitled epic',
      description: input.description || '',
      architectureNotes: input.architectureNotes || '',
      epicRails: input.epicRails || [],
      status: input.status || 'PLANNED',
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

    const updated: Task = {
      ...task,
      ...updates,
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

  async approveTask(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const updated = await this.updateTask(taskId, { status: 'WORKING' }, 'PLAN_APPROVED');
    return updated;
  }

  async rejectTask(taskId: string, reason: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
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
    void this.activityMutex.runExclusive(async () => {
      try {
        fs.appendFileSync(logPath, line, { flag: 'a' });
      } catch (error) {
        console.error('Failed to append activity log:', error);
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
        console.error('Failed to append activity log:', error);
      }
    });
  }

  /**
   * Read activity log entries.
   * Returns events in reverse chronological order (newest first).
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

      for (const line of lines) {
        try {
          // Try to parse as JSON (new format)
          if (line.startsWith('{')) {
            const event = JSON.parse(line) as ActivityEvent;
            events.push(event);
          }
          // Skip old format lines for now
        } catch {
          // Skip invalid lines
        }
      }

      // Return in reverse chronological order, limited
      return events.reverse().slice(0, limit);
    } catch (error) {
      console.error('Failed to read activity log:', error);
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
   * Validates and clamps a numeric setting to valid bounds.
   */
  private clampNumber(value: number | undefined, defaultVal: number, min: number, max: number): number {
    if (value === undefined || typeof value !== 'number' || isNaN(value)) {
      return defaultVal;
    }
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Validates that a pattern string is safe (no shell injection).
   */
  private sanitizePattern(pattern: string | undefined, defaultVal: string): string {
    if (!pattern || typeof pattern !== 'string') {
      return defaultVal;
    }
    // Only allow safe template characters
    if (pattern.length > 256) {
      console.warn(`Pattern too long, using default: ${pattern.substring(0, 50)}...`);
      return defaultVal;
    }
    // Remove potentially dangerous characters (shell injection prevention)
    const sanitized = pattern.replace(/[`$(){}[\]|;&<>]/g, '');
    if (sanitized !== pattern) {
      console.warn(`Pattern sanitized: ${pattern} -> ${sanitized}`);
    }
    return sanitized || defaultVal;
  }

  private normalizeProject(project: Partial<Project>): Project {
    const now = new Date().toISOString();

    // Validate approvalMode
    const validApprovalModes = ['CONTROL', 'SPEED', 'TURBO'] as const;
    const approvalMode = validApprovalModes.includes(project.settings?.approvalMode as typeof validApprovalModes[number])
      ? project.settings!.approvalMode!
      : 'CONTROL';

    return {
      id: project.id || generateId('proj'),
      name: project.name || path.basename(this.projectPath),
      rootPath: project.rootPath || this.projectPath,
      globalRails: {
        techStack: Array.isArray(project.globalRails?.techStack) ? project.globalRails.techStack : [],
        forbiddenPatterns: Array.isArray(project.globalRails?.forbiddenPatterns) ? project.globalRails.forbiddenPatterns : [],
        requiredPatterns: Array.isArray(project.globalRails?.requiredPatterns) ? project.globalRails.requiredPatterns : [],
        formatting: typeof project.globalRails?.formatting === 'string' ? project.globalRails.formatting : '',
        testing: typeof project.globalRails?.testing === 'string' ? project.globalRails.testing : '',
        customRules: Array.isArray(project.globalRails?.customRules) ? project.globalRails.customRules : []
      },
      settings: {
        approvalMode,
        speedModeDelayMs: this.clampNumber(project.settings?.speedModeDelayMs, 2000, 0, 60000),
        autoCreateBranch: project.settings?.autoCreateBranch ?? true,
        branchPattern: this.sanitizePattern(project.settings?.branchPattern, 'moe/{epicId}/{taskId}'),
        commitPattern: this.sanitizePattern(project.settings?.commitPattern, 'feat({epicId}): {taskTitle}')
      },
      createdAt: project.createdAt || now,
      updatedAt: project.updatedAt || now
    };
  }

  /**
   * Validates that an entity ID is safe (no path traversal).
   * IDs should only contain alphanumeric characters, hyphens, and underscores.
   */
  private validateEntityId(id: string): void {
    if (!id || typeof id !== 'string') {
      throw new Error('Entity ID is required');
    }
    // Only allow safe characters: alphanumeric, hyphen, underscore
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid entity ID: ${id}. IDs must contain only alphanumeric characters, hyphens, and underscores.`);
    }
    // Prevent overly long IDs
    if (id.length > 128) {
      throw new Error(`Entity ID too long: ${id.length} chars (max 128)`);
    }
  }

  private async writeEntity(kind: string, id: string, entity: unknown): Promise<void> {
    // Validate ID to prevent path traversal attacks
    this.validateEntityId(id);

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
