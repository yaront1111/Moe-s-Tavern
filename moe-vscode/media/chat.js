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
            let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
                const idx = codeBlocks.length;
                codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
                return '%%CODEBLOCK_' + idx + '%%';
            });

            // Escape HTML in non-code portions
            processed = escapeHtml(processed);

            // Inline code (after escaping so backticks are literal)
            processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

            // Bold
            processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

            // Italic (single *)
            processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>');

            // Links [text](url) - only allow safe protocols
            processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(match, text, url) {
                if (/^(https?:|mailto:)/i.test(url)) {
                    return '<a href="' + url + '" target="_blank">' + text + '</a>';
                }
                return text;
            });

            // Unordered lists (lines starting with - )
            processed = processed.replace(/((?:^|\n)- .+(?:\n- .+)*)/g, function(block) {
                const items = block.trim().split('\n').map(function(line) {
                    return '<li>' + line.replace(/^- /, '') + '</li>';
                }).join('');
                return '<ul>' + items + '</ul>';
            });

            // Ordered lists (lines starting with 1. 2. etc)
            processed = processed.replace(/((?:^|\n)\d+\. .+(?:\n\d+\. .+)*)/g, function(block) {
                const items = block.trim().split('\n').map(function(line) {
                    return '<li>' + line.replace(/^\d+\.\s/, '') + '</li>';
                }).join('');
                return '<ol>' + items + '</ol>';
            });

            // Newlines to <br> (but not inside code blocks placeholders)
            processed = processed.replace(/\n/g, '<br>');

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
        return html.replace(/@(\w[\w-]*)/g, '<span class="mention">@$1</span>');
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
        pinChevron.textContent = pinsCollapsed ? '\u25B6' : '\u25BC';
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
            unpin.textContent = '\u2715';
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
        const atMatch = before.match(/@(\w*)$/);
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
