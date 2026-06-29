// =============================================================================
// WebSocketServer - plugin + MCP proxy connections
// =============================================================================

import { WebSocketServer as WSS, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { StateManager, StateChangeEvent } from '../state/StateManager.js';
import { MAX_COMMENTS_PER_TASK } from '../state/StateManager.js';
import type { McpAdapter } from './McpAdapter.js';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { activeWaiters } from '../tools/waitForTask.js';
import { activeChatWaiters } from '../tools/chatWait.js';
import { MAX_TASK_COMMENT_LENGTH } from '../tools/addComment.js';
import {
  ACTIVITY_LOG_DEFAULT_MAX_PAYLOAD_CHARS,
  normalizeActivityLogParams,
  queryActivityLog,
} from '../tools/getActivityLog.js';
import {
  computeDashboardAggregate,
  filterTasksForMetrics,
} from '../util/metrics.js';
import { buildReopenClearingUpdates } from '../util/reopen.js';

// Identity / lifecycle fields a /ws plugin client must never set directly via
// UPDATE_TASK. The daemon owns these; legit board edits only ever touch
// status / order / title / description / definitionOfDone / priority. Stripping
// these closes the "unauthenticated client overwrites completedAt / metrics /
// reopenCount / step state" hole.
const UPDATE_TASK_DENYLIST: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'completedAt',
  'reviewStartedAt',
  'reviewCompletedAt',
  'planSubmittedAt',
  'planApprovedAt',
  'workStartedAt',
  'metrics',
  'reopenCount',
  'stepsCompleted',
  'contextFetchedBy',
  'priorHandoffs',
  'rejectionHistory',
  'rejectionDetails',
  'priorAttempt',
  'pendingPlanCritique',
  'planCritiqueResult',
  'budget',
]);

export type PluginMessage =
  | { type: 'PING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_ACTIVITY_LOG'; payload?: { limit?: number; offset?: number; maxPayloadChars?: number } }
  | { type: 'CREATE_TASK'; payload: Record<string, unknown> }
  | { type: 'UPDATE_TASK'; payload: { taskId: string; updates: Record<string, unknown> } }
  | { type: 'DELETE_TASK'; payload: { taskId: string } }
  | { type: 'CREATE_EPIC'; payload: Record<string, unknown> }
  | { type: 'UPDATE_EPIC'; payload: { epicId: string; updates: Record<string, unknown> } }
  | { type: 'DELETE_EPIC'; payload: { epicId: string } }
  | { type: 'REORDER_TASK'; payload: { taskId: string; beforeId: string | null; afterId: string | null } }
  | { type: 'APPROVE_TASK'; payload: { taskId: string } }
  | { type: 'REJECT_TASK'; payload: { taskId: string; reason: string } }
  | { type: 'REOPEN_TASK'; payload: { taskId: string; reason: string } }
  | { type: 'APPROVE_PROPOSAL'; payload: { proposalId: string } }
  | { type: 'REJECT_PROPOSAL'; payload: { proposalId: string } }
  | { type: 'UPDATE_SETTINGS'; payload: Record<string, unknown> }
  | { type: 'CREATE_TEAM'; payload: { name: string; role: string; maxSize?: number } }
  | { type: 'UPDATE_TEAM'; payload: { teamId: string; updates: Record<string, unknown> } }
  | { type: 'DELETE_TEAM'; payload: { teamId: string } }
  | { type: 'ADD_TEAM_MEMBER'; payload: { teamId: string; workerId: string } }
  | { type: 'REMOVE_TEAM_MEMBER'; payload: { teamId: string; workerId: string } }
  | { type: 'ARCHIVE_DONE_TASKS'; payload?: { epicId?: string } }
  | { type: 'ADD_TASK_COMMENT'; payload: { taskId: string; content: string; author?: string } }
  | { type: 'GET_CHANNELS' }
  | { type: 'GET_METRICS'; payload?: { epicId?: string; sinceIso?: string } }
  | {
      type: 'AGENT_TOOL_EVENT';
      payload: {
        workerId?: string;
        tool?: string;
        args?: unknown;
        result?: unknown;
        durationMs?: number;
      };
    }
  | { type: 'GET_MESSAGES'; payload: { channel: string; limit?: number; sinceId?: string } }
  | { type: 'SEND_MESSAGE'; payload: { channel: string; content: string } }
  | { type: 'GET_PINS'; payload: { channel: string } }
  | { type: 'PIN_MESSAGE'; payload: { channel: string; messageId: string } }
  | { type: 'UNPIN_MESSAGE'; payload: { channel: string; messageId: string } }
  | { type: 'TOGGLE_PIN_DONE'; payload: { channel: string; messageId: string } }
  | { type: 'GET_DECISIONS' }
  | { type: 'APPROVE_DECISION'; payload: { decisionId: string } }
  | { type: 'REJECT_DECISION'; payload: { decisionId: string } };

