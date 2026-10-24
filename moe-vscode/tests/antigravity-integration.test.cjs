const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '../src/util/AntigravityIntegration.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;

function harness({ api, flatProxy = true, appName = 'Antigravity' } = {}) {
    const module = { exports: {} };
    const logs = [];
    const context = vm.createContext({
        exports: module.exports,
        module,
        require: name => {
            if (name === 'vscode') return { env: { appName }, antigravity: api };
            if (name === 'fs') return { existsSync: () => flatProxy };
            if (name === 'path') return path;
            throw new Error(`Unexpected import: ${name}`);
        }
    });
    vm.runInContext(compiled, context, { filename: sourcePath });
    return {
        integration: module.exports,
        logs,
        output: { appendLine: line => logs.push(line) },
        VmError: vm.runInContext('Error', context)
    };
}

test('Antigravity detection does not treat vanilla VS Code as the fork', () => {
    assert.equal(harness().integration.isAntigravity(), true);
    assert.equal(harness({ appName: 'Visual Studio Code' }).integration.isAntigravity(), false);
});

for (const flatProxy of [true, false]) {
    test(`MCP registration retains the ${flatProxy ? 'flat' : 'legacy'} bundled proxy path`, () => {
        const calls = [];
        const h = harness({ flatProxy, api: { registerMcpServer: options => calls.push(options) } });
        h.integration.registerMcpServer('extension', 'project', h.output);
        assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
            name: 'moe-proxy', command: 'node',
            args: [path.join('extension', 'bundled', 'proxy', ...(flatProxy ? [] : ['dist']), 'index.js')],
            cwd: 'project'
        }]);
        assert.deepEqual(h.logs, ['Registered moe-proxy as Antigravity MCP server']);
    });
}

test('an unavailable Antigravity API is a no-op', () => {
    const h = harness();
    assert.doesNotThrow(() => h.integration.registerMcpServer('extension', 'project', h.output));
    assert.deepEqual(h.logs, []);
});

test('MCP registration logs an Error without escaping its error boundary', () => {
    const h = harness({ api: { registerMcpServer: () => { throw new h.VmError('offline'); } } });
    assert.doesNotThrow(() => h.integration.registerMcpServer('extension', 'project', h.output));
    assert.deepEqual(h.logs, ['Antigravity MCP registration failed: offline']);
});

for (const failure of ['offline', null, undefined, 42]) {
    test(`MCP registration safely reports a non-Error rejection: ${String(failure)}`, () => {
        const h = harness({ api: { registerMcpServer: () => { throw failure; } } });
        assert.doesNotThrow(() => h.integration.registerMcpServer('extension', 'project', h.output));
        assert.deepEqual(h.logs, [`Antigravity MCP registration failed: ${String(failure)}`]);
    });
}

test('MCP registration contains an unprintable thrown object', () => {
    const failure = Object.create(null);
    const h = harness({ api: { registerMcpServer: () => { throw failure; } } });
    assert.doesNotThrow(() => h.integration.registerMcpServer('extension', 'project', h.output));
    assert.deepEqual(h.logs, ['Antigravity MCP registration failed: Unknown error']);
});
