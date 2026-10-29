import { describe, expect, it } from 'vitest';
import { MoeErrorCode } from '../util/errors.js';
import { evaluateArchitecture, extractImports, parseArchitectureRules, resolveImport } from './architectureRules.js';

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'state-no-tools', from: ['src/state'], forbid: ['src/tools'], reason: 'state must not reach tools', ...over,
});
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, rules: [rule()], ...over });
const withRule = (over: Record<string, unknown>) => doc({ rules: [rule(over)] });
const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

const refusal = (field: string) => ({ code: MoeErrorCode.INVALID_INPUT, codeName: 'INVALID_INPUT', context: { field } });

describe('parseArchitectureRules', () => {
  it('P1 returns a fresh canonical document in the documented key order', () => {
    const text = JSON.stringify({
      rules: [
        { reason: 'state must not reach tools', forbid: ['src/tools'], from: ['src/state'], id: 'state-no-tools' },
        { id: 'ui.no_db', from: ['src/ui', 'src/web'], forbid: ['src/db'], reason: 'ui goes through the api' },
      ],
      version: 1,
    });
    const parsed = parseArchitectureRules(text);
    expect(parsed).toStrictEqual({
      version: 1,
      rules: [
        { id: 'state-no-tools', from: ['src/state'], forbid: ['src/tools'], reason: 'state must not reach tools' },
        { id: 'ui.no_db', from: ['src/ui', 'src/web'], forbid: ['src/db'], reason: 'ui goes through the api' },
      ],
    });
    expect(Object.keys(parsed)).toEqual(['version', 'rules']);
    expect(parsed.rules.map(r => Object.keys(r))).toEqual([
      ['id', 'from', 'forbid', 'reason'], ['id', 'from', 'forbid', 'reason'],
    ]);
  });

  it('P2 accepts every documented limit exactly', () => {
    const prefixes = many(32, i => `src/p${i}`);
    const rules = many(100, i => ({
      id: i === 0 ? 'a'.repeat(64) : `r${i}`, from: prefixes, forbid: prefixes, reason: 'x'.repeat(300),
    }));
    const parsed = parseArchitectureRules(JSON.stringify({ version: 1, rules }));
    expect(parsed).toStrictEqual({ version: 1, rules });
    expect(parsed.rules[0]?.id).toHaveLength(64);
  });

  it.each([
    ['invalid JSON', '{"version":1,', 'architectureRules'],
    ['a non-string text', 42, 'architectureRules'],
    ['a root array', '[]', 'architectureRules'],
    ['a root null', 'null', 'architectureRules'],
    ['version 2', doc({ version: 2 }), 'version'],
    ["version '1'", doc({ version: '1' }), 'version'],
    ['version missing', doc({ version: undefined }), 'version'],
    ['an extra top-level key', doc({ extra: true }), 'extra'],
    ['rules missing', doc({ rules: undefined }), 'rules'],
    ['rules not an array', doc({ rules: {} }), 'rules'],
    ['rules empty', doc({ rules: [] }), 'rules'],
    ['101 rules', doc({ rules: many(101, i => rule({ id: `r${i}` })) }), 'rules'],
    ['a string rule', doc({ rules: ['x'] }), 'rules[0]'],
    ['a null rule', doc({ rules: [null] }), 'rules[0]'],
    ['an array rule', doc({ rules: [[]] }), 'rules[0]'],
    ['an extra rule key', withRule({ severity: 'high' }), 'rules[0].severity'],
    ['id missing', withRule({ id: undefined }), 'rules[0].id'],
    ['id uppercase', withRule({ id: 'State' }), 'rules[0].id'],
    ["id with a leading '-'", withRule({ id: '-state' }), 'rules[0].id'],
    ['id of 65 characters', withRule({ id: 'a'.repeat(65) }), 'rules[0].id'],
    ['a duplicate id', doc({ rules: [rule(), rule({ from: ['src/ui'] })] }), 'rules[1].id'],
    ['from missing', withRule({ from: undefined }), 'rules[0].from'],
    ['from empty', withRule({ from: [] }), 'rules[0].from'],
    ['from of 33 entries', withRule({ from: many(33, i => `src/p${i}`) }), 'rules[0].from'],
    ['forbid empty', withRule({ forbid: [] }), 'rules[0].forbid'],
    ['forbid of 33 entries', withRule({ forbid: many(33, i => `src/p${i}`) }), 'rules[0].forbid'],
    ['a trailing-slash prefix', withRule({ from: ['src/state/'] }), 'rules[0].from[0]'],
    ["a './' prefix", withRule({ from: ['./src'] }), 'rules[0].from[0]'],
    ['a backslash prefix', withRule({ from: ['src\\state'] }), 'rules[0].from[0]'],
    ['a doubled-slash prefix', withRule({ from: ['src//state'] }), 'rules[0].from[0]'],
    ['a space-padded prefix', withRule({ from: [' src'] }), 'rules[0].from[0]'],
    ['a traversal prefix', withRule({ from: ['../x'] }), 'rules[0].from[0]'],
    ['an absolute prefix', withRule({ from: ['/abs'] }), 'rules[0].from[0]'],
    ['a drive-letter prefix', withRule({ from: ['C:/x'] }), 'rules[0].from[0]'],
    ['an empty prefix', withRule({ from: [''] }), 'rules[0].from[0]'],
    ['a numeric prefix', withRule({ from: [7] }), 'rules[0].from[0]'],
    ['a bad forbid entry at index 1', withRule({ forbid: ['src/tools', './bad'] }), 'rules[0].forbid[1]'],
    ['reason missing', withRule({ reason: undefined }), 'rules[0].reason'],
    ['reason empty', withRule({ reason: '' }), 'rules[0].reason'],
    ['reason of 301 units', withRule({ reason: 'x'.repeat(301) }), 'rules[0].reason'],
    ['a non-string reason', withRule({ reason: 42 }), 'rules[0].reason'],
  ] as [string, unknown, string][])('P3 refuses %s naming its field', (_label, text, field) => {
    expect(thrown(() => parseArchitectureRules(text as string))).toMatchObject(refusal(field));
  });
});

