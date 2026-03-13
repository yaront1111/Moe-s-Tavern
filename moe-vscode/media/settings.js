    var vscode = acquireVsCodeApi();

    var approvalModeEl = document.getElementById('approvalMode');
    var speedModeDelayMsEl = document.getElementById('speedModeDelayMs');
    var agentCommandEl = document.getElementById('agentCommand');
    var autoCreateBranchEl = document.getElementById('autoCreateBranch');
    var branchPatternEl = document.getElementById('branchPattern');
    var commitPatternEl = document.getElementById('commitPattern');
    var saveBtn = document.getElementById('saveBtn');
    var cancelBtn = document.getElementById('cancelBtn');

    saveBtn.addEventListener('click', function() {
        vscode.postMessage({
            type: 'save',
            approvalMode: approvalModeEl.value,
            speedModeDelayMs: parseInt(speedModeDelayMsEl.value, 10) || 2000,
            agentCommand: agentCommandEl.value.trim(),
            autoCreateBranch: autoCreateBranchEl.checked,
            branchPattern: branchPatternEl.value.trim(),
            commitPattern: commitPatternEl.value.trim()
        });
    });

    cancelBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'cancel' });
    });
