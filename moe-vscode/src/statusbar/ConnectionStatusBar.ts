import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';

export class ConnectionStatusBar implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];

    constructor(private daemonClient: MoeDaemonClient) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'moe.connect';
        this.statusBarItem.show();

        // Listen for connection changes
        this.disposables.push(
            daemonClient.onConnectionChanged((status) => {
                this.updateStatus(status);
            })
        );

        // Set initial status
        this.updateStatus(daemonClient.connectionState);
    }

    private updateStatus(status: string): void {
        switch (status) {
            case 'connected':
                this.statusBarItem.text = '$(check) Moe';
                this.statusBarItem.tooltip = 'Connected to Moe daemon';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.command = 'moe.disconnect';
                break;
            case 'connecting':
                this.statusBarItem.text = '$(sync~spin) Moe';
                this.statusBarItem.tooltip = 'Connecting to Moe daemon...';
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.command = undefined;
                break;
            case 'disconnected':
            default:
                this.statusBarItem.text = '$(circle-slash) Moe';
                this.statusBarItem.tooltip = 'Disconnected from Moe daemon. Click to connect.';
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
