import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { declaredProfile, installedArtifact, installedRoot, runtimeProfile } from '../services/MoeDaemonClient';
import type { DeclaredProfile, ReadinessFailure, ReadinessReply } from '../services/MoeDaemonClient';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'grok' | 'custom';
export type AgentRole = 'architect' | 'worker' | 'qa' | 'governor';
type ReadinessSource = () => Promise<ReadinessReply>;
type LaunchOptions = { customCommand?: string; teamName?: string; readiness?: ReadinessSource };

interface ResolvedScript {
    scriptPath: string;
    envOverrides?: Record<string, string>;
}

const TERMINAL_NAMES: Record<AgentRole, string> = {
    architect: 'Moe Planner',
    worker: 'Moe Coder',
    qa: 'Moe QA',
    governor: 'Moe Governor',
};

/**
 * Resolve the agent launch script (moe-agent.ps1 or moe-agent.sh)
 * by checking workspace-local, bundled, and global install locations.
 */
function resolveAgentScript(
    extensionPath: string,
    workspacePath: string
): ResolvedScript | null {
    const isWin = process.platform === 'win32';
    const scriptName = isWin ? 'moe-agent.ps1' : 'moe-agent.sh';

    // 1. Check workspace-local scripts/
    const localScript = path.join(workspacePath, 'scripts', scriptName);
    if (fs.existsSync(localScript)) {
        return { scriptPath: localScript };
    }

    // 2. Check bundled scripts inside the extension
    const bundledScript = path.join(extensionPath, 'bundled', 'scripts', scriptName);
    if (fs.existsSync(bundledScript)) {
        const envOverrides: Record<string, string> = {};
        const bundledDaemon = path.join(extensionPath, 'bundled', 'daemon', 'index.js');
        if (fs.existsSync(bundledDaemon)) {
            envOverrides['MOE_DAEMON_PATH'] = bundledDaemon;
        }
        const bundledProxy = path.join(extensionPath, 'bundled', 'proxy', 'index.js');
        if (fs.existsSync(bundledProxy)) {
            envOverrides['MOE_PROXY_PATH'] = bundledProxy;
        }
        return {
            scriptPath: bundledScript,
            envOverrides: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
        };
    }

    // 3. Check global install path from ~/.moe/config.json
    try {
        const homedir = process.env.HOME || process.env.USERPROFILE || '';
        const configPath = path.join(homedir, '.moe', 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            const installPath: string | undefined = config?.installPath;
            if (installPath) {
                const globalScript = path.join(installPath, 'scripts', scriptName);
                if (fs.existsSync(globalScript)) {
                    const envOverrides: Record<string, string> = {};
                    const globalDaemon = path.join(installPath, 'packages', 'moe-daemon', 'dist', 'index.js');
                    if (fs.existsSync(globalDaemon)) {
                        envOverrides['MOE_DAEMON_PATH'] = globalDaemon;
                    }
                    const globalProxy = path.join(installPath, 'packages', 'moe-proxy', 'dist', 'index.js');
                    if (fs.existsSync(globalProxy)) {
                        envOverrides['MOE_PROXY_PATH'] = globalProxy;
                    }
                    return {
                        scriptPath: globalScript,
                        envOverrides: Object.keys(envOverrides).length > 0 ? envOverrides : undefined,
                    };
                }
            }
        }
    } catch {
        // Ignore config read errors
    }

    return null;
}

// Contract with scripts/moe-agent.{sh,ps1} (CQ-R13c2): exactly '1', set only after every installed
// artifact is accepted. A marker VS Code itself inherited is not stripped; the wrapper then fails closed.
export const PROTECTED_RUNTIME_MARKER = 'MOE_RUNTIME_PROTECTED';

