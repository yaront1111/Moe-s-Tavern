import * as path from 'path';
import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { ChatChannel, ChatMessage, PinEntry, Decision } from '../types/moe';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'moe.chat';
    private _view?: vscode.WebviewView;
    private _webviewReady = false;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly daemonClient: MoeDaemonClient
    ) {
        this.disposables.push(
            daemonClient.onMessageCreated((msg) => {
                this.postToWebview({ type: 'newMessage', message: msg });
                this.notifyIfNeeded(msg);
            })
        );

        this.disposables.push(
            daemonClient.onChannelCreated((channel) => {
                this.postToWebview({ type: 'channelCreated', channel });
            })
        );

        this.disposables.push(
            daemonClient.onChannelsReceived((channels) => {
                this.postToWebview({ type: 'updateChannels', channels });
            })
        );

        this.disposables.push(
            daemonClient.onMessagesReceived((data) => {
                this.postToWebview({ type: 'loadMessages', channel: data.channel, messages: data.messages });
            })
        );

        this.disposables.push(
            daemonClient.onPinsReceived((data) => {
                this.postToWebview({ type: 'loadPins', channel: data.channel, pins: data.pins });
            })
        );

        this.disposables.push(
            daemonClient.onPinCreated((data) => {
                this.postToWebview({ type: 'pinCreated', channel: data.channel, pin: data.pin });
            })
        );

        this.disposables.push(
            daemonClient.onPinRemoved((data) => {
                this.postToWebview({ type: 'pinRemoved', channel: data.channel, messageId: data.messageId });
            })
        );

        this.disposables.push(
            daemonClient.onPinToggled((data) => {
                this.postToWebview({ type: 'pinToggled', channel: data.channel, pin: data.pin });
            })
        );

        this.disposables.push(
            daemonClient.onDecisionsReceived((decisions) => {
                this.postToWebview({ type: 'loadDecisions', decisions });
            })
        );

        this.disposables.push(
            daemonClient.onDecisionProposed((decision) => {
                this.postToWebview({ type: 'decisionProposed', decision });
            })
        );

        this.disposables.push(
            daemonClient.onDecisionResolved((decision) => {
                this.postToWebview({ type: 'decisionResolved', decision });
            })
        );

        this.disposables.push(
            daemonClient.onConnectionChanged((status) => {
                this.postToWebview({ type: 'updateConnection', status });
                if (status === 'connected') {
                    daemonClient.requestChannels();
                }
            })
        );

        this.disposables.push(
            daemonClient.onStateChanged((state) => {
                if (state?.workers) {
                    this.postToWebview({ type: 'updateWorkers', workers: state.workers.map(w => ({ id: w.id, status: w.status || 'IDLE' })) });
                }
                if (state?.channels) {
                    this.postToWebview({ type: 'updateChannels', channels: state.channels });
                }
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
        this._webviewReady = false;

        this.disposables.push(
            webviewView.onDidDispose(() => {
                this._view = undefined;
                this._webviewReady = false;
            })
        );

        this.disposables.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible && this._webviewReady) {
                    this.postToWebview({ type: 'updateConnection', status: this.daemonClient.connectionState });
                    if (this.daemonClient.connectionState === 'connected') {
                        this.daemonClient.requestChannels();
                    }
                }
            })
        );

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // Register message handler BEFORE setting HTML to avoid race condition
        this.disposables.push(
            webviewView.webview.onDidReceiveMessage((message) => {
                this.handleWebviewMessage(message);
            })
        );

        webviewView.webview.html = this.getHtmlContent(webviewView.webview);
    }

    private handleWebviewMessage(message: { type: string; [key: string]: unknown }): void {
        try {
            switch (message.type) {
                case 'ready':
                    this._webviewReady = true;
                    this.postToWebview({ type: 'updateConnection', status: this.daemonClient.connectionState });
                    if (this.daemonClient.connectionState === 'connected') {
                        this.daemonClient.requestChannels();
                        this.daemonClient.requestDecisions();
                        const state = this.daemonClient.currentState;
                        if (state?.workers) {
                            this.postToWebview({ type: 'updateWorkers', workers: state.workers.map(w => ({ id: w.id, status: w.status || 'IDLE' })) });
                        }
                    }
                    break;
                case 'selectChannel':
                    if (typeof message.channel === 'string') {
                        this.daemonClient.requestMessages(message.channel as string, 50);
                        this.daemonClient.requestPins(message.channel as string);
                    }
                    break;
                case 'sendMessage':
                    if (typeof message.channel === 'string' && typeof message.content === 'string') {
                        this.daemonClient.sendChatMessage(message.channel as string, message.content as string);
                    }
                    break;
                case 'pinMessage':
                    if (typeof message.channel === 'string' && typeof message.messageId === 'string') {
                        this.daemonClient.pinMessage(message.channel as string, message.messageId as string);
                    }
                    break;
                case 'unpinMessage':
                    if (typeof message.channel === 'string' && typeof message.messageId === 'string') {
                        this.daemonClient.unpinMessage(message.channel as string, message.messageId as string);
                    }
                    break;
                case 'togglePinDone':
                    if (typeof message.channel === 'string' && typeof message.messageId === 'string') {
                        this.daemonClient.togglePinDone(message.channel as string, message.messageId as string);
                    }
                    break;
                case 'approveDecision':
                    if (typeof message.decisionId === 'string') {
                        this.daemonClient.approveDecision(message.decisionId as string);
                    }
                    break;
                case 'rejectDecision':
                    if (typeof message.decisionId === 'string') {
                        this.daemonClient.rejectDecision(message.decisionId as string);
                    }
                    break;
                case 'openFile':
                    if (typeof message.path === 'string') {
                        this.openFileAtPath(message.path as string, typeof message.line === 'number' ? message.line as number : 0);
                    }
                    break;
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Chat error: ${errMsg}`);
        }
    }

    private notifyIfNeeded(msg: ChatMessage): void {
        try {
            if (msg.sender === 'human' || msg.sender === 'system') {
                return;
            }
            const config = vscode.workspace.getConfiguration('moe.chat.notifications');
            const enabled = config.get<boolean>('enabled', true);
            if (!enabled) {
                return;
            }
            const mutedChannels = config.get<string[]>('mutedChannels', []);
            if (mutedChannels.includes(msg.channel)) {
                return;
            }
            const truncated = msg.content.length > 80 ? msg.content.slice(0, 80) + '...' : msg.content;
            vscode.window.showInformationMessage(`[Moe Chat] ${msg.sender}: ${truncated}`);

            // Sound notification is handled by the OS via showInformationMessage above.
            // Webview audio doesn't play when the panel is hidden (the primary use case).
        } catch {
            // Never break message flow
        }
    }

    private async openFileAtPath(filePath: string, line: number): Promise<void> {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            const absPath = path.resolve(workspaceFolder.uri.fsPath, filePath);
            const uri = vscode.Uri.file(absPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const lineNum = Math.max(0, line - 1);
            await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(lineNum, 0, lineNum, 0)
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Could not open file: ${errMsg}`);
        }
    }

    private postToWebview(message: unknown): void {
        if (this._view && this._webviewReady) {
            this._view.webview.postMessage(message);
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
    <title>Moe Chat</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Channel tabs */
        .channel-tabs {
            display: flex;
            gap: 2px;
            padding: 4px 8px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            overflow-x: auto;
            flex-shrink: 0;
        }
        .channel-tab {
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
            font-size: 11px;
            color: var(--vscode-foreground);
            opacity: 0.7;
            background: transparent;
            border: none;
        }
        .channel-tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
        .channel-tab.active {
            opacity: 1;
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .channel-tab .type-icon {
            margin-right: 3px;
            font-size: 10px;
        }
        .channel-tab .unread {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 8px;
            padding: 0 5px;
            font-size: 10px;
            margin-left: 4px;
        }

        /* Messages area */
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }
        .message {
            margin-bottom: 8px;
            padding: 4px 0;
        }
        .message-header {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 2px;
        }
        .sender-badge {
            font-weight: 600;
            font-size: 12px;
            padding: 1px 6px;
            border-radius: 3px;
        }
        .sender-human { color: #4fc1ff; }
        .sender-system { color: var(--vscode-descriptionForeground); font-style: italic; }
        .sender-agent { color: #dcdcaa; }
        .timestamp {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .message-content {
            margin-left: 2px;
            line-height: 1.4;
            word-break: break-word;
        }
        .message-content pre {
            background: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            margin: 4px 0;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: var(--vscode-editor-font-size);
        }
        .message-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 0.9em;
        }
        .message-content pre code {
            background: none;
            padding: 0;
        }
        .message-content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .message-content a:hover {
            text-decoration: underline;
        }
        .message-content ul, .message-content ol {
            padding-left: 20px;
            margin: 4px 0;
        }
        .message-content li {
            margin: 2px 0;
        }
        .message-content .file-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
            text-decoration-style: dotted;
            cursor: pointer;
        }
        .message-content .file-link:hover {
            text-decoration-style: solid;
        }
        .message.system-msg {
            opacity: 0.6;
            font-style: italic;
        }
        .message.system-msg .message-content {
            font-size: 11px;
        }
        .reply-quote {
            border-left: 2px solid var(--vscode-panel-border);
            padding-left: 8px;
            margin-bottom: 4px;
            opacity: 0.7;
            font-size: 11px;
        }
        .mention { color: #569cd6; font-weight: 600; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; vertical-align: middle; }

        /* Pinned section */
        .pinned-section {
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
            flex-shrink: 0;
            max-height: 200px;
            overflow-y: auto;
        }
        .pinned-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 8px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            user-select: none;
        }
        .pinned-header:hover { background: var(--vscode-list-hoverBackground); }
        .pinned-header .pin-icon { margin-right: 4px; }
        .pinned-header .pin-count {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 8px;
            padding: 0 5px;
            font-size: 10px;
            margin-left: 4px;
        }
        .pinned-header .chevron { font-size: 10px; }
        .pinned-list { padding: 0 8px 4px; }
        .pinned-list.collapsed { display: none; }
        .pinned-item {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            padding: 3px 4px;
            border-radius: 3px;
            font-size: 11px;
            line-height: 1.3;
        }
        .pinned-item:hover { background: var(--vscode-list-hoverBackground); }
        .pinned-item.done .pin-content { text-decoration: line-through; opacity: 0.6; }
        .pin-checkbox {
            cursor: pointer;
            margin-top: 2px;
            flex-shrink: 0;
        }
        .pin-content { flex: 1; word-break: break-word; }
        .pin-sender { font-weight: 600; margin-right: 4px; font-size: 10px; }
        .pin-unpin {
            cursor: pointer;
            opacity: 0;
            font-size: 10px;
            flex-shrink: 0;
            color: var(--vscode-descriptionForeground);
        }
        .pinned-item:hover .pin-unpin { opacity: 0.7; }
        .pin-unpin:hover { opacity: 1 !important; }

        /* Pin icon on message hover */
        .message { position: relative; }
        .message .pin-btn {
            position: absolute;
            top: 4px;
            right: 4px;
            display: none;
            cursor: pointer;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            padding: 1px 4px;
            line-height: 1;
        }
        .message:hover .pin-btn { display: inline-block; }
        .message .pin-btn:hover { color: var(--vscode-foreground); }

        /* Decision card */
        .decision-card {
            border: 1px solid #d4a017;
            border-left: 3px solid #d4a017;
            border-radius: 4px;
            padding: 8px 10px;
            margin: 4px 0;
            background: rgba(212, 160, 23, 0.08);
        }
        .decision-card .decision-label {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            color: #d4a017;
            margin-bottom: 4px;
        }
        .decision-card .decision-content {
            line-height: 1.4;
            margin-bottom: 6px;
        }
        .decision-card .decision-actions {
            display: flex;
            gap: 6px;
        }
        .decision-card .decision-actions button {
            padding: 3px 10px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            background: transparent;
            color: var(--vscode-foreground);
        }
        .decision-card .decision-actions button:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .decision-card .decision-actions .approve-btn {
            border-color: #22c55e;
            color: #22c55e;
        }
        .decision-card .decision-actions .approve-btn:hover {
            background: rgba(34, 197, 94, 0.15);
        }
        .decision-card .decision-actions .reject-btn {
            border-color: #ef4444;
            color: #ef4444;
        }
        .decision-card .decision-actions .reject-btn:hover {
            background: rgba(239, 68, 68, 0.15);
        }
        .decision-card .decision-status {
            font-size: 11px;
            font-weight: 600;
        }
        .decision-card .decision-status.approved { color: #22c55e; }
        .decision-card .decision-status.rejected { color: #ef4444; }

        /* Input area */
        .input-area {
            display: flex;
            gap: 4px;
            padding: 8px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
            flex-shrink: 0;
        }
        .input-area textarea {
            flex: 1;
            resize: none;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            padding: 6px 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            border-radius: 4px;
            outline: none;
            min-height: 32px;
            max-height: 80px;
        }
        .input-area textarea:focus {
            border-color: var(--vscode-focusBorder);
        }
        .input-area button {
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            align-self: flex-end;
        }
        .input-area button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .input-area button:disabled {
            opacity: 0.5;
            cursor: default;
        }

        /* Mention autocomplete */
        .mention-dropdown {
            display: none;
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 4px;
            max-height: 120px;
            overflow-y: auto;
            z-index: 10;
        }
        .mention-dropdown.visible { display: block; }
        .mention-item {
            padding: 4px 8px;
            cursor: pointer;
            font-size: 12px;
        }
        .mention-item:hover, .mention-item.selected {
            background: var(--vscode-list-hoverBackground);
        }

        /* Connection overlay */
        .overlay {
            display: none;
            position: absolute;
            inset: 0;
            background: var(--vscode-editor-background);
            opacity: 0.9;
            justify-content: center;
            align-items: center;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            z-index: 20;
        }
        .overlay.visible { display: flex; }

        /* Empty state */
        .empty-state {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .input-wrapper {
            position: relative;
            flex: 1;
        }
    </style>
</head>
<body>
    <div class="overlay" id="overlay">Not connected to daemon</div>
    <div class="channel-tabs" id="channelTabs"></div>
    <div class="pinned-section" id="pinnedSection" style="display:none">
        <div class="pinned-header" id="pinnedHeader">
            <span><span class="pin-icon">&#128204;</span>Pinned<span class="pin-count" id="pinCount">0</span></span>
            <span class="chevron" id="pinChevron">&#9660;</span>
        </div>
        <div class="pinned-list" id="pinnedList"></div>
    </div>
    <div class="messages" id="messages">
        <div class="empty-state">Select a channel to start chatting</div>
    </div>
    <div class="input-area" id="inputArea">
        <div class="input-wrapper">
            <div class="mention-dropdown" id="mentionDropdown"></div>
            <textarea id="chatInput" rows="1" placeholder="Type a message..." disabled></textarea>
        </div>
        <button id="sendBtn" disabled>Send</button>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
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
