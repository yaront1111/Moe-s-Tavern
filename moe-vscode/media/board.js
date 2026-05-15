        const vscode = acquireVsCodeApi();
        const columns = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
        const columnNames = {
            'BACKLOG': 'Backlog',
            'PLANNING': 'Planning',
            'AWAITING_APPROVAL': 'Approval',
            'WORKING': 'Working',
            'REVIEW': 'Review',
            'DONE': 'Done'
        };

        // Restore persisted webview state if available
        const savedState = vscode.getState() || {};
        let currentState = null;
        let draggedTaskId = null;
        let draggedEpicId = null;
        let selectedEpicFilter = savedState.selectedEpicFilter || '';
        const collapsedEpics = new Set(savedState.collapsedEpics || []);
        let activeTab = savedState.activeTab || 'board';

        function persistViewState() {
            vscode.setState({
                selectedEpicFilter,
                collapsedEpics: Array.from(collapsedEpics),
                activeTab
            });
        }

        function switchTab(tabName) {
            activeTab = tabName;
            persistViewState();
            var tabs = document.querySelectorAll('.tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tabName);
            }
            var contents = document.querySelectorAll('.tab-content');
            for (var j = 0; j < contents.length; j++) {
                contents[j].classList.toggle('active', contents[j].id === tabName + 'Tab');
            }
            // Re-render active tab content
            if (currentState) {
                if (tabName === 'proposals') {
                    renderProposals(currentState.proposals || []);
                } else if (tabName === 'activity') {
                    vscode.postMessage({ type: 'requestActivityLog' });
                }
            }
        }

        function renderProposals(proposals) {
            var container = document.getElementById('proposalsContainer');
            if (!container) { return; }

            var pending = (proposals || []).filter(function(p) { return p.status === 'PENDING'; });

            if (pending.length === 0) {
                container.textContent = '';
                var emptyP = document.createElement('p');
                emptyP.className = 'muted';
                emptyP.textContent = 'No pending proposals';
                container.appendChild(emptyP);
                return;
            }

            var html = '<div class="proposals-header">Rail Proposals</div>';
            pending.forEach(function(p) {
                var proposalId = escapeHtml(p.id || '');
                html += '<div class="proposal-card">';
                html += '<div class="proposal-header">' + escapeHtml(p.proposalType || '') + ' - ' + escapeHtml(p.targetScope || '') + '</div>';
                if (p.currentValue) {
                    html += '<div class="proposal-field muted">Current: ' + escapeHtml(p.currentValue) + '</div>';
                }
                html += '<div class="proposal-field">Proposed: ' + escapeHtml(p.proposedValue || '') + '</div>';
                if (p.reason) {
                    html += '<div class="proposal-field muted">Reason: ' + escapeHtml(p.reason) + '</div>';
                }
                var taskInfo = p.taskId ? p.taskId.slice(-8) : '?';
                var workerInfo = p.workerId ? escapeHtml(p.workerId) : '?';
                html += '<div class="proposal-info">Task: ' + escapeHtml(taskInfo) + ' | Worker: ' + workerInfo + '</div>';
                html += '<div class="proposal-actions">';
                html += '<button class="btn-approve" data-proposal-id="' + proposalId + '" data-action="approveProposal">Approve</button>';
                html += '<button class="btn-reject" data-proposal-id="' + proposalId + '" data-action="rejectProposal">Reject</button>';
                html += '</div>';
                html += '</div>';
            });

            container.textContent = '';
            container.insertAdjacentHTML('beforeend', html);
        }

        function approveProposal(btn) {
            var proposalId = btn.getAttribute('data-proposal-id');
            if (!proposalId) { return; }
            btn.disabled = true;
            vscode.postMessage({ type: 'approveProposal', proposalId: proposalId });
        }

        function rejectProposal(btn) {
            var proposalId = btn.getAttribute('data-proposal-id');
            if (!proposalId) { return; }
            btn.disabled = true;
            vscode.postMessage({ type: 'rejectProposal', proposalId: proposalId });
        }

        // Activity Log
        var activityEvents = [];
        var activityFilter = '';

        function renderActivityLog(events) {
            if (events && events.length > 0) {
                activityEvents = events;
            }

            var container = document.getElementById('activityContainer');
            if (!container) { return; }

            var filtered = activityFilter
                ? activityEvents.filter(function(e) { return e.event === activityFilter; })
                : activityEvents;

            if (filtered.length === 0) {
                container.textContent = '';
                var emptyP = document.createElement('p');
                emptyP.className = 'muted';
                emptyP.textContent = activityEvents.length === 0 ? 'No activity recorded' : 'No matching events';
                container.appendChild(emptyP);
                return;
            }

            var html = '<div class="activity-toolbar">';
            html += '<select class="activity-filter" id="activityFilterSelect">';
            html += '<option value="">All Events</option>';
            var eventTypes = ['TASK_CREATED','TASK_UPDATED','TASK_DELETED','EPIC_CREATED','EPIC_UPDATED',
                'PLAN_SUBMITTED','PLAN_APPROVED','PLAN_REJECTED','STEP_STARTED','STEP_COMPLETED',
                'TASK_COMPLETED','TASK_BLOCKED'];
            eventTypes.forEach(function(t) {
                var sel = activityFilter === t ? ' selected' : '';
                html += '<option value="' + escapeHtml(t) + '"' + sel + '>' + escapeHtml(t) + '</option>';
            });
            html += '</select></div>';

            html += '<table class="activity-table"><thead><tr><th>Timestamp</th><th>Event</th><th>Details</th></tr></thead><tbody>';
            filtered.forEach(function(evt) {
                var ts = formatTimestamp(evt.timestamp);
                var details = buildEventDetails(evt);
                html += '<tr><td>' + escapeHtml(ts) + '</td><td>' + escapeHtml(evt.event || '') + '</td><td>' + escapeHtml(details) + '</td></tr>';
            });
            html += '</tbody></table>';

            container.textContent = '';
            container.insertAdjacentHTML('beforeend', html);
        }

        function onActivityFilterChange(value) {
            activityFilter = value;
            renderActivityLog(null);
        }

        function formatTimestamp(isoStr) {
            try {
                var d = new Date(isoStr);
                if (isNaN(d.getTime())) { return isoStr || ''; }
                var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
                    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            } catch (e) {
                return isoStr || '';
            }
        }

        function buildEventDetails(evt) {
            var parts = [];
            if (evt.taskId) { parts.push('Task:' + evt.taskId.slice(-8)); }
            if (evt.epicId) { parts.push('Epic:' + evt.epicId.slice(-8)); }
            if (evt.workerId) { parts.push('Worker:' + evt.workerId); }
            if (evt.payload) {
                try {
                    var p = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
                    Object.keys(p).forEach(function(k) {
                        if (k !== 'taskId' && k !== 'epicId' && k !== 'workerId') {
                            var v = typeof p[k] === 'object' ? JSON.stringify(p[k]) : String(p[k]);
                            if (v.length > 50) { v = v.substring(0, 47) + '...'; }
                            parts.push(k + ':' + v);
                        }
                    });
                } catch (e) {
                    // ignore payload parse errors
                }
            }
            return parts.join(' | ');
        }

        function connect() {
            vscode.postMessage({ type: 'connect' });
        }

        function showAgentMenu() {
            vscode.postMessage({ type: 'showAgentMenu' });
        }

        function openSettings() {
            vscode.postMessage({ type: 'openSettings' });
        }

        // Context menu
        var activeContextMenu = null;

        function closeContextMenu() {
            if (activeContextMenu) {
                activeContextMenu.remove();
                activeContextMenu = null;
            }
        }

        document.addEventListener('click', closeContextMenu);
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { closeContextMenu(); }
        });

        document.addEventListener('contextmenu', function(e) {
            var card = e.target.closest('.task-card');
            if (!card) { return; }
            e.preventDefault();
            closeContextMenu();

            var taskId = card.getAttribute('data-task-id');
            if (!taskId) { return; }

            var menu = document.createElement('div');
            menu.className = 'context-menu';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';

            var openItem = document.createElement('div');
            openItem.className = 'context-menu-item';
            openItem.textContent = 'Open';
            openItem.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeContextMenu();
                vscode.postMessage({ type: 'openTaskDetail', taskId: taskId });
            });
            menu.appendChild(openItem);

            var askItem = document.createElement('div');
            askItem.className = 'context-menu-item';
            askItem.textContent = 'Ask Question';
            askItem.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeContextMenu();
                vscode.postMessage({ type: 'openTaskDetail', taskId: taskId });
            });
            menu.appendChild(askItem);

            var sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);

            var deleteItem = document.createElement('div');
            deleteItem.className = 'context-menu-item danger';
            deleteItem.textContent = 'Delete';
            deleteItem.addEventListener('click', function(ev) {
                ev.stopPropagation();
                closeContextMenu();
                if (window.confirm('Delete this task?')) {
                    vscode.postMessage({ type: 'deleteTask', taskId: taskId });
                }
            });
            menu.appendChild(deleteItem);

            document.body.appendChild(menu);
            activeContextMenu = menu;

            // Ensure menu stays within viewport
            var rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
            }
        });

        var searchQuery = '';

        // Epic filter and Add Epic button handlers
        document.getElementById('epicFilter').addEventListener('change', function() {
            selectedEpicFilter = this.value;
            persistViewState();
            if (currentState) { renderBoard(currentState); }
        });
        document.getElementById('addEpicBtn').addEventListener('click', function() {
            vscode.postMessage({ type: 'createEpic' });
        });

        // Search input handler
        document.getElementById('searchInput').addEventListener('input', function() {
            searchQuery = this.value.toLowerCase();
            var clearBtn = document.getElementById('searchClear');
            if (clearBtn) { clearBtn.style.display = searchQuery ? 'block' : 'none'; }
            if (currentState) { renderBoard(currentState); }
        });
        document.getElementById('searchClear').addEventListener('click', function() {
            searchQuery = '';
            var input = document.getElementById('searchInput');
            if (input) { input.value = ''; }
            this.style.display = 'none';
            if (currentState) { renderBoard(currentState); }
        });

        const workflowOrder = ['BACKLOG','PLANNING','AWAITING_APPROVAL','WORKING','REVIEW','DONE'];

        function updateEpicFilter(epics) {
            var filterEl = document.getElementById('epicFilter');
            var toolbar = document.getElementById('boardToolbar');
            if (!filterEl || !toolbar) { return; }
            toolbar.style.display = 'flex';

            var prevValue = selectedEpicFilter;
            filterEl.textContent = '';
            var allOpt = document.createElement('option');
            allOpt.value = '';
            allOpt.textContent = 'All Epics';
            filterEl.appendChild(allOpt);

            var sortedEpics = (epics || []).slice().sort(function(a, b) {
                var oa = a.order || 0;
                var ob = b.order || 0;
                if (oa !== ob) { return oa - ob; }
                return (a.title || '').localeCompare(b.title || '');
            });
            var foundPrev = false;
            sortedEpics.forEach(function(epic) {
                var opt = document.createElement('option');
                opt.value = epic.id;
                opt.textContent = epic.title || epic.id;
                filterEl.appendChild(opt);
                if (epic.id === prevValue) { foundPrev = true; }
            });
            if (foundPrev) {
                filterEl.value = prevValue;
                selectedEpicFilter = prevValue;
            } else {
                filterEl.value = '';
                selectedEpicFilter = '';
            }
        }

        function renderWorkerPanel(workers, teams, tasks) {
            var panel = document.getElementById('workerPanel');
            if (!panel) { return; }

            if (!workers || workers.length === 0) {
                panel.style.display = 'none';
                panel.textContent = '';
                return;
            }

            // Build task map for current task title lookup
            var taskMap = {};
            if (tasks && tasks.length) {
                tasks.forEach(function(t) { taskMap[t.id] = t; });
            }

            // Build team map
            var teamMap = {};
            if (teams && teams.length) {
                teams.forEach(function(t) { teamMap[t.id] = t; });
            }

            // Group workers by teamId
            var teamGroups = {};
            var teamOrder = [];
            var soloWorkers = [];

            workers.forEach(function(w) {
                if (w.teamId && teamMap[w.teamId]) {
                    if (!teamGroups[w.teamId]) {
                        teamGroups[w.teamId] = [];
                        teamOrder.push(w.teamId);
                    }
                    teamGroups[w.teamId].push(w);
                } else {
                    soloWorkers.push(w);
                }
            });

            var html = '';

            // Render team groups
            teamOrder.forEach(function(tid) {
                var team = teamMap[tid];
                var teamName = team ? team.name : tid;
                html += '<span class="team-label">[' + escapeHtml(teamName) + ']</span>';
                teamGroups[tid].forEach(function(w) {
                    html += renderWorkerCard(w, taskMap);
                });
            });

            // Render solo workers
            if (soloWorkers.length > 0 && teamOrder.length > 0) {
                html += '<span class="team-label">[Solo]</span>';
            }
            soloWorkers.forEach(function(w) {
                html += renderWorkerCard(w, taskMap);
            });

            panel.textContent = '';
            panel.insertAdjacentHTML('beforeend', html);
            panel.style.display = 'flex';
        }

        function renderWorkerCard(worker, taskMap) {
            var wStatus = escapeHtml(worker.status || 'IDLE');
            var wType = escapeHtml(worker.type || worker.id || 'worker');

            // Determine body text: current task title, lastError, or Idle
            var bodyText = 'Idle';
            if (worker.currentTaskId && taskMap[worker.currentTaskId]) {
                var title = taskMap[worker.currentTaskId].title || '';
                bodyText = title.length > 28 ? title.substring(0, 27).trimEnd() + '...' : title;
            } else if (worker.lastError) {
                bodyText = worker.lastError.length > 28 ? worker.lastError.substring(0, 27).trimEnd() + '...' : worker.lastError;
            }

            return '<div class="worker-card" data-status="' + wStatus + '">'
                + '<div class="worker-card-header">'
                + '<span class="worker-type">' + wType + '</span>'
                + '<span class="worker-status" data-status="' + wStatus + '">' + wStatus + '</span>'
                + '</div>'
                + '<div class="worker-task" title="' + escapeHtml(bodyText) + '">' + escapeHtml(bodyText) + '</div>'
                + '</div>';
        }

        var lastBoardFingerprint = '';
        var columnFingerprints = {};

        function computeBoardFingerprint(state) {
            try {
                var taskFp = (state.tasks || []).slice().sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(t) {
                    var stepsFp = (t.implementationPlan || []).map(function(s) {
                        return (s.stepId || '') + ':' + (s.status || '');
                    }).join(';');
                    return [t.id, t.status, t.order, t.title, t.priority,
                        t.assignedWorkerId || '', (t.comments || []).length,
                        t.hasPendingQuestion || false, stepsFp].join(':');
                }).join('|');

                var epicFp = (state.epics || []).slice().sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(e) {
                    return [e.id, e.title, e.status, e.order].join(':');
                }).join('|');

                var filterFp = 'epic=' + selectedEpicFilter + '|search=' + searchQuery;
                var collapseFp = Array.from(collapsedEpics).sort().join(',');

                var workerFp = (state.workers || []).map(function(w) {
                    return [w.id, w.status, w.currentTaskId || ''].join(':');
                }).join('|');

                return taskFp + '##' + epicFp + '##' + filterFp + '##' + collapseFp + '##' + workerFp;
            } catch (e) {
                return '';
            }
        }

        function computeColumnFingerprint(columnTasks, epics, status) {
            try {
                var taskFp = columnTasks.slice().sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(t) {
                    var stepsFp = (t.implementationPlan || []).map(function(s) {
                        return (s.stepId || '') + ':' + (s.status || '');
                    }).join(';');
                    return [t.id, t.order, t.title, t.priority,
                        t.assignedWorkerId || '', (t.comments || []).length,
                        t.hasPendingQuestion || false, stepsFp].join(':');
                }).join('|');

                var relevantEpicIds = {};
                columnTasks.forEach(function(t) {
                    if (t.epicId) { relevantEpicIds[t.epicId] = true; }
                });
                var epicFp = epics.filter(function(e) {
                    return relevantEpicIds[e.id];
                }).sort(function(a, b) {
                    return (a.id || '').localeCompare(b.id || '');
                }).map(function(e) {
                    return [e.id, e.title, e.status, e.order].join(':');
                }).join('|');

                var collapseFp = Array.from(collapsedEpics).sort().join(',');

                return status + '##' + taskFp + '##' + epicFp + '##' + collapseFp;
            } catch (e) {
                return '';
            }
        }

        function renderBoard(state) {
            currentState = state;
            const board = document.getElementById('board');

            if (!state || !state.tasks) {
                lastBoardFingerprint = '';
                columnFingerprints = {};
                board.textContent = '';
                var toolbar = document.getElementById('boardToolbar');
                if (toolbar) { toolbar.style.display = 'none'; }
                var workerPanel = document.getElementById('workerPanel');
                if (workerPanel) { workerPanel.style.display = 'none'; workerPanel.textContent = ''; }
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                const h3 = document.createElement('h3');
                h3.textContent = 'No Tasks';
                const p = document.createElement('p');
                p.textContent = 'Create tasks in the IDE';
                empty.appendChild(h3);
                empty.appendChild(p);
                board.appendChild(empty);
                return;
            }

            // Board-level fingerprint check - skip re-render if unchanged
            var newFingerprint = computeBoardFingerprint(state);
            if (newFingerprint && newFingerprint === lastBoardFingerprint) {
                return;
            }
            lastBoardFingerprint = newFingerprint;

            const epics = state.epics || [];
            updateEpicFilter(epics);

            // Render worker panel
            renderWorkerPanel(state.workers || [], state.teams || [], state.tasks || []);

            // Apply epic filter
            var filteredTasks = state.tasks;
            if (selectedEpicFilter) {
                filteredTasks = state.tasks.filter(function(t) {
                    return t.epicId === selectedEpicFilter;
                });
            }

            // Apply search filter
            if (searchQuery) {
                filteredTasks = filteredTasks.filter(function(t) {
                    return (t.title || '').toLowerCase().includes(searchQuery)
                        || (t.description || '').toLowerCase().includes(searchQuery);
                });
            }

            // Column-level diffing: only re-render columns whose fingerprint changed
            try {
                var needsFullRebuild = !board.querySelector('.column');

                if (needsFullRebuild) {
                    // First render or board was cleared - build all columns
                    var html = '';
                    columns.forEach(function(status) {
                        var colTasks = filteredTasks.filter(function(t) { return t.status === status; });
                        var groupedHtml = renderGroupedTasks(colTasks, epics, status);
                        var addBtn = (status === 'BACKLOG')
                            ? '<button class="create-task-btn" data-action="createTask" title="Create Task">+</button>'
                            : '';
                        var archiveBtn = (status === 'DONE' && colTasks.length > 0)
                            ? '<button class="archive-btn" data-action="archiveDone" data-count="' + colTasks.length + '" title="Archive done tasks">&times;</button>'
                            : '';
                        html += '<div class="column" id="column-' + escapeHtml(status) + '" data-status="' + escapeHtml(status) + '"'
                            + ' data-drop="column">'
                            + '<div class="column-header">'
                            + '<span>' + escapeHtml(columnNames[status] || status) + '</span>'
                            + '<span class="column-header-right"><span class="column-count">' + colTasks.length + '</span>' + addBtn + archiveBtn + '</span>'
                            + '</div>'
                            + '<div class="tasks">' + groupedHtml + '</div>'
                            + '</div>';

                        columnFingerprints[status] = computeColumnFingerprint(colTasks, epics, status);
                    });
                    board.textContent = '';
                    board.insertAdjacentHTML('beforeend', html);
                } else {
                    // Incremental update - only re-render changed columns
                    columns.forEach(function(status) {
                        var colTasks = filteredTasks.filter(function(t) { return t.status === status; });
                        var colFp = computeColumnFingerprint(colTasks, epics, status);

                        if (colFp && colFp === columnFingerprints[status]) {
                            return; // Skip unchanged column
                        }

                        var colEl = document.getElementById('column-' + status);
                        if (!colEl) {
                            return; // Column element missing, skip (will be caught on next full rebuild)
                        }

                        // Save scroll position of the tasks container
                        var tasksEl = colEl.querySelector('.tasks');
                        var scrollTop = tasksEl ? tasksEl.scrollTop : 0;

                        // Re-render column content
                        var groupedHtml = renderGroupedTasks(colTasks, epics, status);
                        var addBtn = (status === 'BACKLOG')
                            ? '<button class="create-task-btn" data-action="createTask" title="Create Task">+</button>'
                            : '';
                        var archiveBtn = (status === 'DONE' && colTasks.length > 0)
                            ? '<button class="archive-btn" data-action="archiveDone" data-count="' + colTasks.length + '" title="Archive done tasks">&times;</button>'
                            : '';

                        var colHtml = '<div class="column-header">'
                            + '<span>' + escapeHtml(columnNames[status] || status) + '</span>'
                            + '<span class="column-header-right"><span class="column-count">' + colTasks.length + '</span>' + addBtn + archiveBtn + '</span>'
                            + '</div>'
                            + '<div class="tasks">' + groupedHtml + '</div>';

                        colEl.textContent = '';
                        colEl.insertAdjacentHTML('beforeend', colHtml);

                        // Restore scroll position
                        var newTasksEl = colEl.querySelector('.tasks');
                        if (newTasksEl && scrollTop > 0) {
                            newTasksEl.scrollTop = scrollTop;
                        }

                        columnFingerprints[status] = colFp;
                    });
                }
            } catch (e) {
                // On column diff error, clear fingerprints and force full rebuild
                columnFingerprints = {};
                var fallbackHtml = '';
                columns.forEach(function(status) {
                    var colTasks = filteredTasks.filter(function(t) { return t.status === status; });
                    var groupedHtml = renderGroupedTasks(colTasks, epics, status);
                    var addBtn = (status === 'BACKLOG')
                        ? '<button class="create-task-btn" data-action="createTask" title="Create Task">+</button>'
                        : '';
                    var archiveBtn = (status === 'DONE' && colTasks.length > 0)
                        ? '<button class="archive-btn" data-action="archiveDone" data-count="' + colTasks.length + '" title="Archive done tasks">&times;</button>'
                        : '';
                    fallbackHtml += '<div class="column" id="column-' + escapeHtml(status) + '" data-status="' + escapeHtml(status) + '"'
                        + ' data-drop="column">'
                        + '<div class="column-header">'
                        + '<span>' + escapeHtml(columnNames[status] || status) + '</span>'
                        + '<span class="column-header-right"><span class="column-count">' + colTasks.length + '</span>' + addBtn + archiveBtn + '</span>'
                        + '</div>'
                        + '<div class="tasks">' + groupedHtml + '</div>'
                        + '</div>';
                });
                board.textContent = '';
                board.insertAdjacentHTML('beforeend', fallbackHtml);
            }
        }

        function renderGroupedTasks(tasks, epics, columnStatus) {
            if (tasks.length === 0) { return ''; }

            // Group tasks by epicId
            var groups = {};
            var epicOrder = [];
            tasks.forEach(function(t) {
                var eid = t.epicId || '__ungrouped__';
                if (!groups[eid]) {
                    groups[eid] = [];
                    epicOrder.push(eid);
                }
                groups[eid].push(t);
            });

            // Sort epic groups by epic.order then epic.title
            epicOrder.sort(function(a, b) {
                if (a === '__ungrouped__') { return 1; }
                if (b === '__ungrouped__') { return -1; }
                var epicA = epics.find(function(e) { return e.id === a; });
                var epicB = epics.find(function(e) { return e.id === b; });
                var orderA = epicA ? (epicA.order || 0) : 9999;
                var orderB = epicB ? (epicB.order || 0) : 9999;
                if (orderA !== orderB) { return orderA - orderB; }
                var titleA = epicA ? epicA.title : '';
                var titleB = epicB ? epicB.title : '';
                return titleA.localeCompare(titleB);
            });

            // Sort tasks within each group by task.order
            Object.keys(groups).forEach(function(eid) {
                groups[eid].sort(function(a, b) {
                    return (a.order || 0) - (b.order || 0);
                });
            });

            // If only one epic group (or only ungrouped), skip grouping UI
            if (epicOrder.length === 1 && epicOrder[0] === '__ungrouped__') {
                return groups['__ungrouped__'].map(function(t) {
                    return renderTaskCard(t, epics, columnStatus);
                }).join('');
            }

            var result = '';
            epicOrder.forEach(function(eid) {
                var groupTasks = groups[eid];
                if (eid === '__ungrouped__') {
                    result += renderEpicGroup(null, 'Ungrouped', null, groupTasks, epics, columnStatus);
                } else {
                    var epic = epics.find(function(e) { return e.id === eid; });
                    var epicTitle = epic ? epic.title : 'Unknown Epic';
                    var epicStatus = epic ? epic.status : null;
                    result += renderEpicGroup(eid, epicTitle, epicStatus, groupTasks, epics, columnStatus);
                }
            });
            return result;
        }

        function renderEpicGroup(epicId, epicTitle, epicStatus, tasks, epics, columnStatus) {
            var isCollapsed = epicId ? collapsedEpics.has(epicId) : false;
            var toggleChar = isCollapsed ? '&#9654;' : '&#9660;';
            var safeEpicId = epicId ? escapeHtml(epicId) : '';

            var headerHtml = '<div class="epic-header" data-action="toggleEpicCollapse" data-epic-id="' + safeEpicId + '"'
                + (epicId ? ' draggable="true" data-drag="epic"' : '')
                + '>'
                + '<span class="epic-toggle">' + toggleChar + '</span>';

            if (epicStatus) {
                headerHtml += '<span class="epic-status-dot" data-epic-status="' + escapeHtml(epicStatus) + '"></span>';
            }

            headerHtml += '<span class="epic-title" title="' + escapeHtml(epicTitle) + '">' + escapeHtml(epicTitle) + '</span>'
                + '<span class="epic-count">' + tasks.length + '</span>';

            if (epicStatus) {
                var statusLabel = epicStatus.charAt(0) + epicStatus.slice(1).toLowerCase();
                headerHtml += '<span class="epic-status-chip">' + escapeHtml(statusLabel) + '</span>';
            }

            headerHtml += '</div>';

            var tasksClass = 'epic-tasks' + (isCollapsed ? ' collapsed' : '');
            var tasksHtml = '<div class="' + tasksClass + '">';
            tasks.forEach(function(t) {
                tasksHtml += renderTaskCard(t, epics, columnStatus);
            });
            tasksHtml += '</div>';

            return '<div class="epic-group" data-epic-id="' + safeEpicId + '">'
                + headerHtml + tasksHtml + '</div>';
        }

        function toggleEpicCollapse(epicId) {
            if (!epicId) { return; }
            if (collapsedEpics.has(epicId)) {
                collapsedEpics.delete(epicId);
            } else {
                collapsedEpics.add(epicId);
            }
            persistViewState();
            if (currentState) {
                renderBoard(currentState);
            }
        }

        function openEpicDetail(event, epicId) {
            event.stopPropagation();
            if (!epicId) { return; }
            vscode.postMessage({ type: 'openEpicDetail', epicId: epicId });
        }

        function onEpicDragStart(event, epicId) {
            draggedEpicId = epicId;
            draggedTaskId = null;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'epic:' + epicId);
            var header = event.target.closest('.epic-header');
            if (header) { header.classList.add('dragging'); }
        }

        function onEpicDragEnd(event) {
            draggedEpicId = null;
            var header = event.target.closest('.epic-header');
            if (header) { header.classList.remove('dragging'); }
        }

        function renderTaskCard(task, epics, columnStatus) {
            const taskId = escapeHtml(task.id);
            const titleText = escapeHtml(task.title || '');
            const taskStatus = escapeHtml(task.status || '');

            // Description preview (first ~120 chars)
            let descHtml = '';
            if (task.description) {
                const desc = task.description.length > 120
                    ? task.description.substring(0, 119).trimEnd() + '...'
                    : task.description;
                descHtml = '<div class="task-desc">' + escapeHtml(desc) + '</div>';
            }

            // Build chips
            let chips = '';

            // Epic chip
            if (task.epicId && epics.length > 0) {
                const epic = epics.find(e => e.id === task.epicId);
                if (epic && epic.title) {
                    const epicLabel = epic.title.length > 18
                        ? epic.title.substring(0, 17).trimEnd() + '...'
                        : epic.title;
                    chips += '<span class="chip chip-epic" title="' + escapeHtml(epic.title) + '">' + escapeHtml(epicLabel) + '</span>';
                }
            }

            // Priority chip (skip MEDIUM)
            if (task.priority && task.priority !== 'MEDIUM') {
                const pClass = task.priority === 'CRITICAL' ? 'chip-critical'
                    : task.priority === 'HIGH' ? 'chip-high'
                    : task.priority === 'LOW' ? 'chip-low' : '';
                if (pClass) {
                    const pLabel = task.priority.charAt(0) + task.priority.slice(1).toLowerCase();
                    chips += '<span class="chip ' + pClass + '">' + escapeHtml(pLabel) + '</span>';
                }
            }

            // Status sub-chip (if task status differs from column)
            if (task.status && task.status !== columnStatus) {
                const statusLabel = task.status.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
                chips += '<span class="chip chip-status">' + escapeHtml(statusLabel) + '</span>';
            }

            // Step progress chip
            if (task.implementationPlan && task.implementationPlan.length > 0) {
                const steps = task.implementationPlan;
                const total = steps.length;
                const completed = steps.filter(s => s.status === 'COMPLETED').length;
                const inProgress = steps.filter(s => s.status === 'IN_PROGRESS').length;
                const progressClass = completed === total ? 'chip-progress-done'
                    : inProgress > 0 ? 'chip-progress-active'
                    : 'chip-progress-pending';
                chips += '<span class="chip ' + progressClass + '">' + completed + '/' + total + '</span>';
            }

            // Pending question chip
            if (task.hasPendingQuestion) {
                chips += '<span class="chip chip-question" title="Pending question">?</span>';
            }

            // Task ID chip (last 4 chars uppercase)
            if (task.id) {
                const idShort = task.id.slice(-4).toUpperCase();
                chips += '<span class="chip chip-id">' + escapeHtml(idShort) + '</span>';
            }

            // Worker badge
            let workerHtml = '';
            if (task.assignedWorkerId) {
                workerHtml = '<span class="task-worker">' + escapeHtml(task.assignedWorkerId) + '</span>';
            }

            // Nav arrows
            const statusIdx = workflowOrder.indexOf(task.status);
            let navHtml = '';
            const showPrev = statusIdx > 0;
            const showNext = statusIdx >= 0 && statusIdx < workflowOrder.length - 1;
            if (showPrev || showNext) {
                navHtml = '<div class="task-nav-arrows">';
                if (showPrev) {
                    navHtml += '<button class="task-nav-btn" data-action="navTask" data-direction="prev" title="Move back">&#9664;</button>';
                }
                if (showNext) {
                    navHtml += '<button class="task-nav-btn" data-action="navTask" data-direction="next" title="Move forward">&#9654;</button>';
                }
                navHtml += '</div>';
            }

            return `
                <div class="task-card"
                     draggable="true"
                     data-task-id="${taskId}"
                     data-status="${taskStatus}"
                     data-drag="task">
                    <div class="task-title-row">
                        <div class="task-title">${titleText}</div>
                        ${navHtml}
                    </div>
                    ${descHtml}
                    <div class="task-meta">
                        ${chips}
                        ${workerHtml}
                    </div>
                </div>
            `;
        }

        function escapeHtml(text) {
            if (!text) { return ''; }
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function onDragStart(event, taskId) {
            draggedTaskId = taskId;
            draggedEpicId = null;
            event.target.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'task:' + taskId);
        }

        function onDragEnd(event) {
            event.target.classList.remove('dragging');
            draggedTaskId = null;
        }

        function onDragOver(event) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        }

        function onDrop(event, newStatus) {
            event.preventDefault();
            if (draggedEpicId && currentState && currentState.tasks) {
                // Epic header drop: move all tasks in this epic to the new column status
                var tasksToMove = currentState.tasks.filter(function(t) {
                    return t.epicId === draggedEpicId;
                });
                tasksToMove.forEach(function(t) {
                    if (t.status !== newStatus) {
                        vscode.postMessage({
                            type: 'updateTaskStatus',
                            taskId: t.id,
                            status: newStatus
                        });
                    }
                });
                draggedEpicId = null;
            } else if (draggedTaskId) {
                vscode.postMessage({
                    type: 'updateTaskStatus',
                    taskId: draggedTaskId,
                    status: newStatus
                });
            }
        }

        function createTask(event) {
            event.stopPropagation();
            vscode.postMessage({ type: 'createTask' });
        }

        function archiveDone(event, count) {
            event.stopPropagation();
            if (count <= 0) { return; }
            if (window.confirm('Archive ' + count + ' done task' + (count > 1 ? 's' : '') + '?')) {
                vscode.postMessage({ type: 'archiveDoneTasks', epicId: selectedEpicFilter || undefined });
            }
        }

        function openTask(taskId) {
            vscode.postMessage({ type: 'openTaskDetail', taskId });
        }

        function navTask(event, taskId, direction) {
            event.stopPropagation();
            if (!currentState || !currentState.tasks) { return; }
            const task = currentState.tasks.find(t => t.id === taskId);
            if (!task) { return; }

            const idx = workflowOrder.indexOf(task.status);
            if (idx < 0) { return; }

            if (direction === 'next') {
                if (idx >= workflowOrder.length - 1) { return; }
                if (task.status === 'AWAITING_APPROVAL') {
                    vscode.postMessage({ type: 'approveTask', taskId: taskId });
                } else {
                    const newStatus = workflowOrder[idx + 1];
                    vscode.postMessage({ type: 'updateTaskStatus', taskId: taskId, status: newStatus });
                }
            } else if (direction === 'prev') {
                if (idx <= 0) { return; }
                if (task.status === 'REVIEW' || task.status === 'DONE') {
                    const reason = prompt('Reason for reopening:');
                    if (reason) {
                        vscode.postMessage({ type: 'reopenTask', taskId: taskId, reason: reason });
                    }
                } else {
                    const newStatus = workflowOrder[idx - 1];
                    vscode.postMessage({ type: 'updateTaskStatus', taskId: taskId, status: newStatus });
                }
            }
        }

        function updateConnectionStatus(status) {
            try {
                const dot = document.getElementById('statusDot');
                const text = document.getElementById('statusText');
                const btn = document.getElementById('connectBtn');
                const agentsBtn = document.getElementById('agentsBtn');
                const settingsBtn = document.getElementById('settingsBtn');

                if (dot) { dot.className = 'status-dot ' + status; }
                if (text) { text.textContent = status.charAt(0).toUpperCase() + status.slice(1); }
                if (btn) { btn.style.display = status === 'connected' ? 'none' : 'inline-block'; }
                if (agentsBtn) { agentsBtn.style.display = status === 'connected' ? 'inline-block' : 'none'; }
                if (settingsBtn) { settingsBtn.style.display = status === 'connected' ? 'inline-block' : 'none'; }

                // Update board empty state to reflect connection status
                const board = document.getElementById('board');
                const emptyState = board ? board.querySelector('.empty-state') : null;
                if (emptyState) {
                    const h3 = emptyState.querySelector('h3');
                    const p = emptyState.querySelector('p');
                    if (status === 'connected') {
                        if (h3) { h3.textContent = 'No Tasks'; }
                        if (p) { p.textContent = 'Create tasks in the IDE'; }
                    } else if (status === 'connecting') {
                        if (h3) { h3.textContent = 'Connecting...'; }
                        if (p) { p.textContent = 'Waiting for daemon'; }
                    } else {
                        if (h3) { h3.textContent = 'Not Connected'; }
                        if (p) { p.textContent = 'Click Connect to start'; }
                    }
                }
            } catch (e) {
                // Prevent partial updates from breaking the UI
            }
        }

        // Track whether we've received any state from the extension
        var stateReceived = false;

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateState':
                    stateReceived = true;
                    currentState = message.state;
                    var tabBarEl = document.getElementById('tabBar');
                    if (tabBarEl) { tabBarEl.style.display = 'flex'; }
                    renderBoard(message.state);
                    if (activeTab === 'proposals') {
                        renderProposals((message.state && message.state.proposals) || []);
                    }
                    break;
                case 'connectionStatus':
                    stateReceived = true;
                    updateConnectionStatus(message.status);
                    break;
                case 'activityLog':
                    renderActivityLog(message.events || []);
                    break;
            }
        });

        // ============================================================
        // Event delegation (replaces inline onclick/ondrag/etc handlers)
        // ============================================================

        // Click delegation
        document.body.addEventListener('click', function(e) {
            // Check for data-action attribute
            var actionEl = e.target.closest('[data-action]');
            if (actionEl) {
                var action = actionEl.getAttribute('data-action');
                switch (action) {
                    case 'createTask': createTask(e); break;
                    case 'archiveDone': {
                        var count = parseInt(actionEl.getAttribute('data-count') || '0', 10);
                        archiveDone(e, count);
                        break;
                    }
                    case 'navTask': {
                        var card = actionEl.closest('.task-card');
                        var tid = card ? card.getAttribute('data-task-id') : null;
                        var dir = actionEl.getAttribute('data-direction');
                        if (tid && dir) navTask(e, tid, dir);
                        break;
                    }
                    case 'toggleEpicCollapse': {
                        var eid = actionEl.getAttribute('data-epic-id');
                        if (eid) toggleEpicCollapse(eid);
                        break;
                    }
                    case 'approveProposal': approveProposal(actionEl); break;
                    case 'rejectProposal': rejectProposal(actionEl); break;
                    case 'showAgentMenu': showAgentMenu(); break;
                    case 'openSettings': openSettings(); break;
                    case 'connect': connect(); break;
                    case 'switchTab': switchTab(actionEl.getAttribute('data-tab')); break;
                }
                return;
            }
            // Task card click (open task detail)
            var taskCard = e.target.closest('.task-card');
            if (taskCard && !e.target.closest('button')) {
                var taskId = taskCard.getAttribute('data-task-id');
                if (taskId) openTask(taskId);
            }
        });

        // Double-click delegation (epic detail)
        document.body.addEventListener('dblclick', function(e) {
            var epicHeader = e.target.closest('.epic-header[data-epic-id]');
            if (epicHeader) {
                var eid = epicHeader.getAttribute('data-epic-id');
                if (eid) openEpicDetail(e, eid);
            }
        });

        // Drag start delegation
        document.body.addEventListener('dragstart', function(e) {
            var el = e.target.closest('[data-drag]');
            if (!el) return;
            var dragType = el.getAttribute('data-drag');
            if (dragType === 'task') {
                var tid = el.getAttribute('data-task-id');
                if (tid) onDragStart(e, tid);
            } else if (dragType === 'epic') {
                var eid = el.getAttribute('data-epic-id');
                if (eid) onEpicDragStart(e, eid);
            }
        });

        // Drag over delegation
        document.body.addEventListener('dragover', function(e) {
            var col = e.target.closest('[data-drop="column"]');
            if (col) {
                onDragOver(e);
            }
        });

        // Drop delegation
        document.body.addEventListener('drop', function(e) {
            var col = e.target.closest('[data-drop="column"]');
            if (col) {
                var status = col.getAttribute('data-status');
                if (status) onDrop(e, status);
            }
        });

        // Drag end delegation
        document.body.addEventListener('dragend', function(e) {
            var el = e.target.closest('[data-drag]');
            if (el) {
                var dragType = el.getAttribute('data-drag');
                if (dragType === 'epic') {
                    onEpicDragEnd(e);
                } else if (dragType === 'task') {
                    onDragEnd(e);
                }
            }
        });

        // Activity filter change delegation
        document.body.addEventListener('change', function(e) {
            if (e.target.id === 'activityFilterSelect') {
                onActivityFilterChange(e.target.value);
            }
        });

        // Notify extension that webview is ready
        vscode.postMessage({ type: 'ready' });

        // Retry: if no state received within 2s, re-send ready
        var retryInterval = setInterval(function() {
            if (stateReceived) {
                clearInterval(retryInterval);
            } else {
                vscode.postMessage({ type: 'ready' });
            }
        }, 2000);

        // Stop retrying after 30 seconds
        setTimeout(function() { clearInterval(retryInterval); }, 30000);

        // Restore active tab from saved state
        if (activeTab && activeTab !== 'board') {
            switchTab(activeTab);
        }
