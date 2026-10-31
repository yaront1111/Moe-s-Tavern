import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ToolTestHarness } from '../../tools/toolTestHarness.js';
import { clearAllSpeedModeTimeouts } from '../../tools/submitPlan.js';
import {
  instantiateRecipe, readRecipeInstance, recipeDefinitionDigest, recipeInputsDigest, recipeKinds, RECIPE_DEFINITIONS_PATH as DEFS,
} from './recipe.js';
import { docsLiteralReplace as kind } from './docsLiteralReplace.js';
import type { RecipeDefinition, RecipeInstance } from '../../types/schema.js';

// CQ-C09 DoD on real temporary repos: committed bytes, C08's instantiation flow and the post-patch commit diff.
const h = new ToolTestHarness();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const DOC = '# Guide\n\nSee the old link.\n';
const AFTER = '# Guide\n\nSee the new link.\n';
const DEF: RecipeDefinition = { id: 'docs-fix', kind: 'docs-literal-replace', version: 1,
  requiredChecks: [{ id: 'docs', command: 'npm run lint' }], params: { allowedPaths: ['docs'] } };
const INPUTS = { path: 'docs/a.md', originalSha256: sha(DOC), oldText: 'old link', newText: 'new link' };
const BOARD = '.moe/tasks/task-1.json';

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', ...args], { cwd: h.testDir, encoding: 'utf8',
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.test' } }).trim();
}
/** Writes the files, stages exactly them plus `extra` (a git index edit, or more paths), and commits. */
function commit(files: Record<string, string | Buffer>, extra: string[] | (() => void) = []): string {
  for (const [file, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.testDir, file)), { recursive: true });
    fs.writeFileSync(path.join(h.testDir, file), bytes);
  }
  if (Object.keys(files).length) git('add', '--', ...Object.keys(files));
  if (typeof extra === 'function') extra(); else if (extra.length) git('add', '-A', '--', ...extra);
  git('commit', '-q', '--allow-empty', '-m', 'fixture');
  return git('rev-parse', 'HEAD');
}
const recipes = (...defs: unknown[]) => JSON.stringify({ version: 1, recipes: defs });
const task = () => h.state.getTask('task-1')!;
const run = (inputs: Record<string, unknown> = INPUTS) => instantiateRecipe(h.state, { taskId: 'task-1', recipeId: 'docs-fix', inputs });
const fellBack = (reason: string) => ({ instantiated: false, fallback: 'ordinary-planning', reason });
const refused = (reason: string, detail?: string) => ({ ok: false, reason, ...(detail === undefined ? {} : { detail }) });
const symlinkAt = (file: string) => () => {
  git('update-index', '--add', '--cacheinfo', `120000,${git('rev-parse', `HEAD:${file}`)},${file}`);
};

let head = '';
beforeEach(async () => {
  h.init(); h.setupMoeFolder({ globalRails: { techStack: [], formatting: '', testing: '', customRules: [],
    forbiddenPatterns: ['rm -rf'], requiredPatterns: ['error handling', 'test'] } });
  h.createEpic(); h.createTask({ status: 'PLANNING' });
  await h.state.load(); h.state.project!.settings = { ...h.state.project!.settings, approvalMode: 'TURBO' };
  git('init', '-q'); head = commit({ [DEFS]: recipes(DEF), 'docs/a.md': DOC });
});
afterEach(() => { clearAllSpeedModeTimeouts(); vi.restoreAllMocks(); h.state.clearEmitter(); h.cleanup(); });

