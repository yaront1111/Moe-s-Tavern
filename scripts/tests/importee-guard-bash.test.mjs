import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const wrapper = readFileSync(new URL('../moe-agent.sh', import.meta.url), 'utf8');
// Execute the wrapper's complete attribution pass, not a copied guard implementation.
const algorithm = wrapper.split('resolve_attribution() {')[1].split("<<'PYEOF'\n")[1].split('\nPYEOF')[0];
const streamParser = wrapper.split("STREAM_JSON_PARSER=$(cat <<'PYEOF'\n")[1].split('\nPYEOF')[0];
const python = process.platform === 'win32' ? 'python' : 'python3';
// Ambient Git routing must never redirect fixture writes into a live checkout.
const fixtureEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull };

function fixture(t, sources, { head = {}, selected = Object.keys(sources), peers = [], events = [], unborn = false } = {}) {
    const scratch = mkdtempSync(join(tmpdir(), 'moe-bash-importee-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }));
    const root = join(scratch, 'git');
    mkdirSync(root);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, env: fixtureEnvironment });
    git('init', '--quiet');
    git('config', 'user.name', 'Importee Test');
    git('config', 'user.email', 'importee@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(root, 'README'), 'baseline\n');
    for (const [path, text] of Object.entries(head)) writeFileSync(join(root, path), text);
    git('add', '--all');
    if (!unborn) git('commit', '--quiet', '-m', 'fixture baseline');
    for (const [path, text] of Object.entries(sources)) {
        if (text === null) rmSync(join(root, path));
        else writeFileSync(join(root, path), text);
    }
    const snapshot = selected.map(path => `${sources[path] === null ? 'D' : git('hash-object', '-w', '--', path).trim()}\t??\t${path}`).join('\n');
    writeFileSync(join(scratch, 'snapshot'), snapshot + '\n');
    for (const name of ['baseline', 'unattributed', 'tools']) writeFileSync(join(scratch, name), '');
    writeFileSync(join(scratch, 'scope.json'), JSON.stringify({ asserted: selected, peersActive: true, peerDeclared: peers }));
    if (events.length) {
        const harvested = spawnSync(python, ['-c', streamParser], {
            input: events.map(event => JSON.stringify(event)).join('\n') + '\n',
            encoding: 'utf8', windowsHide: true, timeout: 30_000,
            env: { ...fixtureEnvironment, MOE_GIT_TOP: root, MOE_GIT_REL: '', MOE_TOOL_WRITES_FILE: join(scratch, 'tools') },
        });
        assert.equal(harvested.status, 0, harvested.stderr);
    }
    const result = spawnSync(python, ['-c', algorithm, 'completion', 'task-importee',
        ...['snapshot', 'baseline', 'unattributed', 'tools', 'scope.json'].map(name => join(scratch, name)), scratch], {
        encoding: 'utf8', windowsHide: true, timeout: 30_000,
        env: { ...fixtureEnvironment, MOE_GIT_TOP: root, MOE_GIT_REL: '', MOE_LAND_UNDECLARED: 'never',
            MOE_LAND_CONTESTED: 'skip-untouched', MOE_LAND_BOARD_STATE: 'false' },
    });
    assert.equal(result.status, 0, result.stderr);
    const records = name => readFileSync(join(scratch, name), 'utf8').split('\0').filter(Boolean).map(row => row.split('\t'));
    return { selected: records('candidates').map(row => row[2]), skipped: records('skipped'), git, scratch, root };
}

for (const [label, example] of [
    ['line comment', '// import value from "./not-a-module.mjs";'],
    ['block comment', '/* export { value } from "./not-a-module.mjs"; */'],
    ['quoted example', 'const text = \'import value from "./not-a-module.mjs"\';'],
    ['template text', 'const text = `import value from "./not-a-module.mjs"`;'],
    ['regex literal', String.raw`const pattern = /import value from "\.\/not-a-module.mjs"/;`],
    ['arrow regex', 'const matches = () => /["]/.test("x");'],
    ['arrow regex quantified group', 'const matches = (line) => /^ {6}FIELD(?:_FILE)?:/.test(line);'],
]) {
    test(`Bash guard ignores ${label} without breaking a valid dependency`, t => {
        const result = fixture(t, {
            'a.mjs': 'import { answer } from "./b.mjs"; console.log(answer);\n',
            'b.mjs': `export const answer = 42;\n${example}\n`,
        });
        assert.deepEqual(result.selected, ['a.mjs', 'b.mjs']);
        assert.deepEqual(result.skipped, []);
        // Materialize exactly the selected Git blobs: a dirty tree cannot mask an omitted importee.
        const index = join(result.scratch, 'index');
        const git = (...args) => execFileSync('git', ['-C', result.root, ...args], {
            encoding: 'utf8', windowsHide: true, env: { ...fixtureEnvironment, GIT_INDEX_FILE: index },
        });
        git('read-tree', 'HEAD');
        for (const path of result.selected) git('update-index', '--add', '--cacheinfo', '100644', result.git('hash-object', path).trim(), path);
        const clean = join(result.scratch, 'clean');
        mkdirSync(clean);
        git('checkout-index', '--all', `--prefix=${clean.replaceAll('\\', '/')}/`);
        const run = spawnSync(process.execPath, [join(clean, 'a.mjs')], { encoding: 'utf8', windowsHide: true, env: fixtureEnvironment });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout.trim(), '42');
    });
}

