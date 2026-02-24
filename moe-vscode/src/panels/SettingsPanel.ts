import * as vscode from 'vscode';
import type { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { MoeStateSnapshot, ProjectSettings } from '../types/moe';

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly daemonClient: MoeDaemonClient;
    private disposed = false;

    public static createOrShow(
        extensionUri: vscode.Uri,
        client: MoeDaemonClient,
        state: MoeStateSnapshot
    ): void {
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'moe.settings',
            'Moe Settings',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, client, state);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        client: MoeDaemonClient,
        state: MoeStateSnapshot
    ) {
        this.panel = panel;
        this.daemonClient = client;

        const nonce = this.getNonce();
        const settings = state.project?.settings;
        this.panel.webview.html = this.getWebviewContent(nonce, settings);

        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined
        );

        this.panel.onDidDispose(() => this.dispose());
    }

    private handleMessage(message: { type: string; [key: string]: unknown }): void {
        switch (message.type) {
            case 'save': {
                const settings: Partial<ProjectSettings> = {
                    approvalMode: message.approvalMode as ProjectSettings['approvalMode'],
                    speedModeDelayMs: Number(message.speedModeDelayMs),
                    agentCommand: String(message.agentCommand ?? '').trim(),
                    autoCreateBranch: Boolean(message.autoCreateBranch),
                    branchPattern: String(message.branchPattern ?? '').trim(),
                    commitPattern: String(message.commitPattern ?? '').trim(),
                };

                try {
                    this.daemonClient.updateSettings(settings);
                    vscode.window.showInformationMessage('Settings saved.');
                    this.dispose();
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to save settings: ${errMsg}`);
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
        SettingsPanel.currentPanel = undefined;
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

    private getWebviewContent(nonce: string, settings: ProjectSettings | undefined): string {
        const approvalMode = escapeHtml(settings?.approvalMode ?? 'CONTROL');
        const speedModeDelayMs = settings?.speedModeDelayMs ?? 2000;
        const agentCommand = escapeHtml(settings?.agentCommand ?? 'claude');
        const autoCreateBranch = settings?.autoCreateBranch ?? true;
        const branchPattern = escapeHtml(settings?.branchPattern ?? 'moe/{epicId}/{taskId}');
        const commitPattern = escapeHtml(settings?.commitPattern ?? 'feat({epicId}): {taskTitle}');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Moe Settings</title>
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
        h2 {
            font-size: 14px;
            font-weight: 600;
            margin-top: 24px;
            margin-bottom: 12px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
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
        label.checkbox-label {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
        }
        input[type="text"], input[type="number"], select {
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
        input[type="text"]:focus, input[type="number"]:focus, select:focus {
            border-color: var(--vscode-focusBorder);
        }
        input[type="checkbox"] {
            accent-color: var(--vscode-button-background);
        }
        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin-top: 2px;
        }
        .button-row {
            display: flex;
            gap: 8px;
            margin-top: 24px;
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
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <h1>Moe Settings</h1>

    <h2>Workflow</h2>

    <div class="form-group">
        <label for="approvalMode">Approval Mode</label>
        <select id="approvalMode">
            <option value="CONTROL"${approvalMode === 'CONTROL' ? ' selected' : ''}>CONTROL</option>
            <option value="SPEED"${approvalMode === 'SPEED' ? ' selected' : ''}>SPEED</option>
            <option value="TURBO"${approvalMode === 'TURBO' ? ' selected' : ''}>TURBO</option>
        </select>
        <div class="hint">CONTROL: Manual approval. SPEED: Auto-approve after delay. TURBO: Instant auto-approve.</div>
    </div>

    <div class="form-group">
        <label for="speedModeDelayMs">Speed Mode Delay (ms)</label>
        <input type="number" id="speedModeDelayMs" min="500" max="30000" step="500" value="${speedModeDelayMs}" />
    </div>

    <h2>Agent</h2>

    <div class="form-group">
        <label for="agentCommand">Agent Command</label>
        <input type="text" id="agentCommand" value="${agentCommand}" list="agentCommands" />
        <datalist id="agentCommands">
            <option value="claude">
            <option value="codex">
            <option value="gemini">
        </datalist>
        <div class="hint">CLI command used to launch AI agents</div>
    </div>

    <h2>Git</h2>

    <div class="form-group">
        <label class="checkbox-label">
            <input type="checkbox" id="autoCreateBranch"${autoCreateBranch ? ' checked' : ''} />
            Auto Create Branch
        </label>
    </div>

    <div class="form-group">
        <label for="branchPattern">Branch Pattern</label>
        <input type="text" id="branchPattern" value="${branchPattern}" />
        <div class="hint">Available: {epicId}, {taskId}</div>
    </div>

    <div class="form-group">
        <label for="commitPattern">Commit Pattern</label>
        <input type="text" id="commitPattern" value="${commitPattern}" />
        <div class="hint">Available: {epicId}, {taskTitle}</div>
    </div>

    <div class="button-row">
        <button class="btn-primary" id="saveBtn">Save</button>
        <button class="btn-secondary" id="cancelBtn">Cancel</button>
    </div>

    <script nonce="${nonce}">
        var vscode = acquireVsCodeApi();

        var approvalModeEl = document.getElementById('approvalMode');
        var speedModeDelayMsEl = document.getElementById('speedModeDelayMs');
        var agentCommandEl = document.getElementById('agentCommand');
        var autoCreateBranchEl = document.getElementById('autoCreateBranch');
        var branchPatternEl = document.getElementById('branchPattern');
        var commitPatternEl = document.getElementById('commitPattern');
        var saveBtn = document.getElementById('saveBtn');
        var cancelBtn = document.getElementById('cancelBtn');

        saveBtn.addEventListener('click', function() {
            vscode.postMessage({
                type: 'save',
                approvalMode: approvalModeEl.value,
                speedModeDelayMs: parseInt(speedModeDelayMsEl.value, 10) || 2000,
                agentCommand: agentCommandEl.value.trim(),
                autoCreateBranch: autoCreateBranchEl.checked,
                branchPattern: branchPatternEl.value.trim(),
                commitPattern: commitPatternEl.value.trim()
            });
        });

        cancelBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'cancel' });
        });
    </script>
</body>
</html>`;
    }
}
