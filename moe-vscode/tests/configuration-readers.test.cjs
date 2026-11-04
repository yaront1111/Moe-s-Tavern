// Every moe.* setting that package.json declares must have a reader in src.
// A key counts as read when ONE src .ts file calls getConfiguration('<section>')
// and .get('<leaf>') such that `${section}.${leaf}` equals the key. The rule
// over-approximates on purpose (every .get leaf in a file joins every section of
// that file, comments included): it only has to catch a declared key that
// nothing reads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

function declaredSettings(pkgPath) {
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (error) {
        throw new Error(`cannot read ${pkgPath}: ${error.message}`);
    }
    // contributes.configuration may be one object or an array of them.
    const keys = [].concat(pkg?.contributes?.configuration ?? [])
        .flatMap((section) => Object.keys(section?.properties ?? {}))
        .filter((key) => key.startsWith('moe.'));
    if (keys.length === 0) {
        throw new Error(`${pkgPath} declares no moe.* configuration properties`);
    }
    return keys;
}

function settingsReadIn(text) {
    const sections = [...text.matchAll(/getConfiguration\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
    const leaves = [...text.matchAll(/\.get\s*(?:<[^()]*?>)?\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
    return sections.flatMap((section) => leaves.map((leaf) => `${section}.${leaf}`));
}

// Reads package.json first, so an unreadable or empty one is the failure reason.
function deadSettings(pkgPath, srcDir) {
    const declared = declaredSettings(pkgPath);
    const files = fs.readdirSync(srcDir, { recursive: true }).filter((file) => file.endsWith('.ts'));
    const read = new Set(files.flatMap((file) => settingsReadIn(fs.readFileSync(path.join(srcDir, file), 'utf8'))));
    return declared.filter((key) => !read.has(key));
}

function withFixture(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-configuration-readers-'));
    try {
        for (const [rel, text] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), text);
        }
        return fn(path.join(dir, 'package.json'), path.join(dir, 'src'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('C1: every moe.* setting declared in package.json has a getConfiguration reader in src', () => {
    const dead = deadSettings(path.join(root, 'package.json'), path.join(root, 'src'));
    assert.deepStrictEqual(dead, [], `declared in package.json with no getConfiguration reader in src: ${dead.join(', ')}`);
});

test('C2: an unreadable package.json fails with the reason', () => {
    withFixture({ 'src/a.ts': '' }, (pkg, src) => {
        assert.throws(() => deadSettings(pkg, src), { message: /^cannot read .*package\.json: ENOENT/ });
    });
    withFixture({ 'package.json': '{ "contributes": ', 'src/a.ts': '' }, (pkg, src) => {
        assert.throws(() => deadSettings(pkg, src), { message: /^cannot read .*package\.json: .*JSON/ });
    });
});

test('C3: a package.json with no moe.* configuration properties fails instead of passing on an empty set', () => {
    for (const text of ['{}', '{"contributes":{}}', '{"contributes":{"configuration":{"title":"Moe","properties":{}}}}',
        '{"contributes":{"configuration":[{"properties":{"other.key":{"type":"string"}}}]}}']) {
        withFixture({ 'package.json': text, 'src/a.ts': '' }, (pkg, src) => {
            assert.throws(() => deadSettings(pkg, src), { message: /declares no moe\.\* configuration properties$/ }, text);
        });
    }
});

test('C4: a key is read only through getConfiguration(section) plus .get(leaf) in the same .ts file', () => {
    const properties = Object.fromEntries(['moe.a.b', 'moe.c', 'moe.split.x', 'moe.attr', 'other.setting']
        .map((key) => [key, { type: 'string' }]));
    withFixture({
        'package.json': JSON.stringify({ contributes: { configuration: [{ title: 'Moe', properties }] } }),
        'src/top.ts': "const c = vscode.workspace.getConfiguration('moe');\nc.get<Record<string, string[]>>(\"c\", {});\n"
            + "vscode.workspace.getConfiguration('moe.split');\nel.getAttribute('attr');\n",
        'src/deep/nested.ts': "vscode.workspace.getConfiguration(\"moe.a\").get<boolean>('b', true);\ncfg.get('x');\n",
    }, (pkg, src) => {
        assert.deepStrictEqual(deadSettings(pkg, src), ['moe.split.x', 'moe.attr']);
    });
});