for (const [label, source] of [
    ['side effect', 'import "./missing.mjs";'],
    ['named import', 'import { value } from "./missing.mjs";'],
    ['reexport', 'export { value } from "./missing.mjs";'],
    ['dynamic import', 'const value = import("./missing.mjs");'],
    ['require', 'const value = require("./missing.mjs");'],
    ['arrow regex followed by import', 'const matches = () => /["]/.test("x"); import "./missing.mjs";'],
    ['comment separated', 'import /* comment */ { value } /* comment */ from /* comment */ "./missing.mjs";'],
    ['template interpolation', 'const text = `prefix ${import("./missing.mjs")} suffix`;'],
    ['nested template interpolation', 'const text = `prefix ${{ value: `nested ${import("./missing.mjs")}` }} suffix`;'],
    ['escaped specifier', 'import { value } from "\\x2e/missing.mjs";'],
    ['unicode escaped specifier', 'import { value } from "\\u002e/missing.mjs";'],
]) {
    test(`Bash guard holds a missing ${label} dependency`, t => {
        const result = fixture(t, { 'a.mjs': source });
        assert.deepEqual(result.selected, []);
        assert.deepEqual(result.skipped, [['MOE_ATTR_IMPORTEE_MISSING(./missing.mjs)', 'a.mjs']]);
    });
}

test('Bash guard removes dependency chains to a fixed point', t => {
    const result = fixture(t, {
        'a.mjs': 'export { answer } from "./b.mjs";',
        'b.mjs': 'export { answer } from "./c.mjs";',
        'c.mjs': 'export const answer = 42;',
    }, { selected: ['a.mjs', 'b.mjs'] });
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.skipped.map(row => row[1]).sort(), ['a.mjs', 'b.mjs']);
});

test('Bash guard subtracts a landing deletion from HEAD', t => {
    const result = fixture(t, {
        'a.mjs': 'import { value } from "./b.mjs";', 'b.mjs': null,
    }, { head: { 'b.mjs': 'export const value = 42;' } });
    assert.deepEqual(result.selected, ['b.mjs']);
    assert.deepEqual(result.skipped, [['MOE_ATTR_IMPORTEE_MISSING(./b.mjs)', 'a.mjs']]);
});

test('Bash guard preserves a closed cycle and TypeScript emitted-JS bridge', t => {
    const result = fixture(t, {
        'a.ts': 'import { b } from "./b.js"; export const a = 1;',
        'b.ts': 'import { a } from "./a.js"; export const b = 2;',
    });
    assert.deepEqual(result.selected, ['a.ts', 'b.ts']);
    assert.deepEqual(result.skipped, []);
});

test('Bash guard holds an unterminated source literal instead of assuming no dependencies', t => {
    const result = fixture(t, { 'a.mjs': 'const value = "unterminated' });
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.skipped, [['MOE_ATTR_IMPORTEE_MISSING(<unparseable-source>)', 'a.mjs']]);
});

test('Bash guard checks missing imports on an unborn branch', t => {
    const result = fixture(t, { 'a.mjs': 'import "./missing.mjs";' }, { unborn: true });
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.skipped, [['MOE_ATTR_IMPORTEE_MISSING(./missing.mjs)', 'a.mjs']]);
});

test('Bash guard holds a literal relative import escaping the repository root', t => {
    const result = fixture(t, { 'a.mjs': 'import "../outside.mjs";' });
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.skipped, [['MOE_ATTR_IMPORTEE_MISSING(../outside.mjs)', 'a.mjs']]);
});

function bashFunction(name) {
    const start = wrapper.indexOf(`${name}() {`);
    assert.notEqual(start, -1);
    const end = wrapper.indexOf('\n}\n', start);
    assert.notEqual(end, -1);
    return wrapper.slice(start, end + 3);
}

