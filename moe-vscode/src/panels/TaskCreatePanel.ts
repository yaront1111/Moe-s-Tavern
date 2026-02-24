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
            { enableScripts: true }
        );

        TaskCreatePanel.currentPanel = new TaskCreatePanel(panel, client, state);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        client: MoeDaemonClient,
        state: MoeStateSnapshot
    ) {
        this.panel = panel;
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
        const epicOptions = epics
            .map(e => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.title)}</option>`)
            .join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
        <button class="btn-primary" id="submitBtn" onclick="submitForm()" disabled>Create Task</button>
        <button class="btn-secondary" onclick="cancelForm()">Cancel</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const epicEl = document.getElementById('epic');
        const titleEl = document.getElementById('title');
        const descriptionEl = document.getElementById('description');
        const dodEl = document.getElementById('dod');
        const priorityEl = document.getElementById('priority');
        const titleCharCount = document.getElementById('titleCharCount');
        const titleError = document.getElementById('titleError');
        const epicError = document.getElementById('epicError');
        const submitBtn = document.getElementById('submitBtn');

        function updateButtonState() {
            const hasEpic = !!epicEl.value;
            const hasTitle = !!titleEl.value.trim();
            const titleInRange = titleEl.value.trim().length <= 500;
            submitBtn.disabled = !(hasEpic && hasTitle && titleInRange);
        }

        titleEl.addEventListener('input', function() {
            const len = titleEl.value.length;
            titleCharCount.textContent = len + ' / 500';
            titleCharCount.className = len > 500 ? 'char-count over' : 'char-count';
            if (len > 0) {
                titleEl.classList.remove('error');
                titleError.classList.remove('visible');
            }
            updateButtonState();
        });

        epicEl.addEventListener('change', function() {
            if (epicEl.value) {
                epicEl.classList.remove('error');
                epicError.classList.remove('visible');
            }
            updateButtonState();
        });

        // Initial state: button disabled until form is valid
        updateButtonState();

        function validate() {
            let valid = true;

            if (!epicEl.value) {
                epicEl.classList.add('error');
                epicError.classList.add('visible');
                valid = false;
            } else {
                epicEl.classList.remove('error');
                epicError.classList.remove('visible');
            }

            const title = titleEl.value.trim();
            if (!title) {
                titleEl.classList.add('error');
                titleError.textContent = 'Title is required.';
                titleError.classList.add('visible');
                valid = false;
            } else if (title.length > 500) {
                titleEl.classList.add('error');
                titleError.textContent = 'Title must be 500 characters or fewer.';
                titleError.classList.add('visible');
                valid = false;
            } else {
                titleEl.classList.remove('error');
                titleError.classList.remove('visible');
            }

            return valid;
        }

        function submitForm() {
            if (!validate()) {
                return;
            }

            const dodText = dodEl.value || '';
            const dodItems = dodText.split('\\n').map(function(line) { return line.trim(); }).filter(function(line) { return line.length > 0; });

            vscode.postMessage({
                type: 'submit',
                epicId: epicEl.value,
                title: titleEl.value.trim(),
                description: descriptionEl.value.trim(),
                definitionOfDone: dodItems,
                priority: priorityEl.value
            });
        }

        function cancelForm() {
            vscode.postMessage({ type: 'cancel' });
        }

        // Handle init message from extension
        window.addEventListener('message', function(event) {
            const message = event.data;
            if (message.type === 'init' && message.epics) {
                // Re-populate epics if sent after panel creation
                const epics = message.epics;
                while (epicEl.options.length > 1) {
                    epicEl.remove(1);
                }
                for (let i = 0; i < epics.length; i++) {
                    const opt = document.createElement('option');
                    opt.value = epics[i].id;
                    opt.textContent = epics[i].title;
                    epicEl.appendChild(opt);
                }
                updateButtonState();
            }
        });

        // Allow Enter in title to submit
        titleEl.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitForm();
            }
        });
    </script>
</body>
</html>`;
    }
}
