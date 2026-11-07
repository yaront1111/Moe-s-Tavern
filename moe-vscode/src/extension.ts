import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { BoardViewProvider } from './providers/BoardViewProvider';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { MetricsViewProvider } from './providers/MetricsViewProvider';
import { ManagedVmTreeProvider } from './providers/ManagedVmTreeProvider';
import { AccountsTreeProvider } from './providers/AccountsTreeProvider';
import { MoeDaemonClient, getOutputChannel, readDaemonJsonText, useProtectedStateRoot } from './services/MoeDaemonClient';
import type { ReadinessReply } from './services/MoeDaemonClient';
import { ConnectionStatusBar } from './statusbar/ConnectionStatusBar';
import { EpicDetailPanel } from './panels/EpicDetailPanel';
import { PlanReviewPanel } from './panels/PlanReviewPanel';
import { TaskCreatePanel } from './panels/TaskCreatePanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { TaskDetailPanel } from './panels/TaskDetailPanel';
import { launchAgent, launchAllAgents, AgentProvider, AgentRole, protectedAccountsTerminal } from './util/AgentLauncher';
import { isAntigravity, registerMcpServer } from './util/AntigravityIntegration';
import { registerTaskNotifier } from './util/TaskNotifier';
import { AgentSeatTracker, wireAgentSeats } from './util/AgentSeatTracker';
import { SeatPids, isProcessAlive } from './util/SeatSurvival';

let daemonClient: MoeDaemonClient | undefined;
let statusBar: ConnectionStatusBar | undefined;

/** The launcher's readiness source for verified-local worker and QA seats; no client refuses. */
const readiness = (): Promise<ReadinessReply> =>
    daemonClient ? daemonClient.requestExecutionReadiness() : Promise.resolve({ failed: 'NOT_CONNECTED' });

