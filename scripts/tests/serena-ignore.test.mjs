// scripts/moe-serena-ignore.mjs: the Serena ignore override (task-c6a24053).
// U rows test the pure core against Serena 1.6.2's own output. F rows run the
// real CLI against throwaway git repositories under os.tmpdir().
// Non-ASCII characters are written as \u{...} escapes, never raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertGitignore, parseIgnoredPaths, renderBlock } from '../moe-serena-ignore.mjs';

// U1/U2: captured by running Serena's real GitignoreParser._parse_gitignore_content
// (U2 with ntpath monkeypatched in).
const U1_IN = '# comment\n  # indented comment\n\n*.log\n!keep.log\n/anchored\n**/deep\nsub/x\n\\#hash\n\\!bang\n trailing   \n'
  + '! spaced\n\x1f#unit-sep comment\nnbsp\xa0\n\u{feff}bom\nvt\x0bsplit\r\n//double\nback\\slash\nlast';
const U2_IN = '*.log\n/anchored\n**/deep\nsub/x\n//double\nback\\slash\n\\lead\nC:drive\n!neg\\x';
const U_ROWS = [
  ['linux', U1_IN, '', ['*.log', '!keep.log', '/anchored', '**/deep', 'sub/x', '#hash', '!bang', 'trailing', '!spaced', 'nbsp',
    '\u{feff}bom', 'vt', 'split', '//double', 'back\\slash', 'last']],
  ['linux', U1_IN, 'a/b', ['a/b/**/*.log', '!a/b/**/keep.log', 'a/b/anchored', 'a/b/**/deep', 'a/b/**/sub/x', 'a/b/**/#hash',
    'a/b/**/!bang', 'a/b/**/trailing', '!a/b/**/spaced', 'a/b/**/nbsp', 'a/b/**/\u{feff}bom', 'a/b/**/vt', 'a/b/**/split', '/double',
    'a/b/**/back\\slash', 'a/b/**/last']],
  ['win32', U2_IN, '', ['*.log', '/anchored', '**/deep', 'sub/x', '//double', 'back/slash', '/lead', 'C:drive', '!neg/x']],
  ['win32', U2_IN, 'a/b', ['a/b/**/*.log', 'a/b/anchored', 'a/b/**/deep', 'a/b/**/sub/x', '/double', 'a/b/**/back/slash', '/lead',
    'C:drive', '!a/b/**/neg/x']],
];

test('U1/U2: convertGitignore mirrors Serena 1.6.2 on POSIX and Windows', () => {
  for (const [platform, input, relDir, expected] of U_ROWS) {
    assert.deepStrictEqual(convertGitignore(input, relDir, platform), expected, `${platform} relDir '${relDir}'`);
  }
});

const U3_ROWS = [
  ['ignored_paths: []\n', []],
  ['project_name: x\n', []],
  ['ignored_paths:\nproject_name: x\n', []],
  ['\u{feff}project_name: x\r\nignored_paths:\r\n- .moe\r\n- "docs/**" # c\r\n\r\n# note\r\n- \'it\'\'s\'\r\nread_only: false\r\n',
    ['.moe', 'docs/**', "it's"]],
  ['"ignored_paths": # c\n  - a b/**\n  - "x\\"y" \n  - \'q\' # c\nz: 1\n', ['a b/**', 'x"y', 'q']],
  ["ignored_paths: [a, \"b\", 'c''d'] # c\n", ['a', 'b', "c'd"]],
  ...['*alias', '!tag x', '&a x', '123', 'true', '~', '|', '"bad\\x41"'].map((item) => [`ignored_paths:\n- ${item}\n`, null]),
  ['ignored_paths:\n  - a\n    b\n', null],
  ['ignored_paths: [a, b\n', null],
  ['ignored_paths: [a, ]\n', null],
  ['ignored_paths: []\nignored_paths: []\n', null],
  ['ignored_paths:\n-\n', null],
];

test('U3: parseIgnoredPaths reads only plain or quoted string sequences', () => {
  for (const [text, expected] of U3_ROWS) assert.deepStrictEqual(parseIgnoredPaths(text), expected, JSON.stringify(text));
});

test('U4: renderBlock escapes characters YAML forbids raw', () => {
  const lines = renderBlock(['q"\\', 'a\x7fb', '\u{feff}x']).split('\n');
  assert.deepStrictEqual(lines.slice(-5), ['  - "q\\"\\\\"', '  - "a\\u007fb"', '  - "\\ufeffx"', '# <<< moe serena-ignore <<<', '']);
});
