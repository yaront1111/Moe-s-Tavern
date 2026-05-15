    const vscode = acquireVsCodeApi();
    var initData = document.getElementById('initial-data');
    const isEdit = initData.dataset.isEdit === 'true';
    const epicId = initData.dataset.epicId;

    const titleInput = document.getElementById('titleInput');
    const descInput = document.getElementById('descInput');
    const archInput = document.getElementById('archInput');
    const railsInput = document.getElementById('railsInput');
    const titleError = document.getElementById('titleError');

    function getTrimmedTitle() {
        return titleInput.value.trim();
    }

    function getRails() {
        return railsInput.value
            .split('\n')
            .map(function(line) { return line.trim(); })
            .filter(function(line) { return line.length > 0; });
    }

    function validateTitle() {
        const valid = getTrimmedTitle().length > 0;
        titleError.style.display = valid ? 'none' : 'block';
        return valid;
    }

    titleInput.addEventListener('input', function() {
        validateTitle();
    });

    if (isEdit) {
        var saveBtn = document.getElementById('saveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', function() {
                if (!validateTitle()) { return; }
                var statusSelect = document.getElementById('statusSelect');
                vscode.postMessage({
                    type: 'save',
                    epicId: epicId,
                    title: getTrimmedTitle(),
                    description: descInput.value.trim(),
                    architectureNotes: archInput.value.trim(),
                    epicRails: getRails(),
                    status: statusSelect ? statusSelect.value : 'PLANNED'
                });
            });
        }

        var deleteBtn = document.getElementById('deleteBtn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', function() {
                vscode.postMessage({ type: 'delete', epicId: epicId });
            });
        }
    } else {
        var createBtn = document.getElementById('createBtn');
        if (createBtn) {
            createBtn.addEventListener('click', function() {
                if (!validateTitle()) { return; }
                vscode.postMessage({
                    type: 'create',
                    title: getTrimmedTitle(),
                    description: descInput.value.trim(),
                    architectureNotes: archInput.value.trim(),
                    epicRails: getRails()
                });
            });
        }
    }

    var cancelBtn = document.getElementById('cancelBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'cancel' });
        });
    }

    // Focus title on load
    titleInput.focus();
