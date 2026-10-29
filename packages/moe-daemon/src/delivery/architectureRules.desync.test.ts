import { describe, expect, it } from 'vitest';
import { evaluateArchitecture, extractImports, parseArchitectureRules } from './architectureRules.js';

// A lexing misread (regex versus division, Annex-B or JSX syntax) can flip
// template or block-comment state for every LATER line. These pin the
// fail-safe re-scan: such a hidden line surfaces as 'ambiguous-syntax'
// uncertainty instead of passing silently (task-16628bef).

const src = (...lines: string[]) => lines.join('\n');
const ref = (line: number, specifier: string) => ({ line, specifier });
const amb = (line: number) => ({ line, reason: 'ambiguous-syntax' });
const none = { imports: [], uncertain: [] };
const REQ = "const t = require('../tools/t.js');";

const DIVISION_AS_REGEX = ['const a = {} / 1, b = `/;', '`;', REQ, '// `'];
const REGEX_AFTER_EXTENDS = ['class A extends /`/.constructor {}', REQ, '// `'];
const HTML_OPEN_COMMENT = ['<!-- `', REQ, '// `'];

const HIDDEN: [string, string, number][] = [
  ['a division read as a regex that eats a backtick', src(...DIVISION_AS_REGEX), 3],
  ['a regex after extends read as division', src(...REGEX_AFTER_EXTENDS), 2],
  ['an Annex-B <!-- comment', src(...HTML_OPEN_COMMENT), 2],
  ['a backtick in JSX text', src('const el = <p>Use ` here</p>;', REQ, '// `'), 2],
  ['a regex after export default holding /*', src('export default /\\/*/;', REQ, '// */'), 2],
  ['a non-null division read as a regex ending in a template', src('const r = a! / b; const p = `${x}/${y}`;', REQ, 'const q = `z`;'), 2],
  ['multi-line JSX text', src('const el = (', '  <p>', '    Use ` here', '  </p>', ');', REQ, '// `'), 6],
  ['an Annex-B --> comment', src('x = 1', '--> `', REQ, '// `'), 3],
  ["a regex swallowing a substitution's closing brace", src('const s = `${', '  a++ / 2}/x', '`;', REQ, '// `'), 4],
  ['a hidden line that starts with a star', src('export default /\\/*/;', 'x = 1', "* 0; require('../tools/t.js');", '// */'), 3],
  ["a regex swallowing a substitution's opening brace", src("const s = `${ {} / 1, f({ k: '/'", '}),', "require('../tools/t.js') }`;"), 3],
  ['a regex read as division exposing an opening brace', src('const s = `${ new (class extends /{/.constructor', ' {})() }', '`;', REQ, '// `'), 4],
];

describe('extractImports after a lexing ambiguity', () => {
  it.each(HIDDEN)('D1 flags the later line hidden by %s', (_label, text, line) => {
    expect(extractImports(text)).toStrictEqual({ imports: [], uncertain: [amb(line)] });
  });

  it.each([
    ['no risk point before a code-gen template', src('const gen = `', "import a from './a';", "const b = require('./b');", '`;'), none],
    ['no risk point before commented-out code',
      src('/*', "const legacy = require('./legacy');", '*/', "require('./r');"), { imports: [ref(4, './r')], uncertain: [] }],
    ['a risk point with no multi-line region',
      src('const x = {} / 2; const s = `${x}`;', "require('./r');"), { imports: [ref(2, './r')], uncertain: [] }],
    ['a region before the first risk point', src('const s = `', "import a from './a';", '`;', 'const x = {} / 2 + `y`;'), none],
    ['a hidden external-only line', src('class A extends /`/.constructor {}', "const fs = require('fs');", '// `'), none],
    ['a hidden dynamic import',
      src('class A extends /`/.constructor {}', 'const m = await import(name);', '// `'), { imports: [], uncertain: [amb(2)] }],
    ['several hidden lines',
      src('class A extends /`/.constructor {}', "require('../a'); require('../b');", "import c from './c';", '// `'),
      { imports: [], uncertain: [amb(2), amb(3)] }],
    ['single-line regions after a risk point',
      src('const el = <br>; const s = `x`; /* note */', "require('./r');"), { imports: [ref(2, './r')], uncertain: [] }],
    ['two regions sharing a line',
      src('export default /\\/*/;', "require('../a'); */ x = 1; /* require('../b');", '*/'), { imports: [], uncertain: [amb(2)] }],
  ])('D3 reports exactly on %s', (_label, text, expected) => {
    expect(extractImports(text)).toStrictEqual(expected);
  });

  it.each([
    ['CRLF', DIVISION_AS_REGEX.join('\r\n'), 3],
    ['U+2028', REGEX_AFTER_EXTENDS.join('\u2028'), 2],
    ['lone CR', HTML_OPEN_COMMENT.join('\r'), 2],
  ])('D4 numbers a hidden line exactly under %s', (_label, text, line) => {
    expect(extractImports(text)).toStrictEqual({ imports: [], uncertain: [amb(line)] });
  });

  it.each([
    ['a template', src('const a = {} / 1, b = `/;', '`;', REQ), 3],
    ['a block comment', src('export default /\\/*/;', REQ), 2],
  ])('D5 flags the last line of %s left open at EOF', (_label, text, line) => {
    expect(extractImports(text)).toStrictEqual({ imports: [], uncertain: [amb(line)] });
  });
});

