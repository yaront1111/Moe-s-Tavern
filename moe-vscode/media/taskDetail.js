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

    function isAgentAuthor(author) {
        if (!author) { return false; }
        var lower = author.toLowerCase();
        return lower === 'worker' || lower === 'architect' || lower === 'qa'
            || lower.indexOf('agent') !== -1 || lower.indexOf('bot') !== -1
            || lower.indexOf('claude') !== -1 || lower.indexOf('codex') !== -1
            || lower.indexOf('gemini') !== -1;
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
            // Update plan section
            renderSteps(task.implementationPlan);
            // Update comments section
            renderComments(task.comments);
        }
    });
