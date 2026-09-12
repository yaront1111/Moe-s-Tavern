    const vscode = acquireVsCodeApi();

    // ---- Approval state --------------------------------------------------
    // The page — not the extension's cache — owns the approval token. `rendered`
    // is the plan revision of the content currently on screen and is null until a
    // COMPLETE render has succeeded, so a half-drawn or unvalidated plan can never
    // be approved. `latched` means the plan itself moved (or the daemon refused a
    // stale token): that needs a deliberate reopen. A transport hiccup only
    // disables temporarily and recovers on the next successful same-revision
    // render.
    var rendered = null;
    var approvalPending = false;
    var latched = false;
    var approveEnabled = false;

    var PLAN_CHANGED_NOTICE = 'This plan changed since it was displayed. Close and reopen the review to approve the current plan.';
    var GENERIC_FAILURE_NOTICE = 'The approval did not go through. Approve will re-enable once the plan refreshes.';

    function isRevision(value) {
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    }

    function setApproveEnabled(enabled) {
        approveEnabled = !!enabled;
        var btn = document.getElementById('approveBtn');
        if (btn) { btn.disabled = !approveEnabled; }
    }

    function setRejectEnabled(enabled) {
        var btn = document.getElementById('rejectBtn');
        if (btn) { btn.disabled = !enabled; }
    }

    function setNotice(text) {
        var el = document.getElementById('reviewNotice');
        if (!el) { return; }
        el.textContent = text || '';
        if (el.classList) {
            if (text) { el.classList.add('visible'); } else { el.classList.remove('visible'); }
        }
    }

    // The seed the panel wrote into the very HTML that rendered this page. It is a
    // string attribute, so it is parsed strictly: only digits, and 0 is a real
    // token (the legacy value), never a falsy "no token".
    function readSeededRevision() {
        var root = document.getElementById('reviewRoot');
        if (!root || typeof root.getAttribute !== 'function') { return null; }
        var raw = root.getAttribute('data-plan-revision');
        if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) { return null; }
        var parsed = Number(raw);
        return isRevision(parsed) ? parsed : null;
    }

    // Approve
    document.getElementById('approveBtn').addEventListener('click', function() {
        if (!approveEnabled || latched || approvalPending || rendered === null) { return; }
        approvalPending = true;
        setApproveEnabled(false);
        setRejectEnabled(false);
        setNotice('');
        vscode.postMessage({ type: 'approve', expectedPlanRevision: rendered });
    });

    // Reject
    document.getElementById('rejectBtn').addEventListener('click', function() {
        if (approvalPending) { return; }
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
            || lower.indexOf('gemini') !== -1 || lower.indexOf('grok') !== -1;
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

    // Resolve the token an incoming task carries, or null when the task must not
    // be approvable at all. An ABSENT revision field is a legacy record and means
    // effective 0; a present but malformed one is NOT legacy and disables.
    function tokenForTask(task) {
        if (!task || typeof task !== 'object') { return null; }
        if (task.status !== 'AWAITING_APPROVAL') { return null; }
        if (task.planRevision === undefined) { return 0; }
        return isRevision(task.planRevision) ? task.planRevision : null;
    }

    function applyRenderedTask(task) {
        // Disable FIRST: every later exit — invalid task, malformed revision, a
        // renderer that throws — then leaves approval off by construction rather
        // than by remembering to turn it off.
        setApproveEnabled(false);

        var revision = tokenForTask(task);
        if (revision === null) { return; }

        try {
            var titleEl = document.getElementById('taskTitle');
            if (titleEl) { titleEl.textContent = task.title || ''; }
            var descEl = document.getElementById('taskDesc');
            if (descEl) { descEl.textContent = task.description || ''; }
            renderDoD(task.definitionOfDone);
            renderSteps(task.implementationPlan);
            renderComments(task.comments);
        } catch (err) {
            // A partial render means the human is looking at content that does not
            // match the token, so approval stays off until a render completes.
            setNotice('The plan could not be displayed. Approve is disabled until it renders.');
            return;
        }

        // Only a COMPLETE render is allowed to move the token.
        if (rendered !== null && revision !== rendered) {
            // `rendered` still tracks what is on screen, but a changed plan latches:
            // the human must reopen and read it deliberately.
            rendered = revision;
            latched = true;
            setNotice(PLAN_CHANGED_NOTICE);
            return;
        }

        rendered = revision;
        if (latched || approvalPending) { return; }
        setNotice('');
        setApproveEnabled(true);
    }

    function applyApprovalFailure(msg) {
        approvalPending = false;
        setRejectEnabled(true);
        setApproveEnabled(false);
        if (msg && msg.stale) {
            latched = true;
            setNotice(PLAN_CHANGED_NOTICE);
            return;
        }
        setNotice(msg && typeof msg.message === 'string' && msg.message ? msg.message : GENERIC_FAILURE_NOTICE);
    }

    // Handle live updates from extension
    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || typeof msg !== 'object') { return; }
        if (msg.type === 'updateTask') {
            applyRenderedTask(msg.task);
        } else if (msg.type === 'approvePending') {
            // The panel confirms the approval left the extension; nothing else may
            // be sent until the daemon answers one way or the other.
            approvalPending = true;
            setApproveEnabled(false);
            setRejectEnabled(false);
        } else if (msg.type === 'approveFailed') {
            applyApprovalFailure(msg);
        } else if (msg.type === 'taskRemoved') {
            // The task backing this page is gone; nothing here is approvable.
            approvalPending = false;
            setApproveEnabled(false);
            setNotice('This task is no longer on the board. Approve is disabled.');
        }
    });

    // Bind the page to the revision the panel rendered it from. A missing or
    // non-numeric attribute means no token at all, so Approve stays disabled.
    rendered = readSeededRevision();
    setApproveEnabled(rendered !== null);
