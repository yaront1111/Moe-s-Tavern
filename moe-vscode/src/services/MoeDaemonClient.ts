import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import WebSocket from 'ws';

// Type definitions for Moe daemon communication.
// Canonical types are defined in packages/moe-daemon/src/types/schema.ts
// These are simplified versions for the VSCode extension.
// Future: Consider extracting to packages/moe-common/ for strict type sharing.

export interface Task {
    id: string;
    epicId: string;
    title: string;
    description: string;
    status: string;
    assignedWorkerId?: string;
    implementationPlan?: Step[];
}

export interface Step {
    stepId: string;
    description: string;
    status: string;
    affectedFiles?: string[];
}

export interface Epic {
    id: string;
    title: string;
    description: string;
}

export interface StateSnapshot {
    project: { id: string; name: string };
    epics: Epic[];
    tasks: Task[];
    workers: unknown[];
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

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

export class MoeDaemonClient implements vscode.Disposable {
    private readonly extensionPath: string;
    private ws: WebSocket | undefined;
    private _connectionState: ConnectionState = 'disconnected';
    private reconnectTimeout: NodeJS.Timeout | undefined;
    private pingInterval: NodeJS.Timeout | undefined;
    private startInProgress = false;

    private readonly _onStateChanged = new vscode.EventEmitter<StateSnapshot>();
    public readonly onStateChanged = this._onStateChanged.event;

    private readonly _onConnectionChanged = new vscode.EventEmitter<ConnectionState>();
    public readonly onConnectionChanged = this._onConnectionChanged.event;

    private readonly _onTaskUpdated = new vscode.EventEmitter<Task>();
    public readonly onTaskUpdated = this._onTaskUpdated.event;

    private state: StateSnapshot | undefined;

    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;
    }

    get connectionState(): ConnectionState {
        return this._connectionState;
    }

    get currentState(): StateSnapshot | undefined {
        return this.state;
    }

    async connect(): Promise<void> {
        if (this._connectionState !== 'disconnected') {
            return;
        }

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

    updateTaskStatus(taskId: string, status: string): void {
        this.sendMessage('UPDATE_TASK', { taskId, status });
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
                case 'STATE_SNAPSHOT':
                    this.state = payload;
                    this._onStateChanged.fire(payload);
                    break;
                case 'TASK_UPDATED':
                case 'TASK_CREATED':
                    this._onTaskUpdated.fire(payload);
                    // Update local state
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
                case 'PONG':
                    // Heartbeat response
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
        const config = vscode.workspace.getConfiguration('moe');
        if (!config.get<boolean>('autoConnect', true)) {
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
    }
}