/** The platform wrapper, daemon and proxy installed under `root`; never the project's scripts/ or a global install. */
export function selectProtectedAgentRuntime(
    basePath: string,
    root: string,
    windows: boolean = process.platform === 'win32'
): { scriptPath: string; envOverrides: Record<string, string> } | { refused: string } {
    const wrapper = installedArtifact(root, windows ? 'scripts/moe-agent.ps1' : 'scripts/moe-agent.sh', basePath);
    if ('rejected' in wrapper) { return { refused: wrapper.rejected }; }
    const envOverrides: Record<string, string> = {};
    for (const [name, relative] of [['MOE_DAEMON_PATH', 'daemon/index.js'], ['MOE_PROXY_PATH', 'proxy/index.js']]) {
        const selection = installedArtifact(root, relative, basePath);
        if ('rejected' in selection) { return { refused: selection.rejected }; }
        envOverrides[name] = selection.accepted;
    }
    envOverrides[PROTECTED_RUNTIME_MARKER] = '1';
    return { scriptPath: wrapper.accepted, envOverrides };
}

// ---- Verified-local Start Agent decision: a mirror of JetBrains VerifiedLocalLaunch (CQ-M07o, CQ-M07p) ----
// A worker or QA seat starts only after the daemon reports verified-local and ready; the wrapper's VM route then
// runs its agent. Every other answer refuses, and nothing falls back to the host.

/** The agent CLIs a Moe VM runs: the guest JOBS table (AGENT_JOBS in scripts/local-runner/guest-bridge.mjs). */
const VM_AGENT_COMMANDS = ['claude', 'codex'];
const MAX_SHOWN_COMMAND = 200;
const MAX_SHOWN_ID = 64;
const MAX_SHOWN_IDS = 32;
const NOTHING_STARTED = 'Nothing was started, and Moe never runs these agents on this machine instead.';
const FAILURES: Record<ReadinessFailure, string> = {
    NOT_CONNECTED: 'the Moe daemon is not connected',
    DISCONNECTED: 'the Moe daemon\'s connection closed before it answered',
    TIMEOUT: 'the Moe daemon did not answer within 20 seconds',
    DAEMON_ERROR: 'the Moe daemon could not report its readiness',
    MALFORMED: 'the Moe daemon\'s readiness answer could not be read',
};
const SEAT_NAMES: Partial<Record<AgentRole, string>> = { worker: 'worker', qa: 'QA' };

export type VmDecision = { launch: true } | { refused: string };

/** 'untrusted' counts on purpose: a project that might be verified-local never gets a host launch. */
export function isVmSeat(role: AgentRole, declared: DeclaredProfile): boolean {
    return (role === 'worker' || role === 'qa') && declared !== 'legacy-like';
}

const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Null for an agent CLI a Moe VM can run; otherwise the refusal naming `command`. */
export function agentRefusal(command: string): string | null {
    const trimmed = command.trim();
    if (VM_AGENT_COMMANDS.includes(trimmed)) { return null; }
    const shown = Array.from(trimmed.slice(0, MAX_SHOWN_COMMAND), c => (isControl(c.charCodeAt(0)) ? '?' : c)).join('');
    return 'Verified-local runs worker and QA agents only in a Moe VM, which has claude and codex. ' +
        `'${shown}' cannot run there, so no agent was started. Pick Claude or Codex.`;
}

// Daemon text keeps only [A-Za-z0-9._-] and at most 64 characters, so it cannot inject markup or control characters.
const shownId = (value: string): string => value.slice(0, MAX_SHOWN_ID).replace(/[^A-Za-z0-9._-]/g, '?');

/** `seats` is 'worker', 'QA' or 'worker and QA'. Never throws; only a ready verified-local answer launches. */
export function verifiedLocalDecision(seats: string, reply: ReadinessReply): VmDecision {
    const lead = `Moe did not start the ${seats} ${seats.includes(' and ') ? 'agents' : 'agent'}:`;
    if (!('answered' in reply)) { return { refused: `${lead} ${FAILURES[reply.failed] ?? FAILURES.MALFORMED}. ${NOTHING_STARTED}` }; }
    const { profile, ready, missingCapabilities: ids } = reply.answered;
    if (profile !== 'verified-local') {
        return { refused: `${lead} the daemon reports the '${shownId(profile)}' execution profile, while .moe/project.json ` +
            `asks for verified-local or could not be read strictly. ${NOTHING_STARTED}` };
    }
    if (ready === true && ids.length === 0) { return { launch: true }; }
    const more = ids.length > MAX_SHOWN_IDS ? `, and ${ids.length - MAX_SHOWN_IDS} more` : '';
    const missing = ids.length > 0 ? ` Missing: ${ids.slice(0, MAX_SHOWN_IDS).map(shownId).join(', ')}${more}.` : '';
    return { refused: `${lead} verified-local is not ready on this machine.${missing} ${NOTHING_STARTED}` };
}