const src = (...lines: string[]) => lines.join('\n');
const ref = (line: number, specifier: string) => ({ line, specifier });
const dyn = (line: number) => ({ line, reason: 'dynamic-import' });
const req = (line: number) => ({ line, reason: 'non-literal-require' });
const none = { imports: [], uncertain: [] };

describe('extractImports', () => {
  it('X1 finds every static, side-effect, re-export and type-only form with its line', () => {
    const text = src(
      "import a from './a';",
      'import { b } from "./b";',
      "import * as c from './c';",
      "import d, { e } from './d';",
      'import {',
      '  f,',
      '  g,',
      "} from './fg';",
      "import type { T } from './t';",
      "import { type U, V } from './uv';",
      "import './side';",
      "export * from './all';",
      "export * as ns from './ns';",
      "export { h as i } from './h';",
      "export type { W } from './w';",
      "export { 'a-b' as ab } from './s';",
      "export { import } from './kw';",
    );
    expect(extractImports(text)).toStrictEqual({
      imports: [
        ref(1, './a'), ref(2, './b'), ref(3, './c'), ref(4, './d'), ref(8, './fg'), ref(9, './t'), ref(10, './uv'),
        ref(11, './side'), ref(12, './all'), ref(13, './ns'), ref(14, './h'), ref(15, './w'), ref(16, './s'), ref(17, './kw'),
      ],
      uncertain: [],
    });
  });

  it('X2 finds literal dynamic imports and requires', () => {
    const text = src(
      "const a = await import('./a.js');",
      'const b = import(`./b.js`);',
      "const d = import('./d.json', { with: { type: 'json' } });",
      "const r = require('./r');",
      'const s = require(`./s`);',
      "let t: import('./types.js').T;",
      "const o = require?.('./opt');",
      "import x = require('./ts-eq');",
    );
    expect(extractImports(text)).toStrictEqual({
      imports: [
        ref(1, './a.js'), ref(2, './b.js'), ref(3, './d.json'), ref(4, './r'), ref(5, './s'), ref(6, './types.js'),
        ref(7, './opt'), ref(8, './ts-eq'),
      ],
      uncertain: [],
    });
  });

  it.each([
    ['import(name)', 'const m = import(name);', { imports: [], uncertain: [dyn(1)] }],
    ['a concatenated import()', src('const x = 1;', "import('./a' + b);"), { imports: [], uncertain: [dyn(2)] }],
    ['a substituted template import()', 'import(`./locale/${lang}.js`);', { imports: [], uncertain: [dyn(1)] }],
    ['a multi-line import()', src('', 'import(', '  name', ');'), { imports: [], uncertain: [dyn(2)] }],
    ['require(dep)', src('', '', 'require(dep);'), { imports: [], uncertain: [req(3)] }],
    ['a concatenated require()', "require('./a' + b);", { imports: [], uncertain: [req(1)] }],
    ['a require( at EOF', 'require(', { imports: [], uncertain: [req(1)] }],
    ['a literal require inside ${}', "const s = `${require('./inner')}`;", { imports: [ref(1, './inner')], uncertain: [] }],
  ])('X3 surfaces %s', (_label, text, expected) => {
    expect(extractImports(text)).toStrictEqual(expected);
  });

  it.each([
    ['line comments', src("// import a from './a'", "// require('./b')"), none],
    ['a multi-line block comment', src('/* one', "import a from './a'", '*/', "require('./r');"), { imports: [ref(4, './r')], uncertain: [] }],
    ['an unterminated block comment', src('/* never closed', "require('./x')"), none],
    ['a JSDoc import type', src("/** @type {import('./doc.js').T} */", 'let t;'), none],
    ['import text in quoted strings', `const s = "import a from './a'"; const q = 'require("./b")';`, none],
    ['import text in template text', "const s = `import a from './a' require('./b') import(x)`;", none],
    ['a regex literal holding import text', "const re = /import x from 'y'/;", none],
    ['member calls', "obj.import('./m'); obj.require('./m'); obj?.require('./m'); this.#require('./m');", none],
    ['import.meta and require.resolve', "const u = import.meta.url; const p = require.resolve('./r');", none],
    ['import and require as object keys', 'const o = { import: 1, require: 2 };', none],
    ['an uncalled require', "if (typeof require === 'function') x = require;", none],
  ])('X4 finds nothing in %s', (_label, text, expected) => {
    expect(extractImports(text)).toStrictEqual(expected);
  });

  it.each([
    ['a quote inside a regex class', "const re = /[']/; import a from './a';", [ref(1, './a')]],
    ['a slash inside a regex class', "const re = /[/']/; import a from './a';", [ref(1, './a')]],
    ['a regex after a control head', "if (ok) /'/.test(s); require('./after-if');", [ref(1, './after-if')]],
    ['chained division', "const x = a / b / c; require('./r');", [ref(1, './r')]],
    ['a division after a call', "const x = f(a) / 2; require('./r'); const y = 1 / 2;", [ref(1, './r')]],
    ['a spread', "f(...require('./spread'));", [ref(1, './spread')]],
    ['an escaped require identifier', "\\u0072equire('./esc'); \\u{69}mport('./esc2');", [ref(1, './esc'), ref(1, './esc2')]],
    ['a hex-escaped specifier', "require('\\x2e\\x2e/tools/t.js');", [ref(1, '../tools/t.js')]],
    ['a legacy-octal specifier', "require('\\056\\056/tools/t.js'); require('\\08\\1010');", [ref(1, '../tools/t.js'), ref(1, '\u00008A0')]],
    ['a regex holding // and a backtick', "const re = /\\/\\/`/; require('./x');", [ref(1, './x')]],
    ['a regex class holding //', "const re = /[//]/; require('./y');", [ref(1, './y')]],
    ['a unicode-escaped specifier', "import a from '\\u002e/\\u{61}';", [ref(1, './a')]],
    ['U+2028 ending a line comment', "// note\u2028require('./after');", [ref(2, './after')]],
    ['U+2029 inside a string', "const s = '\u2029'; require('./x');", [ref(2, './x')]],
    ['CRLF and lone CR input', "// a\r\nimport a from './a';\r\n\r\nrequire('./r');\rrequire('./cr');", [ref(2, './a'), ref(4, './r'), ref(5, './cr')]],
    ['a string line continuation', "const s = 'a\\\nb';\nrequire('./x');", [ref(3, './x')]],
    ['an unterminated string', src("const s = 'oops", "import a from './a';"), [ref(2, './a')]],
    ['a hashbang first line', src("#!/usr/bin/env node require('./no')", "require('./cli');"), [ref(2, './cli')]],
    ['nested templates', "const s = `${ `${ require('./deep') }` }`;", [ref(1, './deep')]],
    ['braces inside a substitution', "const s = `a${ { b: 1 }.b }${ require('./c') }`;", [ref(1, './c')]],
    ['a template line count', src('const s = `one', 'two`;', "require('./t');"), [ref(3, './t')]],
  ])('X5 survives %s', (_label, text, imports) => {
    expect(extractImports(text)).toStrictEqual({ imports, uncertain: [] });
  });

  it.each(['', '`${', "'", '/*', '/[', '\\', '\\u{', '\\7', '`', 'x = /'])('X5 returns for the bare fragment %j', text => {
    expect(extractImports(text)).toStrictEqual(none);
  });
});

