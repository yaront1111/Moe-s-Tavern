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

/**
 * The English strings shared with JetBrains, keyed by their MoeBundle.properties key with the
 * bundle's <html>/<small> markup stripped. tests/settings-policy-corpus.test.cjs pins them to the
 * bundle. They live in this file because the test harnesses load the panel with a closed require map.
 */
export const SETTINGS_BUNDLE_TEXT = {
    'moe.label.landingPolicy': 'Landing & Gate Policy (read-only)',
    'moe.settings.landingPolicyHint': 'Read-only. These come from .moe/project.json settings; a key that is absent shows the daemon default.',
    'moe.settings.enableAgentTeams': 'Enable Agent Teams (Claude Code workers only)',
    'moe.settings.enableAgentTeamsHint': 'When enabled, Claude Code workers can spawn teammate instances for parallel sub-step work.',
};

export interface PolicyRow {
    label: string;
    value: string;
    detail: string;
}

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** planSize.ts positiveInt: a JSON number, an integer, above 0; anything else is the default. */
const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

/** moe-agent.sh `isinstance(v, str)` and complete_task `typeof === 'string'`: only a string counts. */
const trimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const SHARED_DATED_BRANCH = 'moe/work-<YYYY-MM-DD>';

function toggleRow(label: string, on: boolean, onDetail: string, offDetail: string): PolicyRow {
    return { label, value: on ? 'On' : 'Off', detail: on ? onDetail : offDetail };
}

function landingBranchRow(branch: string): PolicyRow {
    const label = 'Landing branch';
    if (branch === '') {
        return { label, value: `${SHARED_DATED_BRANCH} (shared, default)`, detail: 'No consolidationBranch set; wrappers peel onto the shared dated branch.' };
    }
    if (branch.includes('*')) {
        return { label, value: branch, detail: `Glob checked at complete_task only; wrappers still peel onto ${SHARED_DATED_BRANCH}.` };
    }
    return { label, value: branch, detail: 'Peel target and the branch complete_task requires.' };
}

/**
 * validators.ts resolveWorktreeMode: a stored 'on'/'off' is honoured; an unset mode is on only
 * with a non-blank string qualityGate. Any other stored value, null included, reads as unset here
 * (the daemon refuses it), so a hand-edited mode degrades to the gate rule instead of throwing.
 */
function worktreeModeOf(s: JsonObject): { on: boolean; fromDefault: boolean } {
    const stored = s.worktreeMode === 'on' || s.worktreeMode === 'off' ? s.worktreeMode : undefined;
    const fromDefault = stored === undefined && trimmedString(s.qualityGate) !== '';
    return { on: stored === 'on' || fromDefault, fromDefault };
}

