const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ESLint } = require('eslint');

const cwd = path.join(__dirname, '..');

async function lint(source) {
    const eslint = new ESLint({ cwd });
    let results;
    try {
        results = await eslint.lintText(source, { filePath: path.join(cwd, 'src/lint-fixture.ts') });
    } catch (error) {
        assert.fail(`TypeScript lint configuration must load: ${error.message}`);
    }
    assert.equal(results.length, 1, 'the source fixture must not be ignored');
    return results[0];
}

test('flat configuration accepts typed extension code and Node globals', async () => {
    const result = await lint('export const version: string = process.version;\nexport const data = Buffer.alloc(1);\n');
    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
    assert.equal(result.warningCount, 0, JSON.stringify(result.messages));
});

test('flat configuration rejects unused TypeScript variables', async () => {
    const result = await lint('const unused: number = 1;\n');
    assert.equal(result.errorCount, 1);
    assert.equal(result.messages[0].ruleId, '@typescript-eslint/no-unused-vars');
});

test('flat configuration rejects explicit any rather than silently weakening the preset', async () => {
    const result = await lint('export const value: any = 1;\n');
    assert.equal(result.errorCount, 1);
    assert.equal(result.messages[0].ruleId, '@typescript-eslint/no-explicit-any');
});

test('flat configuration retains recommended JavaScript control-flow checks', async () => {
    const result = await lint('export function check(flag: boolean) { if (flag) return 1; else if (flag) return 2; return 0; }\n');
    assert.equal(result.errorCount, 1);
    assert.equal(result.messages[0].ruleId, 'no-dupe-else-if');
});