describe('docs-literal-replace instantiation', () => {
  it('self-registers and instantiates one ordinary step bound to the committed bytes (DoD1, DoD2)', async () => {
    expect(recipeKinds.get('docs-literal-replace')).toBe(kind);
    const outcome = await run();
    const t = task(); const oid = git('rev-parse', 'HEAD:docs/a.md');
    expect(outcome).toEqual({ instantiated: true, status: 'WORKING', planRevision: t.planRevision });
    expect(t.implementationPlan).toEqual([{ stepId: 'step-1', status: 'PENDING', description: expect.any(String), affectedFiles: ['docs/a.md'] }]);
    for (const text of ['"old link"', '"new link"', sha(AFTER), 'change nothing else', 'error handling', 'moe.report_blocked', 'test: npm run lint']) {
      expect(t.implementationPlan[0].description).toContain(text);
    }
    expect(t.executionContract).toEqual({ intendedBehavior: expect.stringContaining('docs/a.md'),
      acceptanceCriteria: [expect.stringContaining(sha(AFTER)), 'No path other than docs/a.md changes.'],
      approvedScope: ['docs/a.md'], sourceAssumptions: [expect.stringMatching(new RegExp(`${head}.*${oid}.*${sha(DOC)}.*offset 17`))],
      checkRefs: ['npm run lint'], requiredChecks: [{ id: 'docs', command: 'npm run lint', configs: [DEFS] }] });
    expect(readRecipeInstance(t)).toEqual({ version: 1, recipeId: 'docs-fix', kind: 'docs-literal-replace', recipeVersion: 1,
      definitionDigest: recipeDefinitionDigest(DEF), commit: head, inputs: INPUTS, inputsDigest: recipeInputsDigest(DEF, INPUTS),
      planRevision: t.planRevision });
  });

  it('keeps BOM and CRLF bytes exact', async () => {
    const doc = '\ufeffTitle\r\nold link\r\n';
    const at = commit({ 'docs/a.md': doc });
    expect(await kind.assessSource(h.testDir, at, { ...INPUTS, originalSha256: sha(doc) })).toEqual({ ok: true,
      assessment: { oid: git('rev-parse', 'HEAD:docs/a.md'), offset: 8, expectedSha256: sha('\ufeffTitle\r\nnew link\r\n') } });
    expect(await kind.assessSource(h.testDir, 'f'.repeat(40), INPUTS)).toEqual(refused('docs-replace-source-unavailable'));
  });

  const { newText: _newText, ...withoutNew } = INPUTS;
  const big = '\u0001'.repeat(2000);
  type Row = [reason: string, arrange: () => unknown, inputs?: Record<string, unknown>];
  const rows: Row[] = [
    // DoD1: committed bytes only, and exactly one (possibly overlapping) occurrence.
    ['docs-replace-hash-mismatch', () => undefined, { ...INPUTS, originalSha256: sha('other') }],
    ['docs-replace-hash-mismatch', () => fs.writeFileSync(path.join(h.testDir, 'docs/a.md'), 'old link'), { ...INPUTS, originalSha256: sha('old link') }],
    ['docs-replace-old-text-missing', () => undefined, { ...INPUTS, oldText: 'absent' }],
    ['docs-replace-old-text-ambiguous', () => commit({ 'docs/a.md': 'aaa\n' }), { ...INPUTS, originalSha256: sha('aaa\n'), oldText: 'aa', newText: 'b' }],
    ['docs-replace-old-text-ambiguous', () => commit({ 'docs/a.md': 'old link, old link' }), { ...INPUTS, originalSha256: sha('old link, old link') }],
    ['docs-replace-source-unavailable', () => undefined, { ...INPUTS, path: 'docs/b.md' }],
    ['docs-replace-source-unavailable', () => commit({}, symlinkAt('docs/a.md'))],
    ['docs-replace-source-unavailable', () => commit({}, () => git('update-index', '--chmod=+x', 'docs/a.md'))],
    ['docs-replace-source-unavailable', () => commit({ 'docs/a.md': 'old link\0' }), { ...INPUTS, originalSha256: sha('old link\0') }],
    ['docs-replace-source-unavailable', () => commit({ 'docs/a.md': Buffer.from([0x6f, 0xff]) }), { ...INPUTS, originalSha256: sha(Buffer.from([0x6f, 0xff])) }],
    ['docs-replace-source-unavailable', () => commit({ 'docs/a.md': `old link${'x'.repeat(65536)}` }), { ...INPUTS, originalSha256: sha(`old link${'x'.repeat(65536)}`) }],
    // A 64 KiB file fits; its patched bytes would not, so the post-patch check could never read them.
    ['docs-replace-source-unavailable', () => commit({ 'docs/a.md': `old link${'x'.repeat(65528)}` }),
      { ...INPUTS, originalSha256: sha(`old link${'x'.repeat(65528)}`), newText: 'new links' }],
    // DoD2: the definition supplies allowedPaths; requiredChecks are the framework's (C08 refuses an empty list).
    ...[undefined, {}, { allowedPaths: [] }, { allowedPaths: 'docs' }, { allowedPaths: ['./docs'] }, { allowedPaths: ['docs/'] },
      { allowedPaths: ['.moe/roles'] }, { allowedPaths: ['.MOE'] }, { allowedPaths: Array.from({ length: 17 }, (_, i) => `d${i}`) },
      { allowedPaths: ['docs'], extra: 1 }].map((params): Row => ['docs-replace-definition-invalid', () => commit({ [DEFS]: recipes({ ...DEF, params }) })]),
    ...[withoutNew, { ...INPUTS, extra: 'x' }, { ...INPUTS, newText: 5 }, { ...INPUTS, originalSha256: sha(DOC).toUpperCase() },
      { ...INPUTS, originalSha256: 'ab' }, { ...INPUTS, oldText: '' }, { ...INPUTS, oldText: 'o'.repeat(2001) },
      { ...INPUTS, newText: 'n'.repeat(2001) }, { ...INPUTS, oldText: 'old\0link' }, { ...INPUTS, newText: 'new\0' },
      { ...INPUTS, newText: 'old link' }, { ...INPUTS, path: 'docs/../a.md' }, { ...INPUTS, path: './docs/a.md' },
      { ...INPUTS, path: 'docs/\u0007.md' }].map((inputs): Row => ['docs-replace-inputs-invalid', () => undefined, inputs]),
    ...['other/a.md', 'docsx/a.md', '.moe/a.md', 'docs/a.txt', 'docs/a.MD'].map((p): Row => ['docs-replace-path-not-allowed', () => undefined, { ...INPUTS, path: p }]),
    // Refuse rather than truncate a step that cannot hold the quoted literal.
    ['docs-replace-plan-too-large', () => commit({ 'docs/a.md': big }), { ...INPUTS, originalSha256: sha(big), oldText: big }],
  ];
  it.each(rows)('falls back to ordinary planning with %s', async (reason, arrange, inputs) => {
    await arrange();
    expect(await run(inputs)).toEqual(fellBack(reason));
    expect([task().status, task().implementationPlan, task().recipeInstance]).toEqual(['PLANNING', [], undefined]);
  });
});

