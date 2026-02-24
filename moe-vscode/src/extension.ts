import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BoardViewProvider } from './providers/BoardViewProvider';
import { MoeDaemonClient } from './services/MoeDaemonClient';
import { ConnectionStatusBar } from './statusbar/ConnectionStatusBar';
import { EpicDetailPanel } from './panels/EpicDetailPanel';
import { PlanReviewPanel } from './panels/PlanReviewPanel';
import { TaskCreatePanel } from './panels/TaskCreatePanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { TaskDetailPanel } from './panels/TaskDetailPanel';
import { launchAgent, launchAllAgents, AgentProvider, AgentRole } from './util/AgentLauncher';

let daemonClient: MoeDaemonClient | undefined;
let statusBar: ConnectionStatusBar | undefined;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Moe');
    outputChannel.appendLine('Moe extension is activating...');

    // Initialize daemon client
    daemonClient = new MoeDaemonClient(context.extensionPath);
    context.subscriptions.push(daemonClient);

    // Initialize status bar
    statusBar = new ConnectionStatusBar(daemonClient);
    context.subscriptions.push(statusBar);

    // Initialize board view provider
    const boardProvider = new BoardViewProvider(context.extensionUri, daemonClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('moe.board', boardProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('moe.connect', async () => {
            await daemonClient?.connect();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.disconnect', () => {
            daemonClient?.disconnect();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.refresh', () => {
            boardProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.openTaskDetail', (taskId: string) => {
            if (!daemonClient) { return; }
            TaskDetailPanel.createOrShow(
                context.extensionUri,
                daemonClient,
                taskId,
                daemonClient.currentState
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.reviewPlan', (taskId: string) => {
            if (!daemonClient) { return; }
            const state = daemonClient.currentState;
            const task = state?.tasks.find(t => t.id === taskId);
            if (!task) {
                vscode.window.showWarningMessage('Task not found or state unavailable');
                return;
            }
            PlanReviewPanel.createOrShow(context.extensionUri, daemonClient, taskId, state);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.createTask', () => {
            if (!daemonClient) { return; }
            const state = daemonClient.currentState;
            if (!state) {
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
                return;
            }
            TaskCreatePanel.createOrShow(context.extensionUri, daemonClient, state);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.createEpic', () => {
            if (!daemonClient) { return; }
            const state = daemonClient.currentState;
            if (!state) {
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
                return;
            }
            EpicDetailPanel.createOrShow(context.extensionUri, daemonClient, undefined, state);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.openEpicDetail', (epicId: string) => {
            if (!daemonClient) { return; }
            const state = daemonClient.currentState;
            if (!state) {
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
                return;
            }
            EpicDetailPanel.createOrShow(context.extensionUri, daemonClient, epicId, state);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.openSettings', () => {
            if (!daemonClient) { return; }
            const state = daemonClient.currentState;
            if (!state) {
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
                return;
            }
            SettingsPanel.createOrShow(context.extensionUri, daemonClient, state);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.archiveDoneTasks', async () => {
            if (!daemonClient || !daemonClient.currentState) {
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
                return;
            }
            try {
                const epics = daemonClient.currentState.epics || [];
                if (epics.length > 0) {
                    const items: Array<{ label: string; description: string; epicId: string | undefined }> = [
                        { label: 'All Epics', description: 'Archive done tasks across all epics', epicId: undefined },
                        ...epics.map(e => ({ label: e.title, description: e.id, epicId: e.id }))
                    ];
                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: 'Archive done tasks for which epic?'
                    });
                    if (selected) {
                        daemonClient.archiveDoneTasks(selected.epicId);
                        vscode.window.showInformationMessage('Done tasks archived');
                    }
                } else {
                    daemonClient.archiveDoneTasks();
                    vscode.window.showInformationMessage('Done tasks archived');
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to archive tasks: ${errMsg}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.showDaemonStatus', async () => {
            if (!daemonClient) {
                vscode.window.showWarningMessage('Daemon client not initialized');
                return;
            }

            const connState = daemonClient.connectionState;
            const items: vscode.QuickPickItem[] = [
                { label: `Status: ${connState}`, kind: vscode.QuickPickItemKind.Default, description: '' },
            ];

            // Read daemon.json for PID, port, uptime
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const daemonJsonPath = path.join(workspaceFolders[0].uri.fsPath, '.moe', 'daemon.json');
                    if (fs.existsSync(daemonJsonPath)) {
                        const daemonInfo = JSON.parse(fs.readFileSync(daemonJsonPath, 'utf-8'));
                        if (daemonInfo.pid) {
                            items.push({ label: `PID: ${daemonInfo.pid}`, description: '' });
                        }
                        if (daemonInfo.port) {
                            items.push({ label: `Port: ${daemonInfo.port}`, description: '' });
                        }
                        if (daemonInfo.startedAt) {
                            const elapsed = Date.now() - new Date(daemonInfo.startedAt).getTime();
                            const minutes = Math.floor(elapsed / 60000);
                            const hours = Math.floor(minutes / 60);
                            const uptime = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
                            items.push({ label: `Uptime: ${uptime}`, description: '' });
                        }
                    } else {
                        items.push({ label: 'Daemon not running', description: 'No daemon.json found' });
                    }
                }
            } catch {
                // Ignore daemon.json read errors
            }

            // Add task/epic counts
            const currentState = daemonClient.currentState;
            if (currentState) {
                const taskCount = currentState.tasks?.length || 0;
                const epicCount = currentState.epics?.length || 0;
                const workerCount = currentState.workers?.length || 0;
                items.push({ label: `Tasks: ${taskCount} | Epics: ${epicCount} | Workers: ${workerCount}`, description: '' });
            }

            items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
            items.push({ label: 'Restart Daemon', description: 'Disconnect and reconnect' });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Daemon Status'
            });

            if (selected?.label === 'Restart Daemon') {
                vscode.commands.executeCommand('moe.restartDaemon');
            }
        })
    );

    // Helper to pick a provider (with workspace state persistence)
    async function pickProvider(ctx: vscode.ExtensionContext): Promise<{ provider: AgentProvider; customCommand?: string } | undefined> {
        const lastProvider = ctx.workspaceState.get<AgentProvider>('moe.lastProvider', 'claude');
        const lastCustomCmd = ctx.workspaceState.get<string>('moe.lastCustomCommand', '');

        const providers: Array<{ label: string; description: string; provider: AgentProvider }> = [
            { label: 'Claude', description: lastProvider === 'claude' ? 'Last used' : '', provider: 'claude' },
            { label: 'Codex', description: lastProvider === 'codex' ? 'Last used' : '', provider: 'codex' },
            { label: 'Gemini', description: lastProvider === 'gemini' ? 'Last used' : '', provider: 'gemini' },
            { label: 'Custom...', description: lastProvider === 'custom' && lastCustomCmd ? `Last: ${lastCustomCmd}` : 'Enter a custom CLI command', provider: 'custom' },
        ];

        // Move last-used provider to top
        const lastIdx = providers.findIndex(p => p.provider === lastProvider);
        if (lastIdx > 0) {
            const [item] = providers.splice(lastIdx, 1);
            providers.unshift(item);
        }

        const selected = await vscode.window.showQuickPick(providers, {
            placeHolder: 'Select agent provider'
        });
        if (!selected) { return undefined; }

        let customCommand: string | undefined;
        if (selected.provider === 'custom') {
            const cmd = await vscode.window.showInputBox({
                prompt: 'Enter the CLI command to launch agents',
                value: lastCustomCmd,
                placeHolder: 'e.g., /path/to/my-agent'
            });
            if (!cmd) { return undefined; }
            customCommand = cmd;
            await ctx.workspaceState.update('moe.lastCustomCommand', cmd);
        }

        await ctx.workspaceState.update('moe.lastProvider', selected.provider);
        return { provider: selected.provider, customCommand };
    }

    function getTeamName(ctx: vscode.ExtensionContext): string | undefined {
        const teamEnabled = ctx.workspaceState.get<boolean>('moe.teamMode', false);
        if (!teamEnabled) { return undefined; }
        const state = daemonClient?.currentState;
        return state?.project?.name || 'moe-team';
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.startAgent', async () => {
            try {
                const teamEnabled = context.workspaceState.get<boolean>('moe.teamMode', false);

                type MenuItem = { label: string; kind?: vscode.QuickPickItemKind; role?: AgentRole; action?: string };
                const items: MenuItem[] = [
                    { label: `$(${teamEnabled ? 'check' : 'circle-outline'}) Team Mode`, action: 'toggleTeam' },
                    { label: '', kind: vscode.QuickPickItemKind.Separator },
                    { label: 'Start All Agents', action: 'startAll' },
                    { label: '', kind: vscode.QuickPickItemKind.Separator },
                    { label: 'Start Architect', role: 'architect' as AgentRole },
                    { label: 'Start Worker', role: 'worker' as AgentRole },
                    { label: 'Start QA', role: 'qa' as AgentRole },
                ];

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Start Moe Agent'
                });
                if (!selected) { return; }

                if (selected.action === 'toggleTeam') {
                    const newVal = !teamEnabled;
                    await context.workspaceState.update('moe.teamMode', newVal);
                    vscode.window.showInformationMessage(`Team mode ${newVal ? 'enabled' : 'disabled'}`);
                    return;
                }

                const providerChoice = await pickProvider(context);
                if (!providerChoice) { return; }

                const teamName = getTeamName(context);

                if (selected.action === 'startAll') {
                    launchAllAgents(providerChoice.provider, context.extensionPath, {
                        customCommand: providerChoice.customCommand,
                        teamName,
                    });
                    vscode.window.showInformationMessage('Starting all agents...');
                } else if (selected.role) {
                    launchAgent(selected.role, providerChoice.provider, context.extensionPath, {
                        customCommand: providerChoice.customCommand,
                        teamName,
                    });
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to start agent: ${errMsg}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.startAllAgents', async () => {
            try {
                const providerChoice = await pickProvider(context);
                if (!providerChoice) { return; }

                const teamName = getTeamName(context);
                launchAllAgents(providerChoice.provider, context.extensionPath, {
                    customCommand: providerChoice.customCommand,
                    teamName,
                });
                vscode.window.showInformationMessage('Starting all agents (architect, worker, qa)...');
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to start agents: ${errMsg}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.showActivityLog', () => {
            if (!daemonClient || daemonClient.connectionState !== 'connected') {
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
                return;
            }
            daemonClient.requestActivityLog(50);
            const disposable = daemonClient.onActivityLog((events) => {
                disposable.dispose();
                const lines = events.map(e => {
                    const ts = new Date(e.timestamp).toLocaleTimeString();
                    const taskPart = e.taskId ? ` [${e.taskId.slice(-8)}]` : '';
                    const workerPart = e.workerId ? ` (${e.workerId})` : '';
                    return `${ts} ${e.event}${taskPart}${workerPart}`;
                });
                const doc = lines.join('\n') || 'No activity events found.';
                vscode.workspace.openTextDocument({ content: doc, language: 'log' }).then(
                    (textDoc) => vscode.window.showTextDocument(textDoc, { preview: true })
                );
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.restartDaemon', async () => {
            if (!daemonClient) {
                vscode.window.showWarningMessage('Daemon client not initialized');
                return;
            }
            try {
                daemonClient.disconnect();
                vscode.window.showInformationMessage('Disconnected. Reconnecting to daemon...');
                await daemonClient.connect();
                vscode.window.showInformationMessage('Reconnected to daemon');
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to reconnect: ${errMsg}`);
            }
        })
    );

    // Auto-connect if enabled
    const config = vscode.workspace.getConfiguration('moe');
    if (config.get<boolean>('autoConnect', true)) {
        daemonClient.connect().catch((err) => {
            outputChannel.appendLine(`Auto-connect failed: ${err.message}`);
        });
    }

    outputChannel.appendLine('Moe extension activated');
}

export function deactivate() {
    // Disposal is handled via context.subscriptions
}
