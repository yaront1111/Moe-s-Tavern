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

    private getHtmlContent(_webview: vscode.Webview): string {
        const nonce = this.getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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

    <script nonce="${nonce}">
    (function() {
        const vscode = acquireVsCodeApi();
        const prevState = vscode.getState() || {};

        let currentChannel = prevState.currentChannel || null;
        let channels = [];
        var workerMap = {};
        let unreadCounts = prevState.unreadCounts || {};
        let messageCache = prevState.messageCache || {};
        let mentionIdx = -1;
        let mentionFilter = '';
        let pinCache = prevState.pinCache || {};
        let pinsCollapsed = false;
        let decisionMap = prevState.decisionMap || {};

        const channelTabs = document.getElementById('channelTabs');
        const messagesEl = document.getElementById('messages');
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('sendBtn');
        const overlay = document.getElementById('overlay');
        const mentionDropdown = document.getElementById('mentionDropdown');
        const pinnedSection = document.getElementById('pinnedSection');
        const pinnedHeader = document.getElementById('pinnedHeader');
        const pinnedList = document.getElementById('pinnedList');
        const pinCount = document.getElementById('pinCount');
        const pinChevron = document.getElementById('pinChevron');

        function saveState() {
            vscode.setState({ currentChannel, unreadCounts, messageCache, pinCache, decisionMap });
        }

        // =====================================================================
        // Sender colors (deterministic per sender)
        // =====================================================================
        const agentColors = ['#dcdcaa', '#ce9178', '#c586c0', '#4ec9b0', '#d7ba7d', '#9cdcfe'];
        const senderColorMap = {};
        let nextColorIdx = 0;

        function getSenderColor(sender) {
            if (sender === 'human') return '';
            if (sender === 'system') return '';
            if (!senderColorMap[sender]) {
                senderColorMap[sender] = agentColors[nextColorIdx % agentColors.length];
                nextColorIdx++;
            }
            return senderColorMap[sender];
        }

        // =====================================================================
        // Channel rendering
        // =====================================================================
        const typeIcons = { general: '#', epic: 'E', task: 'T', custom: '*' };

        function renderChannels() {
            channelTabs.innerHTML = '';
            const grouped = { general: [], epic: [], task: [], custom: [] };
            for (const ch of channels) {
                const group = grouped[ch.type] || grouped.custom;
                group.push(ch);
            }
            for (const type of ['general', 'epic', 'task', 'custom']) {
                for (const ch of grouped[type]) {
                    const tab = document.createElement('button');
                    tab.className = 'channel-tab' + (ch.id === currentChannel ? ' active' : '');
                    const icon = typeIcons[ch.type] || '*';
                    let html = '<span class="type-icon">' + escapeHtml(icon) + '</span>' + escapeHtml(ch.name);
                    const unread = unreadCounts[ch.id] || 0;
                    if (unread > 0 && ch.id !== currentChannel) {
                        html += '<span class="unread">' + unread + '</span>';
                    }
                    tab.innerHTML = html;
                    tab.addEventListener('click', () => selectChannel(ch.id));
                    channelTabs.appendChild(tab);
                }
            }
        }

        function selectChannel(channelId) {
            currentChannel = channelId;
            unreadCounts[channelId] = 0;
            chatInput.disabled = false;
            sendBtn.disabled = false;
            renderChannels();
            messagesEl.innerHTML = '<div class="empty-state">Loading messages...</div>';
            vscode.postMessage({ type: 'selectChannel', channel: channelId });
            saveState();
        }

        // =====================================================================
        // Message rendering
        // =====================================================================
        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        function renderMarkdown(text) {
            try {
                // Extract fenced code blocks to placeholders
                const codeBlocks = [];
                let processed = text.replace(/\`\`\`(\\w*)\n([\\s\\S]*?)\`\`\`/g, function(match, lang, code) {
                    const idx = codeBlocks.length;
                    codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\\n$/, '')) + '</code></pre>');
                    return '%%CODEBLOCK_' + idx + '%%';
                });

                // Escape HTML in non-code portions
                processed = escapeHtml(processed);

                // Inline code (after escaping so backticks are literal)
                processed = processed.replace(/\`([^\`]+)\`/g, '<code>$1</code>');

                // Bold
                processed = processed.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');

                // Italic (single *)
                processed = processed.replace(/\\*(.+?)\\*/g, '<em>$1</em>');

                // Links [text](url) - only allow safe protocols
                processed = processed.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, function(match, text, url) {
                    if (/^(https?:|mailto:)/i.test(url)) {
                        return '<a href="' + url + '" target="_blank">' + text + '</a>';
                    }
                    return text;
                });

                // Unordered lists (lines starting with - )
                processed = processed.replace(/((?:^|\\n)- .+(?:\\n- .+)*)/g, function(block) {
                    const items = block.trim().split('\\n').map(function(line) {
                        return '<li>' + line.replace(/^- /, '') + '</li>';
                    }).join('');
                    return '<ul>' + items + '</ul>';
                });

                // Ordered lists (lines starting with 1. 2. etc)
                processed = processed.replace(/((?:^|\\n)\\d+\\. .+(?:\\n\\d+\\. .+)*)/g, function(block) {
                    const items = block.trim().split('\\n').map(function(line) {
                        return '<li>' + line.replace(/^\\d+\\.\\s/, '') + '</li>';
                    }).join('');
                    return '<ol>' + items + '</ol>';
                });

                // Newlines to <br> (but not inside code blocks placeholders)
                processed = processed.replace(/\\n/g, '<br>');

                // Restore code blocks
                for (let i = 0; i < codeBlocks.length; i++) {
                    processed = processed.replace('%%CODEBLOCK_' + i + '%%', codeBlocks[i]);
                }

                return processed;
            } catch (e) {
                return escapeHtml(text);
            }
        }

        function linkifyFilePaths(html) {
            try {
                // Match file paths with 2+ segments, optional :lineNumber
                // Skip content inside <a>, <code>, <pre> tags
                return html.replace(/(?:<[^>]+>)|(\b(?:[\w.-]+\/){1,}[\w.-]+(?::(\d+))?)/g, function(match, filePath, lineNum) {
                    if (!filePath) return match; // HTML tag, return as-is
                    var line = lineNum || '0';
                    return '<a class="file-link" data-path="' + filePath.replace(/:(\d+)$/, '') + '" data-line="' + line + '">' + filePath + '</a>';
                });
            } catch (e) {
                return html;
            }
        }

        function highlightMentions(html) {
            return html.replace(/@(\\w[\\w-]*)/g, '<span class="mention">@$1</span>');
        }

        function renderContent(text, isSystem) {
            try {
                if (isSystem) {
                    return '<em>' + escapeHtml(text) + '</em>';
                }
                return highlightMentions(linkifyFilePaths(renderMarkdown(text)));
            } catch (e) {
                return escapeHtml(text);
            }
        }

        var statusColors = { IDLE: '#888', CODING: '#22c55e', PLANNING: '#a855f7', BLOCKED: '#ef4444', READING_CONTEXT: '#3b82f6', AWAITING_APPROVAL: '#f59e0b' };

        function getStatusIndicator(sender) {
            var w = workerMap[sender];
            if (!w || sender === 'human' || sender === 'system') return '';
            var color = statusColors[w.status] || statusColors.IDLE;
            return '<span class="status-dot" data-sender="' + escapeHtml(sender) + '" style="background:' + color + '"></span>';
        }

        function refreshStatusBadges() {
            var dots = messagesEl.querySelectorAll('.status-dot');
            for (var i = 0; i < dots.length; i++) {
                var sender = dots[i].dataset.sender;
                var w = workerMap[sender];
                var color = w ? (statusColors[w.status] || statusColors.IDLE) : statusColors.IDLE;
                dots[i].style.background = color;
            }
        }

        // =====================================================================
        // Pinned messages
        // =====================================================================
        pinnedHeader.addEventListener('click', function() {
            pinsCollapsed = !pinsCollapsed;
            pinnedList.classList.toggle('collapsed', pinsCollapsed);
            pinChevron.textContent = pinsCollapsed ? '\\u25B6' : '\\u25BC';
        });

        function renderPins() {
            var pins = pinCache[currentChannel] || [];
            if (pins.length === 0) {
                pinnedSection.style.display = 'none';
                return;
            }
            pinnedSection.style.display = '';
            pinCount.textContent = String(pins.length);
            pinnedList.innerHTML = '';
            var cachedMsgs = messageCache[currentChannel] || [];
            for (var i = 0; i < pins.length; i++) {
                var pin = pins[i];
                var msg = cachedMsgs.find(function(m) { return m.id === pin.messageId; });
                var item = document.createElement('div');
                item.className = 'pinned-item' + (pin.done ? ' done' : '');

                var checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'pin-checkbox';
                checkbox.checked = pin.done;
                checkbox.dataset.messageId = pin.messageId;
                checkbox.addEventListener('change', function(e) {
                    var msgId = e.target.dataset.messageId;
                    vscode.postMessage({ type: 'togglePinDone', channel: currentChannel, messageId: msgId });
                });

                var content = document.createElement('span');
                content.className = 'pin-content';
                if (msg) {
                    content.innerHTML = '<span class="pin-sender">' + escapeHtml(msg.sender) + ':</span>' +
                        escapeHtml(msg.content.length > 120 ? msg.content.slice(0, 120) + '...' : msg.content);
                } else {
                    content.textContent = '(message ' + pin.messageId.slice(0, 8) + ')';
                }

                var unpin = document.createElement('span');
                unpin.className = 'pin-unpin';
                unpin.textContent = '\\u2715';
                unpin.title = 'Unpin';
                unpin.dataset.messageId = pin.messageId;
                unpin.addEventListener('click', function(e) {
                    var msgId = e.target.dataset.messageId;
                    vscode.postMessage({ type: 'unpinMessage', channel: currentChannel, messageId: msgId });
                });

                item.appendChild(checkbox);
                item.appendChild(content);
                item.appendChild(unpin);
                pinnedList.appendChild(item);
            }
        }

        function formatTime(iso) {
            try {
                const d = new Date(iso);
                return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } catch { return ''; }
        }

        function renderMessage(msg, allMessages) {
            const div = document.createElement('div');
            const isSystem = msg.sender === 'system';
            div.className = 'message' + (isSystem ? ' system-msg' : '');
            div.dataset.id = msg.id;

            let html = '';

            // Reply quote
            if (msg.replyTo) {
                const parent = allMessages.find(m => m.id === msg.replyTo);
                if (parent) {
                    html += '<div class="reply-quote">' + escapeHtml(parent.sender) + ': ' +
                            escapeHtml(parent.content.slice(0, 100)) + '</div>';
                }
            }

            // Header
            const senderClass = msg.sender === 'human' ? 'sender-human' :
                                msg.sender === 'system' ? 'sender-system' : 'sender-agent';
            const colorStyle = getSenderColor(msg.sender);
            const styleAttr = colorStyle ? ' style="color:' + colorStyle + '"' : '';
            html += '<div class="message-header">';
            html += getStatusIndicator(msg.sender);
            html += '<span class="sender-badge ' + senderClass + '"' + styleAttr + '>' + escapeHtml(msg.sender) + '</span>';
            html += '<span class="timestamp">' + formatTime(msg.timestamp) + '</span>';
            html += '</div>';

            // Content
            html += '<div class="message-content">' + renderContent(msg.content, isSystem) + '</div>';

            // Decision card (if message linked to a decision)
            if (msg.decisionId && decisionMap[msg.decisionId]) {
                var dec = decisionMap[msg.decisionId];
                html += '<div class="decision-card" data-decision-id="' + escapeHtml(dec.id) + '">';
                html += '<div class="decision-label">&#9878; Decision</div>';
                html += '<div class="decision-content">' + escapeHtml(dec.content) + '</div>';
                if (dec.status === 'proposed') {
                    html += '<div class="decision-actions">';
                    html += '<button class="approve-btn" data-decision-id="' + escapeHtml(dec.id) + '">&#10003; Approve</button>';
                    html += '<button class="reject-btn" data-decision-id="' + escapeHtml(dec.id) + '">&#10007; Reject</button>';
                    html += '</div>';
                } else {
                    html += '<div class="decision-status ' + dec.status + '">';
                    html += dec.status === 'approved' ? '&#10003; Approved' : '&#10007; Rejected';
                    if (dec.approvedBy) html += ' by ' + escapeHtml(dec.approvedBy);
                    html += '</div>';
                }
                html += '</div>';
            }

            // Pin button (on hover)
            if (!isSystem) {
                html += '<span class="pin-btn" data-msg-id="' + msg.id + '" title="Pin message">&#128204;</span>';
            }

            div.innerHTML = html;
            return div;
        }

        function renderMessages(messages) {
            messagesEl.innerHTML = '';
            if (!messages || messages.length === 0) {
                messagesEl.innerHTML = '<div class="empty-state">No messages yet</div>';
                return;
            }
            for (const msg of messages) {
                messagesEl.appendChild(renderMessage(msg, messages));
            }
            scrollToBottom(true);
        }

        function appendMessage(msg) {
            // Remove empty state if present
            const empty = messagesEl.querySelector('.empty-state');
            if (empty) empty.remove();

            const isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
            const allCached = messageCache[currentChannel] || [];
            messagesEl.appendChild(renderMessage(msg, allCached));
            if (isNearBottom) {
                scrollToBottom(false);
            }
        }

        function scrollToBottom(force) {
            if (force) {
                messagesEl.scrollTop = messagesEl.scrollHeight;
            } else {
                messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
            }
        }

        // =====================================================================
        // @mention autocomplete
        // =====================================================================
        function showMentionDropdown(filter) {
            mentionFilter = filter.toLowerCase();
            const matches = Object.keys(workerMap).filter(function(id) { return id.toLowerCase().startsWith(mentionFilter); });
            if (matches.length === 0) {
                mentionDropdown.classList.remove('visible');
                return;
            }
            mentionIdx = 0;
            mentionDropdown.innerHTML = '';
            for (let i = 0; i < matches.length; i++) {
                const item = document.createElement('div');
                item.className = 'mention-item' + (i === 0 ? ' selected' : '');
                item.textContent = '@' + matches[i];
                item.addEventListener('click', () => insertMention(matches[i]));
                mentionDropdown.appendChild(item);
            }
            mentionDropdown.classList.add('visible');
        }

        function hideMentionDropdown() {
            mentionDropdown.classList.remove('visible');
            mentionIdx = -1;
        }

        function insertMention(worker) {
            const val = chatInput.value;
            const pos = chatInput.selectionStart;
            // Find the @ position before cursor
            const before = val.slice(0, pos);
            const atIdx = before.lastIndexOf('@');
            if (atIdx >= 0) {
                chatInput.value = val.slice(0, atIdx) + '@' + worker + ' ' + val.slice(pos);
                chatInput.selectionStart = chatInput.selectionEnd = atIdx + worker.length + 2;
            }
            hideMentionDropdown();
            chatInput.focus();
        }

        // =====================================================================
        // Input handling
        // =====================================================================
        chatInput.addEventListener('input', () => {
            const val = chatInput.value;
            const pos = chatInput.selectionStart;
            const before = val.slice(0, pos);
            const atMatch = before.match(/@(\\w*)$/);
            if (atMatch) {
                showMentionDropdown(atMatch[1]);
            } else {
                hideMentionDropdown();
            }
        });

        chatInput.addEventListener('keydown', (e) => {
            if (mentionDropdown.classList.contains('visible')) {
                const items = mentionDropdown.querySelectorAll('.mention-item');
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    mentionIdx = Math.min(mentionIdx + 1, items.length - 1);
                    items.forEach((it, i) => it.classList.toggle('selected', i === mentionIdx));
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    mentionIdx = Math.max(mentionIdx - 1, 0);
                    items.forEach((it, i) => it.classList.toggle('selected', i === mentionIdx));
                    return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    if (mentionIdx >= 0 && items[mentionIdx]) {
                        items[mentionIdx].click();
                    }
                    return;
                }
                if (e.key === 'Escape') {
                    hideMentionDropdown();
                    return;
                }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendBtn.addEventListener('click', sendMessage);

        // File link click handler
        messagesEl.addEventListener('click', function(e) {
            var link = e.target.closest('.file-link');
            if (link) {
                e.preventDefault();
                vscode.postMessage({ type: 'openFile', path: link.dataset.path, line: parseInt(link.dataset.line || '0', 10) });
                return;
            }
            var approveBtn = e.target.closest('.approve-btn[data-decision-id]');
            if (approveBtn) {
                e.preventDefault();
                vscode.postMessage({ type: 'approveDecision', decisionId: approveBtn.dataset.decisionId });
                return;
            }
            var rejectBtn = e.target.closest('.reject-btn[data-decision-id]');
            if (rejectBtn) {
                e.preventDefault();
                vscode.postMessage({ type: 'rejectDecision', decisionId: rejectBtn.dataset.decisionId });
                return;
            }
            var pinBtn = e.target.closest('.pin-btn');
            if (pinBtn && currentChannel) {
                e.preventDefault();
                vscode.postMessage({ type: 'pinMessage', channel: currentChannel, messageId: pinBtn.dataset.msgId });
            }
        });

        function sendMessage() {
            const content = chatInput.value.trim();
            if (!content || !currentChannel) return;
            vscode.postMessage({ type: 'sendMessage', channel: currentChannel, content });
            chatInput.value = '';
            hideMentionDropdown();
        }

        // =====================================================================
        // Inbound message handling
        // =====================================================================
        window.addEventListener('message', (event) => {
            const data = event.data;
            switch (data.type) {
                case 'updateChannels':
                    channels = data.channels || [];
                    renderChannels();
                    // Auto-select first channel if none selected
                    if (!currentChannel && channels.length > 0) {
                        selectChannel(channels[0].id);
                    }
                    break;

                case 'loadMessages':
                    if (data.channel === currentChannel) {
                        messageCache[currentChannel] = data.messages || [];
                        renderMessages(messageCache[currentChannel]);
                        saveState();
                    }
                    break;

                case 'newMessage': {
                    const msg = data.message;
                    if (!msg) break;
                    // Add to cache
                    if (!messageCache[msg.channel]) messageCache[msg.channel] = [];
                    messageCache[msg.channel].push(msg);
                    // If viewing this channel, append
                    if (msg.channel === currentChannel) {
                        appendMessage(msg);
                    } else {
                        // Increment unread
                        unreadCounts[msg.channel] = (unreadCounts[msg.channel] || 0) + 1;
                        renderChannels();
                    }
                    saveState();
                    break;
                }

                case 'channelCreated':
                    if (data.channel) {
                        channels.push(data.channel);
                        renderChannels();
                    }
                    break;

                case 'loadPins':
                    pinCache[data.channel] = data.pins || [];
                    if (data.channel === currentChannel) renderPins();
                    break;

                case 'pinCreated':
                    if (data.pin && data.channel) {
                        if (!pinCache[data.channel]) pinCache[data.channel] = [];
                        var exists = pinCache[data.channel].find(function(p) { return p.messageId === data.pin.messageId; });
                        if (!exists) pinCache[data.channel].push(data.pin);
                        if (data.channel === currentChannel) renderPins();
                    }
                    break;

                case 'pinRemoved':
                    if (data.messageId && data.channel && pinCache[data.channel]) {
                        pinCache[data.channel] = pinCache[data.channel].filter(function(p) { return p.messageId !== data.messageId; });
                        if (data.channel === currentChannel) renderPins();
                    }
                    break;

                case 'pinToggled':
                    if (data.pin && data.channel && pinCache[data.channel]) {
                        for (var pi = 0; pi < pinCache[data.channel].length; pi++) {
                            if (pinCache[data.channel][pi].messageId === data.pin.messageId) {
                                pinCache[data.channel][pi] = data.pin;
                                break;
                            }
                        }
                        if (data.channel === currentChannel) renderPins();
                    }
                    break;

                case 'loadDecisions':
                    decisionMap = {};
                    (data.decisions || []).forEach(function(d) { decisionMap[d.id] = d; });
                    // Re-render current messages to show decision cards
                    if (currentChannel && messageCache[currentChannel]) {
                        renderMessages(messageCache[currentChannel]);
                    }
                    break;

                case 'decisionProposed':
                    if (data.decision) {
                        decisionMap[data.decision.id] = data.decision;
                        // Re-render to show the new decision card
                        if (currentChannel && messageCache[currentChannel]) {
                            renderMessages(messageCache[currentChannel]);
                        }
                    }
                    break;

                case 'decisionResolved':
                    if (data.decision) {
                        decisionMap[data.decision.id] = data.decision;
                        // Update the decision card in-place
                        var card = messagesEl.querySelector('.decision-card[data-decision-id="' + data.decision.id + '"]');
                        if (card) {
                            var dec = data.decision;
                            var actionsEl = card.querySelector('.decision-actions');
                            if (actionsEl) actionsEl.remove();
                            var existingStatus = card.querySelector('.decision-status');
                            if (existingStatus) existingStatus.remove();
                            var statusDiv = document.createElement('div');
                            statusDiv.className = 'decision-status ' + dec.status;
                            statusDiv.innerHTML = dec.status === 'approved' ? '&#10003; Approved' : '&#10007; Rejected';
                            if (dec.approvedBy) statusDiv.innerHTML += ' by ' + escapeHtml(dec.approvedBy);
                            card.appendChild(statusDiv);
                        }
                    }
                    break;

                case 'updateWorkers':
                    workerMap = {};
                    (data.workers || []).forEach(function(w) { workerMap[w.id] = w; });
                    refreshStatusBadges();
                    break;

                case 'updateConnection':
                    if (data.status === 'connected') {
                        overlay.classList.remove('visible');
                    } else {
                        overlay.classList.add('visible');
                        overlay.textContent = data.status === 'connecting' ? 'Connecting...' : 'Not connected to daemon';
                    }
                    break;

            }
        });

        // Signal ready
        vscode.postMessage({ type: 'ready' });
    })();
    </script>
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
