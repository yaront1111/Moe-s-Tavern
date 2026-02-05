import * as vscode from 'vscode';
import { BoardViewProvider } from './providers/BoardViewProvider';
import { MoeDaemonClient } from './services/MoeDaemonClient';
import { ConnectionStatusBar } from './statusbar/ConnectionStatusBar';

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
            boardProvider.openTaskDetail(taskId);
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
