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
import { MAX_TASK_COMMENT_LENGTH } from '../tools/addComment.js';

export type PluginMessage =
  | { type: 'PING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_ACTIVITY_LOG'; payload?: { limit?: number } }
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
  | { type: 'ADD_TASK_COMMENT'; payload: { taskId: string; content: string; author?: string } };

export class MoeWebSocketServer {
  private wss: WSS;
  private pluginClients = new Set<WebSocket>();
  private mcpClients = new Set<WebSocket>();
  private mcpWorkerMap = new Map<WebSocket, Set<string>>();
  private isClosed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    httpServer: HttpServer,
    private readonly state: StateManager,
    private readonly mcpAdapter: McpAdapter
  ) {
    this.wss = new WSS({ server: httpServer });
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

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = req.url || '/';
    if (url.startsWith('/mcp')) {
      this.mcpClients.add(ws);
      ws.on('message', (data: WebSocket.RawData) => this.handleMcpMessage(ws, data.toString()));
      ws.on('close', () => {
        this.mcpClients.delete(ws);
        this.cleanupMcpWorkers(ws);
      });
      ws.on('error', (error) => {
        logger.error({ error, endpoint: 'mcp' }, 'MCP client WebSocket error');
        this.mcpClients.delete(ws);
        this.cleanupMcpWorkers(ws);
      });
      return;
    }

    this.pluginClients.add(ws);
    this.sendStateSnapshot(ws);
    ws.on('message', (data: WebSocket.RawData) => this.handlePluginMessage(ws, data.toString()));
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
    const filtered = { ...snapshot, tasks: snapshot.tasks.filter(t => t.status !== 'ARCHIVED') };
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
          const limit = (message.payload as { limit?: number })?.limit ?? 100;
          const events = this.state.getActivityLog(limit);
          this.safeSend(ws, JSON.stringify({ type: 'ACTIVITY_LOG', payload: events }));
          return;
        }
        case 'CREATE_TASK': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const task = await this.state.createTask(message.payload as Record<string, unknown>);
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
          // Validate status transitions when status is being changed
          if (updates && typeof updates === 'object' && 'status' in updates) {
            const existing = this.state.getTask(taskId);
            if (existing) {
              const VALID_TRANSITIONS: Record<string, string[]> = {
                BACKLOG: ['PLANNING', 'WORKING'],
                PLANNING: ['AWAITING_APPROVAL', 'BACKLOG'],
                AWAITING_APPROVAL: ['WORKING', 'PLANNING'],
                WORKING: ['REVIEW', 'PLANNING', 'BACKLOG'],
                REVIEW: ['DONE', 'WORKING', 'BACKLOG'],
                DONE: ['BACKLOG', 'WORKING', 'ARCHIVED'],
                ARCHIVED: ['BACKLOG', 'WORKING']
              };
              const newStatus = (updates as { status: string }).status;
              if (newStatus !== existing.status) {
                const allowed = VALID_TRANSITIONS[existing.status];
                if (!allowed || !allowed.includes(newStatus)) {
                  this.safeSend(ws, JSON.stringify({
                    type: 'ERROR',
                    message: `Cannot move task from ${existing.status} to ${newStatus}. Allowed: ${allowed?.join(', ') || 'none'}`,
                    operation: 'UPDATE_TASK'
                  }));
                  return;
                }
                // Enforce WIP column limits
                const columnLimits = this.state.project?.settings?.columnLimits;
                if (columnLimits && typeof columnLimits[newStatus] === 'number') {
                  const limit = columnLimits[newStatus];
                  const currentCount = Array.from(this.state.tasks.values()).filter(t => t.status === newStatus).length;
                  if (currentCount >= limit) {
                    this.safeSend(ws, JSON.stringify({
                      type: 'ERROR',
                      message: `Column ${newStatus} is at its WIP limit of ${limit}`,
                      operation: 'UPDATE_TASK'
                    }));
                    return;
                  }
                }
              }
            }
          }
          const task = await this.state.updateTask(taskId, updates as Record<string, unknown>);
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
          const task = await this.state.deleteTask(taskId);
          this.safeSend(ws, JSON.stringify({ type: 'TASK_DELETED', payload: task }));
          return;
        }
        case 'CREATE_EPIC': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const epic = await this.state.createEpic(message.payload as Record<string, unknown>);
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
          const epic = await this.state.updateEpic(epicId, updates as Record<string, unknown>);
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
          const epic = await this.state.deleteEpic(epicId);
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
          const task = await this.state.reorderTask(taskId, beforeId, afterId);
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'APPROVE_TASK': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.taskId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing taskId' }));
            return;
          }
          const task = await this.state.approveTask(message.payload.taskId);
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
          const task = await this.state.rejectTask(message.payload.taskId, reason);
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
          const task = await this.state.reopenTask(message.payload.taskId, reopenReason);
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
          return;
        }
        case 'APPROVE_PROPOSAL': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.proposalId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing proposalId' }));
            return;
          }
          const proposal = await this.state.approveProposal(message.payload.proposalId);
          this.safeSend(ws, JSON.stringify({ type: 'PROPOSAL_UPDATED', payload: proposal }));
          return;
        }
        case 'REJECT_PROPOSAL': {
          if (!message.payload || typeof message.payload !== 'object' || !message.payload.proposalId) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing proposalId' }));
            return;
          }
          const proposal = await this.state.rejectProposal(message.payload.proposalId);
          this.safeSend(ws, JSON.stringify({ type: 'PROPOSAL_UPDATED', payload: proposal }));
          return;
        }
        case 'UPDATE_SETTINGS': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const project = await this.state.updateSettings(message.payload as Record<string, unknown>);
          this.safeSend(ws, JSON.stringify({ type: 'SETTINGS_UPDATED', payload: project }));
          return;
        }
        case 'CREATE_TEAM': {
          if (!message.payload || typeof message.payload !== 'object') {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing payload' }));
            return;
          }
          const { name, role, maxSize } = message.payload as { name: string; role: string; maxSize?: number };
          if (!name || !role) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: 'Missing name or role' }));
            return;
          }
          const team = await this.state.createTeam({ name, role: role as 'architect' | 'worker' | 'qa', maxSize });
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
          const team = await this.state.updateTeam(teamId, updates as Record<string, unknown>);
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
          const team = await this.state.deleteTeam(teamId);
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
          const team = await this.state.addTeamMember(teamId, workerId);
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
          const team = await this.state.removeTeamMember(teamId, workerId);
          this.safeSend(ws, JSON.stringify({ type: 'TEAM_UPDATED', payload: team }));
          return;
        }
        case 'ARCHIVE_DONE_TASKS': {
          const epicFilter = (message as { payload?: { epicId?: string } }).payload?.epicId;
          const snapshot = this.state.getSnapshot();
          const doneTasks = snapshot.tasks.filter(t =>
            t.status === 'DONE' && (!epicFilter || t.epicId === epicFilter)
          );
          if (doneTasks.length === 0) {
            this.safeSend(ws, JSON.stringify({ type: 'ARCHIVE_DONE_RESULT', payload: { archived: 0 } }));
            return;
          }
          let archived = 0;
          for (const task of doneTasks) {
            try {
              await this.state.updateTask(task.id, { status: 'ARCHIVED' }, 'TASK_ARCHIVED');
              archived++;
            } catch (err) {
              logger.error({ taskId: task.id, error: err }, 'Failed to archive task');
            }
          }
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
          const existing = this.state.getTask(taskId);
          if (!existing) {
            this.safeSend(ws, JSON.stringify({ type: 'ERROR', message: `Task not found: ${taskId}` }));
            return;
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
          const task = await this.state.updateTask(taskId, updates, 'TASK_COMMENT_ADDED');
          this.safeSend(ws, JSON.stringify({ type: 'TASK_UPDATED', payload: task }));
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
      const response = await this.mcpAdapter.handle(request);
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
  private trackMcpWorker(ws: WebSocket, request: Record<string, unknown>): void {
    if (request.method !== 'tools/call') return;
    const params = request.params as { arguments?: Record<string, unknown> } | undefined;
    const workerId = params?.arguments?.workerId;
    if (typeof workerId !== 'string') return;

    let workerIds = this.mcpWorkerMap.get(ws);
    if (!workerIds) {
      workerIds = new Set();
      this.mcpWorkerMap.set(ws, workerIds);
    }
    workerIds.add(workerId);
  }

  /**
   * Clean up workers owned by a disconnected MCP connection.
   */
  private cleanupMcpWorkers(ws: WebSocket): void {
    const workerIds = this.mcpWorkerMap.get(ws);
    if (!workerIds || workerIds.size === 0) {
      this.mcpWorkerMap.delete(ws);
      return;
    }

    let deletedCount = 0;
    for (const workerId of workerIds) {
      // Cancel any active wait_for_task waiter before deleting the worker
      const waiter = activeWaiters.get(workerId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.unsubscribe();
        waiter.resolve({ hasNext: false, cancelled: true });
        activeWaiters.delete(workerId);
        logger.info({ workerId }, 'Cancelled active waiter for disconnected MCP client');
      }

      const worker = this.state.getWorker(workerId);
      if (worker) {
        logger.info({ workerId }, 'Cleaning up worker from disconnected MCP client');
        this.state.deleteWorker(workerId);
        deletedCount++;
      }
    }

    this.mcpWorkerMap.delete(ws);

    if (deletedCount > 0) {
      const snap = this.state.getSnapshot();
      this.broadcast({ type: 'STATE_SNAPSHOT', payload: { ...snap, tasks: snap.tasks.filter(t => t.status !== 'ARCHIVED') } });
    }
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

    // Mark as closed immediately to prevent new operations
    this.isClosed = true;

    this.closePromise = (async () => {
      if (this.pluginClients.size > 0) {
        const shuttingDownMessage = JSON.stringify({ type: 'DAEMON_SHUTTING_DOWN' });
        for (const client of this.pluginClients) {
          this.safeSend(client, shuttingDownMessage);
        }

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
