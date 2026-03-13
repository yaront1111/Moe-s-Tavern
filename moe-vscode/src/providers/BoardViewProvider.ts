import * as vscode from 'vscode';
import { MoeDaemonClient, StateSnapshot } from '../services/MoeDaemonClient';
import { EpicDetailPanel } from '../panels/EpicDetailPanel';
import { TaskCreatePanel } from '../panels/TaskCreatePanel';
import { PlanReviewPanel } from '../panels/PlanReviewPanel';
import { TaskDetailPanel } from '../panels/TaskDetailPanel';

// Debug output channel for tracing webview lifecycle
let debugChannel: vscode.OutputChannel | undefined;
function dbg(msg: string): void {
    if (!debugChannel) {
        debugChannel = vscode.window.createOutputChannel('Moe Board Debug');
    }
    debugChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

export class BoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'moe.board';
    private _view?: vscode.WebviewView;
    private _webviewReady = false;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly daemonClient: MoeDaemonClient
    ) {
        // Listen for state changes
        this.disposables.push(
            daemonClient.onStateChanged((state) => {
                this.updateBoard(state);
            })
        );

        this.disposables.push(
            daemonClient.onConnectionChanged((status) => {
                this.updateConnectionStatus(status);
            })
        );

        this.disposables.push(
            daemonClient.onActivityLog((events) => {
                if (this._view && this._webviewReady) {
                    this._view.webview.postMessage({
                        type: 'activityLog',
                        events
                    });
                }
            })
        );
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        dbg('resolveWebviewView called');
        this._view = webviewView;
        this._webviewReady = false;

        webviewView.onDidDispose(() => {
            this._view = undefined;
            this._webviewReady = false;
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateConnectionStatus(this.daemonClient.connectionState);
                if (this.daemonClient.currentState) {
                    this.updateBoard(this.daemonClient.currentState);
                }
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // Register message handler BEFORE setting HTML to avoid race condition
        // where the webview sends 'ready' before the handler is in place.
        webviewView.webview.onDidReceiveMessage((message) => {
            switch (message.type) {
                case 'updateTaskStatus':
                    this.daemonClient.updateTaskStatus(message.taskId, message.status);
                    break;
                case 'approveTask':
                    this.daemonClient.approveTask(message.taskId);
                    break;
                case 'rejectTask':
                    this.daemonClient.rejectTask(message.taskId, message.reason);
                    break;
                case 'reopenTask':
                    this.daemonClient.reopenTask(message.taskId, message.reason);
                    break;
                case 'openTaskDetail':
                    this.openTaskDetail(message.taskId);
                    break;
                case 'createEpic':
                    EpicDetailPanel.createOrShow(
                        this.extensionUri,
                        this.daemonClient,
                        undefined,
                        this.daemonClient.currentState
                    );
                    break;
                case 'openEpicDetail':
                    if (message.epicId) {
                        EpicDetailPanel.createOrShow(
                            this.extensionUri,
                            this.daemonClient,
                            message.epicId,
                            this.daemonClient.currentState
                        );
                    }
                    break;
                case 'createTask':
                    if (this.daemonClient.currentState) {
                        TaskCreatePanel.createOrShow(
                            this.extensionUri,
                            this.daemonClient,
                            this.daemonClient.currentState
                        );
                    }
                    break;
                case 'approveProposal':
                    try {
                        this.daemonClient.approveProposal(message.proposalId);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Failed to approve proposal: ${errMsg}`);
                    }
                    break;
                case 'rejectProposal':
                    try {
                        this.daemonClient.rejectProposal(message.proposalId);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Failed to reject proposal: ${errMsg}`);
                    }
                    break;
                case 'showAgentMenu':
                    vscode.commands.executeCommand('moe.startAgent');
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('moe.openSettings');
                    break;
                case 'requestActivityLog':
                    try {
                        this.daemonClient.requestActivityLog(200);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Failed to request activity log: ${errMsg}`);
                    }
                    break;
                case 'deleteTask':
                    try {
                        this.daemonClient.deleteTask(message.taskId);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Failed to delete task: ${errMsg}`);
                    }
                    break;
                case 'archiveDoneTasks':
                    try {
                        this.daemonClient.archiveDoneTasks(message.epicId);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(`Failed to archive tasks: ${errMsg}`);
                    }
                    break;
                case 'connect':
                    vscode.commands.executeCommand('moe.connect');
                    break;
                case 'ready':
                    dbg('Received "ready" from webview');
                    this._webviewReady = true;
                    dbg(`connectionState=${this.daemonClient.connectionState}, hasState=${!!this.daemonClient.currentState}`);
                    // Send current state immediately
                    this.updateConnectionStatus(this.daemonClient.connectionState);
                    if (this.daemonClient.currentState) {
                        this.updateBoard(this.daemonClient.currentState);
                    } else if (this.daemonClient.connectionState === 'connected') {
                        dbg('State not cached yet, sending GET_STATE');
                        this.daemonClient.sendMessage('GET_STATE');
                    }
                    break;
            }
        });

        // Set HTML after handler is registered
        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Push current state directly — don't rely on webview sending 'ready'.
        // Use retries to handle cases where webview JS hasn't loaded yet.
        const pushState = () => {
            dbg(`pushState: connState=${this.daemonClient.connectionState}, hasState=${!!this.daemonClient.currentState}`);
            this.updateConnectionStatus(this.daemonClient.connectionState);
            if (this.daemonClient.currentState) {
                this.updateBoard(this.daemonClient.currentState);
            }
        };
        pushState();
        setTimeout(pushState, 300);
        setTimeout(pushState, 1000);
        setTimeout(pushState, 3000);
    }

    refresh(): void {
        if (this._view && this.daemonClient.currentState) {
            this.updateBoard(this.daemonClient.currentState);
        }
    }

    openTaskDetail(taskId: string): void {
        const state = this.daemonClient.currentState;
        const task = state?.tasks?.find(t => t.id === taskId);
        if (task && task.status === 'AWAITING_APPROVAL') {
            PlanReviewPanel.createOrShow(
                this.extensionUri,
                this.daemonClient,
                taskId,
                state
            );
        } else {
            TaskDetailPanel.createOrShow(
                this.extensionUri,
                this.daemonClient,
                taskId,
                state
            );
        }
    }

    private updateBoard(state: StateSnapshot): void {
        dbg(`updateBoard called, _view=${!!this._view}, tasks=${state?.tasks?.length ?? 'null'}`);
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateState',
                state
            });
            dbg('updateBoard postMessage sent');
        }
    }

    private updateConnectionStatus(status: string): void {
        dbg(`updateConnectionStatus called, _view=${!!this._view}, status=${status}`);
        if (this._view) {
            this._view.webview.postMessage({
                type: 'connectionStatus',
                status
            });
            dbg('updateConnectionStatus postMessage sent');
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'board.js'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
    <title>Moe Task Board</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 8px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
        }
        .status-dot.connected { background: #4caf50; }
        .status-dot.connecting { background: #ff9800; }
        .status-dot.disconnected { background: #f44336; }
        .connect-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            cursor: pointer;
            font-size: 11px;
            border-radius: 2px;
        }
        .connect-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .board {
            display: flex;
            gap: 8px;
            overflow-x: auto;
            min-height: 300px;
        }
        .column {
            min-width: 140px;
            flex: 1;
            background: var(--vscode-editor-background);
            border-radius: 4px;
            padding: 8px;
        }
        .column-header {
            font-weight: bold;
            font-size: 11px;
            text-transform: uppercase;
            margin-bottom: 8px;
            padding-bottom: 4px;
            border-bottom: 2px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
        }
        .column-header-right {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .create-task-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            width: 18px;
            height: 18px;
            font-size: 14px;
            line-height: 16px;
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }
        .create-task-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .column-count {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
        }
        .tasks {
            min-height: 50px;
        }
        .task-card {
            background: var(--vscode-list-hoverBackground);
            border: 1px solid var(--vscode-panel-border);
            border-left: 4px solid transparent;
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 6px;
            cursor: pointer;
            transition: background 0.15s;
        }
        .task-card:hover {
            background: var(--vscode-list-activeSelectionBackground);
        }
        .task-card.dragging {
            opacity: 0.5;
        }
        /* Status stripe colors */
        .task-card[data-status="BACKLOG"] { border-left-color: var(--vscode-descriptionForeground, #888); }
        .task-card[data-status="PLANNING"] { border-left-color: #ff9800; }
        .task-card[data-status="AWAITING_APPROVAL"] { border-left-color: #ffc107; }
        .task-card[data-status="WORKING"] { border-left-color: #2196f3; }
        .task-card[data-status="REVIEW"] { border-left-color: #9c27b0; }
        .task-card[data-status="DONE"] { border-left-color: #4caf50; }
        .task-title-row {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 4px;
        }
        .task-title {
            font-size: 12px;
            font-weight: 500;
            margin-bottom: 4px;
            word-break: break-word;
            flex: 1;
        }
        .task-desc {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
        }
        .task-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 3px;
            align-items: center;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .chip {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 8px;
            font-size: 10px;
            line-height: 14px;
            white-space: nowrap;
        }
        .chip-critical {
            background: #dc3545;
            color: #fff;
        }
        .chip-high {
            background: #ff9800;
            color: #fff;
        }
        .chip-low {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .chip-progress-done {
            background: #228b22;
            color: #fff;
        }
        .chip-progress-active {
            background: #1e90ff;
            color: #fff;
        }
        .chip-progress-pending {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .chip-epic {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            max-width: 100px;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chip-id {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-family: monospace;
        }
        .chip-status {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .chip-question {
            background: #ffc107;
            color: #000;
            font-weight: bold;
        }
        .task-worker {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 4px;
            border-radius: 2px;
            font-size: 9px;
        }
        .task-nav-btn {
            background: none;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 10px;
            padding: 0 4px;
            line-height: 16px;
            border-radius: 3px;
        }
        .task-nav-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-activeSelectionBackground));
            color: var(--vscode-foreground);
        }
        .task-nav-arrows {
            display: flex;
            gap: 2px;
            flex-shrink: 0;
        }
        .epic-group {
            margin-bottom: 4px;
        }
        .epic-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            cursor: pointer;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            margin-bottom: 4px;
            border-radius: 3px;
            user-select: none;
        }
        .epic-header:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .epic-header.dragging {
            opacity: 0.5;
        }
        .epic-toggle {
            width: 12px;
            display: inline-block;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .epic-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
            flex-shrink: 0;
        }
        .epic-status-dot[data-epic-status="ACTIVE"] { background: #4caf50; }
        .epic-status-dot[data-epic-status="PLANNED"] { background: #3B82F6; }
        .epic-status-dot[data-epic-status="COMPLETED"] { background: #9E9E9E; }
        .epic-title {
            font-weight: bold;
            font-size: 11px;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .epic-count {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 0 5px;
            border-radius: 8px;
            font-size: 10px;
            flex-shrink: 0;
        }
        .epic-status-chip {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }
        .epic-tasks {
            padding-left: 0;
        }
        .epic-tasks.collapsed {
            display: none;
        }
        .board-toolbar {
            display: flex;
            gap: 6px;
            align-items: center;
            margin-bottom: 8px;
            flex-wrap: wrap;
        }
        .epic-filter {
            padding: 3px 6px;
            font-family: var(--vscode-font-family);
            font-size: 11px;
            color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
            border-radius: 2px;
            outline: none;
            flex: 1;
            min-width: 80px;
            max-width: 180px;
        }
        .epic-filter:focus {
            border-color: var(--vscode-focusBorder);
        }
        .search-input {
            width: 100%;
            padding: 3px 22px 3px 8px;
            font-family: var(--vscode-font-family);
            font-size: 11px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 2px;
            outline: none;
        }
        .search-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .search-clear {
            position: absolute;
            right: 2px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 14px;
            padding: 0 4px;
            line-height: 1;
        }
        .search-clear:hover {
            color: var(--vscode-foreground);
        }
        .add-epic-btn {
            background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
            border: none;
            padding: 3px 8px;
            cursor: pointer;
            font-size: 11px;
            border-radius: 2px;
            white-space: nowrap;
        }
        .add-epic-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
        }
        .worker-panel {
            display: none;
            flex-direction: row;
            flex-wrap: wrap;
            gap: 8px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
        }
        .team-label {
            font-size: 11px;
            font-weight: bold;
            width: 100%;
            margin-top: 4px;
            color: var(--vscode-descriptionForeground);
        }
        .worker-card {
            width: 200px;
            height: 60px;
            border-radius: 4px;
            padding: 6px 8px;
            border: 1px solid var(--vscode-panel-border);
            border-left: 3px solid var(--vscode-panel-border);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .worker-card[data-status="BLOCKED"] {
            border-left-color: #dc3545;
        }
        .worker-card[data-status="CODING"],
        .worker-card[data-status="PLANNING"] {
            border-left-color: #007bff;
        }
        .worker-card[data-status="AWAITING_APPROVAL"] {
            border-left-color: #ffc107;
        }
        .worker-card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .worker-type {
            font-weight: bold;
            font-size: 12px;
        }
        .worker-status {
            font-size: 10px;
        }
        .worker-status[data-status="BLOCKED"] { color: #dc3545; }
        .worker-status[data-status="CODING"],
        .worker-status[data-status="PLANNING"] { color: #007bff; }
        .worker-status[data-status="AWAITING_APPROVAL"] { color: #ffc107; }
        .worker-task {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            margin-top: 4px;
        }
        .tab-bar {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding: 0 8px;
            margin-bottom: 8px;
        }
        .tab {
            padding: 6px 12px;
            border: none;
            background: transparent;
            cursor: pointer;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            border-bottom: 2px solid transparent;
        }
        .tab.active {
            border-bottom-color: var(--vscode-focusBorder);
            font-weight: bold;
        }
        .tab:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .proposal-card {
            border: 1px solid var(--vscode-panel-border);
            padding: 10px;
            margin: 8px 0;
            border-radius: 4px;
        }
        .proposal-header {
            font-weight: bold;
            font-size: 13px;
            margin-bottom: 4px;
        }
        .proposal-field {
            font-size: 12px;
            margin: 2px 0;
        }
        .proposal-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .proposal-actions {
            display: flex;
            gap: 8px;
            margin-top: 6px;
        }
        .btn-approve {
            background: none;
            border: 1px solid #4caf50;
            color: #4caf50;
            padding: 3px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 11px;
        }
        .btn-approve:hover { background: rgba(76,175,80,0.15); }
        .btn-approve:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-reject {
            background: none;
            border: 1px solid #f44336;
            color: #f44336;
            padding: 3px 10px;
            border-radius: 3px;
            cursor: pointer;
            font-family: var(--vscode-font-family);
            font-size: 11px;
        }
        .btn-reject:hover { background: rgba(244,67,54,0.15); }
        .btn-reject:disabled { opacity: 0.5; cursor: not-allowed; }
        .muted {
            color: var(--vscode-descriptionForeground);
        }
        .proposals-header {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 8px;
        }
        .proposals-container {
            padding: 8px;
        }
        .activity-container {
            padding: 8px;
        }
        .activity-toolbar {
            margin-bottom: 8px;
        }
        .activity-filter {
            padding: 3px 6px;
            font-family: var(--vscode-font-family);
            font-size: 11px;
            color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
            border-radius: 2px;
            outline: none;
        }
        .activity-filter:focus {
            border-color: var(--vscode-focusBorder);
        }
        .activity-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        .activity-table th {
            text-align: left;
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: bold;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .activity-table td {
            padding: 3px 8px;
            font-size: 11px;
        }
        .activity-table tr:nth-child(even) {
            background: var(--vscode-list-hoverBackground);
        }
        .archive-btn {
            background: transparent;
            color: var(--vscode-descriptionForeground);
            border: none;
            cursor: pointer;
            font-size: 14px;
            padding: 0 2px;
            line-height: 1;
        }
        .archive-btn:hover {
            color: var(--vscode-errorForeground, #f44336);
        }
        .context-menu {
            position: fixed;
            background: var(--vscode-menu-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            z-index: 1000;
            min-width: 150px;
            padding: 4px 0;
        }
        .context-menu-item {
            padding: 4px 12px;
            cursor: pointer;
            font-size: 12px;
            color: var(--vscode-menu-foreground, var(--vscode-foreground));
        }
        .context-menu-item:hover {
            background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
            color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
        }
        .context-menu-item.danger {
            color: var(--vscode-errorForeground, #f44336);
        }
        .context-menu-separator {
            height: 1px;
            background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
            margin: 4px 0;
        }
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state h3 {
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="status">
            <span class="status-dot disconnected" id="statusDot"></span>
            <span id="statusText">Disconnected</span>
        </div>
        <div style="display:flex;gap:4px;">
            <button class="connect-btn" id="agentsBtn" data-action="showAgentMenu" style="display:none;">Agents</button>
            <button class="connect-btn" id="settingsBtn" data-action="openSettings" style="display:none;" title="Settings">&#9881;</button>
            <button class="connect-btn" id="connectBtn" data-action="connect">Connect</button>
        </div>
    </div>
    <div class="tab-bar" id="tabBar" style="display:none;">
        <button class="tab active" data-tab="board" data-action="switchTab">Board</button>
        <button class="tab" data-tab="proposals" data-action="switchTab">Proposals</button>
        <button class="tab" data-tab="activity" data-action="switchTab">Activity Log</button>
    </div>
    <div class="tab-content active" id="boardTab">
        <div class="board-toolbar" id="boardToolbar" style="display:none;">
            <select class="epic-filter" id="epicFilter"><option value="">All Epics</option></select>
            <div style="position:relative;flex:1;min-width:100px;max-width:200px;">
                <input type="text" class="search-input" id="searchInput" placeholder="Search tasks..." />
                <button class="search-clear" id="searchClear" style="display:none;">&times;</button>
            </div>
            <button class="add-epic-btn" id="addEpicBtn">+ Epic</button>
        </div>
        <div class="worker-panel" id="workerPanel"></div>
        <div class="board" id="board">
            <div class="empty-state">
                <h3>Connecting...</h3>
                <p>Waiting for daemon</p>
            </div>
        </div>
    </div>
    <div class="tab-content" id="proposalsTab">
        <div class="proposals-container" id="proposalsContainer">
            <p class="muted">No pending proposals</p>
        </div>
    </div>
    <div class="tab-content" id="activityTab">
        <div class="activity-container" id="activityContainer">
            <p class="muted">Activity log placeholder</p>
        </div>
    </div>

    <script src="${scriptUri}"></script>

</body>
</html>`;
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