describe('extractImports on pathological input', () => {
  it.each([
    ['a 300 KB line of failed regex scans', '+/['.repeat(100_000), none],
    ['100k nested template substitutions', '`${'.repeat(100_000) + "require('./deep')", { imports: [ref(1, './deep')], uncertain: [] }],
    ['200k chained import keywords', 'import '.repeat(200_000) + "x from './a'", { imports: [ref(1, './a')], uncertain: [] }],
    ['a 1 MB identifier', 'a'.repeat(1_000_000), none],
    ['a 1 MB unterminated string', `'${'x'.repeat(1_000_000)}`, none],
    ['300k failed brace escapes', `'${'\\u{'.repeat(300_000)}`, none],
  ])('X6 stays linear on %s', (_label, text, expected) => {
    expect(extractImports(text)).toStrictEqual(expected);
  });

  it('X6 never throws and keeps every reported line inside the text', () => {
    const alphabet = ["'", '"', '`', '/', '\\', '*', '{', '}', '${', '(', ')', '[', ']', '\n', '\r', '\u2028', ' ', '.', '?', '#',
      'x', '0', 'u', 'import', 'require', 'from', "'./a'"];
    let seed = 7;
    const pick = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    let reported = 0;
    for (let run = 0; run < 3000; run++) {
      const text = Array.from({ length: 1 + pick(60) }, () => alphabet[pick(alphabet.length)]).join('');
      const lines = text.split(/\r\n|[\n\r\u2028\u2029]/).length;
      const { imports, uncertain } = extractImports(text);
      for (const entry of [...imports, ...uncertain]) {
        reported++;
        expect(entry.line).toBeGreaterThanOrEqual(1);
        expect(entry.line).toBeLessThanOrEqual(lines);
      }
    }
    expect(reported).toBeGreaterThan(100);
  });
});

