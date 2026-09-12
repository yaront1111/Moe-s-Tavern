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
    /** Revision of an approval that was sent but not yet answered by the daemon. */
    private pendingApprovalRevision: number | undefined;
    /** True once this panel knows the page is NOT showing content it could deliver. */
    private contentOutOfSync = false;
    private disposed = false;

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

        // A daemon refusal is the authoritative "this approval did not happen".
        this.disposables.push(
            this.client.onError(event => this.handleClientError(event))
        );

        // A drop while an approval is in flight must not leave the panel waiting
        // for an answer that can no longer arrive.
        this.disposables.push(
            this.client.onConnectionChanged(state => this.handleConnectionChange(state))
        );

        // Cleanup on panel close
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private findTask(): Task | undefined {
        return this.client.currentState?.tasks.find(t => t.id === this.taskId);
    }

    private debouncedUpdate(): void {
        if (this.disposed) { return; }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            if (this.disposed) { return; }

            const task = this.findTask();
            if (!task) {
                // The page is now showing a task that no longer exists — say so and
                // treat its content as unbacked until a real task is delivered again.
                this.contentOutOfSync = true;
                void this.postControl({ type: 'taskRemoved' });
                return;
            }

            // The ONLY authoritative completion: the daemon moved this task on.
            if (this.pendingApprovalRevision !== undefined && task.status === 'WORKING') {
                this.pendingApprovalRevision = undefined;
                vscode.window.showInformationMessage('Plan approved');
                this.dispose();
                return;
            }

            void this.postTaskUpdate(task);
        }, 200);
    }

    /**
     * Deliver the task to the page, and remember whether it actually arrived.
     *
     * A failed delivery cannot disable anything remotely, so the gate has to live
     * here: while `contentOutOfSync` is set, this panel refuses every approve
     * message, because it knows the page is showing content it could not refresh.
     */
    private async postTaskUpdate(task: Task): Promise<void> {
        if (this.disposed) { return; }
        try {
            const delivered = await this.panel.webview.postMessage({ type: 'updateTask', task });
            this.contentOutOfSync = delivered === false;
        } catch {
            this.contentOutOfSync = true;
        }
    }

    /**
     * Act only on errors correlated to THIS task and the approve operation: the
     * daemon returns the task id in the allowlisted error context, so an error for
     * another task or another operation is ignored entirely.
     */
    private handleClientError(event: {
        operation?: string;
        message: string;
        codeName?: string;
        context?: { taskId?: string };
    }): void {
        if (this.disposed) { return; }
        if (event.operation !== 'APPROVE_TASK') { return; }
        if (!event.context || event.context.taskId !== this.taskId) { return; }

        const stale = event.codeName === 'PLAN_REVISION_MISMATCH';
        vscode.window.showErrorMessage(
            stale
                ? 'Plan approval refused — the plan changed since it was displayed. Reopen the review to read the current plan.'
                : `Plan approval failed: ${event.message}`
        );
        void this.reportApprovalFailure(stale, stale
            ? 'The daemon refused this approval because the plan changed. Close and reopen the review.'
            : `The approval failed: ${event.message}`);
    }

    private handleConnectionChange(state: string): void {
        if (this.disposed) { return; }
        if (state === 'connected') { return; }
        if (this.pendingApprovalRevision === undefined) { return; }

        vscode.window.showWarningMessage(
            'Lost the connection to the Moe daemon — the plan approval was not confirmed.'
        );
        void this.reportApprovalFailure(false,
            'The connection dropped before the approval was confirmed. Approve will re-enable once the plan refreshes.');
    }

    private async handleWebviewMessage(msg: {
        type: string;
        taskId?: string;
        reason?: string;
        content?: string;
        expectedPlanRevision?: unknown;
    }): Promise<void> {
        if (this.disposed) { return; }
        try {
            switch (msg.type) {
                case 'approve':
                    await this.handleApprove(msg.expectedPlanRevision);
                    break;

                case 'reject': {
                    const reason = msg.reason;
                    if (reason) {
                        if (this.client.rejectTask(this.taskId, reason)) {
                            vscode.window.showInformationMessage('Plan rejected');
                            this.dispose();
                        } else {
                            vscode.window.showWarningMessage('Not connected to Moe daemon — plan was not rejected.');
                        }
                    }
                    break;
                }

                case 'promptReject': {
                    const reason = await vscode.window.showInputBox({
                        prompt: 'Rejection reason',
                        placeHolder: 'Why is this plan being rejected?',
                    });
                    if (reason) {
                        if (this.client.rejectTask(this.taskId, reason)) {
                            vscode.window.showInformationMessage('Plan rejected');
                            this.dispose();
                        } else {
                            vscode.window.showWarningMessage('Not connected to Moe daemon — plan was not rejected.');
                        }
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

    /**
     * Approve the plan the webview actually rendered.
     *
     * `token` is whatever the page sent and is the ONLY source of the revision.
     * This method deliberately never consults `currentState` to produce, replace
     * or second-guess it: the cache's newest revision is by definition not the one
     * the human read, and the daemon — not this panel — is the authority on
     * staleness. A click carrying an older revision is therefore sent as-is and
     * refused server side.
     */
    private async handleApprove(token: unknown): Promise<void> {
        if (this.disposed) { return; }

        // Duplicate sends while the daemon has not answered yet.
        if (this.pendingApprovalRevision !== undefined) { return; }

        // The page is showing content this panel failed to refresh, so whatever it
        // rendered cannot be trusted as reviewed-and-current.
        if (this.contentOutOfSync) {
            vscode.window.showWarningMessage(
                'The review page could not be refreshed — reopen the review before approving.'
            );
            await this.reportApprovalFailure(false,
                'The review page could not be refreshed. Close and reopen the review before approving.');
            return;
        }

        if (!isPlanRevision(token)) {
            // Calling the one-argument approval here would approve a plan nobody
            // reviewed — the exact hole this panel exists to close.
            vscode.window.showErrorMessage(
                `Plan approval refused: the review page sent no usable plan revision (${String(token)}).`
            );
            await this.reportApprovalFailure(false,
                'The review page sent no usable plan revision. Close and reopen the review.');
            return;
        }

        if (!this.client.approveTask(this.taskId, token)) {
            vscode.window.showWarningMessage('Not connected to Moe daemon — plan was not approved.');
            await this.reportApprovalFailure(false,
                'The approval could not be sent. Approve will re-enable once the plan refreshes.');
            return;
        }

        // A successful send only means bytes left the socket. Approval is finished
        // only when the daemon says so (see debouncedUpdate / handleClientError).
        this.pendingApprovalRevision = token;
        await this.postControl({ type: 'approvePending' });
    }

    /**
     * Post a control message to the page. Control messages never clear
     * `contentOutOfSync` — only a delivered task update proves the page is current.
     */
    private async postControl(message: Record<string, unknown>): Promise<void> {
        if (this.disposed) { return; }
        try {
            await this.panel.webview.postMessage(message);
        } catch {
            // The page is unreachable; `contentOutOfSync` already gates approval.
        }
    }

    private async reportApprovalFailure(stale: boolean, message: string): Promise<void> {
        this.pendingApprovalRevision = undefined;
        await this.postControl({ type: 'approveFailed', stale, message });
    }

    private getWebviewContent(task: Task | undefined): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'planReview.js'));

        if (!task) {
            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
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
        // Derived from the SAME task object that just produced the markup above,
        // so the token can never describe content other than what is on screen.
        const revisionAttr = seedRevisionAttribute(task);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
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
            align-items: center;
            gap: 8px;
            padding: 12px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .review-notice {
            flex: 1;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .review-notice.visible {
            color: var(--vscode-errorForeground);
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

    <div class="review-container" id="reviewRoot"${revisionAttr}>
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
        <div class="review-notice" id="reviewNotice"></div>
        <!-- Starts disabled: only the script, after it has confirmed a seeded
             token for fully rendered content, is allowed to enable approval. -->
        <button class="btn btn-approve" id="approveBtn" disabled>Approve</button>
        <button class="btn btn-reject" id="rejectBtn">Reject</button>
    </div>

    <script src="${scriptUri}"></script>
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
        // `panel.dispose()` below re-enters here through onDidDispose, so the guard
        // is what makes disposal run exactly once.
        if (this.disposed) { return; }
        this.disposed = true;
        this.pendingApprovalRevision = undefined;

        PlanReviewPanel.currentPanels.delete(this.taskId);
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
        this.panel.dispose();
    }
}

// ============================================================================
// Utility functions (module-scoped, not exported)
// ============================================================================

/**
 * True only for a value that can serve as an approval token: a non-negative safe
 * integer. Never coerces — a numeric conversion here would be exactly the silent
 * fallback that lets an unreviewed plan through.
 */
function isPlanRevision(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The `data-plan-revision` attribute for the review root, or an empty string when
 * the attribute must be omitted entirely.
 *
 * An ABSENT revision field is a legacy task record and seeds 0 — the daemon reads
 * absence the same way, and 0 is exactly the value a truthiness check would drop.
 * A present but malformed value is NOT legacy: it seeds nothing, so the page loads
 * with Approve disabled rather than bound to a token nobody can trust. The same
 * goes for a task that is not awaiting approval.
 */
function seedRevisionAttribute(task: Task): string {
    if (task.status !== 'AWAITING_APPROVAL') { return ''; }
    const raw: unknown = task.planRevision;
    if (raw === undefined) { return ` data-plan-revision="${escapeHtml('0')}"`; }
    if (!isPlanRevision(raw)) { return ''; }
    return ` data-plan-revision="${escapeHtml(String(raw))}"`;
}

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
        || lower.includes('gemini') || lower.includes('grok');
}

