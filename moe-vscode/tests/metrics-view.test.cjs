const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// The first-pass KPI formatter lives inside the inline webview script that
// getHtml() emits, so these tests execute that exact script instead of
// duplicating its arithmetic.
const sourcePath = path.join(__dirname, '../src/providers/MetricsViewProvider.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

const EM_DASH = '—';

function loadProvider() {
    const module = { exports: {} };
    const vscode = { Uri: { file: fsPath => ({ fsPath }) } };
    const context = vm.createContext({
        exports: module.exports,
        module,
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        require: name => {
            if (name === 'vscode') { return vscode; }
            throw new Error('unexpected require from MetricsViewProvider: ' + name);
        }
    });
    vm.runInContext(compiled, context, { filename: sourcePath });
    const subscription = { dispose() {} };
    const client = {
        onMetrics: () => subscription,
        onConnectionChanged: () => subscription,
        listMetrics: () => {}
    };
    return new module.exports.MetricsViewProvider({ fsPath: 'extension' }, client);
}

function readWebviewScript() {
    const provider = loadProvider();
    try {
        const html = provider['getHtml']();
        const match = /<script>([\s\S]*?)<\/script>/.exec(html);
        if (!match) {
            throw new Error('MetricsViewProvider.getHtml() emitted no <script> block to test');
        }
        return match[1];
    } finally {
        // Release the metrics listeners and the 30s poll timer.
        provider.dispose();
    }
}

const webviewScript = readWebviewScript();

// Runs the production webview script in a fresh context, delivers one aggregate
// message and reports what the first-pass KPI element ended up showing.
function renderFirstPass(aggregate) {
    const elements = {};
    let onMessage;
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage() {} }),
        document: {
            querySelectorAll: () => [],
            getElementById: id => (elements[id] ??= {})
        },
        window: {
            addEventListener: (type, handler) => {
                if (type === 'message') { onMessage = handler; }
            }
        },
        console
    });
    vm.runInContext(webviewScript, context, { filename: 'MetricsViewProvider.webview.js' });
    if (typeof onMessage !== 'function') {
        throw new Error('the webview script registered no message handler');
    }
    onMessage({ data: { type: 'aggregate', aggregate } });
    return elements.kpiFirstPass && elements.kpiFirstPass.textContent;
}

test('no task approved first pass renders as zero percent', () => {
    assert.equal(renderFirstPass({ firstPassApprovalPct: 0 }), '0%');
});

test('half of the tasks approved first pass renders as fifty percent', () => {
    assert.equal(renderFirstPass({ firstPassApprovalPct: 50 }), '50%');
});

test('every task approved first pass renders as one hundred percent', () => {
    assert.equal(renderFirstPass({ firstPassApprovalPct: 100 }), '100%');
});

test('an omitted first-pass rate stays the em dash placeholder', () => {
    assert.equal(renderFirstPass({}), EM_DASH);
});

test('a null first-pass rate stays the em dash placeholder', () => {
    assert.equal(renderFirstPass({ firstPassApprovalPct: null }), EM_DASH);
});

test('a non-numeric first-pass rate stays the em dash placeholder', () => {
    assert.equal(renderFirstPass({ firstPassApprovalPct: '50' }), EM_DASH);
});
