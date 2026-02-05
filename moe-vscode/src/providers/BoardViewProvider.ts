import * as vscode from 'vscode';
import { MoeDaemonClient, StateSnapshot, Task } from '../services/MoeDaemonClient';

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
        const task = this.daemonClient.currentState?.tasks.find(t => t.id === taskId);
        if (!task) {
            return;
        }

        // Show task detail in a quick pick or webview panel
        const items: vscode.QuickPickItem[] = [
            { label: '$(eye) View Details', description: task.title }
        ];

        if (task.status === 'AWAITING_APPROVAL') {
            items.push(
                { label: '$(check) Approve', description: 'Approve the implementation plan' },
                { label: '$(x) Reject', description: 'Reject and send back for revision' }
            );
        }

        if (task.status === 'DONE' || task.status === 'REVIEW') {
            items.push({ label: '$(refresh) Reopen', description: 'Reopen for further work' });
        }

        vscode.window.showQuickPick(items, {
            placeHolder: `Task: ${task.title}`
        }).then((selected) => {
            if (!selected) { return; }

            if (selected.label.includes('Approve')) {
                this.daemonClient.approveTask(taskId);
                vscode.window.showInformationMessage(`Task "${task.title}" approved`);
            } else if (selected.label.includes('Reject')) {
                vscode.window.showInputBox({
                    prompt: 'Rejection reason',
                    placeHolder: 'Why is this plan being rejected?'
                }).then((reason) => {
                    if (reason) {
                        this.daemonClient.rejectTask(taskId, reason);
                        vscode.window.showInformationMessage(`Task "${task.title}" rejected`);
                    }
                });
            } else if (selected.label.includes('Reopen')) {
                vscode.window.showInputBox({
                    prompt: 'Reopen reason',
                    placeHolder: 'Why is this task being reopened?'
                }).then((reason) => {
                    if (reason) {
                        this.daemonClient.reopenTask(taskId, reason);
                        vscode.window.showInformationMessage(`Task "${task.title}" reopened`);
                    }
                });
            } else if (selected.label.includes('View Details')) {
                this.showTaskDetailPanel(task);
            }
        });
    }

    private showTaskDetailPanel(task: Task): void {
        const panel = vscode.window.createWebviewPanel(
            'moe.taskDetail',
            `Task: ${task.title}`,
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getTaskDetailHtml(task);
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
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 6px;
            cursor: pointer;
            transition: background 0.1s;
        }
        .task-card:hover {
            background: var(--vscode-list-activeSelectionBackground);
        }
        .task-card.dragging {
            opacity: 0.5;
        }
        .task-title {
            font-size: 12px;
            font-weight: 500;
            margin-bottom: 4px;
            word-break: break-word;
        }
        .task-meta {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .task-worker {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 1px 4px;
            border-radius: 2px;
            font-size: 9px;
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
        <button class="connect-btn" id="connectBtn" onclick="connect()">Connect</button>
    </div>
    <div class="board" id="board">
        <div class="empty-state">
            <h3>Not Connected</h3>
            <p>Click Connect to start</p>
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

        function connect() {
            vscode.postMessage({ type: 'connect' });
        }

        function renderBoard(state) {
            currentState = state;
            const board = document.getElementById('board');

            if (!state || !state.tasks) {
                board.innerHTML = '<div class="empty-state"><h3>No Tasks</h3><p>Create tasks in the IDE</p></div>';
                return;
            }

            let html = '';
            columns.forEach(status => {
                const tasks = state.tasks.filter(t => t.status === status);
                html += \`
                    <div class="column" data-status="\${status}"
                         ondragover="onDragOver(event)" ondrop="onDrop(event, '\${status}')">
                        <div class="column-header">
                            <span>\${columnNames[status]}</span>
                            <span class="column-count">\${tasks.length}</span>
                        </div>
                        <div class="tasks">
                            \${tasks.map(t => renderTask(t)).join('')}
                        </div>
                    </div>
                \`;
            });

            board.innerHTML = html;
        }

        function renderTask(task) {
            return \`
                <div class="task-card"
                     draggable="true"
                     data-task-id="\${task.id}"
                     ondragstart="onDragStart(event, '\${task.id}')"
                     ondragend="onDragEnd(event)"
                     onclick="openTask('\${task.id}')">
                    <div class="task-title">\${escapeHtml(task.title)}</div>
                    <div class="task-meta">
                        \${task.assignedWorkerId ? \`<span class="task-worker">\${task.assignedWorkerId}</span>\` : ''}
                    </div>
                </div>
            \`;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function onDragStart(event, taskId) {
            draggedTaskId = taskId;
            event.target.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
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
            if (draggedTaskId) {
                vscode.postMessage({
                    type: 'updateTaskStatus',
                    taskId: draggedTaskId,
                    status: newStatus
                });
            }
        }

        function openTask(taskId) {
            vscode.postMessage({ type: 'openTaskDetail', taskId });
        }

        function updateConnectionStatus(status) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            const btn = document.getElementById('connectBtn');

            dot.className = 'status-dot ' + status;
            text.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            btn.style.display = status === 'connected' ? 'none' : 'inline-block';
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateState':
                    renderBoard(message.state);
                    break;
                case 'connectionStatus':
                    updateConnectionStatus(message.status);
                    break;
            }
        });

        // Notify extension that webview is ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    private getTaskDetailHtml(task: Task): string {
        const steps = task.implementationPlan || [];
        const stepsHtml = steps.map((step, i) => `
            <div style="margin-bottom: 12px; padding: 8px; background: var(--vscode-editor-background); border-radius: 4px;">
                <div style="font-weight: bold;">Step ${i + 1}: ${step.status}</div>
                <div style="margin-top: 4px; font-size: 12px;">${this.escapeHtml(step.description)}</div>
                ${step.affectedFiles ? `<div style="margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground);">Files: ${step.affectedFiles.join(', ')}</div>` : ''}
            </div>
        `).join('');

        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        h1 { font-size: 18px; margin-bottom: 8px; }
        .meta { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
        .description { margin-bottom: 20px; }
        h2 { font-size: 14px; margin-bottom: 12px; }
    </style>
</head>
<body>
    <h1>${this.escapeHtml(task.title)}</h1>
    <div class="meta">Status: ${task.status} | ID: ${task.id}</div>
    <div class="description">${this.escapeHtml(task.description)}</div>
    ${steps.length > 0 ? `<h2>Implementation Plan</h2>${stepsHtml}` : ''}
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
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