export function activate(context: vscode.ExtensionContext) {
    // Before anything reads runtimeProfile: the persisted protected pin lives per user, outside every workspace.
    useProtectedStateRoot(path.join(context.globalStorageUri.fsPath, 'protected-state'));
    // The client's "Moe" channel: one Output entry for the extension and the daemon client.
    const outputChannel = getOutputChannel();
    outputChannel.appendLine('Moe extension is activating...');

    // Initialize daemon client
    daemonClient = new MoeDaemonClient(context.extensionPath);
    context.subscriptions.push(daemonClient);

    // Initialize status bar
    statusBar = new ConnectionStatusBar(daemonClient);
    context.subscriptions.push(statusBar);

    // Task status notices, matching JetBrains MoeMessageDispatcher (VSC-1). Registered once per activation.
    context.subscriptions.push(registerTaskNotifier(daemonClient, vscode.window, vscode.commands));

    // Agent seats (VSC-21, matching JetBrains MoeProjectService.agentSeats). A wrapper killed with its terminal never
    // runs the exit trap that deregisters it, so this window deregisters the seats whose terminal it lost.
    const persist = (key: string, value: unknown): void => {
        context.workspaceState.update(key, value).then(undefined, err =>
            outputChannel.appendLine(`Moe could not save ${key}: ${err instanceof Error ? err.message : String(err)}`));
    };
    const seatPids = new SeatPids(
        () => context.workspaceState.get('moe.agentSeatPids'),
        pids => persist('moe.agentSeatPids', pids)
    );
    const seatTracker = new AgentSeatTracker(
        () => context.workspaceState.get<string[]>('moe.agentSeats', []),
        ids => { persist('moe.agentSeats', ids); seatPids.keep(ids); },
        workerId => { daemonClient?.deregisterWorker(workerId, 'terminal_closed'); }
    );
    // Unlike a JetBrains restart, a window reload (persistent terminal sessions) or Restart Extensions leaves seat
    // terminals running. A saved seat whose shell is still alive is open in this session too, so the first connect
    // must not deregister it.
    for (const workerId of seatPids.surviving(context.workspaceState.get<string[]>('moe.agentSeats', []), isProcessAlive)) {
        seatTracker.launched(workerId);
    }
    const seatTerminals = new WeakMap<vscode.Terminal, string>();
    const mapSurvivor = (terminal: vscode.Terminal): void => {
        terminal.processId.then(pid => {
            const workerId = seatPids.seatOf(pid);
            if (workerId && !seatTerminals.has(terminal)) { seatTerminals.set(terminal, workerId); }
        }, () => undefined);
    };
    vscode.window.terminals.forEach(mapSurvivor);
    // A persistent terminal can reconnect after activation.
    context.subscriptions.push(vscode.window.onDidOpenTerminal(mapSurvivor));
    context.subscriptions.push(wireAgentSeats({
        tracker: seatTracker,
        onDidCloseTerminal: vscode.window.onDidCloseTerminal,
        workerIdOf: terminal => seatTerminals.get(terminal),
        onConnected: daemonClient.onConnectionChanged,
        onAcked: daemonClient.onWorkerDeregistered,
    }));
    const onLaunched = (workerId: string, terminal: vscode.Terminal): void => {
        seatTerminals.set(terminal, workerId);
        seatTracker.launched(workerId);
        terminal.processId.then(pid => seatPids.record(workerId, pid), () => undefined);
    };

    // The board is an editor tab; the sidebar's Task Board entry is an empty tree whose welcome
    // content (package.json viewsWelcome) opens it, and which opens it itself whenever it is shown.
    const boardProvider = new BoardViewProvider(context.extensionUri, daemonClient);
    const boardLauncher = vscode.window.createTreeView<never>('moe.board', {
        treeDataProvider: { getChildren: () => [], getTreeItem: item => item }
    });
    const openBoardFromSidebar = (): void => {
        if (boardLauncher.visible && !boardProvider.isOpen) { boardProvider.show(true); }
    };
    context.subscriptions.push(
        boardProvider,
        vscode.window.registerWebviewPanelSerializer(BoardViewProvider.viewType, boardProvider),
        vscode.commands.registerCommand('moe.openBoard', () => boardProvider.show()),
        boardLauncher,
        boardLauncher.onDidChangeVisibility(openBoardFromSidebar)
    );
    openBoardFromSidebar();

    // Initialize chat view provider
    const chatProvider = new ChatViewProvider(context.extensionUri, daemonClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('moe.chat', chatProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Initialize metrics view provider
    const metricsProvider = new MetricsViewProvider(context.extensionUri, daemonClient);
    context.subscriptions.push(metricsProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('moe.metrics', metricsProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Managed VMs: owned-VM status with refresh, reconcile and cleanup (CQ-I05); never edits settings
    const managedVms = new ManagedVmTreeProvider(context.extensionPath, daemonClient);
    context.subscriptions.push(
        managedVms,
        vscode.window.registerTreeDataProvider('moe.managedVms', managedVms),
        vscode.commands.registerCommand('moe.managedVms.refresh', () => managedVms.refresh()),
        vscode.commands.registerCommand('moe.managedVms.reconcile', () => managedVms.reconcile()),
        vscode.commands.registerCommand('moe.managedVms.cleanup', () => managedVms.cleanup())
    );
    // Claude accounts: the read-only rotation view (VSC-14); a TreeView, because the chips line and the note go in its description and message
    const accountsProvider = new AccountsTreeProvider(daemonClient, undefined, protectedAccountsTerminal);
    const accountsView = vscode.window.createTreeView('moe.accounts', { treeDataProvider: accountsProvider });
    accountsProvider.attach(accountsView);
    context.subscriptions.push(accountsProvider, accountsView, vscode.commands.registerCommand('moe.accounts.refresh', () => accountsProvider.refresh()));
    context.subscriptions.push(...accountsProvider.registerCommands());
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
                taskId
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
            const archived = (sent: boolean): void => {
                if (sent) { vscode.window.showInformationMessage('Done tasks archived'); return; }
                vscode.window.showWarningMessage('Not connected to Moe daemon — done tasks were not archived.');
            };
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
                        archived(daemonClient.archiveDoneTasks(selected.epicId));
                    }
                } else {
                    archived(daemonClient.archiveDoneTasks());
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
                        const daemonInfo = JSON.parse(readDaemonJsonText(daemonJsonPath));
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
            items.push({ label: 'Reconnect to Daemon', description: 'Disconnect and connect again' });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Daemon Status'
            });

            if (selected?.label === 'Reconnect to Daemon') {
                vscode.commands.executeCommand('moe.reconnect');
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
            { label: 'Antigravity', description: lastProvider === 'gemini' ? 'Last used' : '', provider: 'gemini' },
            { label: 'Grok', description: lastProvider === 'grok' ? 'Last used' : '', provider: 'grok' },
            { label: 'Copilot', description: lastProvider === 'copilot' ? 'Last used' : '', provider: 'copilot' },
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
                    { label: 'Start Governor', role: 'governor' as AgentRole },
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
                        readiness,
                        onLaunched,
                    });
                    vscode.window.showInformationMessage('Starting all agents...');
                } else if (selected.role) {
                    void launchAgent(selected.role, providerChoice.provider, context.extensionPath, {
                        customCommand: providerChoice.customCommand,
                        teamName,
                        readiness,
                        onLaunched,
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
                    readiness,
                    onLaunched,
                });
                vscode.window.showInformationMessage('Starting all agents (architect, worker, qa, governor)...');
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
            // The reply to this request only: the board's own activity request can never answer it, nor this one the board's.
            let done = false;
            const sent = daemonClient.requestActivityLog(50, (events) => {
                if (done) { return; }
                done = true;
                clearTimeout(timeoutHandle);
                if (!events) {
                    vscode.window.showWarningMessage('Moe could not read the activity log.');
                    return;
                }
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
            // Bail if the daemon never replies.
            const timeoutHandle = setTimeout(() => {
                if (done) { return; }
                done = true;
                vscode.window.showWarningMessage('Activity log request timed out.');
            }, 10000);
            if (!sent) {
                done = true;
                clearTimeout(timeoutHandle);
                vscode.window.showWarningMessage('Not connected to daemon. Connect first.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('moe.reconnect', async () => {
            if (!daemonClient) {
                vscode.window.showWarningMessage('Daemon client not initialized');
                return;
            }
            try {
                vscode.window.showInformationMessage('Disconnected. Reconnecting to daemon...');
                // reconnect() waits out an attempt still in flight, so it never reports a connection it did not make.
                if (await daemonClient.reconnect()) {
                    vscode.window.showInformationMessage('Reconnected to daemon');
                }
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

    // Antigravity-specific integrations (no-op on vanilla VS Code)
    if (isAntigravity()) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && daemonClient) {
            const projectPath = workspaceFolders[0].uri.fsPath;
            registerMcpServer(context.extensionPath, projectPath, outputChannel);
        }
    }

    outputChannel.appendLine('Moe extension activated');
}

export function deactivate() {
    // Disposal is handled via context.subscriptions
}
