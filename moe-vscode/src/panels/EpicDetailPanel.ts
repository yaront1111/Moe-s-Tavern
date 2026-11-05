import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { Epic, MoeStateSnapshot } from '../types/moe';

// The JetBrains MoeBundle.properties texts of 19af5ca6, copied exactly so both IDEs say the same thing.
const ARCHIVE_EPIC_TITLE = 'Archive Epic';
const ARCHIVE_EPIC_CONFIRM = 'Archive epic "{0}" and its {1} task(s)? Every task of the epic that is not archived yet, including Backlog, Review, Blocked and Done tasks, moves to Archived and leaves the board. Setting the epic back to Active later does not bring them back.';
const ARCHIVE_EPIC_IN_FLIGHT = 'Epic "{0}" was not archived and nothing was sent. These tasks are still in Planning, Awaiting Approval or Working and must leave those columns first, for example by moving them to Backlog:\n{1}\nYour edits are still in this dialog.';
// moe.archive_epic's IN_FLIGHT (packages/moe-daemon/src/tools/archiveEpic.ts): any of these refuses the archive.
const IN_FLIGHT_STATUSES: readonly string[] = ['PLANNING', 'AWAITING_APPROVAL', 'WORKING'];

/** Fills {0}/{1} in one pass, so a value holding `{1}` or `$&` is inserted verbatim and never re-scanned. */
function fillPlaceholders(template: string, values: readonly string[]): string {
    return template.replace(/\{(\d)\}/g, (match, index: string) => values[Number(index)] ?? match);
}

/** The save awaiting the daemon: 'save' is one frame, 'fields' an archive's field frame, 'archive' its status frame. */
interface PendingSave {
    epicId: string;
    title: string;
    stage: 'save' | 'fields' | 'archive';
}

type EpicUpdates = Parameters<MoeDaemonClient['updateEpic']>[1];

export class EpicDetailPanel implements vscode.Disposable {
    public static readonly viewType = 'moe.epicDetail';

    private static panels: Map<string, EpicDetailPanel> = new Map();

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private pendingSave: PendingSave | undefined;
    private confirming = false;

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

