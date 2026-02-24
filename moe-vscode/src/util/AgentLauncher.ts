import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type AgentProvider = 'claude' | 'codex' | 'gemini' | 'custom';
export type AgentRole = 'architect' | 'worker' | 'qa';

interface ResolvedScript {
    scriptPath: string;
    envOverrides?: Record<string, string>;
}

const TERMINAL_NAMES: Record<AgentRole, string> = {
    architect: 'Moe Planner',
    worker: 'Moe Coder',
    qa: 'Moe QA',
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

function randomHex4(): string {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
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
    let prefix = '';
    if (envOverrides) {
        for (const [key, value] of Object.entries(envOverrides)) {
            prefix += `$env:${key}='${value}'; `;
        }
    }

    let cmd = `${prefix}powershell -NoProfile -ExecutionPolicy Bypass -Command "& '${scriptPath}' -Role ${role} -Project '${workspacePath}' -WorkerId '${workerId}' -Command '${command}'"`;

    if (teamName) {
        // Insert -Team before the closing quote
        cmd = `${prefix}powershell -NoProfile -ExecutionPolicy Bypass -Command "& '${scriptPath}' -Role ${role} -Project '${workspacePath}' -WorkerId '${workerId}' -Command '${command}' -Team '${teamName}'"`;
    }

    return cmd;
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
            prefix += `${key}='${value}' `;
        }
    }

    let cmd = `${prefix}bash '${scriptPath}' --role ${role} --project '${workspacePath}' --worker-id '${workerId}' --command '${command}'`;

    if (teamName) {
        cmd += ` --team '${teamName}'`;
    }

    return cmd;
}

/**
 * Launch a single Moe agent in a VS Code terminal.
 */
export function launchAgent(
    role: AgentRole,
    provider: AgentProvider,
    extensionPath: string,
    options?: { customCommand?: string; teamName?: string }
): void {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open. Open a project first.');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;

        const resolved = resolveAgentScript(extensionPath, workspacePath);
        if (!resolved) {
            vscode.window.showErrorMessage(
                'Moe agent script not found. Ensure scripts/moe-agent exists in the workspace, extension bundle, or global install.'
            );
            return;
        }

        const workerId = `${role}-${randomHex4()}`;

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
 * Launch all three Moe agents (architect, worker, qa) with staggered starts.
 */
export function launchAllAgents(
    provider: AgentProvider,
    extensionPath: string,
    options?: { customCommand?: string; teamName?: string }
): void {
    launchAgent('architect', provider, extensionPath, options);
    setTimeout(() => {
        launchAgent('worker', provider, extensionPath, options);
    }, 1500);
    setTimeout(() => {
        launchAgent('qa', provider, extensionPath, options);
    }, 3000);
}