const rules = parseArchitectureRules(JSON.stringify({
  version: 1, rules: [{ id: 'state-no-tools', from: ['src/state'], forbid: ['src/tools'], reason: 'r' }],
}));
const tree = new Set(['src/tools/t.ts']);
const file = 'src/state/s.ts';
const evaluate = (text: string) => evaluateArchitecture(rules, [{ path: file, text }], tree);
const violation = (line: number) => ({ ruleId: 'state-no-tools', file, line, specifier: '../tools/t.js', resolved: 'src/tools/t.ts' });

describe('evaluateArchitecture after a lexing ambiguity', () => {
  it.each(HIDDEN)('D2 is inconclusive on %s', (_label, text, line) => {
    expect(evaluate(text)).toStrictEqual({
      outcome: 'inconclusive', selectedRules: ['state-no-tools'], violations: [], uncertain: [{ file, line, reason: 'ambiguous-syntax' }],
    });
  });

  it('D2 fails the bare require an ambiguity would hide', () => {
    expect(evaluate(REQ)).toStrictEqual({ outcome: 'failed', selectedRules: ['state-no-tools'], violations: [violation(1)], uncertain: [] });
  });

  it('D2 still fails, listing the ambiguity, when a real violation is present', () => {
    const text = src("import t0 from '../tools/t.js';", 'class A extends /`/.constructor {}', REQ, '// `');
    expect(evaluate(text)).toStrictEqual({
      outcome: 'failed', selectedRules: ['state-no-tools'], violations: [violation(1)],
      uncertain: [{ file, line: 3, reason: 'ambiguous-syntax' }],
    });
  });
});

describe('the ambiguity re-scan on pathological input', () => {
  it.each([
    ['80k hazard-free slashes on one line', 'a/b;'.repeat(80_000)],
    ['100k block comments after a JSX-like <', '<p>\n' + '/*\n*/\n'.repeat(100_000)],
  ])('D6 stays linear on %s', (_label, text) => {
    expect(extractImports(text)).toStrictEqual(none);
  });

  it('D6 flags each of 20k hidden lines once, in order', () => {
    const text = '<p>\n`\n' + "require('../x');\n".repeat(20_000) + '`';
    expect(extractImports(text)).toStrictEqual({ imports: [], uncertain: Array.from({ length: 20_000 }, (_, k) => amb(k + 3)) });
  });

  it('D7 never throws, keeps every line in range and flags ambiguity in a seeded corpus', () => {
    const alphabet = ["'", '"', '`', '/', '\\', '*', '{', '}', '${', '(', ')', '[', ']', '\n', '\r', '\u2028', ' ', '.', '?', '#',
      'x', '0', 'u', 'import', 'require', 'from', "'./a'", '<', '!', '-', '>', 'p', "require('../a')"];
    let seed = 7;
    const pick = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    let flags = 0;
    for (let run = 0; run < 3000; run++) {
      const text = Array.from({ length: 1 + pick(60) }, () => alphabet[pick(alphabet.length)]).join('');
      const lines = text.split(/\r\n|[\n\r\u2028\u2029]/).length;
      const { imports, uncertain } = extractImports(text);
      for (const entry of [...imports, ...uncertain]) {
        expect(entry.line).toBeGreaterThanOrEqual(1);
        expect(entry.line).toBeLessThanOrEqual(lines);
      }
      flags += uncertain.filter(entry => entry.reason === 'ambiguous-syntax').length;
    }
    expect(flags).toBeGreaterThan(0);
  });
});