        this.disposables.push(
            this.client.onEpicUpdated((epic) => this.onEpicEcho(epic)),
            this.client.onError((event) => this.onSaveRefused(event)),
            this.client.onConnectionChanged((state) => this.onConnection(state))
        );
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
            // Retained: a form moved to a background tab keeps what was typed into it.
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const instance = new EpicDetailPanel(panel, extensionUri, client, epicId, state);
        EpicDetailPanel.panels.set(key, instance);
        return instance;
    }

    dispose(): void {
        const key = this.epicId ?? '__create__';
        EpicDetailPanel.panels.delete(key);
        this.pendingSave = undefined;

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
                    if (!this.client.createEpic(title, description, architectureNotes, epicRails)) {
                        // Nothing reached the socket: keep the form open so the typed epic survives a retry.
                        vscode.window.showWarningMessage('Not connected to Moe daemon — epic was not created.');
                        return;
                    }
                    vscode.window.showInformationMessage(`Epic "${title}" created.`);
                    this.dispose();
                    break;
                }
                case 'save':
                    await this.handleSave(message);
                    break;
                case 'delete': {
                    const epicId = String(message.epicId ?? '');
                    const confirmed = await vscode.window.showWarningMessage(
                        'Are you sure you want to delete this epic? All tasks in this epic will also be deleted.',
                        { modal: true },
                        'Delete'
                    );
                    if (confirmed === 'Delete') {
                        if (!this.client.deleteEpic(epicId)) {
                            vscode.window.showWarningMessage('Not connected to Moe daemon — epic was not deleted.');
                            return;
                        }
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

    /**
     * Save, decided from the NEWEST cache. Since task-625c7cfe the daemon refuses a whole UPDATE_EPIC to ARCHIVED,
     * typed fields included, while a task is in flight, so an archive never travels with the field edits
     * (JetBrains 19af5ca6): they go first, and the status frame follows the daemon's echo of them (onEpicEcho).
     */
    private async handleSave(message: { [key: string]: unknown }): Promise<void> {
        const epicId = String(message.epicId ?? '');
        const title = String(message.title ?? '').trim();
        if (!title) {
            vscode.window.showErrorMessage('Epic title is required.');
            return;
        }
        if (this.pendingSave || this.confirming) {
            vscode.window.showInformationMessage(`Still waiting for the Moe daemon to answer the last save of epic "${this.pendingSave?.title ?? title}".`);
            return;
        }
        const fields = {
            title,
            description: String(message.description ?? '').trim(),
            architectureNotes: String(message.architectureNotes ?? '').trim(),
            epicRails: Array.isArray(message.epicRails) ? message.epicRails as string[] : [],
        };
        const status = String(message.status ?? 'PLANNED');
        const epic = [this.client.currentState, this.state].map((s) => s?.epics.find((e) => e.id === epicId)).find(Boolean);
        // Not an archive move (an epic in neither cache is deleted, or archived and plain-updated by the daemon).
        if (status !== 'ARCHIVED' || !epic || epic.status === 'ARCHIVED') {
            this.sendSave(epicId, title, 'save', { ...fields, status } as EpicUpdates);
            return;
        }
        const tasks = ((this.client.currentState ?? this.state)?.tasks ?? []).filter((t) => t.epicId === epicId);
        const inFlight = tasks.filter((t) => IN_FLIGHT_STATUSES.includes(t.status));
        this.confirming = true;
        try {
            if (inFlight.length > 0) {
                const list = inFlight.map((t) => `- ${t.title}`).join('\n');
                await vscode.window.showWarningMessage(
                    fillPlaceholders(ARCHIVE_EPIC_IN_FLIGHT, [epic.title, list]), { modal: true });
                return;
            }
            const count = String(tasks.filter((t) => t.status !== 'ARCHIVED').length);
            const answer = await vscode.window.showWarningMessage(
                fillPlaceholders(ARCHIVE_EPIC_CONFIRM, [epic.title, count]), { modal: true }, ARCHIVE_EPIC_TITLE);
            if (answer !== ARCHIVE_EPIC_TITLE) {
                return;
            }
        } finally {
            this.confirming = false;
        }
        this.sendSave(epicId, title, 'fields', fields);
    }

    /** Sends the first frame of a save; the save is pending only once it really went out. */
    private sendSave(epicId: string, title: string, stage: 'save' | 'fields', updates: EpicUpdates): void {
        if (!this.client.updateEpic(epicId, updates)) {
            vscode.window.showWarningMessage('Not connected to Moe daemon — epic was not saved.');
            return;
        }
        this.pendingSave = { epicId, title, stage };
    }

    /**
     * The daemon's EPIC_UPDATED for the pending save's epic (it arrives twice: broadcast, then reply). /ws has no
     * correlation id, so replies match by epic id and never by echoed fields (validateEpicUpdates truncates them).
     * Accepted limit: on the one-frame path, a foreign update of the same epic reaching the daemon in the few ms
     * before our frame would count as the echo.
     */
    private onEpicEcho(epic: Epic | undefined): void {
        const pending = this.pendingSave;
        if (!pending || epic?.id !== pending.epicId) {
            return;
        }
        if (pending.stage === 'fields') {
            if (this.client.updateEpic(pending.epicId, { status: 'ARCHIVED' })) {
                pending.stage = 'archive';
            } else if (this.pendingSave === pending) {
                // A throwing socket already warned through onConnection and cleared the save.
                this.pendingSave = undefined;
                vscode.window.showWarningMessage('Not connected to Moe daemon — epic was saved but not archived.');
            }
            return;
        }
        if (pending.stage === 'archive' && epic.status !== 'ARCHIVED') {
            return;
        }
        this.pendingSave = undefined;
        const verb = pending.stage === 'archive' ? 'archived' : 'updated';
        vscode.window.showInformationMessage(`Epic "${pending.title}" ${verb}.`);
        this.dispose();
    }

    /** A refused UPDATE_EPIC for the pending save's epic: show the daemon's message, keep the panel and the edits. */
    private onSaveRefused(event: { operation?: string; message: string; context?: { epicId?: string } }): void {
        const pending = this.pendingSave;
        if (!pending || event.operation !== 'UPDATE_EPIC' || event.context?.epicId !== pending.epicId) {
            return;
        }
        this.pendingSave = undefined;
        const outcome = pending.stage === 'archive' ? 'was saved but not archived' : 'was not saved';
        vscode.window.showErrorMessage(`Epic "${pending.title}" ${outcome}: ${event.message}`);
    }

    private onConnection(state: string): void {
        const pending = this.pendingSave;
        if (!pending || state === 'connected') {
            return;
        }
        this.pendingSave = undefined;
        vscode.window.showWarningMessage(
            `Lost the connection to the Moe daemon before it confirmed the save of epic "${pending.title}". Your edits are still in this panel.`);
    }

    private getWebviewContent(): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'epicDetail.js'));
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
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
            <option value="ARCHIVED"${statusVal === 'ARCHIVED' ? ' selected' : ''}>Archived</option>
        </select>
    </div>
    ` : ''}

    <div class="actions">
        ${isEdit ? `<button class="btn-primary" id="saveBtn">Save</button>` : `<button class="btn-primary" id="createBtn">Create</button>`}
        ${isEdit ? `<div class="spacer"></div><button class="btn-danger" id="deleteBtn">Delete Epic</button>` : ''}
        <button class="btn-secondary" id="cancelBtn">Cancel</button>
    </div>

    <div id="initial-data" data-is-edit="${isEdit ? 'true' : 'false'}" data-epic-id="${epicIdVal}" style="display:none;"></div>
    <script src="${scriptUri}"></script>
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

