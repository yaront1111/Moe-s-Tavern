    const vscode = acquireVsCodeApi();
    let actionSent = false;

    function escapeHtml(text) {
        if (!text) { return ''; }
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Approve
    document.getElementById('approveBtn').addEventListener('click', function() {
        if (actionSent) { return; }
        actionSent = true;
        this.disabled = true;
        document.getElementById('rejectBtn').disabled = true;
        vscode.postMessage({ type: 'approve' });
    });

    // Reject
    document.getElementById('rejectBtn').addEventListener('click', function() {
        if (actionSent) { return; }
        vscode.postMessage({ type: 'promptReject' });
    });

    // Add comment
    function submitComment() {
        var input = document.getElementById('commentInput');
        var content = input.value.trim();
        if (content) {
            vscode.postMessage({ type: 'addComment', content: content });
            input.value = '';
        }
    }

    document.getElementById('askBtn').addEventListener('click', submitComment);

    document.getElementById('commentInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            submitComment();
        }
    });

    // Determine if a comment author is likely an agent
    function isAgentAuthor(author) {
        if (!author) { return false; }
        var lower = author.toLowerCase();
        return lower === 'worker' || lower === 'architect' || lower === 'qa'
            || lower.indexOf('agent') !== -1 || lower.indexOf('bot') !== -1
            || lower.indexOf('claude') !== -1 || lower.indexOf('codex') !== -1
            || lower.indexOf('gemini') !== -1;
    }

    function renderComments(comments) {
        var container = document.getElementById('commentsList');
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
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    function renderSteps(steps) {
        var container = document.getElementById('stepsContent');
        if (!steps || steps.length === 0) {
            container.textContent = '';
            var p = document.createElement('p');
            p.className = 'muted';
            p.textContent = 'No implementation steps defined';
            container.appendChild(p);
            return;
        }
        container.textContent = '';
        for (var i = 0; i < steps.length; i++) {
            var step = steps[i];
            var status = (step.status || 'PENDING').toUpperCase();
            var cssClass = status === 'COMPLETED' ? 'completed'
                : status === 'IN_PROGRESS' ? 'in-progress'
                : 'pending';
            var statusClass = status === 'COMPLETED' ? 'step-status-completed'
                : status === 'IN_PROGRESS' ? 'step-status-in-progress'
                : 'step-status-pending';

            var card = document.createElement('div');
            card.className = 'step-card ' + cssClass;

            var header = document.createElement('div');
            header.className = 'step-header ' + statusClass;
            header.textContent = 'Step ' + (i + 1) + ': ' + status;
            card.appendChild(header);

            var desc = document.createElement('div');
            desc.className = 'step-description';
            desc.textContent = step.description || '';
            card.appendChild(desc);

            if (step.affectedFiles && step.affectedFiles.length > 0) {
                var filesDiv = document.createElement('div');
                filesDiv.className = 'step-files';
                var filesLabel = document.createElement('span');
                filesLabel.textContent = 'Affected files:';
                filesDiv.appendChild(filesLabel);
                var ul = document.createElement('ul');
                for (var j = 0; j < step.affectedFiles.length; j++) {
                    var li = document.createElement('li');
                    li.textContent = step.affectedFiles[j];
                    ul.appendChild(li);
                }
                filesDiv.appendChild(ul);
                card.appendChild(filesDiv);
            }

            container.appendChild(card);
        }
    }

    function renderDoD(dod) {
        var container = document.getElementById('dodContent');
        if (!dod || dod.length === 0) {
            container.textContent = '';
            var p = document.createElement('p');
            p.className = 'muted';
            p.textContent = 'No criteria defined';
            container.appendChild(p);
            return;
        }
        container.textContent = '';
        var ul = document.createElement('ul');
        ul.className = 'dod-list';
        for (var i = 0; i < dod.length; i++) {
            var li = document.createElement('li');
            li.textContent = dod[i];
            ul.appendChild(li);
        }
        container.appendChild(ul);
    }

    // Handle live updates from extension
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'updateTask') {
            var task = msg.task;
            // Update header
            var titleEl = document.getElementById('taskTitle');
            if (titleEl) { titleEl.textContent = task.title || ''; }
            var descEl = document.getElementById('taskDesc');
            if (descEl) { descEl.textContent = task.description || ''; }
            // Update DoD
            renderDoD(task.definitionOfDone);
            // Update steps
            renderSteps(task.implementationPlan);
            // Update comments
            renderComments(task.comments);
        }
    });
