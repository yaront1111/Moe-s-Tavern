    var vscode = acquireVsCodeApi();

    var approvalModeEl = document.getElementById('approvalMode');
    var speedModeDelayMsEl = document.getElementById('speedModeDelayMs');
    var agentCommandEl = document.getElementById('agentCommand');
    var enableAgentTeamsEl = document.getElementById('enableAgentTeams');
    var saveBtn = document.getElementById('saveBtn');
    var cancelBtn = document.getElementById('cancelBtn');

    saveBtn.addEventListener('click', function() {
        vscode.postMessage({
            type: 'save',
            approvalMode: approvalModeEl.value,
            speedModeDelayMs: parseInt(speedModeDelayMsEl.value, 10) || 2000,
            agentCommand: agentCommandEl.value.trim(),
            enableAgentTeams: enableAgentTeamsEl.checked
        });
    });

    cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancel' });
    });

    // Settings changed elsewhere arrive while the form is open. A field the user has changed keeps the user's value;
    // every other field follows, so Save never writes back a value the project no longer has.
    var edited = {};
    function markEdited(id) { return function() { edited[id] = true; }; }
    approvalModeEl.addEventListener('change', markEdited('approvalMode'));
    speedModeDelayMsEl.addEventListener('input', markEdited('speedModeDelayMs'));
    agentCommandEl.addEventListener('input', markEdited('agentCommand'));
    enableAgentTeamsEl.addEventListener('change', markEdited('enableAgentTeams'));

    window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!msg || msg.type !== 'settings' || !msg.settings) { return; }
        var s = msg.settings;
        if (!edited.approvalMode && ['CONTROL', 'SPEED', 'TURBO'].indexOf(s.approvalMode) >= 0) { approvalModeEl.value = s.approvalMode; }
        if (!edited.speedModeDelayMs) { speedModeDelayMsEl.value = String(s.speedModeDelayMs); }
        if (!edited.agentCommand) { agentCommandEl.value = String(s.agentCommand); }
        if (!edited.enableAgentTeams) { enableAgentTeamsEl.checked = s.enableAgentTeams === true; }
        var policy = document.getElementById('landingPolicy');
        if (policy && typeof msg.policyHtml === 'string') { policy.innerHTML = msg.policyHtml; }
    });