describe('docs-literal-replace assessPostpatch (DoD3)', () => {
  let instance: RecipeInstance;
  beforeEach(async () => { await run(); instance = readRecipeInstance(task())!; });
  type Ctx = Partial<{ instance: RecipeInstance; definition: RecipeDefinition }>;
  const assess = (postCommit: string, ctx: Ctx = {}) =>
    kind.assessPostpatch(h.testDir, { taskId: 'task-1', instance, definition: DEF, postCommit, ...ctx });
  const patched = () => commit({ 'docs/a.md': AFTER });
  type Row = [expected: object, arrange: () => string, ctx?: () => Ctx];
  const rows: Row[] = [
    [{ ok: true }, patched],
    [{ ok: true }, () => commit({ 'docs/a.md': AFTER }, [BOARD])],
    [refused('docs-replace-extra-edits', 'docs/b.md'), () => commit({ 'docs/a.md': AFTER, 'docs/b.md': 'x\n' })],
    [refused('docs-replace-extra-edits', DEFS), () => commit({ 'docs/a.md': AFTER, [DEFS]: recipes({ ...DEF, version: 2 }) })],
    [refused('docs-replace-extra-edits', '.moe/tasks/task-2.json'), () => commit({ 'docs/a.md': AFTER, '.moe/tasks/task-2.json': '{}' })],
    [refused('docs-replace-extra-edits', 'docs/b.md'), () => commit({ 'docs/b.md': 'x\n' })],
    [refused('docs-replace-postpatch-mismatch'), () => commit({ 'docs/a.md': `${AFTER}more\n` })],
    [refused('docs-replace-postpatch-mismatch'), () => commit({ 'docs/a.md': AFTER }, () => git('update-index', '--chmod=+x', 'docs/a.md'))],
    [refused('docs-replace-postpatch-mismatch'), () => commit({ 'docs/a.md': AFTER }, symlinkAt('docs/a.md'))],
    [refused('docs-replace-postpatch-mismatch'), () => commit({}, () => git('rm', '-q', '--cached', 'docs/a.md'))],
    [refused('docs-replace-patch-missing'), () => commit({})],
    [refused('docs-replace-patch-missing'), () => commit({}, [BOARD])],
    [refused('docs-replace-postpatch-unavailable'), () => 'f'.repeat(40)],
    [refused('docs-replace-postpatch-unavailable'), () => 'HEAD'],
    [refused('docs-replace-postpatch-unavailable'), () => git('rev-parse', 'HEAD^{tree}')],
    [refused('docs-replace-inputs-changed'), patched, () => ({ instance: { ...instance, inputs: { ...instance.inputs, newText: 'newer link' } } })],
    [refused('docs-replace-inputs-changed'), patched, () => ({ instance: { ...instance, inputsDigest: 'a'.repeat(64) } })],
    // A record whose inputs (digest included) no longer describe its own commit.
    [refused('docs-replace-postpatch-mismatch'), patched, () => {
      const inputs = { ...INPUTS, originalSha256: sha('other') };
      return { instance: { ...instance, inputs, inputsDigest: recipeInputsDigest(DEF, inputs) } };
    }],
    ...[{ ...DEF, version: 2 }, { ...DEF, id: 'other' }, { ...DEF, kind: 'other' }, { ...DEF, params: { allowedPaths: ['docs', 'guides'] } }]
      .map((definition): Row => [refused('docs-replace-recipe-mismatch'), patched, () => ({ definition })]),
  ];
  it.each(rows)('answers %o', async (expected, arrange, ctx) => {
    expect(await assess(arrange(), ctx?.())).toEqual(expected);
  });

  it('never throws', async () => {
    await expect(kind.assessPostpatch(h.testDir, null as never)).resolves.toEqual(refused('docs-replace-postpatch-unavailable'));
    await expect(kind.assessPostpatch(path.join(h.testDir, 'missing'), { taskId: 'task-1', instance, definition: DEF, postCommit: patched() }))
      .resolves.toEqual(refused('docs-replace-postpatch-unavailable'));
  });
});