describe('resolveImport', () => {
  it.each([
    ["'.js' to '.ts' over an existing '.js'", 'src/a.ts', './b.js', ['src/b.ts', 'src/b.js'], 'src/b.ts'],
    ["'.js' to '.tsx'", 'src/a.ts', './c.js', ['src/c.tsx', 'src/c.js'], 'src/c.tsx'],
    ["'.js' to itself", 'src/a.ts', './d.js', ['src/d.js', 'src/d.mjs'], 'src/d.js'],
    ["'.js' to '.mjs'", 'src/a.ts', './e.js', ['src/e.mjs'], 'src/e.mjs'],
    ['a directory to its index', 'src/a.ts', './dir', ['src/dir/index.ts'], 'src/dir/index.ts'],
    ['an extensionless file', 'src/a.ts', './b', ['src/b.ts', 'src/b/index.ts'], 'src/b.ts'],
    ['an exact path first', 'src/a.ts', './b', ['src/b', 'src/b.ts'], 'src/b'],
    ['an exact non-JS file', 'src/a.ts', './data.json', ['src/data.json'], 'src/data.json'],
    ["'..' to the parent index", 'src/x/a.ts', '..', ['src/index.ts'], 'src/index.ts'],
    ['a climbing path', 'src/x/a.ts', '../x/y.js', ['src/x/y.ts'], 'src/x/y.ts'],
    ['the repo root to its index only', 'a/b.ts', '..', ['.ts', 'index.ts'], 'index.ts'],
    ['an escape past the root', 'a/b.ts', '../../x.js', ['x.ts'], null],
    ['a bare package', 'src/a.ts', 'vitest', ['vitest', 'src/vitest.ts'], null],
    ['a node: builtin', 'src/a.ts', 'node:fs', ['node:fs'], null],
    ['a scoped package', 'src/a.ts', '@s/p', ['@s/p'], null],
    ['a non-relative alias', 'src/a.ts', 'src/tools/t.js', ['src/tools/t.ts'], null],
    ['an absolute path', 'src/a.ts', '/src/tools/t.js', ['src/tools/t.ts'], null],
    ['an unmatched relative', 'src/a.ts', './nope.js', ['src/nope.json'], null],
    ['a case mismatch', 'src/a.ts', './B.js', ['src/b.ts'], null],
    ['a backslash-separated relative', 'src/state/s.ts', '..\\tools\\t.js', ['src/tools/t.ts'], 'src/tools/t.ts'],
  ] as [string, string, string, string[], string | null][])('V1 resolves %s', (_label, from, specifier, tree, expected) => {
    expect(resolveImport(from, specifier, new Set(tree))).toBe(expected);
  });
});

