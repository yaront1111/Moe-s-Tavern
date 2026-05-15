    const vscode = acquireVsCodeApi();

    const epicEl = document.getElementById('epic');
    const titleEl = document.getElementById('title');
    const descriptionEl = document.getElementById('description');
    const dodEl = document.getElementById('dod');
    const priorityEl = document.getElementById('priority');
    const titleCharCount = document.getElementById('titleCharCount');
    const titleError = document.getElementById('titleError');
    const epicError = document.getElementById('epicError');
    const submitBtn = document.getElementById('submitBtn');

    function updateButtonState() {
        const hasEpic = !!epicEl.value;
        const hasTitle = !!titleEl.value.trim();
        const titleInRange = titleEl.value.trim().length <= 500;
        submitBtn.disabled = !(hasEpic && hasTitle && titleInRange);
    }

    titleEl.addEventListener('input', function() {
        const len = titleEl.value.length;
        titleCharCount.textContent = len + ' / 500';
        titleCharCount.className = len > 500 ? 'char-count over' : 'char-count';
        if (len > 0) {
            titleEl.classList.remove('error');
            titleError.classList.remove('visible');
        }
        updateButtonState();
    });

    epicEl.addEventListener('change', function() {
        if (epicEl.value) {
            epicEl.classList.remove('error');
            epicError.classList.remove('visible');
        }
        updateButtonState();
    });

    // Initial state: button disabled until form is valid
    updateButtonState();

    function validate() {
        let valid = true;

        if (!epicEl.value) {
            epicEl.classList.add('error');
            epicError.classList.add('visible');
            valid = false;
        } else {
            epicEl.classList.remove('error');
            epicError.classList.remove('visible');
        }

        const title = titleEl.value.trim();
        if (!title) {
            titleEl.classList.add('error');
            titleError.textContent = 'Title is required.';
            titleError.classList.add('visible');
            valid = false;
        } else if (title.length > 500) {
            titleEl.classList.add('error');
            titleError.textContent = 'Title must be 500 characters or fewer.';
            titleError.classList.add('visible');
            valid = false;
        } else {
            titleEl.classList.remove('error');
            titleError.classList.remove('visible');
        }

        return valid;
    }

    function submitForm() {
        if (!validate()) {
            return;
        }

        const dodText = dodEl.value || '';
        const dodItems = dodText.split('\n').map(function(line) { return line.trim(); }).filter(function(line) { return line.length > 0; });

        vscode.postMessage({
            type: 'submit',
            epicId: epicEl.value,
            title: titleEl.value.trim(),
            description: descriptionEl.value.trim(),
            definitionOfDone: dodItems,
            priority: priorityEl.value
        });
    }

    function cancelForm() {
        vscode.postMessage({ type: 'cancel' });
    }

    // Submit button click handler
    submitBtn.addEventListener('click', function() {
        submitForm();
    });

    // Cancel button click handler
    document.getElementById('cancelBtn').addEventListener('click', function() {
        cancelForm();
    });

    // Handle init message from extension
    window.addEventListener('message', function(event) {
        const message = event.data;
        if (message.type === 'init' && message.epics) {
            // Re-populate epics if sent after panel creation
            const epics = message.epics;
            while (epicEl.options.length > 1) {
                epicEl.remove(1);
            }
            for (let i = 0; i < epics.length; i++) {
                const opt = document.createElement('option');
                opt.value = epics[i].id;
                opt.textContent = epics[i].title;
                epicEl.appendChild(opt);
            }
            updateButtonState();
        }
    });

    // Allow Enter in title to submit
    titleEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitForm();
        }
    });