test('Bash final index drops newly dangling importers while keeping independent files', t => {
    const result = fixture(t, {
        'a.mjs': 'export { value } from "./b.mjs";', 'b.mjs': 'export const value = 1;', 'independent.txt': 'keep\n',
    });
    writeFileSync(join(result.root, 'b.mjs'), 'export const value = 2;\n');
    const script = `${bashFunction('resolve_attribution')}\n${bashFunction('moe_temp_index_build')}\n
create_secure_temp() { mktemp -d "$FIXTURE_SCRATCH/helper.XXXXXX"; }
MOE_TOP="$FIXTURE_ROOT"; MOE_REL=""; MOE_TAB=$'\\t'
MOE_GITDIR="$(git -C "$MOE_TOP" rev-parse --absolute-git-dir)"
LAND_TASK_ID=task-importee; PYTHON_CMD="$FIXTURE_PYTHON"
CS_ATTR_UNDECLARED=never; CS_ATTR_CONTESTED=skip-untouched; CS_ATTR_EXCLUDE=""; CS_COMMIT_BOARD_STATE=false
moe_temp_index_build "$(git -C "$MOE_TOP" rev-parse HEAD)" "$FIXTURE_SCRATCH/candidates" "$FIXTURE_SCRATCH/final" "$FIXTURE_SCRATCH/dropped"
`;
    const scriptPath = join(result.scratch, 'build.sh');
    writeFileSync(scriptPath, script);
    const run = spawnSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', [scriptPath], {
        encoding: 'utf8', timeout: 30_000, windowsHide: true,
        env: { ...fixtureEnvironment, FIXTURE_ROOT: result.root.replaceAll('\\', '/'),
            FIXTURE_SCRATCH: result.scratch.replaceAll('\\', '/'), FIXTURE_PYTHON: python },
    });
    assert.equal(run.status, 0, run.stderr);
    const rows = name => readFileSync(join(result.scratch, name), 'utf8').split('\0').filter(Boolean).map(row => row.split('\t'));
    assert.deepEqual(rows('final').map(row => row[2]), ['independent.txt']);
    assert.deepEqual(rows('dropped').sort((a, b) => a[1].localeCompare(b[1])), [
        ['MOE_ATTR_IMPORTEE_MISSING(./b.mjs)', 'a.mjs'], ['MOE_ATTR_CONCURRENT', 'b.mjs'],
    ]);
});

for (const stagedMissing of [false, true]) {
    test(`Bash index guard reads ${stagedMissing ? 'missing' : 'valid'} staged source despite later worktree replacement`, t => {
        const result = fixture(t, { 'a.mjs': 'export const value = 1;' });
        if (stagedMissing) writeFileSync(join(result.root, 'a.mjs'), 'import "./missing.mjs";');
        result.git('add', 'a.mjs');
        const blob = result.git('rev-parse', ':0:a.mjs').trim();
        writeFileSync(join(result.root, 'a.mjs'), stagedMissing ? 'export const value = 1;' : 'import "./missing.mjs";');
        const staged = join(result.scratch, 'staged');
        writeFileSync(staged, `ASSERTED\t${blob}\ta.mjs\0`);
        const output = join(result.scratch, 'validated');
        mkdirSync(output);
        const run = spawnSync(python, ['-c', algorithm, 'index', 'task-importee', staged, '', '', '', '', output], {
            encoding: 'utf8', windowsHide: true, timeout: 30_000,
            env: { ...fixtureEnvironment, MOE_GIT_TOP: result.root, MOE_GIT_REL: '',
                MOE_LAND_BASE: result.git('rev-parse', 'HEAD').trim(), MOE_LAND_INDEX: join(result.root, '.git', 'index') },
        });
        assert.equal(run.status, 0, run.stderr);
        const selected = readFileSync(join(output, 'candidates'), 'utf8').split('\0').filter(Boolean).map(row => row.split('\t')[2]);
        assert.deepEqual(selected, stagedMissing ? [] : ['a.mjs']);
    });
}

test('Bash guard does not invent imports from property calls or computed prefixes', t => {
    const result = fixture(t, { 'a.mjs': 'object.import("./missing.mjs"); object.require("./missing.mjs"); import("./prefix-" + name);' });
    assert.deepEqual(result.selected, ['a.mjs']);
    assert.deepEqual(result.skipped, []);
});

test('Bash guard ignores JSX text and attributes while scanning its expressions', t => {
    const result = fixture(t, {
        'good.tsx': 'const view = <><div title="import x from \'./fake.js\'">Don\'t import x from "./fake.js"<span /></div></>;',
        'bad.tsx': 'const view = <section>{import("./missing.js")}</section>;',
    });
    assert.deepEqual(result.selected, ['good.tsx']);
    assert.deepEqual(result.skipped, [['MOE_ATTR_IMPORTEE_MISSING(./missing.js)', 'bad.tsx']]);
});

