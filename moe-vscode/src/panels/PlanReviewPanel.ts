import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { MoeStateSnapshot, Task, TaskComment } from '../types/moe';

/**
 * Plan Review Panel - a webview panel for reviewing implementation plans
 * of tasks in AWAITING_APPROVAL status.
 *
 * Layout:
 * - Header: task title + description
 * - Left (300px): Definition of Done sidebar
 * - Right (remaining): Implementation Plan steps
 * - Bottom: Comments section with add-comment input
 * - Footer: Approve / Reject action buttons
 */
export class PlanReviewPanel implements vscode.Disposable {
    public static readonly viewType = 'moe.planReview';

    /** Per-task singleton map */
    private static currentPanels: Map<string, PlanReviewPanel> = new Map();

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
        state: MoeStateSnapshot | undefined
    ): PlanReviewPanel {
        const existing = PlanReviewPanel.currentPanels.get(taskId);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            return existing;
        }

        const task = state?.tasks.find(t => t.id === taskId);
        const titleSuffix = task
            ? (task.title.length > 30 ? task.title.substring(0, 30) + '...' : task.title)
            : taskId;

        const panel = vscode.window.createWebviewPanel(
            PlanReviewPanel.viewType,
            `Review: ${titleSuffix}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );

        const instance = new PlanReviewPanel(extensionUri, panel, client, taskId);
        PlanReviewPanel.currentPanels.set(taskId, instance);
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

    private async handleWebviewMessage(msg: { type: string; taskId?: string; reason?: string; content?: string }): Promise<void> {
        try {
            switch (msg.type) {
                case 'approve':
                    this.client.approveTask(this.taskId);
                    vscode.window.showInformationMessage('Plan approved');
                    this.dispose();
                    break;

                case 'reject': {
                    const reason = msg.reason;
                    if (reason) {
                        this.client.rejectTask(this.taskId, reason);
                        vscode.window.showInformationMessage('Plan rejected');
                        this.dispose();
                    }
                    break;
                }

                case 'promptReject': {
                    const reason = await vscode.window.showInputBox({
                        prompt: 'Rejection reason',
                        placeHolder: 'Why is this plan being rejected?',
                    });
                    if (reason) {
                        this.client.rejectTask(this.taskId, reason);
                        vscode.window.showInformationMessage('Plan rejected');
                        this.dispose();
                    }
                    break;
                }

                case 'addComment': {
                    const content = msg.content;
                    if (content && content.trim()) {
                        this.client.addTaskComment(this.taskId, content.trim());
                    }
                    break;
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Plan review action failed: ${errMsg}`);
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
    <title>Plan Review</title>
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

        const titleHtml = escapeHtml(task.title);
        const descHtml = escapeHtml(task.description || '');
        const dodHtml = this.renderDoD(task.definitionOfDone);
        const stepsHtml = this.renderSteps(task.implementationPlan || []);
        const commentsHtml = this.renderComments(task.comments || []);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Review: ${titleHtml}</title>
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
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* ---- Header ---- */
        .task-header {
            padding: 16px 20px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .task-title {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 4px;
        }
        .task-desc {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            white-space: pre-wrap;
            max-height: 60px;
            overflow-y: auto;
        }

        /* ---- Split layout ---- */
        .review-container {
            display: flex;
            flex: 1;
            overflow: hidden;
        }
        .review-left {
            width: 300px;
            min-width: 200px;
            border-right: 1px solid var(--vscode-panel-border);
            padding: 12px;
            overflow-y: auto;
        }
        .review-right {
            flex: 1;
            padding: 12px;
            overflow-y: auto;
        }

        /* ---- Headings ---- */
        .section-title {
            font-size: 13px;
            font-weight: bold;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-foreground);
        }

        /* ---- DoD ---- */
        .dod-list {
            list-style: disc;
            padding-left: 20px;
        }
        .dod-list li {
            margin-bottom: 6px;
            font-size: 12px;
            line-height: 1.4;
        }
        .muted {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 12px;
        }

        /* ---- Step cards ---- */
        .step-card {
            margin-bottom: 10px;
            padding: 10px 12px;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
            border-left: 3px solid #9e9e9e;
        }
        .step-card.completed {
            border-left-color: #4caf50;
        }
        .step-card.in-progress {
            border-left-color: #2196f3;
        }
        .step-card.pending {
            border-left-color: #9e9e9e;
        }
        .step-header {
            font-size: 11px;
            font-weight: bold;
            margin-bottom: 4px;
        }
        .step-status-completed { color: #4caf50; }
        .step-status-in-progress { color: #2196f3; }
        .step-status-pending { color: var(--vscode-descriptionForeground); }
        .step-description {
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .step-files {
            margin-top: 6px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .step-files ul {
            list-style: disc;
            padding-left: 16px;
            margin-top: 2px;
        }
        .step-files li {
            margin-bottom: 2px;
        }

        /* ---- Comments ---- */
        .comments-section {
            border-top: 1px solid var(--vscode-panel-border);
            padding: 12px 20px;
            max-height: 220px;
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
        }
        .comments-title {
            font-size: 12px;
            font-weight: bold;
            margin-bottom: 8px;
            text-transform: uppercase;
        }
        .comments-list {
            flex: 1;
            overflow-y: auto;
            margin-bottom: 8px;
            min-height: 0;
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
        .comment-content {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .comment-input-row {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }
        .comment-input-row input {
            flex: 1;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            border-radius: 2px;
            outline: none;
        }
        .comment-input-row input:focus {
            border-color: var(--vscode-focusBorder);
        }

        /* ---- Action buttons ---- */
        .actions {
            display: flex;
            gap: 8px;
            padding: 12px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .btn {
            padding: 6px 16px;
            border: none;
            border-radius: 3px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            cursor: pointer;
        }
        .btn:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .btn-approve {
            background: #4caf50;
            color: #fff;
        }
        .btn-approve:hover:not(:disabled) {
            background: #43a047;
        }
        .btn-reject {
            background: #f44336;
            color: #fff;
        }
        .btn-reject:hover:not(:disabled) {
            background: #e53935;
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-comment {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-comment:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .no-comments {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 12px;
            padding: 4px 0;
        }
    </style>
</head>
<body>
    <div class="task-header">
        <div class="task-title" id="taskTitle">${titleHtml}</div>
        <div class="task-desc" id="taskDesc">${descHtml}</div>
    </div>

    <div class="review-container">
        <div class="review-left">
            <div class="section-title">Definition of Done</div>
            <div id="dodContent">${dodHtml}</div>
        </div>
        <div class="review-right">
            <div class="section-title">Implementation Plan</div>
            <div id="stepsContent">${stepsHtml}</div>
        </div>
    </div>

    <div class="comments-section">
        <div class="comments-title">Comments</div>
        <div class="comments-list" id="commentsList">${commentsHtml}</div>
        <div class="comment-input-row">
            <input type="text" id="commentInput" placeholder="Ask a question or leave a comment..." />
            <button class="btn btn-comment" id="askBtn">Ask Question</button>
        </div>
    </div>

    <div class="actions">
        <button class="btn btn-approve" id="approveBtn">Approve</button>
        <button class="btn btn-reject" id="rejectBtn">Reject</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let actionSent = false;

        function escapeHtml(text) {
            if (!text) { return ''; }
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        // Approve
        document.getElementById('approveBtn').addEventListener('click', function() {
            if (actionSent) { return; }
            actionSent = true;
            this.disabled = true;
            document.getElementById('rejectBtn').disabled = true;
            vscode.postMessage({ type: 'approve' });
        });

        // Reject
        document.getElementById('rejectBtn').addEventListener('click', function() {
            if (actionSent) { return; }
            vscode.postMessage({ type: 'promptReject' });
        });

        // Add comment
        function submitComment() {
            var input = document.getElementById('commentInput');
            var content = input.value.trim();
            if (content) {
                vscode.postMessage({ type: 'addComment', content: content });
                input.value = '';
            }
        }

        document.getElementById('askBtn').addEventListener('click', submitComment);

        document.getElementById('commentInput').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                submitComment();
            }
        });

        // Determine if a comment author is likely an agent
        function isAgentAuthor(author) {
            if (!author) { return false; }
            var lower = author.toLowerCase();
            return lower === 'worker' || lower === 'architect' || lower === 'qa'
                || lower.indexOf('agent') !== -1 || lower.indexOf('bot') !== -1
                || lower.indexOf('claude') !== -1 || lower.indexOf('codex') !== -1
                || lower.indexOf('gemini') !== -1;
        }

        function renderComments(comments) {
            var container = document.getElementById('commentsList');
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
            // Auto-scroll to bottom
            container.scrollTop = container.scrollHeight;
        }

        function renderSteps(steps) {
            var container = document.getElementById('stepsContent');
            if (!steps || steps.length === 0) {
                container.textContent = '';
                var p = document.createElement('p');
                p.className = 'muted';
                p.textContent = 'No implementation steps defined';
                container.appendChild(p);
                return;
            }
            container.textContent = '';
            for (var i = 0; i < steps.length; i++) {
                var step = steps[i];
                var status = (step.status || 'PENDING').toUpperCase();
                var cssClass = status === 'COMPLETED' ? 'completed'
                    : status === 'IN_PROGRESS' ? 'in-progress'
                    : 'pending';
                var statusClass = status === 'COMPLETED' ? 'step-status-completed'
                    : status === 'IN_PROGRESS' ? 'step-status-in-progress'
                    : 'step-status-pending';

                var card = document.createElement('div');
                card.className = 'step-card ' + cssClass;

                var header = document.createElement('div');
                header.className = 'step-header ' + statusClass;
                header.textContent = 'Step ' + (i + 1) + ': ' + status;
                card.appendChild(header);

                var desc = document.createElement('div');
                desc.className = 'step-description';
                desc.textContent = step.description || '';
                card.appendChild(desc);

                if (step.affectedFiles && step.affectedFiles.length > 0) {
                    var filesDiv = document.createElement('div');
                    filesDiv.className = 'step-files';
                    var filesLabel = document.createElement('span');
                    filesLabel.textContent = 'Affected files:';
                    filesDiv.appendChild(filesLabel);
                    var ul = document.createElement('ul');
                    for (var j = 0; j < step.affectedFiles.length; j++) {
                        var li = document.createElement('li');
                        li.textContent = step.affectedFiles[j];
                        ul.appendChild(li);
                    }
                    filesDiv.appendChild(ul);
                    card.appendChild(filesDiv);
                }

                container.appendChild(card);
            }
        }

        function renderDoD(dod) {
            var container = document.getElementById('dodContent');
            if (!dod || dod.length === 0) {
                container.textContent = '';
                var p = document.createElement('p');
                p.className = 'muted';
                p.textContent = 'No criteria defined';
                container.appendChild(p);
                return;
            }
            container.textContent = '';
            var ul = document.createElement('ul');
            ul.className = 'dod-list';
            for (var i = 0; i < dod.length; i++) {
                var li = document.createElement('li');
                li.textContent = dod[i];
                ul.appendChild(li);
            }
            container.appendChild(ul);
        }

        // Handle live updates from extension
        window.addEventListener('message', function(event) {
            var msg = event.data;
            if (msg.type === 'updateTask') {
                var task = msg.task;
                // Update header
                var titleEl = document.getElementById('taskTitle');
                if (titleEl) { titleEl.textContent = task.title || ''; }
                var descEl = document.getElementById('taskDesc');
                if (descEl) { descEl.textContent = task.description || ''; }
                // Update DoD
                renderDoD(task.definitionOfDone);
                // Update steps
                renderSteps(task.implementationPlan);
                // Update comments
                renderComments(task.comments);
            }
        });
    </script>
</body>
</html>`;
    }

    private renderDoD(dod: string[] | undefined): string {
        if (!dod || dod.length === 0) {
            return '<p class="muted">No criteria defined</p>';
        }
        const items = dod.map(item => `<li>${escapeHtml(item)}</li>`).join('');
        return `<ul class="dod-list">${items}</ul>`;
    }

    private renderSteps(steps: Array<{ stepId: string; description: string; status: string; affectedFiles?: string[] }>): string {
        if (steps.length === 0) {
            return '<p class="muted">No implementation steps defined</p>';
        }

        return steps.map((step, i) => {
            const status = (step.status || 'PENDING').toUpperCase();
            const cssClass = status === 'COMPLETED' ? 'completed'
                : status === 'IN_PROGRESS' ? 'in-progress'
                : 'pending';
            const statusClass = status === 'COMPLETED' ? 'step-status-completed'
                : status === 'IN_PROGRESS' ? 'step-status-in-progress'
                : 'step-status-pending';

            let filesHtml = '';
            if (step.affectedFiles && step.affectedFiles.length > 0) {
                const fileItems = step.affectedFiles.map(f => `<li>${escapeHtml(f)}</li>`).join('');
                filesHtml = `<div class="step-files"><span>Affected files:</span><ul>${fileItems}</ul></div>`;
            }

            return `<div class="step-card ${cssClass}">
                <div class="step-header ${statusClass}">Step ${i + 1}: ${escapeHtml(status)}</div>
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
        PlanReviewPanel.currentPanels.delete(this.taskId);
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
        this.panel.dispose();
    }
}

// ============================================================================
// Utility functions (module-scoped, not exported)
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