/** Never rejects: a missing source refuses (never launches); a throwing source or unreadable reply is a daemon error. */
async function readinessDecision(seats: string, readiness?: ReadinessSource): Promise<VmDecision> {
    if (!readiness) { return verifiedLocalDecision(seats, { failed: 'NOT_CONNECTED' }); }
    try { return verifiedLocalDecision(seats, await readiness()); } catch { return verifiedLocalDecision(seats, { failed: 'DAEMON_ERROR' }); }
}

/** The CLI first (no readiness request for a refused one), then readiness. A refusal shows exactly one error. */
async function vmSeatsMayLaunch(seats: string, command: string, readiness?: ReadinessSource): Promise<boolean> {
    let refusal = agentRefusal(command);
    if (refusal === null) {
        const decision = await readinessDecision(seats, readiness);
        if ('launch' in decision) { return true; }
        refusal = decision.refused;
    }
    vscode.window.showErrorMessage(refusal);
    return false;
}

function randomHex8(): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Escape for a PowerShell single-quoted string: double any embedded single quote.
function psQuote(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

// Reject characters that would corrupt the command regardless of quoting:
// CR/LF break the terminal line and the -EncodedCommand framing, and a NUL
// byte is never legitimate in a path or team name. Names flow in from
// .moe/project.json and the workspace path, so they are not fully trusted.
function assertSafeArg(label: string, value: string): void {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 13 || code === 10 || code === 0) {
            throw new Error(`Invalid ${label}: contains control characters`);
        }
    }
}