test('Bash guard preserves generic TypeScript functions instead of treating them as JSX', t => {
    const result = fixture(t, {
        'a.ts': 'const identity = <T>(value: T) => value;',
        'b.tsx': 'const identity = <T extends object>(value: T) => value;',
    });
    assert.deepEqual(result.selected, ['a.ts', 'b.tsx']);
    assert.deepEqual(result.skipped, []);
});

for (const [label, tool, outcome, expected] of [
    ['rejects only a complete_step claim', null, null, false],
    ['rejects an edit without a result', 'Edit', null, false],
    ['rejects a failed edit', 'Edit', 'error', false],
    ['rejects an unrelated successful result', 'Edit', 'other-id', false],
    ['rejects a replayed successful result', 'Edit', 'replay', false],
    ['accepts a successful edit', 'Edit', 'success', true],
    ['accepts a successful write', 'Write', 'success', true],
]) {
    test(`Bash contested attribution ${label}`, t => {
        const events = [{ type: 'assistant', message: { content: [
            ...(tool ? [{ type: 'tool_use', id: 'edit-1', name: tool, input: { file_path: 'shared.txt' } }] : []),
            { type: 'tool_use', id: 'claim-1', name: 'mcp__moe__moe_complete_step', input: { modifiedFiles: ['shared.txt'] } },
        ] } }];
        if (outcome !== null) events.push({ type: 'user', isReplay: outcome === 'replay', message: { content: [{
            type: 'tool_result', tool_use_id: outcome === 'other-id' ? 'other-edit' : 'edit-1',
            is_error: outcome === 'error', content: 'fixture tool outcome',
        }] } });
        const result = fixture(t, { 'shared.txt': 'session bytes\n' }, {
            peers: [{ path: 'shared.txt', taskId: 'task-peer' }], events,
        });
        assert.deepEqual(result.selected, expected ? ['shared.txt'] : []);
        assert.deepEqual(result.skipped, expected ? [] : [['MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)', 'shared.txt']]);
    });
}

test('Bash complete edit block becomes a witness after partial display and a matching successful result', t => {
    const events = [
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'stream-edit', name: 'Edit' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":"shared.txt"}' } } },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'stream-edit', name: 'Edit', input: { file_path: 'shared.txt' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'stream-edit', content: 'fixture success' }] } },
    ];
    const result = fixture(t, { 'shared.txt': 'session bytes\n' }, {
        peers: [{ path: 'shared.txt', taskId: 'task-peer' }], events,
    });
    assert.deepEqual(result.selected, ['shared.txt']);
    assert.deepEqual(result.skipped, []);
});

test('Bash complete edit blocks preserve authority when partial parent streams overlap', t => {
    const event = (parent, type, body = {}) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type, index: 0, ...body } });
    const events = [
        event('parent-a', 'content_block_start', { content_block: { type: 'tool_use', id: 'edit-a', name: 'Edit' } }),
        event('parent-a', 'content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.txt"}' } }),
        event('parent-b', 'content_block_start', { content_block: { type: 'tool_use', id: 'edit-b', name: 'Edit' } }),
        event('parent-b', 'content_block_delta', { delta: { type: 'input_json_delta', partial_json: '{"file_path":"b.txt"}' } }),
        event('parent-a', 'content_block_stop'), event('parent-b', 'content_block_stop'),
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-a', name: 'Edit', input: { file_path: 'a.txt' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit-a', is_error: false }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit-b', is_error: true }] } },
    ];
    const result = fixture(t, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, {
        peers: [{ path: 'a.txt', taskId: 'task-peer' }, { path: 'b.txt', taskId: 'task-peer' }], events,
    });
    assert.deepEqual(result.selected, ['a.txt']);
    assert.deepEqual(result.skipped, [['MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)', 'b.txt']]);
});

test('Bash partial edit display alone cannot supply an editing witness', t => {
    const events = [
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'partial-edit', name: 'Edit' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":"shared.txt"}' } } },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'partial-edit', is_error: false }] } },
    ];
    const result = fixture(t, { 'shared.txt': 'session bytes\n' }, {
        peers: [{ path: 'shared.txt', taskId: 'task-peer' }], events,
    });
    assert.deepEqual(result.selected, []);
    assert.deepEqual(result.skipped, [['MOE_ATTR_CONTESTED_UNTOUCHED(task-peer)', 'shared.txt']]);
});
