import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { Epic, MoeStateSnapshot } from '../types/moe';

export class EpicDetailPanel implements vscode.Disposable {
    public static readonly viewType = 'moe.epicDetail';

    private static panels: Map<string, EpicDetailPanel> = new Map();

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly client: MoeDaemonClient,
        private readonly epicId: string | undefined,
        private readonly state: MoeStateSnapshot | undefined
    ) {
        this.panel = panel;

        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        this.panel.webview.html = this.getWebviewContent();

        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        client: MoeDaemonClient,
        epicId?: string,
        state?: MoeStateSnapshot
    ): EpicDetailPanel {
        const key = epicId ?? '__create__';

        const existing = EpicDetailPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            return existing;
        }

        const epic = epicId && state
            ? state.epics.find((e) => e.id === epicId)
            : undefined;

        const title = epic ? `Edit: ${epic.title}` : 'Create Epic';

        const panel = vscode.window.createWebviewPanel(
            EpicDetailPanel.viewType,
            title,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: false }
        );

        const instance = new EpicDetailPanel(panel, extensionUri, client, epicId, state);
        EpicDetailPanel.panels.set(key, instance);
        return instance;
    }

    dispose(): void {
        const key = this.epicId ?? '__create__';
        EpicDetailPanel.panels.delete(key);

        this.panel.dispose();
        this.disposables.forEach((d) => d.dispose());
        this.disposables.length = 0;
    }

    private async handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
        try {
            switch (message.type) {
                case 'create': {
                    const title = String(message.title ?? '').trim();
                    if (!title) {
                        vscode.window.showErrorMessage('Epic title is required.');
                        return;
                    }
                    const description = String(message.description ?? '').trim();
                    const architectureNotes = String(message.architectureNotes ?? '').trim();
                    const epicRails = Array.isArray(message.epicRails) ? message.epicRails as string[] : [];
                    this.client.createEpic(title, description, architectureNotes, epicRails);
                    vscode.window.showInformationMessage(`Epic "${title}" created.`);
                    this.dispose();
                    break;
                }
                case 'save': {
                    const epicId = String(message.epicId ?? '');
                    const title = String(message.title ?? '').trim();
                    if (!title) {
                        vscode.window.showErrorMessage('Epic title is required.');
                        return;
                    }
                    const updates: Record<string, unknown> = {
                        title,
                        description: String(message.description ?? '').trim(),
                        architectureNotes: String(message.architectureNotes ?? '').trim(),
                        epicRails: Array.isArray(message.epicRails) ? message.epicRails : [],
                        status: String(message.status ?? 'PLANNED'),
                    };
                    this.client.updateEpic(epicId, updates as Parameters<typeof this.client.updateEpic>[1]);
                    vscode.window.showInformationMessage(`Epic "${title}" updated.`);
                    this.dispose();
                    break;
                }
                case 'delete': {
                    const epicId = String(message.epicId ?? '');
                    const confirmed = await vscode.window.showWarningMessage(
                        'Are you sure you want to delete this epic? All tasks in this epic will also be deleted.',
                        { modal: true },
                        'Delete'
                    );
                    if (confirmed === 'Delete') {
                        this.client.deleteEpic(epicId);
                        vscode.window.showInformationMessage('Epic deleted.');
                        this.dispose();
                    }
                    break;
                }
                case 'cancel':
                    this.dispose();
                    break;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Epic operation failed: ${msg}`);
        }
    }

    private getWebviewContent(): string {
        const nonce = getNonce();
        const epic = this.epicId && this.state
            ? this.state.epics.find((e) => e.id === this.epicId)
            : undefined;

        const isEdit = !!epic;
        const titleVal = escapeHtml(epic?.title ?? '');
        const descVal = escapeHtml(epic?.description ?? '');
        const archVal = escapeHtml(epic?.architectureNotes ?? '');
        const railsVal = escapeHtml(epic?.epicRails?.join('\n') ?? '');
        const statusVal = epic?.status ?? 'PLANNED';
        const epicIdVal = escapeHtml(epic?.id ?? '');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>${isEdit ? 'Edit Epic' : 'Create Epic'}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 24px;
            max-width: 700px;
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
        input[type="text"], textarea, select {
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
        input[type="text"]:focus, textarea:focus, select:focus {
            border-color: var(--vscode-focusBorder);
        }
        textarea {
            resize: vertical;
            min-height: 60px;
        }
        .hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }
        .error-text {
            color: var(--vscode-errorForeground, #f44336);
            font-size: 11px;
            margin-top: 2px;
            display: none;
        }
        .actions {
            display: flex;
            gap: 8px;
            margin-top: 24px;
        }
        button {
            padding: 6px 16px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            border: none;
            border-radius: 2px;
            cursor: pointer;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-danger {
            background: #dc3545;
            color: #fff;
        }
        .btn-danger:hover:not(:disabled) {
            background: #c82333;
        }
        .spacer {
            flex: 1;
        }
    </style>
</head>
<body>
    <h1>${isEdit ? 'Edit Epic' : 'Create Epic'}</h1>

    <div class="form-group">
        <label for="titleInput">Title *</label>
        <input type="text" id="titleInput" value="${titleVal}" placeholder="Epic title" />
        <div class="error-text" id="titleError">Title is required.</div>
    </div>

    <div class="form-group">
        <label for="descInput">Description</label>
        <textarea id="descInput" rows="4" placeholder="Describe the epic goals and scope">${descVal}</textarea>
    </div>

    <div class="form-group">
        <label for="archInput">Architecture Notes</label>
        <textarea id="archInput" rows="4" placeholder="Technical guidance, architecture decisions, file structure">${archVal}</textarea>
    </div>

    <div class="form-group">
        <label for="railsInput">Epic Rails</label>
        <textarea id="railsInput" rows="3" placeholder="One constraint per line">${railsVal}</textarea>
        <div class="hint">One rail per line. Rails guide task implementation within this epic.</div>
    </div>

    ${isEdit ? `
    <div class="form-group">
        <label for="statusSelect">Status</label>
        <select id="statusSelect">
            <option value="PLANNED"${statusVal === 'PLANNED' ? ' selected' : ''}>Planned</option>
            <option value="ACTIVE"${statusVal === 'ACTIVE' ? ' selected' : ''}>Active</option>
            <option value="COMPLETED"${statusVal === 'COMPLETED' ? ' selected' : ''}>Completed</option>
        </select>
    </div>
    ` : ''}

    <div class="actions">
        ${isEdit ? `<button class="btn-primary" id="saveBtn">Save</button>` : `<button class="btn-primary" id="createBtn">Create</button>`}
        ${isEdit ? `<div class="spacer"></div><button class="btn-danger" id="deleteBtn">Delete Epic</button>` : ''}
        <button class="btn-secondary" id="cancelBtn">Cancel</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const isEdit = ${isEdit ? 'true' : 'false'};
        const epicId = '${epicIdVal}';

        const titleInput = document.getElementById('titleInput');
        const descInput = document.getElementById('descInput');
        const archInput = document.getElementById('archInput');
        const railsInput = document.getElementById('railsInput');
        const titleError = document.getElementById('titleError');

        function getTrimmedTitle() {
            return titleInput.value.trim();
        }

        function getRails() {
            return railsInput.value
                .split('\\n')
                .map(function(line) { return line.trim(); })
                .filter(function(line) { return line.length > 0; });
        }

        function validateTitle() {
            const valid = getTrimmedTitle().length > 0;
            titleError.style.display = valid ? 'none' : 'block';
            return valid;
        }

        titleInput.addEventListener('input', function() {
            validateTitle();
        });

        if (isEdit) {
            var saveBtn = document.getElementById('saveBtn');
            if (saveBtn) {
                saveBtn.addEventListener('click', function() {
                    if (!validateTitle()) { return; }
                    var statusSelect = document.getElementById('statusSelect');
                    vscode.postMessage({
                        type: 'save',
                        epicId: epicId,
                        title: getTrimmedTitle(),
                        description: descInput.value.trim(),
                        architectureNotes: archInput.value.trim(),
                        epicRails: getRails(),
                        status: statusSelect ? statusSelect.value : 'PLANNED'
                    });
                });
            }

            var deleteBtn = document.getElementById('deleteBtn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', function() {
                    vscode.postMessage({ type: 'delete', epicId: epicId });
                });
            }
        } else {
            var createBtn = document.getElementById('createBtn');
            if (createBtn) {
                createBtn.addEventListener('click', function() {
                    if (!validateTitle()) { return; }
                    vscode.postMessage({
                        type: 'create',
                        title: getTrimmedTitle(),
                        description: descInput.value.trim(),
                        architectureNotes: archInput.value.trim(),
                        epicRails: getRails()
                    });
                });
            }
        }

        var cancelBtn = document.getElementById('cancelBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'cancel' });
            });
        }

        // Focus title on load
        titleInput.focus();
    </script>
</body>
</html>`;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
