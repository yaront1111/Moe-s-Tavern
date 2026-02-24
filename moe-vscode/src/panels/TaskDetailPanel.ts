import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { MoeStateSnapshot, Task, TaskComment, TaskPriority } from '../types/moe';

/**
 * Task Detail Panel - a full-featured editor panel for viewing and editing tasks.
 *
 * Features:
 * - Editable fields: title, description, DoD, priority
 * - Implementation plan display with status icons and color coding
 * - Comments section with add-comment input
 * - Action buttons: Save, Approve, Reject, Reopen, Prev, Next, Delete
 * - PR link display
 * - Live updates via state change subscription
 */
export class TaskDetailPanel implements vscode.Disposable {
    public static readonly viewType = 'moe.taskDetail';

    /** Per-task singleton map */
    private static currentPanels: Map<string, TaskDetailPanel> = new Map();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly client: MoeDaemonClient;
    private readonly taskId: string;
    private readonly disposables: vscode.Disposable[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Create a new panel or reveal an existing one for the given task.
     */
    static createOrShow(
        extensionUri: vscode.Uri,
        client: MoeDaemonClient,
        taskId: string,
        _state: MoeStateSnapshot | undefined
    ): TaskDetailPanel {
        const existing = TaskDetailPanel.currentPanels.get(taskId);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            return existing;
        }

        const task = client.currentState?.tasks.find(t => t.id === taskId);
        const titleSuffix = task
            ? (task.title.length > 40 ? task.title.substring(0, 40) + '...' : task.title)
            : taskId;

        const panel = vscode.window.createWebviewPanel(
            TaskDetailPanel.viewType,
            `Task: ${titleSuffix}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );

        const instance = new TaskDetailPanel(extensionUri, panel, client, taskId);
        TaskDetailPanel.currentPanels.set(taskId, instance);
        return instance;
    }

    private constructor(
        extensionUri: vscode.Uri,
        panel: vscode.WebviewPanel,
        client: MoeDaemonClient,
        taskId: string
    ) {
        this.extensionUri = extensionUri;
        this.panel = panel;
        this.client = client;
        this.taskId = taskId;

        // Initial render
        const task = this.findTask();
        this.panel.webview.html = this.getWebviewContent(task);

        // Handle messages from webview
        this.disposables.push(
            this.panel.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg))
        );

        // Live updates: subscribe to state changes
        this.disposables.push(
            this.client.onStateChanged(() => {
                this.debouncedUpdate();
            })
        );

        // Cleanup on panel close
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private findTask(): Task | undefined {
        return this.client.currentState?.tasks.find(t => t.id === this.taskId);
    }

    private debouncedUpdate(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            const task = this.findTask();
            if (task) {
                this.panel.webview.postMessage({
                    type: 'updateTask',
                    task,
                });
            }
        }, 200);
    }

    private async handleWebviewMessage(msg: Record<string, unknown>): Promise<void> {
        try {
            switch (msg.type) {
                case 'save': {
                    const updates: { title?: string; description?: string; definitionOfDone?: string[]; priority?: TaskPriority } = {};
                    if (typeof msg.title === 'string') { updates.title = msg.title; }
                    if (typeof msg.description === 'string') { updates.description = msg.description; }
                    if (Array.isArray(msg.definitionOfDone)) { updates.definitionOfDone = msg.definitionOfDone as string[]; }
                    if (typeof msg.priority === 'string') { updates.priority = msg.priority as TaskPriority; }
                    this.client.updateTaskDetails(this.taskId, updates);
                    vscode.window.showInformationMessage('Task saved');
                    break;
                }

                case 'approve':
                    this.client.approveTask(this.taskId);
                    vscode.window.showInformationMessage('Task approved');
                    break;

                case 'promptReject': {
                    const reason = await vscode.window.showInputBox({
                        prompt: 'Rejection reason',
                        placeHolder: 'Why is this plan being rejected?',
                    });
                    if (reason) {
                        this.client.rejectTask(this.taskId, reason);
                        vscode.window.showInformationMessage('Task rejected');
                    }
                    break;
                }

                case 'reopen': {
                    const reopenReason = typeof msg.reason === 'string' ? msg.reason : '';
                    if (reopenReason) {
                        this.client.reopenTask(this.taskId, reopenReason);
                        vscode.window.showInformationMessage('Task reopened');
                    } else {
                        const inputReason = await vscode.window.showInputBox({
                            prompt: 'Reopen reason',
                            placeHolder: 'Why is this task being reopened?',
                        });
                        if (inputReason) {
                            this.client.reopenTask(this.taskId, inputReason);
                            vscode.window.showInformationMessage('Task reopened');
                        }
                    }
                    break;
                }

                case 'delete': {
                    const confirmed = await vscode.window.showWarningMessage(
                        'Delete this task? This cannot be undone.',
                        { modal: true },
                        'Delete'
                    );
                    if (confirmed === 'Delete') {
                        this.client.deleteTask(this.taskId);
                        vscode.window.showInformationMessage('Task deleted');
                        this.dispose();
                    }
                    break;
                }

                case 'addComment': {
                    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
                    if (content) {
                        this.client.addTaskComment(this.taskId, content);
                    }
                    break;
                }

                case 'prev':
                case 'next': {
                    const workflowOrder = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
                    const currentStatus = typeof msg.currentStatus === 'string' ? msg.currentStatus : '';
                    const idx = workflowOrder.indexOf(currentStatus);
                    if (idx < 0) { break; }

                    if (msg.type === 'next') {
                        if (idx >= workflowOrder.length - 1) { break; }
                        if (currentStatus === 'AWAITING_APPROVAL') {
                            this.client.approveTask(this.taskId);
                            vscode.window.showInformationMessage('Task approved');
                        } else {
                            this.client.updateTaskStatus(this.taskId, workflowOrder[idx + 1]);
                        }
                    } else {
                        if (idx <= 0) { break; }
                        if (currentStatus === 'REVIEW' || currentStatus === 'DONE') {
                            const reason = await vscode.window.showInputBox({
                                prompt: 'Reason for reopening',
                                placeHolder: 'Why is this task being reopened?',
                            });
                            if (reason) {
                                this.client.reopenTask(this.taskId, reason);
                                vscode.window.showInformationMessage('Task reopened');
                            }
                        } else {
                            this.client.updateTaskStatus(this.taskId, workflowOrder[idx - 1]);
                        }
                    }
                    break;
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Task action failed: ${errMsg}`);
        }
    }

    private getWebviewContent(task: Task | undefined): string {
        const nonce = getNonce();

        if (!task) {
            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Task Detail</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }
        .not-found {
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="not-found">
        <h2>Task not found</h2>
        <p>The task may have been deleted or is no longer available.</p>
    </div>
</body>
</html>`;
        }

        const epics = this.client.currentState?.epics || [];
        const epic = epics.find(e => e.id === task.epicId);
        const epicTitle = epic ? escapeHtml(epic.title) : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Task: ${escapeHtml(task.title)}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* Header */
        .task-header {
            padding: 12px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .header-left { display: flex; align-items: center; gap: 10px; }
        .status-badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: bold;
            color: #fff;
        }
        .status-BACKLOG { background: #9E9E9E; }
        .status-PLANNING { background: #ff9800; }
        .status-AWAITING_APPROVAL { background: #ffc107; color: #000; }
        .status-WORKING { background: #2196f3; }
        .status-REVIEW { background: #9c27b0; }
        .status-DONE { background: #4caf50; }
        .task-id-header {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: monospace;
        }

        /* Main content */
        .main-content {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
        }

        /* Form fields */
        .field { margin-bottom: 14px; }
        .field-label {
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .field-row {
            display: flex;
            gap: 12px;
            margin-bottom: 14px;
        }
        .field-row .field { flex: 1; margin-bottom: 0; }
        input[type="text"], textarea, select {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            border-radius: 3px;
            outline: none;
        }
        input[type="text"]:focus, textarea:focus, select:focus {
            border-color: var(--vscode-focusBorder);
        }
        textarea { resize: vertical; line-height: 1.5; }

        /* Section headers */
        .section-title {
            font-size: 13px;
            font-weight: bold;
            margin: 16px 0 10px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        /* PR Link */
        .pr-link {
            margin-bottom: 14px;
            font-size: 12px;
        }
        .pr-link a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .pr-link a:hover {
            text-decoration: underline;
        }

        /* Step cards */
        .step-card {
            margin-bottom: 8px;
            padding: 8px 10px;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
            border-left: 3px solid #9e9e9e;
        }
        .step-card.completed { border-left-color: #4caf50; }
        .step-card.in-progress { border-left-color: #2196f3; }
        .step-card.pending { border-left-color: #9e9e9e; }
        .step-header {
            font-size: 11px;
            font-weight: bold;
            margin-bottom: 3px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .step-icon-completed { color: #4caf50; }
        .step-icon-in-progress { color: #2196f3; }
        .step-icon-pending { color: var(--vscode-descriptionForeground); }
        .step-description {
            font-size: 12px;
            line-height: 1.4;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .step-files {
            margin-top: 4px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .step-files span { margin-right: 4px; }

        /* Comments */
        .comments-section {
            margin-top: 16px;
        }
        .comments-list {
            max-height: 200px;
            overflow-y: auto;
            margin-bottom: 8px;
        }
        .comment-item {
            padding: 6px 10px;
            margin-bottom: 6px;
            border-radius: 4px;
            border-left: 3px solid var(--vscode-panel-border);
            font-size: 12px;
        }
        .comment-human {
            border-left-color: #2196f3;
            background: rgba(33, 150, 243, 0.08);
        }
        .comment-agent {
            border-left-color: #4caf50;
            background: rgba(76, 175, 80, 0.08);
        }
        .comment-header {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            margin-bottom: 3px;
            color: var(--vscode-descriptionForeground);
        }
        .comment-author { font-weight: bold; }
        .comment-content { white-space: pre-wrap; word-wrap: break-word; }
        .comment-input-row {
            display: flex;
            gap: 6px;
        }
        .comment-input-row input { flex: 1; }
        .no-comments {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 12px;
            padding: 4px 0;
        }

        /* Action bar */
        .actions {
            display: flex;
            gap: 8px;
            padding: 12px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
            flex-wrap: wrap;
        }
        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 3px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            cursor: pointer;
        }
        .btn:disabled { opacity: 0.5; cursor: default; }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-approve { background: #4caf50; color: #fff; }
        .btn-approve:hover:not(:disabled) { background: #43a047; }
        .btn-reject { background: #f44336; color: #fff; }
        .btn-reject:hover:not(:disabled) { background: #e53935; }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-danger {
            background: none;
            color: #f44336;
            border: 1px solid #f44336;
        }
        .btn-danger:hover:not(:disabled) {
            background: rgba(244, 67, 54, 0.1);
        }
        .btn-comment {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-comment:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .spacer { flex: 1; }
        .muted-text {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="task-header">
        <div class="header-left">
            <span class="status-badge status-${escapeHtml(task.status)}" id="statusBadge">${escapeHtml(humanizeStatus(task.status))}</span>
            ${epicTitle ? '<span style="font-size:11px;color:var(--vscode-descriptionForeground);">' + epicTitle + '</span>' : ''}
        </div>
        <span class="task-id-header">${escapeHtml(task.id)}</span>
    </div>

    <div class="main-content">
        <!-- Editable fields -->
        <div class="field-row">
            <div class="field" style="flex:0 0 140px;">
                <div class="field-label">Priority</div>
                <select id="prioritySelect">
                    <option value="CRITICAL"${task.priority === 'CRITICAL' ? ' selected' : ''}>Critical</option>
                    <option value="HIGH"${task.priority === 'HIGH' ? ' selected' : ''}>High</option>
                    <option value="MEDIUM"${task.priority === 'MEDIUM' ? ' selected' : ''}>Medium</option>
                    <option value="LOW"${task.priority === 'LOW' ? ' selected' : ''}>Low</option>
                </select>
            </div>
            <div class="field">
                <div class="field-label">Title</div>
                <input type="text" id="titleInput" value="${escapeHtml(task.title)}" />
            </div>
        </div>

        <div class="field">
            <div class="field-label">Description</div>
            <textarea id="descriptionInput" rows="6">${escapeHtml(task.description)}</textarea>
        </div>

        <div class="field">
            <div class="field-label">Definition of Done (one item per line)</div>
            <textarea id="dodInput" rows="4">${escapeHtml((task.definitionOfDone || []).join('\n'))}</textarea>
        </div>

        ${task.reopenReason ? `<div class="field">
            <div class="field-label">Reopen Reason</div>
            <textarea id="reopenReasonInput" rows="2" ${task.status !== 'REVIEW' && task.status !== 'DONE' ? 'readonly style="opacity:0.7;"' : ''}>${escapeHtml(task.reopenReason)}</textarea>
        </div>` : ''}

        ${task.prLink ? `<div class="pr-link">
            <div class="field-label">Pull Request</div>
            <a href="${escapeHtml(task.prLink)}" title="Open PR">${escapeHtml(task.prLink)}</a>
        </div>` : ''}

        <!-- Implementation Plan -->
        <div class="section-title" id="planTitle">Implementation Plan</div>
        <div id="planContent">${this.renderSteps(task.implementationPlan || [])}</div>

        <!-- Comments -->
        <div class="comments-section">
            <div class="section-title">Comments</div>
            <div class="comments-list" id="commentsList">${this.renderComments(task.comments || [])}</div>
            <div class="comment-input-row">
                <input type="text" id="commentInput" placeholder="Ask a question or leave a comment..." />
                <button class="btn btn-comment" id="askBtn">Ask Question</button>
            </div>
        </div>
    </div>

    <div class="actions" id="actionsBar">
        <button class="btn btn-primary" id="saveBtn">Save</button>
        ${task.status === 'AWAITING_APPROVAL' ? '<button class="btn btn-approve" id="approveBtn">Approve</button>' : ''}
        ${task.status === 'AWAITING_APPROVAL' ? '<button class="btn btn-reject" id="rejectBtn">Reject</button>' : ''}
        ${task.status === 'REVIEW' || task.status === 'DONE' ? '<button class="btn btn-secondary" id="reopenBtn">Reopen</button>' : ''}
        <button class="btn btn-secondary" id="prevBtn" ${task.status === 'BACKLOG' ? 'disabled' : ''} title="Move back in workflow">Prev</button>
        <button class="btn btn-secondary" id="nextBtn" ${task.status === 'DONE' ? 'disabled' : ''} title="Move forward in workflow">Next</button>
        <span class="spacer"></span>
        <button class="btn btn-danger" id="deleteBtn">Delete</button>
    </div>

    <script nonce="${nonce}">
        var vscodeApi = acquireVsCodeApi();
        var currentTaskStatus = '${escapeHtml(task.status)}';

        function escapeHtml(text) {
            if (!text) { return ''; }
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function isAgentAuthor(author) {
            if (!author) { return false; }
            var lower = author.toLowerCase();
            return lower === 'worker' || lower === 'architect' || lower === 'qa'
                || lower.indexOf('agent') !== -1 || lower.indexOf('bot') !== -1
                || lower.indexOf('claude') !== -1 || lower.indexOf('codex') !== -1
                || lower.indexOf('gemini') !== -1;
        }

        // Save
        document.getElementById('saveBtn').addEventListener('click', function() {
            var dodText = document.getElementById('dodInput').value;
            var dodItems = dodText.split('\\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
            vscodeApi.postMessage({
                type: 'save',
                taskId: '${escapeHtml(task.id)}',
                title: document.getElementById('titleInput').value,
                description: document.getElementById('descriptionInput').value,
                definitionOfDone: dodItems,
                priority: document.getElementById('prioritySelect').value
            });
        });

        // Approve
        var approveBtn = document.getElementById('approveBtn');
        if (approveBtn) {
            approveBtn.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'approve' });
            });
        }

        // Reject
        var rejectBtn = document.getElementById('rejectBtn');
        if (rejectBtn) {
            rejectBtn.addEventListener('click', function() {
                vscodeApi.postMessage({ type: 'promptReject' });
            });
        }

        // Reopen
        var reopenBtn = document.getElementById('reopenBtn');
        if (reopenBtn) {
            reopenBtn.addEventListener('click', function() {
                var reasonEl = document.getElementById('reopenReasonInput');
                var reason = reasonEl ? reasonEl.value.trim() : '';
                vscodeApi.postMessage({ type: 'reopen', reason: reason });
            });
        }

        // Prev / Next
        document.getElementById('prevBtn').addEventListener('click', function() {
            vscodeApi.postMessage({ type: 'prev', currentStatus: currentTaskStatus });
        });
        document.getElementById('nextBtn').addEventListener('click', function() {
            vscodeApi.postMessage({ type: 'next', currentStatus: currentTaskStatus });
        });

        // Delete
        document.getElementById('deleteBtn').addEventListener('click', function() {
            vscodeApi.postMessage({ type: 'delete' });
        });

        // Add comment
        function submitComment() {
            var input = document.getElementById('commentInput');
            var content = input.value.trim();
            if (content) {
                vscodeApi.postMessage({ type: 'addComment', content: content });
                input.value = '';
            }
        }
        document.getElementById('askBtn').addEventListener('click', submitComment);
        document.getElementById('commentInput').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { submitComment(); }
        });

        // Render comments (for live updates)
        function renderComments(comments) {
            var container = document.getElementById('commentsList');
            if (!container) { return; }
            if (!comments || comments.length === 0) {
                container.textContent = '';
                var p = document.createElement('p');
                p.className = 'no-comments';
                p.textContent = 'No comments yet';
                container.appendChild(p);
                return;
            }
            container.textContent = '';
            for (var i = 0; i < comments.length; i++) {
                var c = comments[i];
                var agent = isAgentAuthor(c.author);
                var item = document.createElement('div');
                item.className = 'comment-item ' + (agent ? 'comment-agent' : 'comment-human');
                var header = document.createElement('div');
                header.className = 'comment-header';
                var authorSpan = document.createElement('span');
                authorSpan.className = 'comment-author';
                authorSpan.textContent = c.author || 'Unknown';
                var timeSpan = document.createElement('span');
                timeSpan.textContent = (c.timestamp || '').substring(0, 19);
                header.appendChild(authorSpan);
                header.appendChild(timeSpan);
                var body = document.createElement('div');
                body.className = 'comment-content';
                body.textContent = c.content || '';
                item.appendChild(header);
                item.appendChild(body);
                container.appendChild(item);
            }
            container.scrollTop = container.scrollHeight;
        }

        // Render steps (for live updates)
        function renderSteps(steps) {
            var container = document.getElementById('planContent');
            if (!container) { return; }
            if (!steps || steps.length === 0) {
                container.textContent = '';
                var p = document.createElement('p');
                p.className = 'muted-text';
                p.textContent = 'No implementation steps defined';
                container.appendChild(p);
                return;
            }
            container.textContent = '';
            for (var i = 0; i < steps.length; i++) {
                var step = steps[i];
                var status = (step.status || 'PENDING').toUpperCase();
                var cssClass = status === 'COMPLETED' ? 'completed'
                    : status === 'IN_PROGRESS' ? 'in-progress' : 'pending';
                var iconClass = status === 'COMPLETED' ? 'step-icon-completed'
                    : status === 'IN_PROGRESS' ? 'step-icon-in-progress' : 'step-icon-pending';
                var icon = status === 'COMPLETED' ? '\\u2713'
                    : status === 'IN_PROGRESS' ? '\\u25B6' : '\\u25CB';

                var card = document.createElement('div');
                card.className = 'step-card ' + cssClass;

                var header = document.createElement('div');
                header.className = 'step-header';
                var iconSpan = document.createElement('span');
                iconSpan.className = iconClass;
                iconSpan.textContent = icon;
                header.appendChild(iconSpan);
                var titleSpan = document.createElement('span');
                titleSpan.textContent = 'Step ' + (i + 1) + ': ' + status;
                header.appendChild(titleSpan);
                card.appendChild(header);

                var desc = document.createElement('div');
                desc.className = 'step-description';
                desc.textContent = step.description || '';
                card.appendChild(desc);

                if (step.affectedFiles && step.affectedFiles.length > 0) {
                    var filesDiv = document.createElement('div');
                    filesDiv.className = 'step-files';
                    var filesLabel = document.createElement('span');
                    filesLabel.textContent = 'Files:';
                    filesDiv.appendChild(filesLabel);
                    var filesText = document.createTextNode(' ' + step.affectedFiles.join(', '));
                    filesDiv.appendChild(filesText);
                    card.appendChild(filesDiv);
                }

                container.appendChild(card);
            }
        }

        // Handle live updates - only update plan + comments, not editable fields
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg.type === 'updateTask') {
                var task = msg.task;
                // Update status badge
                var badge = document.getElementById('statusBadge');
                if (badge && task.status) {
                    badge.className = 'status-badge status-' + task.status;
                    badge.textContent = task.status.toLowerCase().replace(/_/g, ' ').replace(/^./, function(c) { return c.toUpperCase(); });
                    currentTaskStatus = task.status;
                }
                // Update plan section
                renderSteps(task.implementationPlan);
                // Update comments section
                renderComments(task.comments);
            }
        });
    </script>
</body>
</html>`;
    }

    private renderSteps(steps: Array<{ stepId: string; description: string; status: string; affectedFiles?: string[] }>): string {
        if (steps.length === 0) {
            return '<p class="muted-text">No implementation steps defined</p>';
        }

        return steps.map((step, i) => {
            const status = (step.status || 'PENDING').toUpperCase();
            const cssClass = status === 'COMPLETED' ? 'completed'
                : status === 'IN_PROGRESS' ? 'in-progress' : 'pending';
            const iconClass = status === 'COMPLETED' ? 'step-icon-completed'
                : status === 'IN_PROGRESS' ? 'step-icon-in-progress' : 'step-icon-pending';
            const icon = status === 'COMPLETED' ? '\u2713'
                : status === 'IN_PROGRESS' ? '\u25B6' : '\u25CB';

            let filesHtml = '';
            if (step.affectedFiles && step.affectedFiles.length > 0) {
                filesHtml = `<div class="step-files"><span>Files:</span> ${step.affectedFiles.map(f => escapeHtml(f)).join(', ')}</div>`;
            }

            return `<div class="step-card ${cssClass}">
                <div class="step-header"><span class="${iconClass}">${icon}</span><span>Step ${i + 1}: ${escapeHtml(status)}</span></div>
                <div class="step-description">${escapeHtml(step.description)}</div>
                ${filesHtml}
            </div>`;
        }).join('');
    }

    private renderComments(comments: TaskComment[]): string {
        if (!comments || comments.length === 0) {
            return '<p class="no-comments">No comments yet</p>';
        }

        return comments.map(c => {
            const isAgent = isAgentAuthor(c.author);
            const cls = isAgent ? 'comment-agent' : 'comment-human';
            const timestamp = (c.timestamp || '').substring(0, 19);
            return `<div class="comment-item ${cls}">
                <div class="comment-header">
                    <span class="comment-author">${escapeHtml(c.author || 'Unknown')}</span>
                    <span>${escapeHtml(timestamp)}</span>
                </div>
                <div class="comment-content">${escapeHtml(c.content)}</div>
            </div>`;
        }).join('');
    }

    dispose(): void {
        TaskDetailPanel.currentPanels.delete(this.taskId);
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
        this.panel.dispose();
    }
}

// ============================================================================
// Utility functions (module-scoped)
// ============================================================================

function escapeHtml(text: string): string {
    if (!text) { return ''; }
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function humanizeStatus(status: string): string {
    return status.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function isAgentAuthor(author: string | undefined): boolean {
    if (!author) { return false; }
    const lower = author.toLowerCase();
    return lower === 'worker' || lower === 'architect' || lower === 'qa'
        || lower.includes('agent') || lower.includes('bot')
        || lower.includes('claude') || lower.includes('codex')
        || lower.includes('gemini');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
