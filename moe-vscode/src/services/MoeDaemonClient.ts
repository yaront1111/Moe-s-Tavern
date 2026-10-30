import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import type {
    Task,
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
    ChatMessage,
    ChatChannel,
    PinEntry,
    Decision,
    MetricsAggregate,
    PluginOutboundMessage,
} from '../types/moe';

/**
 * The APPROVE_TASK wire payload, read straight off the outbound message union so
 * the approval method stays bound to the shape the daemon actually parses.
 */
type ApproveTaskPayload = Extract<PluginOutboundMessage, { type: 'APPROVE_TASK' }>['payload'];

/** The at-most-three context keys an onError subscriber may see. */
interface DaemonErrorContext {
    taskId?: string;
    expectedPlanRevision?: number;
    currentPlanRevision?: number;
}

/**
 * Public shape of the onError event. Everything past `message` is optional, so
 * subscribers that read only operation and message keep compiling untouched.
 */
interface DaemonErrorEvent {
    operation?: string;
    message: string;
    code?: number;
    codeName?: string;
    context?: DaemonErrorContext;
}

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

/**
 * Pick the allowlisted fields out of a daemon error context.
 *
 * The daemon's error contexts are free-form debugging data — internal field
 * names, reason strings, project paths — so the received object is NEVER spread
 * into the public event. At most these three keys cross, and only with the
 * right type. Returns undefined when nothing survives, so the caller can omit
 * the property entirely rather than publish an empty object.
 */
function allowlistedErrorContext(context: unknown): DaemonErrorContext | undefined {
    if (typeof context !== 'object' || context === null) {
        return undefined;
    }
    const source = context as Record<string, unknown>;
    const picked: DaemonErrorContext = {};
    if (typeof source.taskId === 'string') {
        picked.taskId = source.taskId;
    }
    if (typeof source.expectedPlanRevision === 'number' && Number.isFinite(source.expectedPlanRevision)) {
        picked.expectedPlanRevision = source.expectedPlanRevision;
    }
    if (typeof source.currentPlanRevision === 'number' && Number.isFinite(source.currentPlanRevision)) {
        picked.currentPlanRevision = source.currentPlanRevision;
    }
    return Object.keys(picked).length > 0 ? picked : undefined;
}

function pathsMatch(a: string, b: string): boolean {
    const na = path.resolve(a);
    const nb = path.resolve(b);
    return process.platform === 'win32'
        ? na.toLowerCase() === nb.toLowerCase()
        : na === nb;
}

// daemon.json is repository content: the cap matches the daemon, proxy, Claude-plugin and JetBrains readers.
const MAX_DAEMON_JSON_BYTES = 64 * 1024;

/** Read daemon.json through one descriptor, at most cap + 1 bytes; a larger file throws like an unparseable one. */
export function readDaemonJsonText(filePath: string): string {
    return readCappedText(filePath, MAX_DAEMON_JSON_BYTES, 'daemon.json is larger than 64 KiB');
}

function readCappedText(filePath: string, cap: number, tooLarge: string): string {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(cap + 1);
        let total = 0;
        while (total < buf.length) {
            const n = fs.readSync(fd, buf, total, buf.length - total, null);
            if (n === 0) { break; }
            total += n;
        }
        if (total > cap) {
            throw new Error(tooLarge);
        }
        return buf.toString('utf8', 0, total);
    } finally {
        fs.closeSync(fd);
    }
}

// ---- Protected runtime selection: a mirror of JetBrains RuntimeSelectionPolicy (CQ-R01) ----
// Nothing here throws to its callers. Errors are compared by `code`, never instanceof (cross-realm safe).

export type RuntimeProfile = 'legacy' | 'protected';
export type ArtifactSelection = { accepted: string } | { rejected: string };

const MAX_PROJECT_JSON_BYTES = 1024 * 1024;
const DEVICE_PREFIX = /^\/\/[?.]\/(unc\/)?/i;
const DRIVE_ROOT = /^[A-Za-z]:\/$/;
// Projects an explicit verified-local read pinned for this extension-host session.
const pinnedProjects = new Set<string>();

