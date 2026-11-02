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
