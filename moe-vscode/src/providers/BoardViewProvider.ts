import * as vscode from 'vscode';
import { MoeDaemonClient, StateSnapshot } from '../services/MoeDaemonClient';
import { EpicDetailPanel } from '../panels/EpicDetailPanel';
import { TaskCreatePanel } from '../panels/TaskCreatePanel';
import { PlanReviewPanel } from '../panels/PlanReviewPanel';
import { TaskDetailPanel } from '../panels/TaskDetailPanel';

export class BoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'moe.board';
    private _view?: vscode.WebviewView;
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
                if (this._view) {
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
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);

        // Handle messages from the webview
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
                    // Webview is ready, send current state
                    if (this.daemonClient.currentState) {
                        this.updateBoard(this.daemonClient.currentState);
                    }
                    this.updateConnectionStatus(this.daemonClient.connectionState);
                    break;
            }
        });
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
        if (this._view) {
            this._view.webview.postMessage({
                type: 'updateState',
                state
            });
        }
    }

    private updateConnectionStatus(status: string): void {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'connectionStatus',
                status
            });
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
            <button class="connect-btn" id="agentsBtn" onclick="showAgentMenu()" style="display:none;">Agents</button>
            <button class="connect-btn" id="settingsBtn" onclick="openSettings()" style="display:none;" title="Settings">&#9881;</button>
            <button class="connect-btn" id="connectBtn" onclick="connect()">Connect</button>
        </div>
    </div>
    <div class="tab-bar" id="tabBar" style="display:none;">
        <button class="tab active" data-tab="board" onclick="switchTab('board')">Board</button>
        <button class="tab" data-tab="proposals" onclick="switchTab('proposals')">Proposals</button>
        <button class="tab" data-tab="activity" onclick="switchTab('activity')">Activity Log</button>
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
                <h3>Not Connected</h3>
                <p>Click Connect to start</p>
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

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const columns = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
        const columnNames = {
            'BACKLOG': 'Backlog',
            'PLANNING': 'Planning',
            'AWAITING_APPROVAL': 'Approval',
            'WORKING': 'Working',
            'REVIEW': 'Review',
            'DONE': 'Done'
        };

        let currentState = null;
        let draggedTaskId = null;
        let draggedEpicId = null;
        let selectedEpicFilter = '';
        const collapsedEpics = new Set();
        let activeTab = 'board';

        function switchTab(tabName) {
            activeTab = tabName;
            var tabs = document.querySelectorAll('.tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tabName);
            }
            var contents = document.querySelectorAll('.tab-content');
            for (var j = 0; j < contents.length; j++) {
                contents[j].classList.toggle('active', contents[j].id === tabName + 'Tab');
            }
            // Re-render active tab content
            if (currentState) {
                if (tabName === 'proposals') {
                    renderProposals(currentState.proposals || []);
                } else if (tabName === 'activity') {
                    vscode.postMessage({ type: 'requestActivityLog' });
                }
            }
        }

        function renderProposals(proposals) {
            var container = document.getElementById('proposalsContainer');
            if (!container) { return; }

            var pending = (proposals || []).filter(function(p) { return p.status === 'PENDING'; });

            if (pending.length === 0) {
                container.textContent = '';
                var emptyP = document.createElement('p');
                emptyP.className = 'muted';
                emptyP.textContent = 'No pending proposals';
                container.appendChild(emptyP);
                return;
            }

            var html = '<div class="proposals-header">Rail Proposals</div>';
            pending.forEach(function(p) {
                var proposalId = escapeHtml(p.id || '');
                html += '<div class="proposal-card">';
                html += '<div class="proposal-header">' + escapeHtml(p.proposalType || '') + ' - ' + escapeHtml(p.targetScope || '') + '</div>';
                if (p.currentValue) {
                    html += '<div class="proposal-field muted">Current: ' + escapeHtml(p.currentValue) + '</div>';
                }
                html += '<div class="proposal-field">Proposed: ' + escapeHtml(p.proposedValue || '') + '</div>';
                if (p.reason) {
                    html += '<div class="proposal-field muted">Reason: ' + escapeHtml(p.reason) + '</div>';
                }
                var taskInfo = p.taskId ? p.taskId.slice(-8) : '?';
                var workerInfo = p.workerId ? escapeHtml(p.workerId) : '?';
                html += '<div class="proposal-info">Task: ' + escapeHtml(taskInfo) + ' | Worker: ' + workerInfo + '</div>';
                html += '<div class="proposal-actions">';
                html += '<button class="btn-approve" data-proposal-id="' + proposalId + '" onclick="approveProposal(this)">Approve</button>';
                html += '<button class="btn-reject" data-proposal-id="' + proposalId + '" onclick="rejectProposal(this)">Reject</button>';
                html += '</div>';
                html += '</div>';
            });

            container.textContent = '';
            container.insertAdjacentHTML('beforeend', html);
        }

        function approveProposal(btn) {
            var proposalId = btn.getAttribute('data-proposal-id');
            if (!proposalId) { return; }
            btn.disabled = true;
            vscode.postMessage({ type: 'approveProposal', proposalId: proposalId });
        }

        function rejectProposal(btn) {
            var proposalId = btn.getAttribute('data-proposal-id');
            if (!proposalId) { return; }
            btn.disabled = true;
            vscode.postMessage({ type: 'rejectProposal', proposalId: proposalId });
        }

        // Activity Log
        var activityEvents = [];
        var activityFilter = '';

        function renderActivityLog(events) {
            if (events && events.length > 0) {
                activityEvents = events;
            }

            var container = document.getElementById('activityContainer');
            if (!container) { return; }

            var filtered = activityFilter
                ? activityEvents.filter(function(e) { return e.event === activityFilter; })
                : activityEvents;

            if (filtered.length === 0) {
                container.textContent = '';
                var emptyP = document.createElement('p');
                emptyP.className = 'muted';
                emptyP.textContent = activityEvents.length === 0 ? 'No activity recorded' : 'No matching events';
                container.appendChild(emptyP);
                return;
            }

            var html = '<div class="activity-toolbar">';
            html += '<select class="activity-filter" id="activityFilterSelect" onchange="onActivityFilterChange(this.value)">';
            html += '<option value="">All Events</option>';
            var eventTypes = ['TASK_CREATED','TASK_UPDATED','TASK_DELETED','EPIC_CREATED','EPIC_UPDATED',
                'PLAN_SUBMITTED','PLAN_APPROVED','PLAN_REJECTED','STEP_STARTED','STEP_COMPLETED',
                'TASK_COMPLETED','TASK_BLOCKED'];
            eventTypes.forEach(function(t) {
                var sel = activityFilter === t ? ' selected' : '';
                html += '<option value="' + escapeHtml(t) + '"' + sel + '>' + escapeHtml(t) + '</option>';
            });
            html += '</select></div>';

            html += '<table class="activity-table"><thead><tr><th>Timestamp</th><th>Event</th><th>Details</th></tr></thead><tbody>';
            filtered.forEach(function(evt) {
                var ts = formatTimestamp(evt.timestamp);
                var details = buildEventDetails(evt);
                html += '<tr><td>' + escapeHtml(ts) + '</td><td>' + escapeHtml(evt.event || '') + '</td><td>' + escapeHtml(details) + '</td></tr>';
            });
            html += '</tbody></table>';

            container.textContent = '';
            container.insertAdjacentHTML('beforeend', html);
        }

        function onActivityFilterChange(value) {
            activityFilter = value;
            renderActivityLog(null);
        }

        function formatTimestamp(isoStr) {
            try {
                var d = new Date(isoStr);
                if (isNaN(d.getTime())) { return isoStr || ''; }
                var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
                    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            } catch (e) {
                return isoStr || '';
            }
        }

        function buildEventDetails(evt) {
            var parts = [];
            if (evt.taskId) { parts.push('Task:' + evt.taskId.slice(-8)); }
            if (evt.epicId) { parts.push('Epic:' + evt.epicId.slice(-8)); }
            if (evt.workerId) { parts.push('Worker:' + evt.workerId); }
            if (evt.payload) {
                try {
                    var p = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
                    Object.keys(p).forEach(function(k) {
                        if (k !== 'taskId' && k !== 'epicId' && k !== 'workerId') {
                            var v = typeof p[k] === 'object' ? JSON.stringify(p[k]) : String(p[k]);
                            if (v.length > 50) { v = v.substring(0, 47) + '...'; }
                            parts.push(k + ':' + v);
                        }
                    });
                } catch (e) {
                    // ignore payload parse errors
                }
            }
            return parts.join(' | ');
        }

        function connect() {
            vscode.postMessage({ type: 'connect' });
        }

        function showAgentMenu() {
            vscode.postMessage({ type: 'showAgentMenu' });
        }

        function openSettings() {
            vscode.postMessage({ type: 'openSettings' });
        }

        // Context menu
        var activeContextMenu = null;

        function closeContextMenu() {
            if (activeContextMenu) {
                activeContextMenu.remove();
                activeContextMenu = null;
            }
        }

        document.addEventListener('click', closeContextMenu);
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { closeContextMenu(); }
        });

        document.addEventListener('contextmenu', function(e) {
            var card = e.target.closest('.task-card');
            if (!card) { return; }
            e.preventDefault();
            closeContextMenu();

            var taskId = card.getAttribute('data-task-id');
            if (!taskId) { return; }

            var menu = document.createElement('div');
            menu.className = 'context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';

            var openItem = document.createElement('div');
            openItem.className = 'context-menu-item';
            openItem.textContent = 'Open';
            openItem.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeContextMenu();
                vscode.postMessage({ type: 'openTaskDetail', taskId: taskId });
            });
            menu.appendChild(openItem);

            var askItem = document.createElement('div');
            askItem.className = 'context-menu-item';
            askItem.textContent = 'Ask Question';
            askItem.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeContextMenu();
                vscode.postMessage({ type: 'openTaskDetail', taskId: taskId });
            });
            menu.appendChild(askItem);

            var sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);

            var deleteItem = document.createElement('div');
            deleteItem.className = 'context-menu-item danger';
            deleteItem.textContent = 'Delete';
            deleteItem.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeContextMenu();
                if (window.confirm('Delete this task?')) {
                    vscode.postMessage({ type: 'deleteTask', taskId: taskId });
                }
            });
            menu.appendChild(deleteItem);

            document.body.appendChild(menu);
            activeContextMenu = menu;

            // Ensure menu stays within viewport
            var rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
            }
        });

        var searchQuery = '';

        // Epic filter and Add Epic button handlers
        document.getElementById('epicFilter').addEventListener('change', function() {
            selectedEpicFilter = this.value;
            if (currentState) { renderBoard(currentState); }
        });
        document.getElementById('addEpicBtn').addEventListener('click', function() {
            vscode.postMessage({ type: 'createEpic' });
        });

        // Search input handler
        document.getElementById('searchInput').addEventListener('input', function() {
            searchQuery = this.value.toLowerCase();
            var clearBtn = document.getElementById('searchClear');
            if (clearBtn) { clearBtn.style.display = searchQuery ? 'block' : 'none'; }
            if (currentState) { renderBoard(currentState); }
        });
        document.getElementById('searchClear').addEventListener('click', function() {
            searchQuery = '';
            var input = document.getElementById('searchInput');
            if (input) { input.value = ''; }
            this.style.display = 'none';
            if (currentState) { renderBoard(currentState); }
        });

        const workflowOrder = ['BACKLOG','PLANNING','AWAITING_APPROVAL','WORKING','REVIEW','DONE'];

        function updateEpicFilter(epics) {
            var filterEl = document.getElementById('epicFilter');
            var toolbar = document.getElementById('boardToolbar');
            if (!filterEl || !toolbar) { return; }
            toolbar.style.display = 'flex';

            var prevValue = selectedEpicFilter;
            filterEl.textContent = '';
            var allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = 'All Epics';
            filterEl.appendChild(allOpt);

            var sortedEpics = (epics || []).slice().sort(function(a, b) {
                var oa = a.order || 0;
                var ob = b.order || 0;
                if (oa !== ob) { return oa - ob; }
                return (a.title || '').localeCompare(b.title || '');
            });
            var foundPrev = false;
            sortedEpics.forEach(function(epic) {
                var opt = document.createElement('option');
                opt.value = epic.id;
                opt.textContent = epic.title || epic.id;
                filterEl.appendChild(opt);
                if (epic.id === prevValue) { foundPrev = true; }
            });
            if (foundPrev) {
                filterEl.value = prevValue;
                selectedEpicFilter = prevValue;
            } else {
                filterEl.value = '';
                selectedEpicFilter = '';
            }
        }

        function renderWorkerPanel(workers, teams, tasks) {
            var panel = document.getElementById('workerPanel');
            if (!panel) { return; }

            if (!workers || workers.length === 0) {
                panel.style.display = 'none';
                panel.textContent = '';
                return;
            }

            // Build task map for current task title lookup
            var taskMap = {};
            if (tasks && tasks.length) {
                tasks.forEach(function(t) { taskMap[t.id] = t; });
            }

            // Build team map
            var teamMap = {};
            if (teams && teams.length) {
                teams.forEach(function(t) { teamMap[t.id] = t; });
            }

            // Group workers by teamId
            var teamGroups = {};
            var teamOrder = [];
            var soloWorkers = [];

            workers.forEach(function(w) {
                if (w.teamId && teamMap[w.teamId]) {
                    if (!teamGroups[w.teamId]) {
                        teamGroups[w.teamId] = [];
                        teamOrder.push(w.teamId);
                    }
                    teamGroups[w.teamId].push(w);
                } else {
                    soloWorkers.push(w);
                }
            });

            var html = '';

            // Render team groups
            teamOrder.forEach(function(tid) {
                var team = teamMap[tid];
                var teamName = team ? team.name : tid;
                html += '<span class="team-label">[' + escapeHtml(teamName) + ']</span>';
                teamGroups[tid].forEach(function(w) {
                    html += renderWorkerCard(w, taskMap);
                });
            });

            // Render solo workers
            if (soloWorkers.length > 0 && teamOrder.length > 0) {
                html += '<span class="team-label">[Solo]</span>';
            }
            soloWorkers.forEach(function(w) {
                html += renderWorkerCard(w, taskMap);
            });

            panel.textContent = '';
            panel.insertAdjacentHTML('beforeend', html);
            panel.style.display = 'flex';
        }

        function renderWorkerCard(worker, taskMap) {
            var wStatus = escapeHtml(worker.status || 'IDLE');
            var wType = escapeHtml(worker.type || worker.id || 'worker');

            // Determine body text: current task title, lastError, or Idle
            var bodyText = 'Idle';
            if (worker.currentTaskId && taskMap[worker.currentTaskId]) {
                var title = taskMap[worker.currentTaskId].title || '';
                bodyText = title.length > 28 ? title.substring(0, 27).trimEnd() + '...' : title;
            } else if (worker.lastError) {
                bodyText = worker.lastError.length > 28 ? worker.lastError.substring(0, 27).trimEnd() + '...' : worker.lastError;
            }

            return '<div class="worker-card" data-status="' + wStatus + '">'
                + '<div class="worker-card-header">'
                + '<span class="worker-type">' + wType + '</span>'
                + '<span class="worker-status" data-status="' + wStatus + '">' + wStatus + '</span>'
                + '</div>'
                + '<div class="worker-task" title="' + escapeHtml(bodyText) + '">' + escapeHtml(bodyText) + '</div>'
                + '</div>';
        }

        var lastBoardFingerprint = '';
        var columnFingerprints = {};

        function computeBoardFingerprint(state) {
            try {
                var taskFp = (state.tasks || []).slice().sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(t) {
                    var stepsFp = (t.implementationPlan || []).map(function(s) {
                        return (s.stepId || '') + ':' + (s.status || '');
                    }).join(';');
                    return [t.id, t.status, t.order, t.title, t.priority,
                        t.assignedWorkerId || '', (t.comments || []).length,
                        t.hasPendingQuestion || false, stepsFp].join(':');
                }).join('|');

                var epicFp = (state.epics || []).slice().sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(e) {
                    return [e.id, e.title, e.status, e.order].join(':');
                }).join('|');

                var filterFp = 'epic=' + selectedEpicFilter + '|search=' + searchQuery;
                var collapseFp = Array.from(collapsedEpics).sort().join(',');

                var workerFp = (state.workers || []).map(function(w) {
                    return [w.id, w.status, w.currentTaskId || ''].join(':');
                }).join('|');

                return taskFp + '##' + epicFp + '##' + filterFp + '##' + collapseFp + '##' + workerFp;
            } catch (e) {
                return '';
            }
        }

        function computeColumnFingerprint(columnTasks, epics, status) {
            try {
                var taskFp = columnTasks.slice().sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(t) {
                    var stepsFp = (t.implementationPlan || []).map(function(s) {
                        return (s.stepId || '') + ':' + (s.status || '');
                    }).join(';');
                    return [t.id, t.order, t.title, t.priority,
                        t.assignedWorkerId || '', (t.comments || []).length,
                        t.hasPendingQuestion || false, stepsFp].join(':');
                }).join('|');

                var relevantEpicIds = {};
                columnTasks.forEach(function(t) {
                    if (t.epicId) { relevantEpicIds[t.epicId] = true; }
                });
                var epicFp = epics.filter(function(e) {
                    return relevantEpicIds[e.id];
                }).sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(e) {
                    return [e.id, e.title, e.status, e.order].join(':');
                }).join('|');

                var collapseFp = Array.from(collapsedEpics).sort().join(',');

                return status + '##' + taskFp + '##' + epicFp + '##' + collapseFp;
            } catch (e) {
                return '';
            }
        }

        function renderBoard(state) {
            currentState = state;
            const board = document.getElementById('board');

            if (!state || !state.tasks) {
                lastBoardFingerprint = '';
                columnFingerprints = {};
                board.textContent = '';
                var toolbar = document.getElementById('boardToolbar');
                if (toolbar) { toolbar.style.display = 'none'; }
                var workerPanel = document.getElementById('workerPanel');
                if (workerPanel) { workerPanel.style.display = 'none'; workerPanel.textContent = ''; }
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                const h3 = document.createElement('h3');
                h3.textContent = 'No Tasks';
                const p = document.createElement('p');
                p.textContent = 'Create tasks in the IDE';
                empty.appendChild(h3);
                empty.appendChild(p);
                board.appendChild(empty);
                return;
            }

            // Board-level fingerprint check - skip re-render if unchanged
            var newFingerprint = computeBoardFingerprint(state);
            if (newFingerprint && newFingerprint === lastBoardFingerprint) {
                return;
            }
            lastBoardFingerprint = newFingerprint;

            const epics = state.epics || [];
            updateEpicFilter(epics);

            // Render worker panel
            renderWorkerPanel(state.workers || [], state.teams || [], state.tasks || []);

            // Apply epic filter
            var filteredTasks = state.tasks;
            if (selectedEpicFilter) {
                filteredTasks = state.tasks.filter(function(t) {
                    return t.epicId === selectedEpicFilter;
                });
            }

            // Apply search filter
            if (searchQuery) {
                filteredTasks = filteredTasks.filter(function(t) {
                    return (t.title || '').toLowerCase().includes(searchQuery)
                        || (t.description || '').toLowerCase().includes(searchQuery);
                });
            }

            // Column-level diffing: only re-render columns whose fingerprint changed
            try {
                var needsFullRebuild = !board.querySelector('.column');

                if (needsFullRebuild) {
                    // First render or board was cleared - build all columns
                    var html = '';
                    columns.forEach(function(status) {
                        var colTasks = filteredTasks.filter(function(t) { return t.status === status; });
                        var groupedHtml = renderGroupedTasks(colTasks, epics, status);
                        var addBtn = (status === 'BACKLOG')
                            ? '<button class="create-task-btn" onclick="createTask(event)" title="Create Task">+</button>'
                            : '';
                        var archiveBtn = (status === 'DONE' && colTasks.length > 0)
                            ? '<button class="archive-btn" onclick="archiveDone(event, ' + colTasks.length + ')" title="Archive done tasks">&times;</button>'
                            : '';
                        html += '<div class="column" id="column-' + escapeHtml(status) + '" data-status="' + escapeHtml(status) + '"'
                            + ' ondragover="onDragOver(event)" ondrop="onDrop(event, \'' + escapeHtml(status) + '\')">'
                            + '<div class="column-header">'
                            + '<span>' + escapeHtml(columnNames[status] || status) + '</span>'
                            + '<span class="column-header-right"><span class="column-count">' + colTasks.length + '</span>' + addBtn + archiveBtn + '</span>'
                            + '</div>'
                            + '<div class="tasks">' + groupedHtml + '</div>'
                            + '</div>';

                        columnFingerprints[status] = computeColumnFingerprint(colTasks, epics, status);
                    });
                    board.textContent = '';
                    board.insertAdjacentHTML('beforeend', html);
                } else {
                    // Incremental update - only re-render changed columns
                    columns.forEach(function(status) {
                        var colTasks = filteredTasks.filter(function(t) { return t.status === status; });
                        var colFp = computeColumnFingerprint(colTasks, epics, status);

                        if (colFp && colFp === columnFingerprints[status]) {
                            return; // Skip unchanged column
                        }

                        var colEl = document.getElementById('column-' + status);
                        if (!colEl) {
                            return; // Column element missing, skip (will be caught on next full rebuild)
                        }

                        // Save scroll position of the tasks container
                        var tasksEl = colEl.querySelector('.tasks');
                        var scrollTop = tasksEl ? tasksEl.scrollTop : 0;

                        // Re-render column content
                        var groupedHtml = renderGroupedTasks(colTasks, epics, status);
                        var addBtn = (status === 'BACKLOG')
                            ? '<button class="create-task-btn" onclick="createTask(event)" title="Create Task">+</button>'
                            : '';
                        var archiveBtn = (status === 'DONE' && colTasks.length > 0)
                            ? '<button class="archive-btn" onclick="archiveDone(event, ' + colTasks.length + ')" title="Archive done tasks">&times;</button>'
                            : '';

                        var colHtml = '<div class="column-header">'
                            + '<span>' + escapeHtml(columnNames[status] || status) + '</span>'
                            + '<span class="column-header-right"><span class="column-count">' + colTasks.length + '</span>' + addBtn + archiveBtn + '</span>'
                            + '</div>'
                            + '<div class="tasks">' + groupedHtml + '</div>';

                        colEl.textContent = '';
                        colEl.insertAdjacentHTML('beforeend', colHtml);

                        // Restore scroll position
                        var newTasksEl = colEl.querySelector('.tasks');
                        if (newTasksEl && scrollTop > 0) {
                            newTasksEl.scrollTop = scrollTop;
                        }

                        columnFingerprints[status] = colFp;
                    });
                }
            } catch (e) {
                // On column diff error, clear fingerprints and force full rebuild
                columnFingerprints = {};
                var fallbackHtml = '';
                columns.forEach(function(status) {
                    var colTasks = filteredTasks.filter(function(t) { return t.status === status; });
                    var groupedHtml = renderGroupedTasks(colTasks, epics, status);
                    var addBtn = (status === 'BACKLOG')
                        ? '<button class="create-task-btn" onclick="createTask(event)" title="Create Task">+</button>'
                        : '';
                    var archiveBtn = (status === 'DONE' && colTasks.length > 0)
                        ? '<button class="archive-btn" onclick="archiveDone(event, ' + colTasks.length + ')" title="Archive done tasks">&times;</button>'
                        : '';
                    fallbackHtml += '<div class="column" id="column-' + escapeHtml(status) + '" data-status="' + escapeHtml(status) + '"'
                        + ' ondragover="onDragOver(event)" ondrop="onDrop(event, \'' + escapeHtml(status) + '\')">'
                        + '<div class="column-header">'
                        + '<span>' + escapeHtml(columnNames[status] || status) + '</span>'
                        + '<span class="column-header-right"><span class="column-count">' + colTasks.length + '</span>' + addBtn + archiveBtn + '</span>'
                        + '</div>'
                        + '<div class="tasks">' + groupedHtml + '</div>'
                        + '</div>';
                });
                board.textContent = '';
                board.insertAdjacentHTML('beforeend', fallbackHtml);
            }
        }

        function renderGroupedTasks(tasks, epics, columnStatus) {
            if (tasks.length === 0) { return ''; }

            // Group tasks by epicId
            var groups = {};
            var epicOrder = [];
            tasks.forEach(function(t) {
                var eid = t.epicId || '__ungrouped__';
                if (!groups[eid]) {
                    groups[eid] = [];
                    epicOrder.push(eid);
                }
                groups[eid].push(t);
            });

            // Sort epic groups by epic.order then epic.title
            epicOrder.sort(function(a, b) {
                if (a === '__ungrouped__') { return 1; }
                if (b === '__ungrouped__') { return -1; }
                var epicA = epics.find(function(e) { return e.id === a; });
                var epicB = epics.find(function(e) { return e.id === b; });
                var orderA = epicA ? (epicA.order || 0) : 9999;
                var orderB = epicB ? (epicB.order || 0) : 9999;
                if (orderA !== orderB) { return orderA - orderB; }
                var titleA = epicA ? epicA.title : '';
                var titleB = epicB ? epicB.title : '';
                return titleA.localeCompare(titleB);
            });

            // Sort tasks within each group by task.order
            Object.keys(groups).forEach(function(eid) {
                groups[eid].sort(function(a, b) {
                    return (a.order || 0) - (b.order || 0);
                });
            });

            // If only one epic group (or only ungrouped), skip grouping UI
            if (epicOrder.length === 1 && epicOrder[0] === '__ungrouped__') {
                return groups['__ungrouped__'].map(function(t) {
                    return renderTaskCard(t, epics, columnStatus);
                }).join('');
            }

            var result = '';
            epicOrder.forEach(function(eid) {
                var groupTasks = groups[eid];
                if (eid === '__ungrouped__') {
                    result += renderEpicGroup(null, 'Ungrouped', null, groupTasks, epics, columnStatus);
                } else {
                    var epic = epics.find(function(e) { return e.id === eid; });
                    var epicTitle = epic ? epic.title : 'Unknown Epic';
                    var epicStatus = epic ? epic.status : null;
                    result += renderEpicGroup(eid, epicTitle, epicStatus, groupTasks, epics, columnStatus);
                }
            });
            return result;
        }

        function renderEpicGroup(epicId, epicTitle, epicStatus, tasks, epics, columnStatus) {
            var isCollapsed = epicId ? collapsedEpics.has(epicId) : false;
            var toggleChar = isCollapsed ? '&#9654;' : '&#9660;';
            var safeEpicId = epicId ? escapeHtml(epicId) : '';

            var headerHtml = '<div class="epic-header"'
                + (epicId ? ' draggable="true" ondragstart="onEpicDragStart(event, \'' + safeEpicId + '\')" ondragend="onEpicDragEnd(event)"' : '')
                + ' onclick="toggleEpicCollapse(\'' + safeEpicId + '\')"'
                + (epicId ? ' ondblclick="openEpicDetail(event, \'' + safeEpicId + '\')"' : '')
                + '>'
                + '<span class="epic-toggle">' + toggleChar + '</span>';

            if (epicStatus) {
                headerHtml += '<span class="epic-status-dot" data-epic-status="' + escapeHtml(epicStatus) + '"></span>';
            }

            headerHtml += '<span class="epic-title" title="' + escapeHtml(epicTitle) + '">' + escapeHtml(epicTitle) + '</span>'
                + '<span class="epic-count">' + tasks.length + '</span>';

            if (epicStatus) {
                var statusLabel = epicStatus.charAt(0) + epicStatus.slice(1).toLowerCase();
                headerHtml += '<span class="epic-status-chip">' + escapeHtml(statusLabel) + '</span>';
            }

            headerHtml += '</div>';

            var tasksClass = 'epic-tasks' + (isCollapsed ? ' collapsed' : '');
            var tasksHtml = '<div class="' + tasksClass + '">';
            tasks.forEach(function(t) {
                tasksHtml += renderTaskCard(t, epics, columnStatus);
            });
            tasksHtml += '</div>';

            return '<div class="epic-group" data-epic-id="' + safeEpicId + '">'
                + headerHtml + tasksHtml + '</div>';
        }

        function toggleEpicCollapse(epicId) {
            if (!epicId) { return; }
            if (collapsedEpics.has(epicId)) {
                collapsedEpics.delete(epicId);
            } else {
                collapsedEpics.add(epicId);
            }
            if (currentState) {
                renderBoard(currentState);
            }
        }

        function openEpicDetail(event, epicId) {
            event.stopPropagation();
            if (!epicId) { return; }
            vscode.postMessage({ type: 'openEpicDetail', epicId: epicId });
        }

        function onEpicDragStart(event, epicId) {
            draggedEpicId = epicId;
            draggedTaskId = null;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'epic:' + epicId);
            var header = event.target.closest('.epic-header');
            if (header) { header.classList.add('dragging'); }
        }

        function onEpicDragEnd(event) {
            draggedEpicId = null;
            var header = event.target.closest('.epic-header');
            if (header) { header.classList.remove('dragging'); }
        }

        function renderTaskCard(task, epics, columnStatus) {
            const taskId = escapeHtml(task.id);
            const titleText = escapeHtml(task.title || '');
            const taskStatus = escapeHtml(task.status || '');

            // Description preview (first ~120 chars)
            let descHtml = '';
            if (task.description) {
                const desc = task.description.length > 120
                    ? task.description.substring(0, 119).trimEnd() + '...'
                    : task.description;
                descHtml = '<div class="task-desc">' + escapeHtml(desc) + '</div>';
            }

            // Build chips
            let chips = '';

            // Epic chip
            if (task.epicId && epics.length > 0) {
                const epic = epics.find(e => e.id === task.epicId);
                if (epic && epic.title) {
                    const epicLabel = epic.title.length > 18
                        ? epic.title.substring(0, 17).trimEnd() + '...'
                        : epic.title;
                    chips += '<span class="chip chip-epic" title="' + escapeHtml(epic.title) + '">' + escapeHtml(epicLabel) + '</span>';
                }
            }

            // Priority chip (skip MEDIUM)
            if (task.priority && task.priority !== 'MEDIUM') {
                const pClass = task.priority === 'CRITICAL' ? 'chip-critical'
                    : task.priority === 'HIGH' ? 'chip-high'
                    : task.priority === 'LOW' ? 'chip-low' : '';
                if (pClass) {
                    const pLabel = task.priority.charAt(0) + task.priority.slice(1).toLowerCase();
                    chips += '<span class="chip ' + pClass + '">' + escapeHtml(pLabel) + '</span>';
                }
            }

            // Status sub-chip (if task status differs from column)
            if (task.status && task.status !== columnStatus) {
                const statusLabel = task.status.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
                chips += '<span class="chip chip-status">' + escapeHtml(statusLabel) + '</span>';
            }

            // Step progress chip
            if (task.implementationPlan && task.implementationPlan.length > 0) {
                const steps = task.implementationPlan;
                const total = steps.length;
                const completed = steps.filter(s => s.status === 'COMPLETED').length;
                const inProgress = steps.filter(s => s.status === 'IN_PROGRESS').length;
                const progressClass = completed === total ? 'chip-progress-done'
                    : inProgress > 0 ? 'chip-progress-active'
                    : 'chip-progress-pending';
                chips += '<span class="chip ' + progressClass + '">' + completed + '/' + total + '</span>';
            }

            // Pending question chip
            if (task.hasPendingQuestion) {
                chips += '<span class="chip chip-question" title="Pending question">?</span>';
            }

            // Task ID chip (last 4 chars uppercase)
            if (task.id) {
                const idShort = task.id.slice(-4).toUpperCase();
                chips += '<span class="chip chip-id">' + escapeHtml(idShort) + '</span>';
            }

            // Worker badge
            let workerHtml = '';
            if (task.assignedWorkerId) {
                workerHtml = '<span class="task-worker">' + escapeHtml(task.assignedWorkerId) + '</span>';
            }

            // Nav arrows
            const statusIdx = workflowOrder.indexOf(task.status);
            let navHtml = '';
            const showPrev = statusIdx > 0;
            const showNext = statusIdx >= 0 && statusIdx < workflowOrder.length - 1;
            if (showPrev || showNext) {
                navHtml = '<div class="task-nav-arrows">';
                if (showPrev) {
                    navHtml += '<button class="task-nav-btn" onclick="navTask(event, \\'' + taskId + '\\', \\'prev\\')" title="Move back">&#9664;</button>';
                }
                if (showNext) {
                    navHtml += '<button class="task-nav-btn" onclick="navTask(event, \\'' + taskId + '\\', \\'next\\')" title="Move forward">&#9654;</button>';
                }
                navHtml += '</div>';
            }

            return \`
                <div class="task-card"
                     draggable="true"
                     data-task-id="\${taskId}"
                     data-status="\${taskStatus}"
                     ondragstart="onDragStart(event, '\${taskId}')"
                     ondragend="onDragEnd(event)"
                     onclick="openTask('\${taskId}')">
                    <div class="task-title-row">
                        <div class="task-title">\${titleText}</div>
                        \${navHtml}
                    </div>
                    \${descHtml}
                    <div class="task-meta">
                        \${chips}
                        \${workerHtml}
                    </div>
                </div>
            \`;
        }

        function escapeHtml(text) {
            if (!text) { return ''; }
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function onDragStart(event, taskId) {
            draggedTaskId = taskId;
            draggedEpicId = null;
            event.target.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'task:' + taskId);
        }

        function onDragEnd(event) {
            event.target.classList.remove('dragging');
            draggedTaskId = null;
        }

        function onDragOver(event) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        }

        function onDrop(event, newStatus) {
            event.preventDefault();
            if (draggedEpicId && currentState && currentState.tasks) {
                // Epic header drop: move all tasks in this epic to the new column status
                var tasksToMove = currentState.tasks.filter(function(t) {
                    return t.epicId === draggedEpicId;
                });
                tasksToMove.forEach(function(t) {
                    if (t.status !== newStatus) {
                        vscode.postMessage({
                            type: 'updateTaskStatus',
                            taskId: t.id,
                            status: newStatus
                        });
                    }
                });
                draggedEpicId = null;
            } else if (draggedTaskId) {
                vscode.postMessage({
                    type: 'updateTaskStatus',
                    taskId: draggedTaskId,
                    status: newStatus
                });
            }
        }

        function createTask(event) {
            event.stopPropagation();
            vscode.postMessage({ type: 'createTask' });
        }

        function archiveDone(event, count) {
            event.stopPropagation();
            if (count <= 0) { return; }
            if (window.confirm('Archive ' + count + ' done task' + (count > 1 ? 's' : '') + '?')) {
                vscode.postMessage({ type: 'archiveDoneTasks', epicId: selectedEpicFilter || undefined });
            }
        }

        function openTask(taskId) {
            vscode.postMessage({ type: 'openTaskDetail', taskId });
        }

        function navTask(event, taskId, direction) {
            event.stopPropagation();
            if (!currentState || !currentState.tasks) { return; }
            const task = currentState.tasks.find(t => t.id === taskId);
            if (!task) { return; }

            const idx = workflowOrder.indexOf(task.status);
            if (idx < 0) { return; }

            if (direction === 'next') {
                if (idx >= workflowOrder.length - 1) { return; }
                if (task.status === 'AWAITING_APPROVAL') {
                    vscode.postMessage({ type: 'approveTask', taskId: taskId });
                } else {
                    const newStatus = workflowOrder[idx + 1];
                    vscode.postMessage({ type: 'updateTaskStatus', taskId: taskId, status: newStatus });
                }
            } else if (direction === 'prev') {
                if (idx <= 0) { return; }
                if (task.status === 'REVIEW' || task.status === 'DONE') {
                    const reason = prompt('Reason for reopening:');
                    if (reason) {
                        vscode.postMessage({ type: 'reopenTask', taskId: taskId, reason: reason });
                    }
                } else {
                    const newStatus = workflowOrder[idx - 1];
                    vscode.postMessage({ type: 'updateTaskStatus', taskId: taskId, status: newStatus });
                }
            }
        }

        function updateConnectionStatus(status) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            const btn = document.getElementById('connectBtn');
            const agentsBtn = document.getElementById('agentsBtn');
            const settingsBtn = document.getElementById('settingsBtn');

            dot.className = 'status-dot ' + status;
            text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            btn.style.display = status === 'connected' ? 'none' : 'inline-block';
            if (agentsBtn) { agentsBtn.style.display = status === 'connected' ? 'inline-block' : 'none'; }
            if (settingsBtn) { settingsBtn.style.display = status === 'connected' ? 'inline-block' : 'none'; }
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateState':
                    currentState = message.state;
                    var tabBarEl = document.getElementById('tabBar');
                    if (tabBarEl) { tabBarEl.style.display = 'flex'; }
                    renderBoard(message.state);
                    if (activeTab === 'proposals') {
                        renderProposals((message.state && message.state.proposals) || []);
                    }
                    break;
                case 'connectionStatus':
                    updateConnectionStatus(message.status);
                    break;
                case 'activityLog':
                    renderActivityLog(message.events || []);
                    break;
            }
        });

        // Notify extension that webview is ready
        vscode.postMessage({ type: 'ready' });
    </script>
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
