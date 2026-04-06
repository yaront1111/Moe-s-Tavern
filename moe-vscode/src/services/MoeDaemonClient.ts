import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import type {
    Task,
    ImplementationStep,
    Epic,
    MoeStateSnapshot,
    ConnectionState,
    Worker,
    Team,
    RailProposal,
    ActivityEvent,
    TaskPriority,
    EpicStatus,
    ProjectSettings,
    Project,
    ChatMessage,
    ChatChannel,
    PinEntry,
    Decision,
} from '../types/moe';

// Re-export types for backward compatibility with existing importers.
export type { Task, Epic, ConnectionState, Worker, Team, RailProposal, ActivityEvent, TaskPriority, EpicStatus, ProjectSettings, ChatMessage, ChatChannel };
export type { MoeStateSnapshot as StateSnapshot } from '../types/moe';
export type { ImplementationStep as Step } from '../types/moe';

type StateSnapshot = MoeStateSnapshot;

// Output channel for logging
let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Moe');
    }
    return outputChannel;
}

function log(message: string): void {
    getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

function pathsMatch(a: string, b: string): boolean {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32'
        ? na.toLowerCase() === nb.toLowerCase()
        : na === nb;
}

export class MoeDaemonClient implements vscode.Disposable {
    private readonly extensionPath: string;
    private ws: WebSocket | undefined;
    private _connectionState: ConnectionState = 'disconnected';
    private reconnectTimeout: NodeJS.Timeout | undefined;
    private pingInterval: NodeJS.Timeout | undefined;
    private startInProgress = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 10;
    private stateReady = false;
    private stateReadyResolve: (() => void) | undefined;
    private stateReadyPromise: Promise<void>;

    private readonly _onStateChanged = new vscode.EventEmitter<StateSnapshot>();
    public readonly onStateChanged = this._onStateChanged.event;

    private readonly _onConnectionChanged = new vscode.EventEmitter<ConnectionState>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    private readonly _onTaskUpdated = new vscode.EventEmitter<Task>();
    public readonly onTaskUpdated = this._onTaskUpdated.event;

    private readonly _onEpicUpdated = new vscode.EventEmitter<Epic>();
    public readonly onEpicUpdated = this._onEpicUpdated.event;

    private readonly _onTaskDeleted = new vscode.EventEmitter<Task>();
    public readonly onTaskDeleted = this._onTaskDeleted.event;

    private readonly _onActivityLog = new vscode.EventEmitter<ActivityEvent[]>();
    public readonly onActivityLog = this._onActivityLog.event;

    private readonly _onMessageCreated = new vscode.EventEmitter<ChatMessage>();
    public readonly onMessageCreated = this._onMessageCreated.event;

    private readonly _onChannelCreated = new vscode.EventEmitter<ChatChannel>();
    public readonly onChannelCreated = this._onChannelCreated.event;

    private readonly _onChannelsReceived = new vscode.EventEmitter<ChatChannel[]>();
    public readonly onChannelsReceived = this._onChannelsReceived.event;

    private readonly _onMessagesReceived = new vscode.EventEmitter<{ channel: string; messages: ChatMessage[] }>();
    public readonly onMessagesReceived = this._onMessagesReceived.event;

    private readonly _onPinsReceived = new vscode.EventEmitter<{ channel: string; pins: PinEntry[] }>();
    public readonly onPinsReceived = this._onPinsReceived.event;

    private readonly _onPinCreated = new vscode.EventEmitter<{ channel: string; pin: PinEntry }>();
    public readonly onPinCreated = this._onPinCreated.event;

    private readonly _onPinRemoved = new vscode.EventEmitter<{ channel: string; messageId: string }>();
    public readonly onPinRemoved = this._onPinRemoved.event;

    private readonly _onPinToggled = new vscode.EventEmitter<{ channel: string; pin: PinEntry }>();
    public readonly onPinToggled = this._onPinToggled.event;

    private readonly _onDecisionsReceived = new vscode.EventEmitter<Decision[]>();
    public readonly onDecisionsReceived = this._onDecisionsReceived.event;

    private readonly _onDecisionProposed = new vscode.EventEmitter<Decision>();
    public readonly onDecisionProposed = this._onDecisionProposed.event;

    private readonly _onDecisionResolved = new vscode.EventEmitter<Decision>();
    public readonly onDecisionResolved = this._onDecisionResolved.event;

    private readonly _onError = new vscode.EventEmitter<{ operation?: string; message: string }>();
    public readonly onError = this._onError.event;

    private daemonShuttingDown = false;

    private state: StateSnapshot | undefined;

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
        this.stateReadyPromise = new Promise<void>((resolve) => {
            this.stateReadyResolve = resolve;
        });
    }

    get connectionState(): ConnectionState {
        return this._connectionState;
    }

    get currentState(): StateSnapshot | undefined {
        return this.state;
    }

    get isStateReady(): boolean {
        return this.stateReady;
    }

    /** Wait for STATE_SNAPSHOT with a timeout. Resolves immediately if already ready. */
    async waitForState(timeoutMs = 5000): Promise<boolean> {
        if (this.stateReady) return true;
        return Promise.race([
            this.stateReadyPromise.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
        ]);
    }

    async connect(): Promise<void> {
        if (this._connectionState !== 'disconnected') {
            return;
        }

        this.daemonShuttingDown = false;

        await this.ensureDaemonRunning();
        const daemonInfo = await this.getDaemonInfo();
        if (!daemonInfo) {
            throw new Error('Daemon not running. Start daemon first.');
        }

        const { host, port } = daemonInfo;
        const url = `ws://${host}:${port}/ws`;

        this.setConnectionState('connecting');

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(url);

                this.ws.on('open', () => {
                    log('Connected to Moe daemon');
                    this.reconnectAttempts = 0;
                    this.setConnectionState('connected');
                    this.startPingInterval();
                    this.requestState();
                    resolve();
                });

                this.ws.on('message', (data) => {
                    this.handleMessage(data.toString());
                });

                this.ws.on('close', () => {
                    log('Disconnected from Moe daemon');
                    this.setConnectionState('disconnected');
                    this.stopPingInterval();
                    // Reset state readiness — new connection needs fresh STATE_SNAPSHOT
                    this.stateReady = false;
                    this.stateReadyPromise = new Promise<void>((resolve) => {
                        this.stateReadyResolve = resolve;
                    });
                    this.scheduleReconnect();
                });

                this.ws.on('error', (err) => {
                    log(`WebSocket error: ${err.message}`);
                    if (this._connectionState === 'connecting') {
                        reject(err);
                    }
                });
            } catch (err) {
                this.setConnectionState('disconnected');
                reject(err);
            }
        });
    }

    disconnect(): void {
        this.cancelReconnect();
        this.stopPingInterval();
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
        this.setConnectionState('disconnected');
    }

    sendMessage(type: string, payload: unknown = {}): void {
        if (this.ws && this._connectionState === 'connected') {
            this.ws.send(JSON.stringify({ type, payload }));
        }
    }

    // =========================================================================
    // Outbound: Task operations
    // =========================================================================

    updateTaskStatus(taskId: string, status: string): void {
        this.sendMessage('UPDATE_TASK', { taskId, updates: { status } });
    }

    createTask(
        epicId: string,
        title: string,
        description: string,
        definitionOfDone: string[],
        priority: TaskPriority
    ): void {
        this.sendMessage('CREATE_TASK', { epicId, title, description, definitionOfDone, priority });
    }

    updateTaskDetails(
        taskId: string,
        updates: { title?: string; description?: string; definitionOfDone?: string[]; priority?: TaskPriority }
    ): void {
        this.sendMessage('UPDATE_TASK', { taskId, updates });
    }

    deleteTask(taskId: string): void {
        this.sendMessage('DELETE_TASK', { taskId });
    }

    approveTask(taskId: string): void {
        this.sendMessage('APPROVE_TASK', { taskId });
    }

    rejectTask(taskId: string, reason: string): void {
        this.sendMessage('REJECT_TASK', { taskId, reason });
    }

    reopenTask(taskId: string, reason: string): void {
        this.sendMessage('REOPEN_TASK', { taskId, reason });
    }

    addTaskComment(taskId: string, content: string): void {
        this.sendMessage('ADD_TASK_COMMENT', { taskId, content });
    }

    // =========================================================================
    // Outbound: Epic operations
    // =========================================================================

    createEpic(
        title: string,
        description: string,
        architectureNotes?: string,
        epicRails?: string[]
    ): void {
        this.sendMessage('CREATE_EPIC', { title, description, architectureNotes, epicRails });
    }

    updateEpic(
        epicId: string,
        updates: { title?: string; description?: string; architectureNotes?: string; epicRails?: string[]; status?: EpicStatus }
    ): void {
        this.sendMessage('UPDATE_EPIC', { epicId, updates });
    }

    deleteEpic(epicId: string): void {
        this.sendMessage('DELETE_EPIC', { epicId });
    }

    // =========================================================================
    // Outbound: Settings, proposals, activity, archive
    // =========================================================================

    updateSettings(settings: Partial<ProjectSettings>): void {
        this.sendMessage('UPDATE_SETTINGS', settings);
    }

    archiveDoneTasks(epicId?: string): void {
        this.sendMessage('ARCHIVE_DONE_TASKS', epicId ? { epicId } : {});
    }

    requestActivityLog(limit?: number): void {
        this.sendMessage('GET_ACTIVITY_LOG', limit ? { limit } : {});
    }

    // =========================================================================
    // Outbound: Chat operations
    // =========================================================================

    requestChannels(): void {
        this.sendMessage('GET_CHANNELS');
    }

    requestMessages(channel: string, limit?: number, sinceId?: string): void {
        this.sendMessage('GET_MESSAGES', { channel, limit, sinceId });
    }

    sendChatMessage(channel: string, content: string): void {
        this.sendMessage('SEND_MESSAGE', { channel, content });
    }

    requestPins(channel: string): void {
        this.sendMessage('GET_PINS', { channel });
    }

    pinMessage(channel: string, messageId: string): void {
        this.sendMessage('PIN_MESSAGE', { channel, messageId });
    }

    unpinMessage(channel: string, messageId: string): void {
        this.sendMessage('UNPIN_MESSAGE', { channel, messageId });
    }

    togglePinDone(channel: string, messageId: string): void {
        this.sendMessage('TOGGLE_PIN_DONE', { channel, messageId });
    }

    requestDecisions(): void {
        this.sendMessage('GET_DECISIONS');
    }

    approveDecision(decisionId: string): void {
        this.sendMessage('APPROVE_DECISION', { decisionId });
    }

    rejectDecision(decisionId: string): void {
        this.sendMessage('REJECT_DECISION', { decisionId });
    }

    approveProposal(proposalId: string): void {
        this.sendMessage('APPROVE_PROPOSAL', { proposalId });
    }

    rejectProposal(proposalId: string): void {
        this.sendMessage('REJECT_PROPOSAL', { proposalId });
    }

    private async getDaemonInfo(): Promise<{ host: string; port: number } | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }

        const config = vscode.workspace.getConfiguration('moe');
        const configPort = config.get<number>('daemon.port', 0);
        const configHost = config.get<string>('daemon.host', '127.0.0.1');

        if (configPort > 0) {
            return { host: configHost, port: configPort };
        }

        // Try to read from .moe/daemon.json
        const projectPath = workspaceFolders[0].uri.fsPath;
        const daemonJsonPath = path.join(projectPath, '.moe', 'daemon.json');

        try {
            const content = fs.readFileSync(daemonJsonPath, 'utf-8');
            const daemonInfo = JSON.parse(content);
            if (daemonInfo.projectPath && !pathsMatch(daemonInfo.projectPath, projectPath)) {
                log(
                    `Stale daemon.json: expected project ${projectPath}, found ${daemonInfo.projectPath}`
                );
                try { fs.unlinkSync(daemonJsonPath); } catch { /* ignore */ }
                return undefined;
            }
            return { host: configHost, port: daemonInfo.port };
        } catch {
            return undefined;
        }
    }

    private getWorkspacePath(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }
        return workspaceFolders[0].uri.fsPath;
    }

    private resolveBundledDaemonPath(): string | undefined {
        const candidate = path.join(this.extensionPath, 'bundled', 'daemon', 'index.js');
        return fs.existsSync(candidate) ? candidate : undefined;
    }

    private resolveGlobalConfigDaemonPath(): string | undefined {
        try {
            const homedir = process.env.HOME || process.env.USERPROFILE || '';
            const configPath = path.join(homedir, '.moe', 'config.json');
            if (!fs.existsSync(configPath)) { return undefined; }
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const installPath = config?.installPath;
            if (!installPath) { return undefined; }
            const candidate = path.join(installPath, 'packages', 'moe-daemon', 'dist', 'index.js');
            if (!fs.existsSync(candidate)) { return undefined; }
            log(`Resolved daemon from global config: ${candidate}`);
            return candidate;
        } catch {
            return undefined;
        }
    }

    private async ensureDaemonRunning(): Promise<void> {
        const config = vscode.workspace.getConfiguration('moe');
        const autoStart = config.get<boolean>('daemon.autoStart', true);
        if (!autoStart) {
            return;
        }
        const configPort = config.get<number>('daemon.port', 0);
        if (configPort > 0) {
            return;
        }

        const projectPath = this.getWorkspacePath();
        if (!projectPath) {
            return;
        }

        const moeDir = path.join(projectPath, '.moe');
        const daemonInfoPath = path.join(moeDir, 'daemon.json');

        if (!fs.existsSync(moeDir)) {
            await this.startDaemon('init', projectPath);
            return;
        }

        if (!fs.existsSync(daemonInfoPath)) {
            await this.startDaemon('start', projectPath);
            return;
        }

        try {
            const content = fs.readFileSync(daemonInfoPath, 'utf-8');
            const daemonInfo = JSON.parse(content);
            if (daemonInfo.projectPath && !pathsMatch(daemonInfo.projectPath, projectPath)) {
                log(
                    `Stale daemon.json: expected project ${projectPath}, found ${daemonInfo.projectPath}`
                );
                try { fs.unlinkSync(daemonInfoPath); } catch { /* ignore */ }
                await this.startDaemon('start', projectPath);
                return;
            }
            const host = config.get<string>('daemon.host', '127.0.0.1');
            const port = Number(daemonInfo.port);
            if (!Number.isNaN(port)) {
                const open = await this.isPortOpen(host, port);
                if (!open) {
                    await this.startDaemon('start', projectPath);
                }
            }
        } catch {
            await this.startDaemon('start', projectPath);
        }
    }

    private async startDaemon(command: 'init' | 'start', projectPath: string): Promise<void> {
        if (this.startInProgress) {
            return;
        }
        const daemonPath = this.resolveBundledDaemonPath() || this.resolveGlobalConfigDaemonPath();
        if (!daemonPath) {
            log('Daemon not found (bundled or global config). Cannot auto-start.');
            return;
        }

        this.startInProgress = true;
        try {
            const node = process.env.MOE_NODE_COMMAND || 'node';
            const args = [daemonPath, command, '--project', projectPath];
            if (command === 'init') {
                args.push('--name', path.basename(projectPath));
            }
            const proc = spawn(node, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            proc.unref();
            log(`Started Moe daemon (${command}) for ${projectPath}`);
            await this.waitForDaemonInfo(projectPath, 10000);
        } catch (err) {
            log(`Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            this.startInProgress = false;
        }
    }

    private async waitForDaemonInfo(projectPath: string, timeoutMs: number): Promise<void> {
        const config = vscode.workspace.getConfiguration('moe');
        const host = config.get<string>('daemon.host', '127.0.0.1');
        const daemonInfoPath = path.join(projectPath, '.moe', 'daemon.json');
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (fs.existsSync(daemonInfoPath)) {
                try {
                    const content = fs.readFileSync(daemonInfoPath, 'utf-8');
                    const daemonInfo = JSON.parse(content);
                    const port = Number(daemonInfo.port);
                    if (!Number.isNaN(port)) {
                        const open = await this.isPortOpen(host, port);
                        if (open) return;
                    }
                } catch {
                    // keep waiting
                }
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    private async isPortOpen(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(200);
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                resolve(false);
            });
            socket.once('timeout', () => {
                socket.destroy();
                resolve(false);
            });
            socket.connect(port, host);
        });
    }

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);
            const { type, payload } = message;

            switch (type) {
                case 'STATE_SNAPSHOT': {
                    const expectedPath = this.getWorkspacePath();
                    if (expectedPath && payload?.project?.rootPath &&
                        !pathsMatch(payload.project.rootPath, expectedPath)) {
                        log(
                            `STATE_SNAPSHOT project mismatch: expected ${expectedPath}, got ${payload.project.rootPath}. Disconnecting.`
                        );
                        const daemonJsonPath = path.join(expectedPath, '.moe', 'daemon.json');
                        try { fs.unlinkSync(daemonJsonPath); } catch { /* ignore */ }
                        this.disconnect();
                        break;
                    }
                    this.state = payload;
                    if (!this.stateReady) {
                        this.stateReady = true;
                        this.stateReadyResolve?.();
                    }
                    this._onStateChanged.fire(payload);
                    break;
                }

                case 'TASK_UPDATED':
                case 'TASK_CREATED':
                    this._onTaskUpdated.fire(payload);
                    if (this.state) {
                        const idx = this.state.tasks.findIndex(t => t.id === payload.id);
                        if (idx >= 0) {
                            this.state.tasks[idx] = payload;
                        } else {
                            this.state.tasks.push(payload);
                        }
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'TASK_DELETED':
                    this._onTaskDeleted.fire(payload);
                    if (this.state) {
                        this.state.tasks = this.state.tasks.filter(t => t.id !== payload.id);
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'EPIC_CREATED':
                case 'EPIC_UPDATED':
                    this._onEpicUpdated.fire(payload);
                    if (this.state) {
                        const idx = this.state.epics.findIndex(e => e.id === payload.id);
                        if (idx >= 0) {
                            this.state.epics[idx] = payload;
                        } else {
                            this.state.epics.push(payload);
                        }
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'EPIC_DELETED':
                    if (this.state) {
                        this.state.epics = this.state.epics.filter(e => e.id !== payload.id);
                        this.state.tasks = this.state.tasks.filter(t => t.epicId !== payload.id);
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'WORKER_CREATED':
                case 'WORKER_UPDATED':
                    if (this.state) {
                        const idx = this.state.workers.findIndex(w => w.id === payload.id);
                        if (idx >= 0) {
                            this.state.workers[idx] = payload;
                        } else {
                            this.state.workers.push(payload);
                        }
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'WORKER_DELETED':
                    if (this.state) {
                        this.state.workers = this.state.workers.filter(w => w.id !== payload.id);
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'TEAM_CREATED':
                case 'TEAM_UPDATED':
                    if (this.state) {
                        const idx = this.state.teams.findIndex(tm => tm.id === payload.id);
                        if (idx >= 0) {
                            this.state.teams[idx] = payload;
                        } else {
                            this.state.teams.push(payload);
                        }
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'TEAM_DELETED':
                    if (this.state) {
                        this.state.teams = this.state.teams.filter(tm => tm.id !== payload.id);
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'PROPOSAL_CREATED':
                case 'PROPOSAL_UPDATED':
                    if (this.state) {
                        const idx = this.state.proposals.findIndex(p => p.id === payload.id);
                        if (idx >= 0) {
                            this.state.proposals[idx] = payload;
                        } else {
                            this.state.proposals.push(payload);
                        }
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'SETTINGS_UPDATED':
                    if (this.state) {
                        this.state.project = payload;
                        this._onStateChanged.fire(this.state);
                    }
                    break;

                case 'ACTIVITY_LOG':
                    this._onActivityLog.fire(payload);
                    break;

                case 'MESSAGE_CREATED':
                    this._onMessageCreated.fire(payload);
                    break;

                case 'CHANNEL_CREATED':
                    this._onChannelCreated.fire(payload);
                    if (this.state) {
                        if (!this.state.channels) { this.state.channels = []; }
                        this.state.channels.push(payload);
                    }
                    break;

                case 'CHANNELS':
                    this._onChannelsReceived.fire(payload.channels);
                    break;

                case 'MESSAGES':
                    this._onMessagesReceived.fire({ channel: payload.channel, messages: payload.messages });
                    break;

                case 'PINS':
                    this._onPinsReceived.fire({ channel: payload.channel, pins: payload.pins });
                    break;

                case 'PIN_CREATED':
                    this._onPinCreated.fire({ channel: payload.channel, pin: payload.pin });
                    break;

                case 'PIN_REMOVED':
                    this._onPinRemoved.fire({ channel: payload.channel, messageId: payload.messageId });
                    break;

                case 'PIN_TOGGLED':
                    this._onPinToggled.fire({ channel: payload.channel, pin: payload.pin });
                    break;

                case 'DECISIONS':
                    this._onDecisionsReceived.fire(payload.decisions ?? []);
                    if (this.state) {
                        this.state.decisions = payload.decisions ?? [];
                    }
                    break;

                case 'DECISION_PROPOSED':
                    this._onDecisionProposed.fire(payload);
                    if (this.state) {
                        if (!this.state.decisions) { this.state.decisions = []; }
                        this.state.decisions.push(payload);
                    }
                    break;

                case 'DECISION_RESOLVED':
                    this._onDecisionResolved.fire(payload);
                    if (this.state) {
                        if (!this.state.decisions) { this.state.decisions = []; }
                        const idx = this.state.decisions.findIndex(d => d.id === payload.id);
                        if (idx >= 0) {
                            this.state.decisions[idx] = payload;
                        }
                    }
                    break;

                case 'MESSAGE_SENT':
                    // Confirmation of sent message — no action needed, MESSAGE_CREATED broadcast handles UI
                    break;

                case 'ARCHIVE_DONE_RESULT':
                    log(`Archived ${payload?.archived ?? 0} done tasks`);
                    break;

                case 'ERROR':
                    log(`Daemon error: ${message.message ?? payload?.message ?? 'unknown'}`);
                    this._onError.fire({
                        operation: payload?.operation,
                        message: message.message ?? payload?.message ?? 'Unknown error',
                    });
                    break;

                case 'DAEMON_SHUTTING_DOWN':
                    log('Daemon is shutting down');
                    this.daemonShuttingDown = true;
                    this.disconnect();
                    break;

                case 'PONG':
                    break;

                default:
                    log(`Unknown message type: ${type}`);
            }
        } catch (err) {
            log(`Failed to parse message: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private requestState(): void {
        this.sendMessage('GET_STATE');
    }

    private setConnectionState(state: ConnectionState): void {
        this._connectionState = state;
        this._onConnectionChanged.fire(state);
    }

    private startPingInterval(): void {
        this.pingInterval = setInterval(() => {
            this.sendMessage('PING');
        }, 30000);
    }

    private stopPingInterval(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
    }

    private scheduleReconnect(): void {
        if (this.daemonShuttingDown) {
            return;
        }

        const config = vscode.workspace.getConfiguration('moe');
        if (!config.get<boolean>('autoConnect', true)) {
            return;
        }

        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            log(`Max reconnect attempts (${this.maxReconnectAttempts}) exhausted`);
            this.setConnectionState('disconnected');
            vscode.window.showErrorMessage(
                `Moe daemon connection failed after ${this.maxReconnectAttempts} retries.`,
                'Reconnect'
            ).then((action) => {
                if (action === 'Reconnect') {
                    this.reconnectAttempts = 0;
                    this.connect().catch(() => {});
                }
            });
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            this.connect().catch(() => {
                // Will retry via scheduleReconnect on close
            });
        }, 5000);
    }

    private cancelReconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
    }

    dispose(): void {
        this.disconnect();
        this._onStateChanged.dispose();
        this._onConnectionChanged.dispose();
        this._onTaskUpdated.dispose();
        this._onEpicUpdated.dispose();
        this._onTaskDeleted.dispose();
        this._onActivityLog.dispose();
        this._onMessageCreated.dispose();
        this._onChannelCreated.dispose();
        this._onChannelsReceived.dispose();
        this._onMessagesReceived.dispose();
        this._onPinsReceived.dispose();
        this._onPinCreated.dispose();
        this._onPinRemoved.dispose();
        this._onPinToggled.dispose();
        this._onDecisionsReceived.dispose();
        this._onDecisionProposed.dispose();
        this._onDecisionResolved.dispose();
        this._onError.dispose();
    }
}
