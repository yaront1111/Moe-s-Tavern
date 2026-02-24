import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';

export class ConnectionStatusBar implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];
    private connectionStatus: string = 'disconnected';
    private awaitingCount = 0;
    private workingCount = 0;

    constructor(private daemonClient: MoeDaemonClient) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.show();

        // Listen for connection changes
        this.disposables.push(
            daemonClient.onConnectionChanged((status) => {
                this.connectionStatus = status;
                if (status !== 'connected') {
                    this.awaitingCount = 0;
                    this.workingCount = 0;
                }
                this.updateDisplay();
            })
        );

        // Listen for state changes to update task counts
        this.disposables.push(
            daemonClient.onStateChanged((state) => {
                try {
                    const tasks = state?.tasks;
                    if (Array.isArray(tasks)) {
                        this.awaitingCount = tasks.filter(t => t.status === 'AWAITING_APPROVAL').length;
                        this.workingCount = tasks.filter(t => t.status === 'WORKING').length;
                    } else {
                        this.awaitingCount = 0;
                        this.workingCount = 0;
                    }
                } catch {
                    this.awaitingCount = 0;
                    this.workingCount = 0;
                }
                this.updateDisplay();
            })
        );

        // Set initial status
        this.connectionStatus = daemonClient.connectionState;
        this.updateDisplay();
    }

    private updateDisplay(): void {
        switch (this.connectionStatus) {
            case 'connected':
                this.statusBarItem.text = `$(check) Moe: ${this.awaitingCount} awaiting | ${this.workingCount} working`;
                this.statusBarItem.tooltip = `Moe: ${this.awaitingCount} tasks awaiting approval, ${this.workingCount} tasks in progress. Click to open board.`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.command = 'moe.board.focus';
                break;
            case 'connecting':
                this.statusBarItem.text = '$(sync~spin) Moe: connecting...';
                this.statusBarItem.tooltip = 'Moe: Connecting to daemon...';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.command = undefined;
                break;
            case 'disconnected':
            default:
                this.statusBarItem.text = '$(circle-slash) Moe: disconnected';
                this.statusBarItem.tooltip = 'Moe: Not connected. Click to connect.';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.statusBarItem.command = 'moe.connect';
                break;
        }
    }

    dispose(): void {
        this.statusBarItem.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}
