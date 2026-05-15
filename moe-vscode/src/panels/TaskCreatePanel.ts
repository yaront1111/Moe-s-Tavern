import * as vscode from 'vscode';
import type { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { Epic, MoeStateSnapshot, TaskPriority } from '../types/moe';

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export class TaskCreatePanel {
    public static currentPanel: TaskCreatePanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly daemonClient: MoeDaemonClient;
    private readonly state: MoeStateSnapshot;
    private disposed = false;

    public static createOrShow(
        extensionUri: vscode.Uri,
        client: MoeDaemonClient,
        state: MoeStateSnapshot
    ): void {
        if (TaskCreatePanel.currentPanel) {
            TaskCreatePanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'moe.createTask',
            'Create Task',
            vscode.ViewColumn.One,
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );

        TaskCreatePanel.currentPanel = new TaskCreatePanel(panel, extensionUri, client, state);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        client: MoeDaemonClient,
        state: MoeStateSnapshot
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.daemonClient = client;
        this.state = state;

        const nonce = this.getNonce();
        const epics = state.epics || [];
        this.panel.webview.html = this.getWebviewContent(nonce, epics);

        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined
        );

        this.panel.onDidDispose(() => this.dispose());

        // Send init data to populate the dropdown
        this.panel.webview.postMessage({
            type: 'init',
            epics: epics.map(e => ({ id: e.id, title: e.title, status: e.status }))
        });
    }

    private handleMessage(message: { type: string; [key: string]: unknown }): void {
        switch (message.type) {
            case 'submit': {
                const epicId = message.epicId as string;
                const title = (message.title as string || '').trim();
                const description = (message.description as string || '').trim();
                const dodRaw = message.definitionOfDone as string[] | undefined;
                const priority = (message.priority as TaskPriority) || 'MEDIUM';

                // Validation
                if (!epicId) {
                    vscode.window.showErrorMessage('Please select an epic.');
                    return;
                }
                if (!title) {
                    vscode.window.showErrorMessage('Title is required.');
                    return;
                }
                if (title.length > 500) {
                    vscode.window.showErrorMessage('Title must be 500 characters or fewer.');
                    return;
                }

                const definitionOfDone = (dodRaw || []).filter(item => item.trim().length > 0);

                try {
                    this.daemonClient.createTask(epicId, title, description, definitionOfDone, priority);
                    vscode.window.showInformationMessage(`Task "${title}" created.`);
                    this.dispose();
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to create task: ${errMsg}`);
                }
                break;
            }
            case 'cancel':
                this.dispose();
                break;
        }
    }

    private dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        TaskCreatePanel.currentPanel = undefined;
        this.panel.dispose();
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private getWebviewContent(nonce: string, epics: Epic[]): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'taskCreate.js'));
        const epicOptions = epics
            .map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.title)}</option>`)
            .join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
    <title>Create Task</title>
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
            padding: 24px;
            max-width: 600px;
            margin: 0 auto;
        }
        h1 {
            font-size: 18px;
            margin-bottom: 20px;
            font-weight: 600;
        }
        .form-group {
            margin-bottom: 16px;
        }
        label {
            display: block;
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 4px;
            color: var(--vscode-foreground);
        }
        label .required {
            color: var(--vscode-errorForeground, #f44336);
        }
        input, select, textarea {
            width: 100%;
            padding: 6px 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 2px;
            outline: none;
        }
        input:focus, select:focus, textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        input.error, select.error, textarea.error {
            border-color: var(--vscode-errorForeground, #f44336);
        }
        textarea {
            min-height: 80px;
            resize: vertical;
        }
        .error-text {
            color: var(--vscode-errorForeground, #f44336);
            font-size: 11px;
            margin-top: 2px;
            display: none;
        }
        .error-text.visible {
            display: block;
        }
        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin-top: 2px;
        }
        .button-row {
            display: flex;
            gap: 8px;
            margin-top: 20px;
        }
        button {
            padding: 6px 14px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .char-count {
            text-align: right;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .char-count.over {
            color: var(--vscode-errorForeground, #f44336);
        }
    </style>
</head>
<body>
    <h1>Create Task</h1>

    <div class="form-group">
        <label for="epic">Epic <span class="required">*</span></label>
        <select id="epic">
            <option value="">-- Select an epic --</option>
            ${epicOptions}
        </select>
        <div class="error-text" id="epicError">Please select an epic.</div>
    </div>

    <div class="form-group">
        <label for="priority">Priority</label>
        <select id="priority">
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM" selected>Medium</option>
            <option value="LOW">Low</option>
        </select>
    </div>

    <div class="form-group">
        <label for="title">Title <span class="required">*</span></label>
        <input type="text" id="title" maxlength="500" placeholder="Brief task title" />
        <div class="char-count" id="titleCharCount">0 / 500</div>
        <div class="error-text" id="titleError">Title is required.</div>
    </div>

    <div class="form-group">
        <label for="description">Description</label>
        <textarea id="description" rows="4" placeholder="Describe what needs to be done"></textarea>
    </div>

    <div class="form-group">
        <label for="dod">Definition of Done</label>
        <textarea id="dod" rows="4" placeholder="One item per line"></textarea>
        <div class="hint">Enter each criterion on a separate line.</div>
    </div>

    <div class="button-row">
        <button class="btn-primary" id="submitBtn" disabled>Create Task</button>
        <button class="btn-secondary" id="cancelBtn">Cancel</button>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