export class MoeWebSocketServer {
  private wss: WSS;
  private pluginClients = new Set<WebSocket>();
  private mcpClients = new Set<WebSocket>();
  private mcpWorkerMap = new Map<WebSocket, Set<string>>();
  // Ownership of parked wait_for_task / chat_wait waiters, keyed by workerId.
  // activeWaiters/activeChatWaiters are keyed globally by workerId, so a
  // short-lived second /mcp connection that reuses a parked id must NOT cancel
  // the live waiter the FIRST connection registered. We record which ws issued
  // the call that (re)registered each waiter and only cancel on disconnect when
  // the closing ws still owns it. Overwritten whenever a new wait/chat_wait call
  // re-registers the waiter (the tool itself cancels+replaces the prior entry).
  private waiterOwners = new Map<string, WebSocket>();
  private chatWaiterOwners = new Map<string, WebSocket>();
  private isClosed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    httpServer: HttpServer,
    private readonly state: StateManager,
    private readonly mcpAdapter: McpAdapter
  ) {
    // Cap incoming frame size to prevent memory exhaustion from malicious clients.
    // 2MB is generous for state snapshots and MCP tool args; activity log queries are paginated.
    this.wss = new WSS({ server: httpServer, maxPayload: 2 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.wss.on('error', (error) => {
      logger.error({ error }, 'WebSocket server error');
    });
  }

  /**
   * Check if the server has been closed.
   */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Safely send a message to a WebSocket client.
   * Checks readyState and handles errors gracefully.
   */
  private safeSend(ws: WebSocket, message: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      ws.send(message);
      return true;
    } catch {
      // Connection likely dropped - client will be cleaned up on close event
      return false;
    }
  }

  /**
   * Execute a state-mutating operation under the StateManager mutex.
   * Prevents races between plugin WS handlers and MCP tool handlers.
   */
  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    return this.state.runExclusive(fn);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = req.url || '/';
    if (url.startsWith('/mcp')) {
      this.mcpClients.add(ws);
      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMcpMessage(ws, data.toString()).catch((err) => {
          logger.error({ error: err, endpoint: 'mcp' }, 'Unhandled error in MCP message handler');
        });
      });
      ws.on('close', () => {
        this.mcpClients.delete(ws);
        this.cleanupMcpWorkers(ws).catch((err) => {
          logger.error({ error: err }, 'Error during MCP worker cleanup');
        });
      });
      ws.on('error', (error) => {
        logger.error({ error, endpoint: 'mcp' }, 'MCP client WebSocket error');
        this.mcpClients.delete(ws);
        this.cleanupMcpWorkers(ws).catch((err) => {
          logger.error({ error: err }, 'Error during MCP worker cleanup after WS error');
        });
      });
      return;
    }

    this.pluginClients.add(ws);
    this.sendStateSnapshot(ws);
    ws.on('message', (data: WebSocket.RawData) => {
      this.handlePluginMessage(ws, data.toString()).catch((err) => {
        logger.error({ error: err, endpoint: 'plugin' }, 'Unhandled error in plugin message handler');
      });
    });
    ws.on('close', () => this.pluginClients.delete(ws));
    ws.on('error', (error) => {
      logger.error({ error, endpoint: 'plugin' }, 'Plugin client WebSocket error');
      this.pluginClients.delete(ws);
    });
  }

  broadcast(event: StateChangeEvent): void {
    if (this.isClosed) {
      return;
    }
    const message = JSON.stringify(event);
    // Iterate over a copy to avoid issues if Set is modified during iteration
    const clients = Array.from(this.pluginClients);
    for (const client of clients) {
      this.safeSend(client, message);
    }
  }

  sendStateSnapshot(ws: WebSocket): void {
    const snapshot = this.state.getSnapshot();
    const filtered = {
      ...snapshot,
      tasks: snapshot.tasks.filter(t => t.status !== 'ARCHIVED'),
      epics: snapshot.epics.filter(e => e.status !== 'ARCHIVED'),
    };
    this.safeSend(ws, JSON.stringify({ type: 'STATE_SNAPSHOT', payload: filtered }));
  }

  private async handlePluginMessage(ws: WebSocket, raw: string): Promise<void> {
    let message: PluginMessage;
    try {
      message = JSON.parse(raw) as PluginMessage;
    } catch {
      this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
      return;
    }

    try {
      switch (message.type) {
        case 'PING':
          this.safeSend(ws, JSON.stringify({ type: 'PONG' }));
          return;
        case 'GET_STATE':
          this.sendStateSnapshot(ws);
          return;
        case 'GET_ACTIVITY_LOG': {
          const params = normalizeActivityLogParams(message.payload || {});
          // Plugin clients must always get a bounded payload; keep maxPayloadChars=0 as
          // an MCP-only full-content opt-in for backwards compatibility.
          if (params.maxPayloadChars === 0) {
            params.maxPayloadChars = ACTIVITY_LOG_DEFAULT_MAX_PAYLOAD_CHARS;
          }
          const { events } = queryActivityLog(this.state, params);
          this.safeSend(ws, JSON.stringify({ type: 'ACTIVITY_LOG', payload: events }));
          return;
        }
        case 'CREATE_TASK': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const task = await this.withMutex(() => this.state.createTask(message.payload as Record<string, unknown>));
          this.safeSend(ws, JSON.stringify({ type: 'TASK_CREATED', payload: task }));
          return;
        }
        case 'UPDATE_TASK': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { taskId, updates } = message.payload;
          if (!taskId || typeof taskId !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          // Strip identity/lifecycle fields the daemon owns — an unauthenticated
          // /ws client must not be able to overwrite completedAt / metrics /
          // reopenCount / step state via a board edit.
          let safeUpdates: Record<string, unknown> = {};
          if (updates && typeof updates === 'object') {
            const dropped: string[] = [];
            for (const [key, value] of Object.entries(updates as Record<string, unknown>)) {
              if (UPDATE_TASK_DENYLIST.has(key)) {
                dropped.push(key);
                continue;
              }
              safeUpdates[key] = value;
            }
            if (dropped.length > 0) {
              logger.debug({ taskId, dropped }, 'UPDATE_TASK: stripped daemon-owned fields from plugin updates');
            }
          }
          // Validation + update inside mutex to prevent TOCTOU race
          const task = await this.withMutex(async () => {
            if ('status' in safeUpdates) {
              const existing = this.state.getTask(taskId);
              if (existing) {
                // Keep in sync with VALID_TRANSITIONS in src/tools/setTaskStatus.ts.
                // ARCHIVED is reachable from resting statuses (BACKLOG / REVIEW / DONE).
                const VALID_TRANSITIONS: Record<string, string[]> = {
                  BACKLOG: ['PLANNING', 'WORKING', 'ARCHIVED'],
                  PLANNING: ['AWAITING_APPROVAL', 'BACKLOG'],
                  AWAITING_APPROVAL: ['WORKING', 'PLANNING'],
                  WORKING: ['REVIEW', 'PLANNING', 'BACKLOG'],
                  REVIEW: ['DONE', 'WORKING', 'BACKLOG', 'PLANNING', 'ARCHIVED'],
                  DONE: ['BACKLOG', 'WORKING', 'ARCHIVED'],
                  ARCHIVED: ['BACKLOG', 'WORKING']
                };
                const newStatus = safeUpdates.status as string;
                if (newStatus !== existing.status) {
                  const allowed = VALID_TRANSITIONS[existing.status];
                  if (!allowed || !allowed.includes(newStatus)) {
                    throw new Error(`Cannot move task from ${existing.status} to ${newStatus}. Allowed: ${allowed?.join(', ') || 'none'}`);
                  }
                  const columnLimits = this.state.project?.settings?.columnLimits;
                  if (columnLimits && typeof columnLimits[newStatus] === 'number') {
                    const limit = columnLimits[newStatus];
                    // Exclude ARCHIVED tasks from WIP counts — they're not in flight.
                    const currentCount = Array.from(this.state.tasks.values()).filter(t => t.status === newStatus && t.status !== 'ARCHIVED').length;
                    if (currentCount >= limit) {
                      throw new Error(`Column ${newStatus} is at its WIP limit of ${limit}`);
                    }
                  }
                  // Plan-approval route (e.g. JetBrains drag of an
                  // AWAITING_APPROVAL card into the Working column): this is a
                  // real plan approval, not a bare status flip. Delegate to the
                  // SAME state.approveTask the board's APPROVE_TASK button uses so
                  // it stamps planApprovedAt and records PLAN_APPROVED — a raw
                  // updateTask would silently lose both. A board drag is a human
                  // action, equivalent to clicking Approve.
                  if (existing.status === 'AWAITING_APPROVAL' && newStatus === 'WORKING') {
                    return this.state.approveTask(taskId);
                  }
                  // Reopen route (e.g. JetBrains drag DONE/REVIEW → WORKING):
                  // invalidate the prior completion via the SAME shared helper
                  // every other reopen path uses, so a reopened task carries no
                  // stale done-signals and can't be vacuously re-completed with
                  // every step still COMPLETED. The denylist above already
                  // stripped these fields from the client payload, so we own them.
                  const isReopening =
                    (existing.status === 'REVIEW' || existing.status === 'DONE' || existing.status === 'ARCHIVED') &&
                    (newStatus === 'WORKING' || newStatus === 'BACKLOG' || newStatus === 'PLANNING');
                  if (isReopening) {
                    // Record this as a TASK_REOPENED activity event (not a generic
                    // TASK_UPDATED) and stamp a reopenReason, mirroring every other
                    // reopen path. We deliberately do NOT call state.reopenTask:
                    // that helper forces the target to BACKLOG and rejects ARCHIVED,
                    // whereas a board drag keeps the dragged column
                    // (WORKING/BACKLOG/PLANNING) and supports ARCHIVED reopens.
                    const providedReason = safeUpdates.reopenReason;
                    safeUpdates = {
                      ...safeUpdates,
                      ...buildReopenClearingUpdates(existing),
                      reopenCount: existing.reopenCount + 1,
                      reopenReason:
                        typeof providedReason === 'string' && providedReason.trim().length > 0
                          ? providedReason
                          : 'Reopened from board',
                    };
                    return this.state.updateTask(taskId, safeUpdates, 'TASK_REOPENED');
                  }
                }
              }
            }
            return this.state.updateTask(taskId, safeUpdates);
          });
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'DELETE_TASK': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { taskId } = message.payload;
          if (!taskId || typeof taskId !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          const task = await this.withMutex(() => this.state.deleteTask(taskId));
          this.safeSend(ws, JSON.stringify({ type: 'TASK_DELETED', payload: task }));
          return;
        }
        case 'CREATE_EPIC': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const epic = await this.withMutex(() => this.state.createEpic(message.payload as Record<string, unknown>));
          this.safeSend(ws, JSON.stringify({ type: 'EPIC_CREATED', payload: epic }));
          return;
        }
        case 'UPDATE_EPIC': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { epicId, updates } = message.payload;
          if (!epicId || typeof epicId !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing epicId' }));
            return;
          }
          const epic = await this.withMutex(() => this.state.updateEpic(epicId, updates as Record<string, unknown>));
          this.safeSend(ws, JSON.stringify({ type: 'EPIC_UPDATED', payload: epic }));
          return;
        }
        case 'DELETE_EPIC': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { epicId } = message.payload;
          if (!epicId || typeof epicId !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing epicId' }));
            return;
          }
          const epic = await this.withMutex(() => this.state.deleteEpic(epicId));
          this.safeSend(ws, JSON.stringify({ type: 'EPIC_DELETED', payload: epic }));
          return;
        }
        case 'REORDER_TASK': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { taskId, beforeId, afterId } = message.payload;
          if (!taskId || typeof taskId !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          const task = await this.withMutex(() => this.state.reorderTask(taskId, beforeId, afterId));
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'APPROVE_TASK': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.taskId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          const task = await this.withMutex(() => this.state.approveTask(message.payload.taskId));
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'REJECT_TASK': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.taskId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          const reason = message.payload.reason;
          if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing or empty reason' }));
            return;
          }
          const task = await this.withMutex(() => this.state.rejectTask(message.payload.taskId, reason));
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'REOPEN_TASK': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.taskId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          const reopenReason = message.payload.reason;
          if (!reopenReason || typeof reopenReason !== 'string' || reopenReason.trim().length === 0) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing or empty reason' }));
            return;
          }
          const task = await this.withMutex(() => this.state.reopenTask(message.payload.taskId, reopenReason));
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'APPROVE_PROPOSAL': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.proposalId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing proposalId' }));
            return;
          }
          const proposal = await this.withMutex(() => this.state.approveProposal(message.payload.proposalId));
          this.safeSend(ws, JSON.stringify({ type: 'PROPOSAL_UPDATED', payload: proposal }));
          return;
        }
        case 'REJECT_PROPOSAL': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.proposalId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing proposalId' }));
            return;
          }
          const proposal = await this.withMutex(() => this.state.rejectProposal(message.payload.proposalId));
          this.safeSend(ws, JSON.stringify({ type: 'PROPOSAL_UPDATED', payload: proposal }));
          return;
        }
        case 'UPDATE_SETTINGS': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const project = await this.withMutex(() => this.state.updateSettings(message.payload as Record<string, unknown>));
          this.safeSend(ws, JSON.stringify({ type: 'SETTINGS_UPDATED', payload: project }));
          return;
        }
        case 'CREATE_TEAM': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const payload = message.payload as Record<string, unknown>;
          if (typeof payload.name !== 'string' || payload.name.trim().length === 0 || typeof payload.role !== 'string' || payload.role.trim().length === 0) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing name or role' }));
            return;
          }
          const team = await this.withMutex(() => this.state.createTeam(payload as { name: string; role: 'architect' | 'worker' | 'qa'; maxSize?: number }));
          this.safeSend(ws, JSON.stringify({ type: 'TEAM_CREATED', payload: team }));
          return;
        }
        case 'UPDATE_TEAM': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { teamId, updates } = message.payload as { teamId: string; updates: Record<string, unknown> };
          if (!teamId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing teamId' }));
            return;
          }
          const team = await this.withMutex(() => this.state.updateTeam(teamId, updates as Record<string, unknown>));
          this.safeSend(ws, JSON.stringify({ type: 'TEAM_UPDATED', payload: team }));
          return;
        }
        case 'DELETE_TEAM': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { teamId } = message.payload as { teamId: string };
          if (!teamId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing teamId' }));
            return;
          }
          const team = await this.withMutex(() => this.state.deleteTeam(teamId));
          this.safeSend(ws, JSON.stringify({ type: 'TEAM_DELETED', payload: team }));
          return;
        }
        case 'ADD_TEAM_MEMBER': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { teamId, workerId } = message.payload as { teamId: string; workerId: string };
          if (!teamId || !workerId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing teamId or workerId' }));
            return;
          }
          const team = await this.withMutex(() => this.state.addTeamMember(teamId, workerId));
          this.safeSend(ws, JSON.stringify({ type: 'TEAM_UPDATED', payload: team }));
          return;
        }
        case 'REMOVE_TEAM_MEMBER': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { teamId, workerId } = message.payload as { teamId: string; workerId: string };
          if (!teamId || !workerId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing teamId or workerId' }));
            return;
          }
          const team = await this.withMutex(() => this.state.removeTeamMember(teamId, workerId));
          this.safeSend(ws, JSON.stringify({ type: 'TEAM_UPDATED', payload: team }));
          return;
        }
        case 'ARCHIVE_DONE_TASKS': {
          const epicFilter = (message as { payload?: { epicId?: string } }).payload?.epicId;
          const archived = await this.withMutex(async () => {
            const snapshot = this.state.getSnapshot();
            const doneTasks = snapshot.tasks.filter(t =>
              t.status === 'DONE' && (!epicFilter || t.epicId === epicFilter)
            );
            let count = 0;
            for (const task of doneTasks) {
              try {
                await this.state.updateTask(task.id, { status: 'ARCHIVED' }, 'TASK_ARCHIVED');
                count++;
              } catch (err) {
                logger.error({ taskId: task.id, error: err }, 'Failed to archive task');
              }
            }
            return count;
          });
          this.safeSend(ws, JSON.stringify({ type: 'ARCHIVE_DONE_RESULT', payload: { archived } }));
          return;
        }
        case 'ADD_TASK_COMMENT': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { taskId, content, author } = message.payload as { taskId: string; content: string; author?: string };
          if (!taskId || typeof taskId !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          if (typeof content !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Comment content must be a string' }));
            return;
          }

          const trimmedContent = content.trim();
          if (trimmedContent.length === 0) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Comment content cannot be empty' }));
            return;
          }
          if (trimmedContent.length > MAX_TASK_COMMENT_LENGTH) {
            this.safeSend(ws, JSON.stringify({
              type: 'ERROR',
              message: `Comment content must be ${MAX_TASK_COMMENT_LENGTH} characters or fewer`
            }));
            return;
          }
          const task = await this.withMutex(async () => {
            const existing = this.state.getTask(taskId);
            if (!existing) {
              throw new Error(`Task not found: ${taskId}`);
            }
            const comment = {
              id: generateId('comment'),
              author: author || 'human',
              content: trimmedContent,
              timestamp: new Date().toISOString()
            };
            const existingComments = Array.isArray(existing.comments) ? existing.comments : [];
            const comments = [...existingComments, comment];
            const boundedComments = comments.length > MAX_COMMENTS_PER_TASK
              ? comments.slice(-MAX_COMMENTS_PER_TASK)
              : comments;
            const updates: Partial<import('../types/schema.js').Task> = { comments: boundedComments };
            if (comment.author === 'human') {
              updates.hasPendingQuestion = true;
            }
            return this.state.updateTask(taskId, updates, 'TASK_COMMENT_ADDED');
          });
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'GET_CHANNELS': {
          const channels = this.state.getChannels();
          this.safeSend(ws, JSON.stringify({ type: 'CHANNELS', payload: { channels } }));
          return;
        }
        case 'GET_METRICS': {
          const payload = (message.payload || {}) as { epicId?: string; sinceIso?: string };
          const epicId = typeof payload.epicId === 'string' && payload.epicId.length > 0 ? payload.epicId : undefined;
          const sinceIso = typeof payload.sinceIso === 'string' && payload.sinceIso.length > 0 ? payload.sinceIso : undefined;
          if (sinceIso && !Number.isFinite(Date.parse(sinceIso))) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'GET_METRICS sinceIso must be ISO 8601' }));
            return;
          }
          const filtered = filterTasksForMetrics(this.state.tasks.values(), { epicId, sinceIso });
          const aggregate = computeDashboardAggregate(filtered, (id) => this.state.getEpic(id)?.title);
          this.safeSend(ws, JSON.stringify({ type: 'METRICS', payload: aggregate }));
          return;
        }
        case 'AGENT_TOOL_EVENT': {
          const payload = (message.payload || {}) as {
            workerId?: string;
            tool?: string;
            args?: unknown;
            result?: unknown;
            durationMs?: number;
          };
          // Fire-and-forget telemetry from @moe/claude-plugin's PostToolUse hook.
          // Persisted to the activity log so the metrics tab can correlate later.
          const workerId = typeof payload.workerId === 'string' ? payload.workerId : 'unknown';
          const tool = typeof payload.tool === 'string' ? payload.tool : 'unknown';
          this.state.appendActivity('AGENT_TOOL_EVENT', {
            workerId,
            tool,
            durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
          });
          // Also fold into the worker's current task metrics so the Metrics
          // tab can render per-task tool counts. Worker may not have a
          // currentTaskId (idle / between claims) — silently drop in that case.
          const worker = workerId !== 'unknown' ? this.state.getWorker(workerId) : null;
          const taskId = worker?.currentTaskId;
          if (taskId) {
            // Read-modify-write of task.metrics MUST run under the state mutex —
            // updateTask is lock-free, so without this the fire-and-forget fold
            // races concurrent complete_step/complete_task/qa_* mutators on the
            // same task and loses the increment (lost update). withMutex is
            // reentrant and this handler is not already inside it, so no deadlock.
            this.withMutex(async () => {
              const task = this.state.getTask(taskId);
              if (!task) return;
              const priorMetrics = task.metrics ?? {};
              const breakdown: Record<string, number> = { ...(priorMetrics.agentToolBreakdown ?? {}) };
              breakdown[tool] = (breakdown[tool] ?? 0) + 1;
              await this.state.updateTask(taskId, {
                metrics: {
                  ...priorMetrics,
                  agentToolCallCount: (priorMetrics.agentToolCallCount ?? 0) + 1,
                  agentToolBreakdown: breakdown,
                },
              });
            }).catch((err) => {
              logger.debug({ err, taskId }, 'Failed to fold AGENT_TOOL_EVENT into task metrics');
            });
          }
          return;
        }
        case 'GET_MESSAGES': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { channel, limit, sinceId } = message.payload as { channel: string; limit?: number; sinceId?: string };
          if (!channel || typeof channel !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing channel' }));
            return;
          }
          const ch = this.state.getChannel(channel);
          if (!ch) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: `Channel not found: ${channel}` }));
            return;
          }
          const messages = await this.state.getMessages(channel, {
            sinceId: sinceId || undefined,
            limit: typeof limit === 'number' ? limit : 50
          });
          this.safeSend(ws, JSON.stringify({ type: 'MESSAGES', payload: { channel, messages } }));
          return;
        }
        case 'SEND_MESSAGE': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { channel, content } = message.payload as { channel: string; content: string };
          if (!channel || typeof channel !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing channel' }));
            return;
          }
          if (!content || typeof content !== 'string' || content.trim().length === 0) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing or empty content' }));
            return;
          }
          const { message: msg } = await this.state.sendMessage({ channel, sender: 'human', content });
          this.safeSend(ws, JSON.stringify({ type: 'MESSAGE_SENT', payload: { message: msg } }));
          return;
        }
        case 'GET_PINS': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { channel: pinChannel } = message.payload as { channel: string };
          if (!pinChannel || typeof pinChannel !== 'string') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing channel' }));
            return;
          }
          const pins = this.state.getPins(pinChannel);
          this.safeSend(ws, JSON.stringify({ type: 'PINS', payload: { channel: pinChannel, pins } }));
          return;
        }
        case 'PIN_MESSAGE': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { channel: pinCh, messageId: pinMsgId } = message.payload as { channel: string; messageId: string };
          if (!pinCh || !pinMsgId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing channel or messageId' }));
            return;
          }
          const pin = await this.state.pinMessage(pinCh, pinMsgId, 'human');
          this.safeSend(ws, JSON.stringify({ type: 'PIN_CREATED', payload: { channel: pinCh, pin } }));
          return;
        }
        case 'UNPIN_MESSAGE': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { channel: unpinCh, messageId: unpinMsgId } = message.payload as { channel: string; messageId: string };
          if (!unpinCh || !unpinMsgId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing channel or messageId' }));
            return;
          }
          await this.state.unpinMessage(unpinCh, unpinMsgId);
          this.safeSend(ws, JSON.stringify({ type: 'PIN_REMOVED', payload: { channel: unpinCh, messageId: unpinMsgId } }));
          return;
        }
        case 'TOGGLE_PIN_DONE': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { channel: toggleCh, messageId: toggleMsgId } = message.payload as { channel: string; messageId: string };
          if (!toggleCh || !toggleMsgId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing channel or messageId' }));
            return;
          }
          const toggledPin = await this.state.togglePinDone(toggleCh, toggleMsgId);
          this.safeSend(ws, JSON.stringify({ type: 'PIN_TOGGLED', payload: { channel: toggleCh, pin: toggledPin } }));
          return;
        }
        case 'GET_DECISIONS': {
          const decisions = this.state.getDecisions();
          this.safeSend(ws, JSON.stringify({ type: 'DECISIONS', payload: { decisions } }));
          return;
        }
        case 'APPROVE_DECISION': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { decisionId: approveDecId } = message.payload as { decisionId: string };
          if (!approveDecId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing decisionId' }));
            return;
          }
          const approved = await this.withMutex(() => this.state.approveDecision(approveDecId, 'human'));
          this.safeSend(ws, JSON.stringify({ type: 'DECISION_RESOLVED', payload: approved }));
          return;
        }
        case 'REJECT_DECISION': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { decisionId: rejectDecId } = message.payload as { decisionId: string };
          if (!rejectDecId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing decisionId' }));
            return;
          }
          const rejected = await this.withMutex(() => this.state.rejectDecision(rejectDecId));
          this.safeSend(ws, JSON.stringify({ type: 'DECISION_RESOLVED', payload: rejected }));
          return;
        }
        default:
          this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: `Unknown message type: ${(message as { type?: string }).type}` }));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Include context about which operation failed
      const context = {
        type: 'ERROR',
        message: errorMessage,
        operation: message.type,
        // Include IDs if available for debugging
        ...(('payload' in message && message.payload && typeof message.payload === 'object') && {
          context: {
            taskId: (message.payload as { taskId?: string }).taskId,
            epicId: (message.payload as { epicId?: string }).epicId
          }
        })
      };
      logger.error({ messageType: message.type, error }, 'WebSocket handler error');
      this.safeSend(ws, JSON.stringify(context));
    }
  }

  private async handleMcpMessage(ws: WebSocket, raw: string): Promise<void> {
    try {
      const request = JSON.parse(raw);
      this.trackMcpWorker(ws, request);
      const response = await this.mcpAdapter.handle(request, {
        shouldContinue: () => this.mcpClients.has(ws) && ws.readyState === WebSocket.OPEN,
      });
      if (response !== null) {
        this.safeSend(ws, JSON.stringify(response));
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Invalid MCP message';
      this.safeSend(
        ws,
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: messageText }
        })
      );
    }
  }

  /**
   * Track which MCP WebSocket connection owns which worker IDs.
   * Extracts workerId from tools/call request arguments.
   */
  private trackMcpWorker(ws: WebSocket, request: unknown): void {
    const requests = Array.isArray(request) ? request : [request];
    for (const item of requests) {
      this.trackSingleMcpWorker(ws, item);
    }
  }

  private trackSingleMcpWorker(ws: WebSocket, request: unknown): void {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return;
    const record = request as Record<string, unknown>;
    if (record.method !== 'tools/call') return;
    const params = record.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return;
    const args = (params as { arguments?: unknown }).arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    const workerId = (args as Record<string, unknown>).workerId;
    if (typeof workerId !== 'string') return;

    let workerIds = this.mcpWorkerMap.get(ws);
    if (!workerIds) {
      workerIds = new Set();
      this.mcpWorkerMap.set(ws, workerIds);
    }
    workerIds.add(workerId);

    // Record which ws owns the (about to be re-registered) waiter for this
    // workerId. wait_for_task / chat_wait cancel + replace any prior waiter for
    // the same id, so the issuing ws becomes the sole owner. cleanupMcpWorkers
    // uses this to avoid cancelling a live waiter that a different connection
    // owns when a short-lived ws reuses the same workerId.
    const toolName = (params as { name?: unknown }).name;
    if (toolName === 'moe.wait_for_task') {
      this.waiterOwners.set(workerId, ws);
    } else if (toolName === 'moe.chat_wait') {
      this.chatWaiterOwners.set(workerId, ws);
    }
  }

  /**
   * Clean up per-connection state for a disconnected MCP WebSocket.
   *
   * We deliberately do NOT delete the worker entity here. The proxy (moe-proxy)
   * is a stdio bridge that opens one WebSocket per RPC invocation for short-lived
   * callers (wrapper pre-flight, moe-call.sh, external scripts). Deleting the
   * worker on every disconnect would evaporate the worker — and its claim, via
   * deleteWorker's task cascade — milliseconds after it was created, causing
   * subsequent RPCs to fail with "Unknown sender" and clearing claims the
   * wrapper was about to hand off to a long-running agent.
   *
   * Stale workers from truly-disconnected agents should be cleaned up by a
   * presence/heartbeat mechanism (lastActivityAt timeout) rather than by
   * TCP close events, since TCP close no longer implies agent death.
   */
  private async cleanupMcpWorkers(ws: WebSocket): Promise<void> {
    const workerIds = this.mcpWorkerMap.get(ws);
    if (!workerIds || workerIds.size === 0) {
      this.mcpWorkerMap.delete(ws);
      return;
    }

    for (const workerId of workerIds) {
      // Cancel any active wait_for_task waiter registered on THIS ws. The map is
      // keyed globally by workerId, so guard on ownership: a live waiter another
      // connection registered (id reused by a short-lived second ws) must survive.
      if (this.waiterOwners.get(workerId) === ws) {
        const waiter = activeWaiters.get(workerId);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.unsubscribe();
          waiter.resolve({ hasNext: false, cancelled: true });
          activeWaiters.delete(workerId);
          logger.info({ workerId }, 'Cancelled active waiter for disconnected MCP client');
        }
        this.waiterOwners.delete(workerId);
      }

      // Cancel any active chat_wait waiter — same ownership guard.
      try {
        if (this.chatWaiterOwners.get(workerId) === ws) {
          const chatWaiter = activeChatWaiters.get(workerId);
          if (chatWaiter) {
            clearTimeout(chatWaiter.timer);
            chatWaiter.unsubscribe();
            chatWaiter.resolve({ hasMessage: false, cancelled: true });
            activeChatWaiters.delete(workerId);
            logger.info({ workerId }, 'Cancelled active chat waiter for disconnected MCP client');
          }
          this.chatWaiterOwners.delete(workerId);
        }
      } catch (err) {
        logger.warn({ workerId, err }, 'Error cleaning up chat waiter');
      }
    }

    this.mcpWorkerMap.delete(ws);
  }

  /**
   * Gracefully close the WebSocket server.
   * Returns a Promise that resolves when all connections are closed.
   */
  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.isClosed) {
      return;
    }

    // Send shutdown notification BEFORE marking as closed so all code paths still work
    if (this.pluginClients.size > 0) {
      const shuttingDownMessage = JSON.stringify({ type: 'DAEMON_SHUTTING_DOWN' });
      for (const client of this.pluginClients) {
        try {
          if (client.readyState === WebSocket.OPEN) {
            client.send(shuttingDownMessage);
          }
        } catch {
          // Client may already be disconnected — don't block shutdown
        }
      }
    }

    // Mark as closed to prevent new operations
    this.isClosed = true;

    this.closePromise = (async () => {
      // Brief delay to let shutdown messages flush
      if (this.pluginClients.size > 0) {
        await new Promise<void>((resolve) => {
          const delay = setTimeout(resolve, 100);
          if (delay.unref) {
            delay.unref();
          }
        });
      }

      // Close all client connections first
      let closeErrors = 0;
      for (const client of this.pluginClients) {
        try {
          client.close(1000, 'Server shutting down');
        } catch (error) {
          closeErrors += 1;
          logger.debug({ error }, 'Error closing plugin client during shutdown');
        }
      }
      for (const client of this.mcpClients) {
        try {
          client.close(1000, 'Server shutting down');
        } catch (error) {
          closeErrors += 1;
          logger.debug({ error }, 'Error closing MCP client during shutdown');
        }
      }
      if (closeErrors > 0) {
        logger.debug({ closeErrors }, 'WebSocket close errors during shutdown');
      }
      this.pluginClients.clear();
      this.mcpClients.clear();
      this.mcpWorkerMap.clear();
      this.waiterOwners.clear();
      this.chatWaiterOwners.clear();

      await new Promise<void>((resolve, reject) => {
        this.wss.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    })().finally(() => {
      this.closePromise = null;
    });

    await this.closePromise;
  }
}