export const defaultFoldCase = process.platform === 'win32' || process.platform === 'darwin';

const errorCode = (err: unknown): unknown => (err as { code?: unknown } | null | undefined)?.code;
const errorText = (err: unknown): string => String((err as { message?: unknown } | null | undefined)?.message ?? err);

function realPathOrNull(p: string): string | null {
    try { return fs.realpathSync.native(p); } catch { return null; }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** `\` becomes `/`, a `//?/` or `//./` device prefix goes (`//?/UNC/x` becomes `//x`), trailing `/` goes except on a root. */
export function comparablePath(p: string, foldCase: boolean): string {
    let value = p.replace(/\\/g, '/').replace(DEVICE_PREFIX, (_match, unc: string | undefined) => (unc ? '//' : ''));
    while (value.length > 1 && value.endsWith('/') && !DRIVE_ROOT.test(value)) { value = value.slice(0, -1); }
    return foldCase ? value.toUpperCase().toLowerCase() : value;
}

/** `child` is `parent` or under it on a segment boundary; both already in comparable form. */
export function isWithin(child: string, parent: string): boolean {
    return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/** The only place protected selection takes the wrapper, daemon and proxy from (bundle-assets.mjs). */
export function installedRoot(extensionPath: string): string {
    return path.join(extensionPath, 'bundled');
}

/** Never throws: an unreadable or untrusted `.moe/project.json` answers 'protected'. */
export function runtimeProfile(basePath: string): RuntimeProfile {
    try {
        if (basePath.trim() === '') { return 'legacy'; }
        const key = comparablePath(realPathOrNull(basePath) ?? path.resolve(basePath), defaultFoldCase);
        if (pinnedProjects.has(key)) { return 'protected'; }
        if (!declaresVerifiedLocal(path.join(basePath, '.moe', 'project.json'))) { return 'legacy'; }
        pinnedProjects.add(key);
        return 'protected';
    } catch (err) {
        log(`Moe runtime selection fails closed to the protected profile: ${errorText(err)}`);
        return 'protected';
    }
}

/** True for exactly "verified-local", false for absent/legacy/observe; throws for anything else. */
function declaresVerifiedLocal(file: string): boolean {
    try { fs.lstatSync(file); } catch (err) { if (errorCode(err) === 'ENOENT') { return false; } throw err; }
    // Checked before open: opening a FIFO or device would block the extension host.
    if (!fs.statSync(file).isFile()) { throw new Error('project.json is not a regular file'); }
    const text = readCappedText(file, MAX_PROJECT_JSON_BYTES, 'project.json is larger than 1 MiB');
    // Buffer#toString keeps a byte order mark, which the daemon's JSON.parse would reject.
    if (text.startsWith('\uFEFF')) { throw new Error('project.json starts with a byte order mark'); }
    const root: unknown = JSON.parse(text);
    if (!isPlainObject(root)) { throw new Error('project.json is not a JSON object'); }
    if (!hasOwn(root, 'settings')) { return false; }
    const settings = root.settings;
    if (!isPlainObject(settings)) { throw new Error('settings is not a JSON object'); }
    if (!hasOwn(settings, 'executionProfile')) { return false; }
    const profile = settings.executionProfile;
    if (profile === 'legacy' || profile === 'observe') { return false; }
    if (profile === 'verified-local') { return true; }
    throw new Error('executionProfile is not legacy, observe or verified-local');
}

/**
 * `relative` under `root`, accepted as its real file only inside the real root (exact
 * comparison) and outside the real project (folded where the file system folds case).
 * The reason reaches the UI; the absolute path only the log.
 */
export function installedArtifact(root: string, relative: string, basePath: string, foldCase = defaultFoldCase): ArtifactSelection {
    const realRoot = realPathOrNull(root);
    if (realRoot === null) { return { rejected: 'installed Moe runtime not found' }; }
    return selectInstalledFile(path.join(root, relative), `installed ${relative}`, basePath, foldCase, realRoot);
}

/** A bare name is never resolved by spawn; the first selected candidate must pass these checks. */
export function installedExecutable(p: string | undefined, basePath: string, foldCase = defaultFoldCase): ArtifactSelection {
    if (!p?.trim()) { return { rejected: 'node executable not found' }; }
    if (!isFullyQualified(p)) { return { rejected: 'node executable is not an absolute path' }; }
    return selectInstalledFile(p, 'node executable', basePath, foldCase);
}

function selectInstalledFile(file: string, label: string, basePath: string, foldCase: boolean, realRoot?: string): ArtifactSelection {
    const project = realPathOrNull(basePath);
    if (project === null) { return { rejected: 'the project directory cannot be resolved' }; }
    const rejected = (reason: string, detail: string): ArtifactSelection => {
        log(`Moe protected runtime selection refused: ${reason} (${detail})`);
        return { rejected: reason };
    };
    let real: string;
    try {
        real = fs.realpathSync.native(file);
        if (!fs.statSync(real).isFile()) { return rejected(`${label} is not a regular file`, real); }
    } catch (err) {
        return rejected(errorCode(err) === 'ENOENT' ? `${label} not found` : `${label} cannot be resolved`, errorText(err));
    }
    if (realRoot !== undefined && !isWithin(comparablePath(real, false), comparablePath(realRoot, false))) {
        return rejected(`${label} resolves outside the installed Moe runtime`, real);
    }
    if (isWithin(comparablePath(real, foldCase), comparablePath(project, foldCase))) {
        return rejected(`${label} resolves inside the project`, real);
    }
    return { accepted: real };
}

/** Windows `\x`, `/x` and `C:x` follow the current drive or directory; only `C:\` and `\\` forms (either slash) qualify. */
export function isFullyQualified(p: string, windows = process.platform === 'win32'): boolean {
    return windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p) : path.posix.isAbsolute(p);
}

export function isOutsideProject(p: string, basePath: string, foldCase = defaultFoldCase): boolean {
    try {
        if (!isFullyQualified(p)) { return false; }
        const projects = pathForms(basePath);
        return !pathForms(p).some(form => projects.some(project => isWithin(comparablePath(form, foldCase), comparablePath(project, foldCase))));
    } catch { return false; }
}

function pathForms(p: string): string[] {
    const forms = [path.resolve(p)];
    try { forms.push(fs.realpathSync.native(p)); } catch (err) {
        // Missing PATH directories are harmless; permission/invalid-path errors must fail closed.
        if (errorCode(err) !== 'ENOENT') { throw err; }
    }
    return forms;
}

const unquoted = (entry: string): string => entry.trim().replace(/^"(.*)"$/, '$1');
function safeStat(file: string): fs.Stats | undefined {
    try { return fs.statSync(file); } catch { return undefined; }
}
function pathNames(env: NodeJS.ProcessEnv, windows: boolean): string[] {
    return windows ? Object.keys(env).filter(key => key.toUpperCase() === 'PATH').sort() : ['PATH'];
}

/** Validated spellings only: libuv's Windows PATH search strips an edge quote (`C:\proj'` searches `C:\proj`). */
export function protectedPathEntries(value: string, basePath: string, delimiter = path.delimiter): string[] {
    return value.split(delimiter).map(unquoted).filter(entry => !/["']$/.test(entry) && isOutsideProject(entry, basePath));
}

/** In-process lookup: neither which/where nor a bare node can execute workspace code. */
export function nodeOnProtectedPath(value: string, basePath: string, windows: boolean): string | undefined {
    return protectedPathEntries(value, basePath).map(entry => path.join(entry, windows ? 'node.exe' : 'node'))
        .find(file => safeStat(file)?.isFile());
}

function latestNvmNode(home: string): string | undefined {
    try {
        const root = path.join(home, '.nvm', 'versions', 'node');
        const latest = fs.readdirSync(root).filter(name => safeStat(path.join(root, name))?.isDirectory()).sort().pop();
        return latest ? path.join(root, latest, 'bin', 'node') : undefined;
    } catch { return undefined; }
}

export function protectedNodeCandidate(env: NodeJS.ProcessEnv, home: string | undefined, windows: boolean, basePath: string): string | undefined {
    if (env.MOE_NODE_COMMAND?.trim()) { return unquoted(env.MOE_NODE_COMMAND); }
    if (!windows && home) {
        const managed = path.join(home, '.local', 'share', 'moe', 'node', 'current', 'bin', 'node');
        try {
            if (fs.statSync(managed).isFile()) { fs.accessSync(managed, fs.constants.X_OK); return managed; }
        } catch { /* An unavailable managed runtime lets the in-process search continue. */ }
    }
    const onPath = nodeOnProtectedPath(env[pathNames(env, windows)[0] ?? 'PATH'] ?? '', basePath, windows);
    if (onPath) { return onPath; }
    const under = (base: string | undefined, relative: string): string | undefined => base ? path.join(base, relative) : undefined;
    const candidates = windows ? [
        under(env.ProgramFiles, 'nodejs/node.exe'), under(env['ProgramFiles(x86)'], 'nodejs/node.exe'),
        under(env.LOCALAPPDATA, 'Programs/nodejs/node.exe'), under(env.LOCALAPPDATA, 'nvm/current/node.exe'),
        under(env.APPDATA, 'nvm/node.exe')
    ] : ['/opt/homebrew/bin/node', '/usr/local/bin/node', under(home, '.nvm/current/bin/node'),
        home ? latestNvmNode(home) : undefined, '/usr/bin/node'];
    return candidates.find((file): file is string => file !== undefined && safeStat(file) !== undefined);
}

export function protectedDaemonCommand(basePath: string, root: string, node: string | undefined):
    { refused: string } | { ready: { node: string; args: string[]; cwd: string } } {
    const daemon = installedArtifact(root, 'daemon/index.js', basePath);
    if ('rejected' in daemon) { return { refused: daemon.rejected }; }
    const executable = installedExecutable(node, basePath);
    if ('rejected' in executable) { return { refused: executable.rejected }; }
    return { ready: { node: executable.accepted, args: [daemon.accepted, 'start', '--project', basePath], cwd: path.dirname(daemon.accepted) } };
}

export function protectedDaemonEnvironment(env: NodeJS.ProcessEnv, basePath: string, nodePath: string, windows: boolean, home: string | undefined): NodeJS.ProcessEnv {
    const result = { ...env };
    for (const key of Object.keys(result)) {
        if (['NODE_OPTIONS', 'NODE_PATH'].includes(windows ? key.toUpperCase() : key)) { delete result[key]; }
    }
    const names = pathNames(result, windows), name = names[0] ?? 'PATH';
    const entries = [path.dirname(nodePath), ...(result[name] ?? '').split(path.delimiter)];
    for (const duplicate of names.slice(1)) { delete result[duplicate]; }
    if (!windows && home) {
        for (const relative of ['.local/share/moe/node/current/bin', '.local/share/moe/npm/bin']) {
            const directory = path.join(home, relative);
            if (safeStat(directory)?.isDirectory()) { entries.push(directory); }
        }
    }
    result[name] = [...new Set(protectedPathEntries(entries.join(path.delimiter), basePath))].join(path.delimiter);
    return result;
}

export class MoeDaemonClient implements vscode.Disposable {
    private readonly extensionPath: string;
    private ws: WebSocket | undefined;
    private _connectionState: ConnectionState = 'disconnected';
    private reconnectTimeout: NodeJS.Timeout | undefined;
    private pingInterval: NodeJS.Timeout | undefined;
    private startInProgress = false;
    private connectInProgress = false;
    private readonly handshakeTimeoutMs = 15000;
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

    private readonly _onError = new vscode.EventEmitter<DaemonErrorEvent>();
    public readonly onError = this._onError.event;

    private readonly _onMetrics = new vscode.EventEmitter<MetricsAggregate>();
    public readonly onMetrics = this._onMetrics.event;

    private daemonShuttingDown = false;
    private manualDisconnect = false;

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
        this.manualDisconnect = false;
        if (this._connectionState !== 'disconnected') {
            return;
        }
        // Guard the awaits below: setConnectionState('connecting') only fires
        // after ensureDaemonRunning()/getDaemonInfo() resolve, so two concurrent
        // connect() calls could both pass the state check and each open a socket
        // (orphaning a ping interval). Set this synchronously before awaiting.
        if (this.connectInProgress) {
            return;
        }
        this.connectInProgress = true;

        try {
            this.daemonShuttingDown = false;

            await this.ensureDaemonRunning();
            const daemonInfo = await this.getDaemonInfo();
            if (!daemonInfo) {
                throw new Error('Daemon not running. Start daemon first.');
            }

            const { host, port } = daemonInfo;
            const url = `ws://${host}:${port}/ws`;

            this.setConnectionState('connecting');

            return await new Promise<void>((resolve, reject) => {
                let settled = false;
                let opened = false;
                let handshakeTimer: NodeJS.Timeout | undefined;
                const clearHandshakeTimer = () => {
                    if (handshakeTimer) {
                        clearTimeout(handshakeTimer);
                        handshakeTimer = undefined;
                    }
                };
                const resolveOnce = () => {
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                };
                const rejectOnce = (err: Error) => {
                    if (!settled) {
                        settled = true;
                        reject(err);
                    }
                };

                try {
                    const ws = new WebSocket(url);
                    this.ws = ws;

                    // A port that accepts TCP but never completes the WS upgrade
                    // fires neither 'open' nor 'close' nor 'error', wedging the
                    // client in 'connecting' forever with no reconnect. Arm a
                    // handshake timeout that tears the socket down and reschedules.
                    handshakeTimer = setTimeout(() => {
                        handshakeTimer = undefined;
                        if (this.ws !== ws) {
                            return;
                        }
                        log('WebSocket handshake timed out');
                        this.ws = undefined;
                        try { ws.terminate(); } catch { /* ignore */ }
                        try { ws.close(); } catch { /* ignore */ }
                        this.stopPingInterval();
                        this.setConnectionState('disconnected');
                        rejectOnce(new Error('WebSocket handshake timed out'));
                        this.scheduleReconnect();
                    }, this.handshakeTimeoutMs);

                    ws.on('open', () => {
                        clearHandshakeTimer();
                        if (this.ws !== ws) {
                            try { ws.close(); } catch { /* ignore stale socket close errors */ }
                            rejectOnce(new Error('WebSocket was replaced before it opened'));
                            return;
                        }
                        opened = true;
                        log('Connected to Moe daemon');
                        this.reconnectAttempts = 0;
                        this.setConnectionState('connected');
                        this.startPingInterval();
                        this.requestState();
                        resolveOnce();
                    });

                    ws.on('message', (data) => {
                        if (this.ws === ws) {
                            this.handleMessage(data.toString());
                        }
                    });

                    ws.on('close', () => {
                        clearHandshakeTimer();
                        if (this.ws !== ws) {
                            log('Ignoring close from stale Moe daemon socket');
                            if (!opened) {
                                rejectOnce(new Error('WebSocket closed before connection opened'));
                            }
                            return;
                        }
                        this.ws = undefined;
                        log('Disconnected from Moe daemon');
                        this.setConnectionState('disconnected');
                        this.stopPingInterval();
                        // Reset state readiness — new connection needs fresh STATE_SNAPSHOT
                        this.stateReady = false;
                        this.stateReadyPromise = new Promise<void>((resolve) => {
                            this.stateReadyResolve = resolve;
                        });
                        if (!opened) {
                            rejectOnce(new Error('WebSocket closed before connection opened'));
                        }
                        this.scheduleReconnect();
                    });

                    ws.on('error', (err) => {
                        clearHandshakeTimer();
                        log(`WebSocket error: ${err.message}`);
                        if (this.ws === ws && this._connectionState === 'connecting') {
                            rejectOnce(err);
                        }
                    });
                } catch (err) {
                    clearHandshakeTimer();
                    this.setConnectionState('disconnected');
                    rejectOnce(err instanceof Error ? err : new Error(String(err)));
                }
            });
        } finally {
            this.connectInProgress = false;
        }
    }

    disconnect(options: { manual?: boolean } = {}): void {
        const manual = options.manual ?? true;
        this.manualDisconnect = manual;
        this.cancelReconnect();
        this.stopPingInterval();
        if (this.ws) {
            const ws = this.ws;
            this.ws = undefined;
            if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
                try {
                    ws.close();
                } catch (err) {
                    log(`Failed to close WebSocket: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        this.setConnectionState('disconnected');
        if (!manual) {
            this.scheduleReconnect();
        }
    }

    /**
     * Send a message to the daemon. Returns true if the frame was handed to the
     * socket, false if the client was not connected or the send failed. Callers
     * that gate UI success/dispose on delivery MUST check this — a silent
     * early-return previously let panels claim success while disconnected.
     */
    sendMessage(type: string, payload: unknown = {}): boolean {
        if (!this.ws || this._connectionState !== 'connected' || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }
        try {
            this.ws.send(JSON.stringify({ type, payload }));
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`Failed to send ${type}: ${message}`);
            this._onError.fire({ operation: type, message });
            // Tear down the half-dead socket so the next connect() does not
            // early-return on a stale ws reference, and so a subsequent
            // sendMessage call can't sneak past the OPEN check on the same
            // broken socket.
            const ws = this.ws;
            this.ws = undefined;
            this.stopPingInterval();
            this.stateReady = false;
            this.stateReadyPromise = new Promise<void>((resolve) => {
                this.stateReadyResolve = resolve;
            });
            if (ws) {
                try { ws.close(); } catch { /* ignore close errors on dead socket */ }
            }
            this.setConnectionState('disconnected');
            this.scheduleReconnect();
            return false;
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

    /**
     * Approve a plan. `expectedPlanRevision` is the revision the human actually
     * reviewed; the daemon compares it against the task's current revision and
     * refuses the approval if the plan moved underneath the reviewer.
     *
     * There is no token-free approval any more: CQ-F MODIFY_RAIL prop-5e7763ed
     * (human-approved 2026-10-25) deleted it. An undefined token is therefore
     * refused right here exactly like a malformed one — no frame is sent, the
     * refusal is logged, and onError fires with the taskId so the surface that
     * asked can tell the user which approval did not go through.
     *
     * The token is whatever the reviewed panel hands in. This method never
     * reads cached state to manufacture one — the newest revision is by
     * definition not the reviewed one.
     */
    approveTask(taskId: string, expectedPlanRevision: number): boolean {
        // Never coerce. Number.isSafeInteger already rejects fractional, NaN,
        // Infinity and out-of-range values, and a numeric conversion here would
        // be exactly the silent fallback this check exists to prevent. The
        // typeof guard matters because untyped webview messages reach this,
        // and it is also what refuses an undefined token.
        if (typeof expectedPlanRevision !== 'number'
            || !Number.isSafeInteger(expectedPlanRevision)
            || expectedPlanRevision < 0) {
            const message = `APPROVE_TASK refused for ${taskId}: expectedPlanRevision must be a `
                + `non-negative safe integer, got ${String(expectedPlanRevision)} `
                + `(${typeof expectedPlanRevision})`;
            log(message);
            this._onError.fire({ operation: 'APPROVE_TASK', message, context: { taskId } });
            return false;
        }
        const payload: ApproveTaskPayload = { taskId, expectedPlanRevision };
        return this.sendMessage('APPROVE_TASK', payload);
    }

    rejectTask(taskId: string, reason: string): boolean {
        return this.sendMessage('REJECT_TASK', { taskId, reason });
    }

    reopenTask(taskId: string, reason: string): boolean {
        return this.sendMessage('REOPEN_TASK', { taskId, reason });
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

    /**
     * Request aggregated task metrics from the daemon. Mirrors the JetBrains
     * `requestMetrics` plumbing. The daemon agent is wiring `moe.list_metrics`
     * — until that lands the response is simply absent and consumers should
     * render gracefully.
     */
    listMetrics(opts: { epicId?: string; sinceIso?: string; limit?: number } = {}): void {
        this.sendMessage('GET_METRICS', opts);
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
            const content = readDaemonJsonText(daemonJsonPath);
            const daemonInfo = JSON.parse(content);
            if (daemonInfo.projectPath && !pathsMatch(daemonInfo.projectPath, projectPath)) {
                log(
                    `Stale daemon.json: expected project ${projectPath}, found ${daemonInfo.projectPath}`
                );
                try { fs.unlinkSync(daemonJsonPath); } catch { /* ignore */ }
                return undefined;
            }
            const port = Number(daemonInfo.port);
            if (Number.isNaN(port) || port <= 0) {
                log(`Invalid daemon port in daemon.json: ${String(daemonInfo.port)}`);
                return undefined;
            }
            return { host: configHost, port };
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
            const content = readDaemonJsonText(daemonInfoPath);
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

    resolveDaemonRuntime(): { node: string; env: NodeJS.ProcessEnv } {
        const env = { ...process.env };
        const override = env.MOE_NODE_COMMAND;
        const home = env.HOME || env.USERPROFILE;
        if (process.platform === 'win32' || !home) { return { node: override || 'node', env }; }

        const originalPath = env.PATH ?? '/usr/bin:/bin';
        const entries = originalPath.split(path.delimiter);
        const nodeDir = path.join(home, '.local', 'share', 'moe', 'node', 'current', 'bin');
        const npmDir = path.join(home, '.local', 'share', 'moe', 'npm', 'bin');
        for (const directory of [nodeDir, npmDir]) {
            if (!entries.includes(directory) && fs.existsSync(directory)) { entries.push(directory); }
        }
        env.PATH = entries.join(path.delimiter);

        const isExecutable = (candidate: string): boolean => {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return fs.statSync(candidate).isFile();
            } catch { return false; }
        };
        // Match the installer's env.sh: its managed Node replaces missing or obsolete system Node.
        const installedNode = path.join(nodeDir, 'node');
        const useInstalledNode = !override && isExecutable(installedNode);
        if (useInstalledNode) {
            env.PATH = [nodeDir, ...entries.filter(directory => directory !== nodeDir)].join(path.delimiter);
        }
        const node = override || (useInstalledNode ? installedNode : 'node');
        return { node, env };
    }

    private async startDaemon(command: 'init' | 'start', projectPath: string): Promise<void> {
        if (this.startInProgress) {
            return;
        }
        if (runtimeProfile(projectPath) === 'protected') { return this.startProtectedDaemon(projectPath); }
        const daemonPath = this.resolveBundledDaemonPath() || this.resolveGlobalConfigDaemonPath();
        if (!daemonPath) {
            log('Daemon not found (bundled or global config). Cannot auto-start.');
            return;
        }

        this.startInProgress = true;
        try {
            const { node, env } = this.resolveDaemonRuntime();
            const args = [daemonPath, command, '--project', projectPath];
            if (command === 'init') {
                args.push('--name', path.basename(projectPath));
            }
            await new Promise<void>((resolve, reject) => {
                const proc = spawn(node, args, {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                    env
                });
                // Missing executables fail asynchronously; try/catch around spawn
                // alone leaves ENOENT as an unhandled child-process error.
                proc.once('error', reject);
                proc.once('spawn', () => {
                    proc.unref();
                    resolve();
                });
            });
            log(`Started Moe daemon (${command}) for ${projectPath}`);
            await this.waitForDaemonInfo(projectPath, 10000);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            log(`Failed to start daemon: ${detail}`);
            const message = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
                ? 'Moe could not start Node.js. Run the Moe installer and restart VS Code, or set MOE_NODE_COMMAND to its executable path.'
                : `Moe could not start its daemon: ${detail}`;
            vscode.window.showErrorMessage(message);
        } finally {
            this.startInProgress = false;
        }
    }

    private async startProtectedDaemon(projectPath: string): Promise<void> {
        const home = process.env.HOME || process.env.USERPROFILE, windows = process.platform === 'win32';
        const selection = protectedDaemonCommand(projectPath, installedRoot(this.extensionPath),
            protectedNodeCandidate(process.env, home, windows, projectPath));
        if ('refused' in selection) {
            const message = `Protected execution profile: ${selection.refused}. Project and PATH copies of the Moe daemon are not used.`;
            log(message);
            vscode.window.showErrorMessage(message);
            return;
        }
        this.startInProgress = true;
        try {
            const { node, args, cwd } = selection.ready;
            const env = protectedDaemonEnvironment(process.env, projectPath, node, windows, home);
            await new Promise<void>((resolve, reject) => {
                const proc = spawn(node, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd, env });
                proc.once('error', reject);
                proc.once('spawn', () => { proc.unref(); resolve(); });
            });
            log(`Started Moe daemon (start) for ${projectPath}`);
            await this.waitForDaemonInfo(projectPath, 10000);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            log(`Failed to start daemon: ${detail}`);
            const message = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
                ? 'Moe could not start Node.js. Run the Moe installer and restart VS Code, or set MOE_NODE_COMMAND to its executable path.'
                : `Moe could not start its daemon: ${detail}`;
            vscode.window.showErrorMessage(message);
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
                    const content = readDaemonJsonText(daemonInfoPath);
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
                        this.disconnect({ manual: false });
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
                        if (payload.status === 'ARCHIVED') {
                            // STATE_SNAPSHOT strips ARCHIVED tasks; mirror that here so an
                            // archived task does not linger in the cache (see TASK_DELETED).
                            this.state.tasks = this.state.tasks.filter(t => t.id !== payload.id);
                        } else {
                            const idx = this.state.tasks.findIndex(t => t.id === payload.id);
                            if (idx >= 0) {
                                this.state.tasks[idx] = payload;
                            } else {
                                this.state.tasks.push(payload);
                            }
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

                case 'ACCOUNTS_UPDATED':
                case 'ACCOUNT_ADDED':
                    // Claude accounts are managed in the JetBrains Accounts tab; VS Code has no account UI.
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

                case 'METRICS':
                    // Daemon emits a MetricsAggregate-shaped payload. Tolerate
                    // missing fields — consumers must already handle absence.
                    this._onMetrics.fire({
                        firstPassApprovalPct: payload?.firstPassApprovalPct,
                        avgWallClockMs: payload?.avgWallClockMs,
                        avgReopenCount: payload?.avgReopenCount,
                        totalCompleted: payload?.totalCompleted,
                        perEpic: Array.isArray(payload?.perEpic) ? payload.perEpic : []
                    });
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

                case 'ERROR': {
                    log(`Daemon error: ${message.message ?? payload?.message ?? 'unknown'}`);
                    // The daemon puts operation/code/codeName at the TOP level;
                    // the nested payload lookup is the older shape and stays on
                    // as the fallback. Reading only the nested one is why a
                    // stale-approval refusal used to arrive uncorrelated.
                    const code = message.code ?? payload?.code;
                    const codeName = message.codeName ?? payload?.codeName;
                    const context = allowlistedErrorContext(message.context ?? payload?.context);
                    this._onError.fire({
                        operation: message.operation ?? payload?.operation,
                        message: message.message ?? payload?.message ?? 'Unknown error',
                        ...(typeof code === 'number' && Number.isFinite(code) && { code }),
                        ...(typeof codeName === 'string' && codeName.length > 0 && { codeName }),
                        ...(context && { context }),
                    });
                    break;
                }

                case 'DAEMON_SHUTTING_DOWN':
                    log('Daemon is shutting down');
                    this.daemonShuttingDown = true;
                    this.disconnect({ manual: false });
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
        // Clear any prior interval so a re-entrant start can't orphan a 30s timer.
        this.stopPingInterval();
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
        if (this.manualDisconnect) {
            log('Reconnect suppressed after manual disconnect');
            return;
        }
        if (this.reconnectTimeout) {
            log('Reconnect already scheduled');
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
                    this.connect().catch((err) => {
                        log(`Manual reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
                        this.setConnectionState('disconnected');
                    });
                }
            });
            return;
        }

        const attempt = this.reconnectAttempts;
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this.connect().catch((err) => {
                log(`Reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
                this.setConnectionState('disconnected');
                this.scheduleReconnect();
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
        this._onMetrics.dispose();
    }
}
