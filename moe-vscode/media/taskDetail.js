    var vscodeApi = acquireVsCodeApi();
    var initData = document.getElementById('initial-data');
    var currentTaskStatus = initData.dataset.taskStatus;
    var currentTaskId = initData.dataset.taskId;

    function escapeHtml(text) {
        if (!text) { return ''; }
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Why a BLOCKED task is parked, and what will clear it. Copy of the
    // contract the JetBrains plugin owns (toolwindow/TaskBlockerPresentation.kt)
    // that src/panels/TaskDetailPanel.ts holds canonically and media/board.js
    // also carries: this is a plain browser script with no bundler, so it
    // cannot import that module.
    // tests/task-blocker-visibility.test.cjs drives one fixture table through
    // all three copies, so drift fails a test rather than shipping.
    var BLOCK_CAUSE_LABEL = {
        RESOURCE_WAIT: 'Resource wait',
        DEPENDENCY_WAIT: 'Dependency wait',
        EXTERNAL_BLOCK: 'External block'
    };
    var BLOCK_CAUSE_CLEARS = {
        RESOURCE_WAIT: 'Clears automatically when the shared resource lease is granted.',
        DEPENDENCY_WAIT: 'Clears automatically when every recorded prerequisite reaches a finished state (DONE or ARCHIVED).',
        EXTERNAL_BLOCK: 'Needs a person: a human or governor has to clear this block.'
    };
    var ATTENTION_LABEL = 'Awaiting human review';
    var ATTENTION_CLEARS = 'Needs a person: a human or QA has to review this task.';
    var BLOCKER_SECTION_TITLE = 'Blocker';
    var BLOCKER_REASON_LABEL = 'Reported reason';
    var BLOCKER_REASON_MISSING = 'No reason was recorded.';
    var BLOCKER_PREREQUISITES_LABEL = 'Prerequisites recorded as waited on';
    var BLOCKER_RESOURCE_LABEL = 'Resource';
    var BLOCKER_FROM_STATUS_LABEL = 'Blocked from';
    var BLOCKER_BLOCKED_AT_LABEL = 'Blocked at';

    // A non-blank string, or null for anything else: missing, null, wrong type.
    function nonBlankString(value) {
        return typeof value === 'string' && value.trim() !== '' ? value : null;
    }

    // The prerequisite ids the task RECORDED as waited on: order kept,
    // duplicates kept, each id verbatim, blanks dropped. Never a count of
    // unfinished work — the daemon counts finished, archived and deleted ids
    // as satisfied.
    function blockedPrerequisiteIds(task) {
        var ids = task && task.blockedOnTaskIds;
        if (!Array.isArray(ids)) { return []; }
        return ids.filter(function(id) { return nonBlankString(id) !== null; });
    }

    // Status gate first: a task that has left BLOCKED usually still carries its
    // blocker fields, and showing those as a live block is worse than showing
    // nothing. Inside BLOCKED a resource wait wins over a dependency wait,
    // because the lease grant is what actually clears it.
    function blockCause(task) {
        if (!task || task.status !== 'BLOCKED') { return null; }
        if (nonBlankString(task.blockedResourceId) !== null) { return 'RESOURCE_WAIT'; }
        if (blockedPrerequisiteIds(task).length > 0) { return 'DEPENDENCY_WAIT'; }
        return 'EXTERNAL_BLOCK';
    }

    // The recorded facts, captioned, in the same order the initial render uses.
    // blockedAt is passed through exactly as sent: never parsed as a date.
    function blockerFacts(task) {
        var facts = [];
        var resource = nonBlankString(task.blockedResourceId);
        if (resource) { facts.push(BLOCKER_RESOURCE_LABEL + ': ' + resource); }
        var fromStatus = nonBlankString(task.blockedFromStatus);
        if (fromStatus) { facts.push(BLOCKER_FROM_STATUS_LABEL + ': ' + fromStatus); }
        var blockedAt = nonBlankString(task.blockedAt);
        if (blockedAt) { facts.push(BLOCKER_BLOCKED_AT_LABEL + ': ' + blockedAt); }
        return facts;
    }

    // One line of the blocker section. Daemon-supplied content arrives as a DOM
    // text node, never as a markup string: a blockedReason is arbitrary
    // agent-written text.
    function blockerLine(cssClass, text) {
        var line = document.createElement('div');
        line.className = cssClass;
        line.textContent = text;
        return line;
    }

    // Rebuild the read-only blocker/attention section from the updated task.
    // Touches ONLY #blockerSection: the title, description and Definition of
    // Done inputs are never reassigned, because a human may be mid-edit.
    // Clearing first is what makes an unblocked task lose its section while the
    // independent attention flag can keep its own.
    function renderBlocker(task) {
        var container = document.getElementById('blockerSection');
        if (!container) { return; }
        container.textContent = '';
        if (!task) { return; }
        var cause = blockCause(task);
        var attention = task.needsHumanReview === true;
        if (!cause && !attention) { return; }
        container.appendChild(blockerLine('section-title', cause ? BLOCKER_SECTION_TITLE : ATTENTION_LABEL));
        if (cause) {
            container.appendChild(blockerLine('blocker-cause', BLOCK_CAUSE_LABEL[cause]));
            container.appendChild(blockerLine('muted-text', BLOCK_CAUSE_CLEARS[cause]));
            container.appendChild(blockerLine('field-label', BLOCKER_REASON_LABEL));
            container.appendChild(blockerLine('blocker-text', nonBlankString(task.blockedReason) || BLOCKER_REASON_MISSING));
        }
        if (attention) {
            container.appendChild(blockerLine('blocker-cause', ATTENTION_LABEL));
            container.appendChild(blockerLine('muted-text', ATTENTION_CLEARS));
        }
        if (cause) {
            var ids = blockedPrerequisiteIds(task);
            if (ids.length > 0) {
                container.appendChild(blockerLine('field-label', BLOCKER_PREREQUISITES_LABEL));
                container.appendChild(blockerLine('blocker-text', ids.join('\n')));
            }
            var facts = blockerFacts(task);
            if (facts.length > 0) {
                container.appendChild(blockerLine('blocker-text', facts.join('\n')));
            }
        }
    }

    function isAgentAuthor(author) {
        if (!author) { return false; }
        var lower = author.toLowerCase();
        return lower === 'worker' || lower === 'architect' || lower === 'qa'
            || lower.indexOf('agent') !== -1 || lower.indexOf('bot') !== -1
            || lower.indexOf('claude') !== -1 || lower.indexOf('codex') !== -1
            || lower.indexOf('gemini') !== -1 || lower.indexOf('grok') !== -1;
    }

    // Save
    document.getElementById('saveBtn').addEventListener('click', function() {
        var dodText = document.getElementById('dodInput').value;
        var dodItems = dodText.split('\n').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
        vscodeApi.postMessage({
            type: 'save',
            taskId: currentTaskId,
            title: document.getElementById('titleInput').value,
            description: document.getElementById('descriptionInput').value,
            definitionOfDone: dodItems,
            priority: document.getElementById('prioritySelect').value
        });
    });

    // Approve
    var approveBtn = document.getElementById('approveBtn');
    if (approveBtn) {
        approveBtn.addEventListener('click', function() {
            vscodeApi.postMessage({ type: 'approve' });
        });
    }

    // Reject
    var rejectBtn = document.getElementById('rejectBtn');
    if (rejectBtn) {
        rejectBtn.addEventListener('click', function() {
            vscodeApi.postMessage({ type: 'promptReject' });
        });
    }

    // Reopen
    var reopenBtn = document.getElementById('reopenBtn');
    if (reopenBtn) {
        reopenBtn.addEventListener('click', function() {
            var reasonEl = document.getElementById('reopenReasonInput');
            var reason = reasonEl ? reasonEl.value.trim() : '';
            vscodeApi.postMessage({ type: 'reopen', reason: reason });
        });
    }

    // Prev / Next
    document.getElementById('prevBtn').addEventListener('click', function() {
        vscodeApi.postMessage({ type: 'prev', currentStatus: currentTaskStatus });
    });
    document.getElementById('nextBtn').addEventListener('click', function() {
        vscodeApi.postMessage({ type: 'next', currentStatus: currentTaskStatus });
    });

    // Delete
    document.getElementById('deleteBtn').addEventListener('click', function() {
        vscodeApi.postMessage({ type: 'delete' });
    });

    // Add comment
    function submitComment() {
        var input = document.getElementById('commentInput');
        var content = input.value.trim();
        if (content) {
            vscodeApi.postMessage({ type: 'addComment', content: content });
            input.value = '';
        }
    }
    document.getElementById('askBtn').addEventListener('click', submitComment);
    document.getElementById('commentInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { submitComment(); }
    });

    // Render comments (for live updates)
    function renderComments(comments) {
        var container = document.getElementById('commentsList');
        if (!container) { return; }
        if (!comments || comments.length === 0) {
            container.textContent = '';
            var p = document.createElement('p');
            p.className = 'no-comments';
            p.textContent = 'No comments yet';
            container.appendChild(p);
            return;
        }
        container.textContent = '';
        for (var i = 0; i < comments.length; i++) {
            var c = comments[i];
            var agent = isAgentAuthor(c.author);
            var item = document.createElement('div');
            item.className = 'comment-item ' + (agent ? 'comment-agent' : 'comment-human');
            var header = document.createElement('div');
            header.className = 'comment-header';
            var authorSpan = document.createElement('span');
            authorSpan.className = 'comment-author';
            authorSpan.textContent = c.author || 'Unknown';
            var timeSpan = document.createElement('span');
            timeSpan.textContent = (c.timestamp || '').substring(0, 19);
            header.appendChild(authorSpan);
            header.appendChild(timeSpan);
            var body = document.createElement('div');
            body.className = 'comment-content';
            body.textContent = c.content || '';
            item.appendChild(header);
            item.appendChild(body);
            container.appendChild(item);
        }
        container.scrollTop = container.scrollHeight;
    }

    // Render steps (for live updates)
    function renderSteps(steps) {
        var container = document.getElementById('planContent');
        if (!container) { return; }
        if (!steps || steps.length === 0) {
            container.textContent = '';
            var p = document.createElement('p');
            p.className = 'muted-text';
            p.textContent = 'No implementation steps defined';
            container.appendChild(p);
            return;
        }
        container.textContent = '';
        for (var i = 0; i < steps.length; i++) {
            var step = steps[i];
            var status = (step.status || 'PENDING').toUpperCase();
            var cssClass = status === 'COMPLETED' ? 'completed'
                : status === 'IN_PROGRESS' ? 'in-progress' : 'pending';
            var iconClass = status === 'COMPLETED' ? 'step-icon-completed'
                : status === 'IN_PROGRESS' ? 'step-icon-in-progress' : 'step-icon-pending';
            var icon = status === 'COMPLETED' ? '\u2713'
                : status === 'IN_PROGRESS' ? '\u25B6' : '\u25CB';

            var card = document.createElement('div');
            card.className = 'step-card ' + cssClass;

            var header = document.createElement('div');
            header.className = 'step-header';
            var iconSpan = document.createElement('span');
            iconSpan.className = iconClass;
            iconSpan.textContent = icon;
            header.appendChild(iconSpan);
            var titleSpan = document.createElement('span');
            titleSpan.textContent = 'Step ' + (i + 1) + ': ' + status;
            header.appendChild(titleSpan);
            card.appendChild(header);

            var desc = document.createElement('div');
            desc.className = 'step-description';
            desc.textContent = step.description || '';
            card.appendChild(desc);

            if (step.affectedFiles && step.affectedFiles.length > 0) {
                var filesDiv = document.createElement('div');
                filesDiv.className = 'step-files';
                var filesLabel = document.createElement('span');
                filesLabel.textContent = 'Files:';
                filesDiv.appendChild(filesLabel);
                var filesText = document.createTextNode(' ' + step.affectedFiles.join(', '));
                filesDiv.appendChild(filesText);
                card.appendChild(filesDiv);
            }

            container.appendChild(card);
        }
    }

    // Handle live updates - only update plan + comments, not editable fields
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'updateTask') {
            var task = msg.task;
            // Update status badge
            var badge = document.getElementById('statusBadge');
            if (badge && task.status) {
                badge.className = 'status-badge status-' + task.status;
                badge.textContent = task.status.toLowerCase().replace(/_/g, ' ').replace(/^./, function(c) { return c.toUpperCase(); });
                currentTaskStatus = task.status;
            }
            // Refresh the read-only blocker/attention section, which also
            // clears it when the task leaves BLOCKED. The attention indicator
            // stays up until its own flag clears.
            renderBlocker(task);
            // Update plan section
            renderSteps(task.implementationPlan);
            // Update comments section
            renderComments(task.comments);
        }
    });