const rulesOf = (...list: object[]) => parseArchitectureRules(JSON.stringify({ version: 1, rules: list }));
const stateRule = { id: 'state-no-tools', from: ['src/state'], forbid: ['src/tools'], reason: 'state stays below tools' };
const uiRule = { id: 'ui-no-db', from: ['src/ui'], forbid: ['src/db'], reason: 'ui goes through the api' };
const tree = new Set(['src/tools/t.ts', 'src/db/q.ts', 'src/state/local.ts']);
const passed = (selectedRules: string[]) => ({ outcome: 'passed', selectedRules, violations: [], uncertain: [] });

describe('evaluateArchitecture', () => {
  it('V2 selects only rules whose from covers a changed path by whole segments', () => {
    const rules = rulesOf(stateRule, uiRule);
    const tools = "import { t } from '../tools/t.js';";
    expect(evaluateArchitecture(rules, [{ path: 'docs/a.md', text: tools }], tree)).toStrictEqual(passed([]));
    expect(evaluateArchitecture(rules, [{ path: 'src/statement.ts', text: "import t from './tools/t.js';" }], tree))
      .toStrictEqual(passed([]));
    expect(evaluateArchitecture(rules, [{ path: 'src/ui/v.ts', text: '' }], tree)).toStrictEqual(passed(['ui-no-db']));
    expect(evaluateArchitecture(rules, [{ path: 'src/state/README.md', text: tools }], tree))
      .toStrictEqual(passed(['state-no-tools']));
    expect(evaluateArchitecture(rules, [], tree)).toStrictEqual(passed([]));
  });

  it('V3 reports a forbidden resolved import with rule, file and line', () => {
    const text = src("import { a } from './local.js';", "import { t } from '../tools/t.js';");
    const result = evaluateArchitecture(rulesOf(stateRule), [{ path: 'src/state/s.ts', text }], tree);
    expect(result).toStrictEqual({
      outcome: 'failed',
      selectedRules: ['state-no-tools'],
      violations: [{ ruleId: 'state-no-tools', file: 'src/state/s.ts', line: 2, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' }],
      uncertain: [],
    });
    expect(Object.keys(result)).toEqual(['outcome', 'selectedRules', 'violations', 'uncertain']);
    expect(Object.keys(result.violations[0] ?? {})).toEqual(['ruleId', 'file', 'line', 'specifier', 'resolved']);
  });

  it("V4 applies a rule's forbid only inside its own from", () => {
    const changed = [
      { path: 'src/state/x.ts', text: "import q from '../db/q.js';" },
      { path: 'src/ui/v.ts', text: "import t from '../tools/t.js';" },
    ];
    expect(evaluateArchitecture(rulesOf(stateRule, uiRule), changed, tree)).toStrictEqual(passed(['state-no-tools', 'ui-no-db']));
  });

  it('V5 surfaces dynamic, non-literal and unresolved-relative uncertainty', () => {
    const text = src('import(name);', 'require(dep);', "import m from './missing.js';", "import v from 'vitest';");
    const result = evaluateArchitecture(rulesOf(stateRule), [{ path: 'src/state/a.ts', text }], new Set());
    expect(result).toStrictEqual({
      outcome: 'inconclusive',
      selectedRules: ['state-no-tools'],
      violations: [],
      uncertain: [
        { file: 'src/state/a.ts', line: 1, reason: 'dynamic-import' },
        { file: 'src/state/a.ts', line: 2, reason: 'non-literal-require' },
        { file: 'src/state/a.ts', line: 3, reason: 'unresolved-relative' },
      ],
    });
    expect(Object.keys(result.uncertain[0] ?? {})).toEqual(['file', 'line', 'reason']);
  });

  it('V6 ranks failed over inconclusive over passed', () => {
    const rules = rulesOf(stateRule);
    const both = [{ path: 'src/state/s.ts', text: src("import t from '../tools/t.js';", 'import(name);') }];
    expect(evaluateArchitecture(rules, both, tree)).toStrictEqual({
      outcome: 'failed',
      selectedRules: ['state-no-tools'],
      violations: [{ ruleId: 'state-no-tools', file: 'src/state/s.ts', line: 1, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' }],
      uncertain: [{ file: 'src/state/s.ts', line: 2, reason: 'dynamic-import' }],
    });
    expect(evaluateArchitecture(rules, [{ path: 'src/state/s.ts', text: 'import(name);' }], tree).outcome).toBe('inconclusive');
    expect(evaluateArchitecture(rules, [{ path: 'src/state/s.ts', text: "import a from './local.js';" }], tree).outcome)
      .toBe('passed');
  });

  it('V7 orders output by code unit, independent of input order', () => {
    const twin = { ...stateRule, id: 'a-state' };
    const changed = [
      { path: 'src/state/b.ts', text: src('import(x);', "import t from '../tools/t.js';", "import u from './gone.js';") },
      { path: 'src/state/B.ts', text: src("import t from '../tools/t.js';", "import q from '../tools/t.js';") },
      { path: 'src/ui/v.mjs', text: "import q from '../db/q.js'; require(dep);" },
      { path: 'docs/x.md', text: '' },
    ];
    const forward = evaluateArchitecture(rulesOf(stateRule, uiRule, twin), changed, tree);
    const reordered = [changed[2], changed[3], changed[1], changed[0]];
    const shuffled = evaluateArchitecture(rulesOf(uiRule, twin, stateRule), reordered, tree);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(forward));
    const v = (ruleId: string, file: string, line: number, specifier: string, resolved: string) =>
      ({ ruleId, file, line, specifier, resolved });
    expect(forward).toStrictEqual({
      outcome: 'failed',
      selectedRules: ['a-state', 'state-no-tools', 'ui-no-db'],
      violations: [
        v('a-state', 'src/state/B.ts', 1, '../tools/t.js', 'src/tools/t.ts'),
        v('state-no-tools', 'src/state/B.ts', 1, '../tools/t.js', 'src/tools/t.ts'),
        v('a-state', 'src/state/B.ts', 2, '../tools/t.js', 'src/tools/t.ts'),
        v('state-no-tools', 'src/state/B.ts', 2, '../tools/t.js', 'src/tools/t.ts'),
        v('a-state', 'src/state/b.ts', 2, '../tools/t.js', 'src/tools/t.ts'),
        v('state-no-tools', 'src/state/b.ts', 2, '../tools/t.js', 'src/tools/t.ts'),
        v('ui-no-db', 'src/ui/v.mjs', 1, '../db/q.js', 'src/db/q.ts'),
      ],
      uncertain: [
        { file: 'src/state/b.ts', line: 1, reason: 'dynamic-import' },
        { file: 'src/state/b.ts', line: 3, reason: 'unresolved-relative' },
        { file: 'src/ui/v.mjs', line: 1, reason: 'non-literal-require' },
      ],
    });
  });

  it('V9 scans .d.ts and every listed extension, and nothing else', () => {
    const tools = "import type { T } from '../tools/t.js';";
    const changed = ['a.d.ts', 'b.cjs', 'c.tsx', 'd.mts', 'e.jsx', 'f.TS', 'g.json'].map(name => ({ path: `src/state/${name}`, text: tools }));
    const result = evaluateArchitecture(rulesOf(stateRule), changed, tree);
    expect(result.outcome).toBe('failed');
    expect(result.violations.map(f => f.file)).toEqual(['src/state/a.d.ts', 'src/state/b.cjs', 'src/state/c.tsx']);
  });

  it.each([
    ["a './' path", [{ path: './src/a.ts', text: '' }], 'changed[0].path'],
    ['a backslash path', [{ path: 'src\\a.ts', text: '' }], 'changed[0].path'],
    ['an absolute path', [{ path: '/src/a.ts', text: '' }], 'changed[0].path'],
    ['a duplicate path', [{ path: 'src/a.ts', text: '' }, { path: 'src/a.ts', text: '' }], 'changed[1].path'],
  ])('V8 refuses %s naming its field', (_label, changed, field) => {
    expect(thrown(() => evaluateArchitecture(rulesOf(stateRule), changed, tree))).toMatchObject(refusal(field));
  });
});