/** validators.ts resolveWorktreeTarget over an already-trimmed branch: the literal, else main (a glob reads main). */
const worktreeTarget = (branch: string): string => (branch !== '' && !/[*?[]/.test(branch) ? branch : 'main');

function worktreeLandingRow(branch: string): PolicyRow {
    const label = 'Landing branch';
    const value = worktreeTarget(branch);
    if (branch === '') {
        return { label, value, detail: 'No consolidationBranch set; each completion lands as one squash commit on main.' };
    }
    if (value !== branch) {
        return { label, value, detail: 'A glob consolidationBranch is not a landing target; each completion lands on main.' };
    }
    return { label, value, detail: 'Each completion lands as one merge-tree squash commit on this branch.' };
}

function gateScopeRow(worktree: boolean, everyTask: boolean): PolicyRow {
    const label = 'Quality gate scope';
    if (worktree) {
        return { label, value: 'Every completion (worktree mode)', detail: 'Every worktree landing runs the gate, whatever qualityGateScope says.' };
    }
    return {
        label,
        value: everyTask ? 'Every task' : 'Epic-final task only',
        detail: everyTask ? "The gate runs before every task's completion commit." : 'The gate runs only on the last open task of an epic.',
    };
}

function attributionRow(undeclared: unknown): PolicyRow {
    const label = 'Undeclared-file attribution';
    if (undeclared === 'never') {
        return { label, value: 'Declared files only (never)', detail: 'A changed file nobody declared is never committed.' };
    }
    if (undeclared === 'always') {
        return { label, value: 'Always commit (always)', detail: 'A changed file nobody declared is committed regardless of live peers.' };
    }
    return { label, value: 'Commit when no other worker is live (solo)', detail: 'With a live peer, undeclared changes are reported unresolved instead.' };
}

function sizingRow(taskSizing: unknown): PolicyRow {
    const sizing = isJsonObject(taskSizing) ? taskSizing : {};
    const warnSteps = positiveInt(sizing.warnSteps, 8);
    const warnFiles = positiveInt(sizing.warnDistinctFiles, 5);
    const maxSteps = Math.max(warnSteps, positiveInt(sizing.maxSteps, 12));
    const maxFiles = Math.max(warnFiles, positiveInt(sizing.maxDistinctFiles, 10));
    return {
        label: 'Plan size limits',
        value: `Warn past ${warnSteps} steps / ${warnFiles} files, reject past ${maxSteps} / ${maxFiles}`,
        detail: 'Applied to every submitted plan.',
    };
}

/**
 * The effective landing and gate policy the daemon and wrappers apply, in display order. A port
 * of JetBrains' MoeSettingsDialog.effectivePolicyRows, but over the RAW wire settings: VS Code
 * keeps project.json untyped, so each value goes through the reader the daemon uses. It never
 * throws; project.json is hand-editable and a wrong type means the daemon default. Worktree mode
 * on adds a mode row before Landing branch and swaps in the worktree board, landing and scope rows.
 */
export function effectivePolicyRows(settings: unknown): PolicyRow[] {
    const s = isJsonObject(settings) ? settings : {};
    const attribution = isJsonObject(s.attribution) ? s.attribution : {};
    const qualityGate = trimmedString(s.qualityGate);
    const branch = trimmedString(s.consolidationBranch);
    const commitHooks = s.commitHooks === true;
    const mode = worktreeModeOf(s);
    const modeRow: PolicyRow = {
        label: 'Worktree mode',
        value: mode.fromDefault ? 'On (unset; a qualityGate is set)' : 'On',
        detail: 'Each WORKING claim works in .worktrees/<taskId> on moe/task/<taskId>.',
    };
    return [
        toggleRow('Auto-commit', s.autoCommit !== false, "Every session exit lands this task's attributed paths.", 'No completion, checkpoint or rescue commits.'),
        toggleRow('Checkpoint commits', s.checkpointCommits !== false, 'Non-final exits commit as wip(task-<id>): ...', 'No wip(task-<id>) commits; unlanded bytes wait for completion.'),
        toggleRow('Push checkpoints', s.checkpointPush !== false, 'Checkpoint commits are pushed to the remote.', 'Checkpoints stay local.'),
        mode.on
            ? toggleRow('Commit board state', s.commitBoardState !== false, 'Landings carry no .moe/ path; board history is snapshotted to refs/moe/board.', 'Landings carry no .moe/ path; no refs/moe/board snapshot is written.')
            : toggleRow('Commit board state', s.commitBoardState !== false, "Landing also stages this task's .moe/tasks/<id>.json.", "This task's .moe/tasks/<id>.json is left uncommitted."),
        {
            label: 'Commit hooks',
            value: commitHooks ? 'Run on completion commits' : 'Skipped (plumbing commits)',
            detail: commitHooks ? 'Completion commits run git hooks; checkpoints stay plumbing.' : 'Landing writes the commit directly, so no git hook runs.',
        },
        ...(mode.on ? [modeRow, worktreeLandingRow(branch)] : [landingBranchRow(branch)]),
        {
            label: 'Quality gate',
            value: qualityGate === '' ? 'Disabled (no command configured)' : qualityGate,
            detail: qualityGate === '' ? 'Nothing gates the completion commit.' : 'Must exit 0 before the completion commit lands.',
        },
        gateScopeRow(mode.on, s.qualityGateScope === 'everyTask'),
        attributionRow(attribution.undeclared),
        sizingRow(s.taskSizing),
    ];
}

function policyRowHtml(row: PolicyRow): string {
    const detail = row.detail === '' ? '' : `<div class="policy-detail">${escapeHtml(row.detail)}</div>`;
    return `<div class="policy-row"><span class="policy-label">${escapeHtml(row.label)}</span>: <span class="policy-value">${escapeHtml(row.value)}</span>${detail}</div>`;
}

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
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
            { enableScripts: true, localResourceRoots: [extensionUri] }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, client, state);
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
                    enableAgentTeams: message.enableAgentTeams === true,
                };

                try {
                    if (this.daemonClient.updateSettings(settings)) {
                        vscode.window.showInformationMessage('Settings saved.');
                        this.dispose();
                    } else {
                        // Nothing reached the socket: keep the panel open so the edits survive a retry.
                        vscode.window.showWarningMessage('Not connected to Moe daemon — settings were not saved.');
                    }
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

    private getWebviewContent(_nonce: string, settings: ProjectSettings | undefined): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'settings.js'));
        const approvalMode = escapeHtml(settings?.approvalMode ?? 'CONTROL');
        const speedModeDelayMs = settings?.speedModeDelayMs ?? 2000;
        const agentCommand = escapeHtml(settings?.agentCommand ?? 'claude');
        const enableAgentTeams = settings?.enableAgentTeams === true;
        const text = SETTINGS_BUNDLE_TEXT;
        const policyRows = effectivePolicyRows(settings).map(policyRowHtml).join('\n        ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
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
        .policy-row {
            margin-bottom: 8px;
        }
        .policy-label {
            font-weight: 600;
        }
        .policy-detail {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
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
            <option value="grok">
        </datalist>
        <div class="hint">CLI command used to launch AI agents</div>
    </div>

    <div class="form-group">
        <label class="checkbox-label">
            <input type="checkbox" id="enableAgentTeams"${enableAgentTeams ? ' checked' : ''} />
            ${escapeHtml(text['moe.settings.enableAgentTeams'])}
        </label>
        <div class="hint">${escapeHtml(text['moe.settings.enableAgentTeamsHint'])}</div>
    </div>

    <h2>${escapeHtml(text['moe.label.landingPolicy'])}</h2>

    <section id="landingPolicy">
        ${policyRows}
    </section>
    <div class="hint">${escapeHtml(text['moe.settings.landingPolicyHint'])}</div>

    <div class="button-row">
        <button class="btn-primary" id="saveBtn">Save</button>
        <button class="btn-secondary" id="cancelBtn">Cancel</button>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