// Escape for a Bash single-quoted string: close, insert escaped quote, reopen.
function shQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildPowerShellCommand(
    scriptPath: string,
    role: AgentRole,
    workspacePath: string,
    workerId: string,
    command: string,
    envOverrides?: Record<string, string>,
    teamName?: string
): string {
    // Validate the untrusted, free-form values before they are baked into a
    // command line. (Role is restricted by the AgentRole type.)
    assertSafeArg('workspace path', workspacePath);
    assertSafeArg('worker id', workerId);
    assertSafeArg('command', command);
    if (teamName) {
        assertSafeArg('team name', teamName);
    }

    let prefix = '';
    if (envOverrides) {
        for (const [key, value] of Object.entries(envOverrides)) {
            assertSafeArg(`env ${key}`, value);
            prefix += `$env:${key}=${psQuote(value)}; `;
        }
    }

    const inner =
        `& ${psQuote(scriptPath)} -Role ${role} -Project ${psQuote(workspacePath)} ` +
        `-WorkerId ${psQuote(workerId)} -Command ${psQuote(command)}` +
        (teamName ? ` -Team ${psQuote(teamName)}` : '');

    // Pass the inner script via -EncodedCommand (UTF-16LE base64) instead of an
    // outer -Command "..." wrapper. psQuote only doubles single quotes, so a
    // double quote in a project/team name would otherwise terminate the outer
    // double-quoted wrapper and inject arbitrary commands. Base64 has no shell
    // metacharacters, so no value can break out.
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    return `${prefix}powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function buildBashCommand(
    scriptPath: string,
    role: AgentRole,
    workspacePath: string,
    workerId: string,
    command: string,
    envOverrides?: Record<string, string>,
    teamName?: string
): string {
    let prefix = '';
    if (envOverrides) {
        for (const [key, value] of Object.entries(envOverrides)) {
            prefix += `${key}=${shQuote(value)} `;
        }
    }

    let cmd =
        `${prefix}bash ${shQuote(scriptPath)} --role ${role} --project ${shQuote(workspacePath)} ` +
        `--worker-id ${shQuote(workerId)} --command ${shQuote(command)}`;

    if (teamName) {
        cmd += ` --team ${shQuote(teamName)}`;
    }

    return cmd;
}

/**
 * Launch a single Moe agent in a VS Code terminal. Only a verified-local (or strictly unreadable) worker or QA seat
 * awaits readiness (`options.readiness`; missing refuses); every other launch opens its terminal synchronously.
 */
export function launchAgent(
    role: AgentRole,
    provider: AgentProvider,
    extensionPath: string,
    options?: LaunchOptions
): Promise<void> {
    return launchRole(role, provider, extensionPath, options);
}

// `shared` is launchAllAgents' single worker-and-QA decision, whose refusal it has already shown.
async function launchRole(
    role: AgentRole,
    provider: AgentProvider,
    extensionPath: string,
    options?: LaunchOptions,
    shared?: Promise<boolean>
): Promise<void> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open. Open a project first.');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        // A seat launchAllAgents already gated stays gated, even if the declaration changed since.
        const vmSeat = shared !== undefined || isVmSeat(role, declaredProfile(workspacePath));

        // runtimeProfile still runs first (it pins); a VM seat takes only the installed runtime whatever it reads.
        const resolved = runtimeProfile(workspacePath) === 'protected' || vmSeat
            ? selectProtectedAgentRuntime(workspacePath, installedRoot(extensionPath))
            : resolveAgentScript(extensionPath, workspacePath);
        if (resolved && 'refused' in resolved) {
            vscode.window.showErrorMessage(
                `Protected execution profile: ${resolved.refused}. ` +
                'Agents only use the wrapper, daemon and proxy installed with the Moe extension.'
            );
            return;
        }
        if (!resolved) {
            vscode.window.showErrorMessage(
                'Moe agent script not found. Ensure scripts/moe-agent exists in the workspace, extension bundle, or global install.'
            );
            return;
        }

        const workerId = `${role}-${randomHex8()}`;

        let command: string;
        if (provider === 'custom') {
            if (!options?.customCommand) {
                vscode.window.showErrorMessage('Custom provider requires a command. Set customCommand in options.');
                return;
            }
            command = options.customCommand;
        } else {
            command = provider;
        }
        // Never reached for a legacy seat, so its launch stays synchronous.
        if (vmSeat && !(await (shared ?? vmSeatsMayLaunch(SEAT_NAMES[role] ?? role, command, options?.readiness)))) {
            return;
        }

        const isWin = process.platform === 'win32';
        const terminalName = TERMINAL_NAMES[role];

        let terminalCommand: string;
        if (isWin) {
            terminalCommand = buildPowerShellCommand(
                resolved.scriptPath,
                role,
                workspacePath,
                workerId,
                command,
                resolved.envOverrides,
                options?.teamName
            );
        } else {
            terminalCommand = buildBashCommand(
                resolved.scriptPath,
                role,
                workspacePath,
                workerId,
                command,
                resolved.envOverrides,
                options?.teamName
            );
        }

        const terminal = vscode.window.createTerminal({
            name: terminalName,
            cwd: workspacePath,
        });
        terminal.sendText(terminalCommand);
        terminal.show();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to launch ${role} agent: ${message}`);
    }
}

/**
 * Launch all Moe agents (architect, worker, qa, governor) with staggered starts.
 */
export function launchAllAgents(
    provider: AgentProvider,
    extensionPath: string,
    options?: LaunchOptions
): void {
    void launchAgent('architect', provider, extensionPath, options);
    // Under verified-local, worker and QA share one decision, requested now, with at most one error.
    const folder = vscode.workspace.workspaceFolders?.[0];
    const shared = folder && isVmSeat('worker', declaredProfile(folder.uri.fsPath))
        ? vmSeatsMayLaunch('worker and QA', provider === 'custom' ? options?.customCommand ?? '' : provider, options?.readiness)
        : undefined;
    setTimeout(() => {
        void launchRole('worker', provider, extensionPath, options, shared);
    }, 1500);
    setTimeout(() => {
        void launchRole('qa', provider, extensionPath, options, shared);
    }, 3000);
    setTimeout(() => {
        void launchAgent('governor', provider, extensionPath, options);
    }, 4500);
}
