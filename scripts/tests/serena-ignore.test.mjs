// scripts/moe-serena-ignore.mjs: the Serena ignore override (task-c6a24053).
// U rows test the pure core against Serena 1.6.2's own output. F rows run the
// real CLI against throwaway git repositories under os.tmpdir().
// Non-ASCII characters are written as \u{...} escapes, never raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convertGitignore, parseIgnoredPaths, renderBlock } from '../moe-serena-ignore.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'moe-serena-ignore.mjs');
const WIN = process.platform === 'win32';

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

// ---- F rows: the CLI against fixture repositories ----

const BEGIN_LINE = "# >>> moe serena-ignore (managed by Moe's scripts/moe-serena-ignore.mjs; edits inside are overwritten) >>>";
// The DoD 1 text, a literal (never renderBlock's output); the list was checked against Serena's own conversion.
const EXPECTED = [BEGIN_LINE,
  "# Serena's own .gitignore walk ignores .git/info/exclude and core.excludesFile, and walks every",
  "# directory they exclude. Moe turns that walk off and lists the same patterns, plus git's, below.",
  '# To opt out, set MOE_SERENA_IGNORE_OVERRIDE=0, or set ignore_all_files_in_gitignore or ignored_paths',
  '# yourself outside this block; Moe then removes this block.',
  'ignore_all_files_in_gitignore: false',
  'ignored_paths:',
  ...['/.git', '.moe', 'docs/**', "it's", '*.swp', 'big/', 'node_modules/', '*.log', '!keep.log', '/vend/', '.serena/cache',
    '.serena/project.local.yml', '.venv/**/*', 'sub/**/*.tmp', 'sub/anchored', 'sub/**/deep', 'sub/**/#hash'].map((p) => `  - "${p}"`),
  '  - "sub/inner/**/\\u' + 'feffx"',
  '# <<< moe serena-ignore <<<', ''].join('\n');
const U = '\u{feff}# user\r\nread_only: false\r\n';
const OK = (file, n = 18) => `[OK] MOE_SERENA_IGNORE_OVERRIDE: wrote ${file} (${n} patterns; Serena's .gitignore walk is off)`;
const SKIP = (reason) => `[info] MOE_SERENA_IGNORE_SKIPPED: ${reason}; Serena keeps its own .gitignore walk`;
const removed = (file) => ` (removed the Moe block from ${file})`;

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// The seat's own MOE_* and GIT_* env never reaches a row.
function env(base) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MOE_|GIT_)/i.test(key)));
  return { ...clean, HOME: path.join(base, 'home'), XDG_CONFIG_HOME: path.join(base, 'xdg'),
    GIT_CONFIG_GLOBAL: write(path.join(base, 'gitconfig'), ''), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base };
}

function withPath(vars, dir) {
  for (const key of Object.keys(vars)) if (/^path$/i.test(key)) delete vars[key];
  vars.PATH = dir;
  return vars;
}

// The DoD 1 repository.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'moe serena-ignore-')); // a space in every root path
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = path.join(base, 'R');
  fs.mkdirSync(root);
  const vars = env(base);
  const put = (rel, text) => write(path.join(root, rel), text);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=moe', '-c', 'user.email=moe@example.invalid', ...args],
      { cwd: root, env: vars, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.error ?? r.stderr}`);
    return r.stdout;
  };
  git('init', '-q');
  put('.gitignore', 'node_modules/\n*.log\n!keep.log\n/vend/\n');
  put('sub/.gitignore', '*.tmp\n/anchored\n**/deep\n# a comment\n\\#hash\n');
  git('add', '.gitignore', 'sub/.gitignore');
  put('sub/inner/.gitignore', '\u{feff}x\n');
  put('big/a/.gitignore', 'nope-a\n');
  put('big/b/.gitignore', 'nope-b\n');
  put('.git/info/exclude', '# info\nbig/\n');
  put('.venv/.gitignore', '*\n');
  put('.venv/lib/.gitignore', 'nope-venv\n');
  put('vend/.gitignore', '!keep.txt\n');
  git('add', '-f', 'vend/.gitignore');
  put('.serena/project.yml', "project_name: fx\nignored_paths:\n- .moe\n- \"docs/**\"\n- 'it''s'\n");
  put('.serena/.gitignore', '/cache\n/project.local.yml\n');
  git('config', 'core.excludesFile', write(path.join(base, 'global-ignore'), '*.swp\n'));
  return { base, root, env: vars, file: path.join(root, '.serena', 'project.local.yml'), git, put };
}

function snapshot(dir, rel = '', out = {}) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = path.join(rel, entry.name), abs = path.join(dir, name);
    if (entry.isSymbolicLink()) out[name] = `link:${fs.readlinkSync(abs)}`;
    else if (entry.isDirectory()) { if (entry.name !== '.git') snapshot(dir, name, out); } else out[name] = fs.readFileSync(abs);
  }
  return out;
}

// Exit 0 and exactly one stdout line, on every path.
function run(fx, { root = fx.root, env: vars = fx.env, args = [root] } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: vars, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `exit ${r.status} ${r.signal ?? ''} ${r.error ?? ''}: ${r.stderr}`);
  assert.match(r.stdout, /^[^\n]+\n$/, `one stdout line: ${JSON.stringify(r.stdout)}`);
  return r.stdout.slice(0, -1);
}

const read = (file) => fs.readFileSync(file, 'utf8');

test('F1 (DoD 1): writes the exact block, then is up to date with the same inode, and reads the XDG default', (t) => {
  const fx = fixture(t);
  assert.equal(run(fx), OK(fx.file));
  assert.equal(read(fx.file), EXPECTED);
  const before = fs.statSync(fx.file, { bigint: true });
  assert.equal(run(fx), `[info] MOE_SERENA_IGNORE_OVERRIDE: ${fx.file} is up to date (18 patterns)`);
  const after = fs.statSync(fx.file, { bigint: true });
  assert.equal(read(fx.file), EXPECTED);
  assert.deepStrictEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs]);
  fx.git('config', '--unset', 'core.excludesFile');
  write(path.join(fx.base, 'xdg', 'git', 'ignore'), '*.swp\n');
  fs.rmSync(fx.file);
  assert.equal(run(fx), OK(fx.file));
  assert.equal(read(fx.file), EXPECTED);
});

test('F2 (DoD 2): user bytes kept, an old block replaced, opt-outs remove the block', (t) => {
  const fx = fixture(t);
  fx.put('.serena/project.local.yml', `${U}excluded_tools: []`);
  assert.equal(run(fx), OK(fx.file));
  assert.equal(read(fx.file), `${U}excluded_tools: []\n${EXPECTED}`);

  const OLD = '# >>> moe serena-ignore (older text) >>>\r\nignore_all_files_in_gitignore: false\r\nignored_paths:\r\n  - "stale"\r\n'
    + '# <<< moe serena-ignore <<<\r\n';
  fx.put('.serena/project.local.yml', `${U}${OLD}excluded_tools: []\n`);
  assert.equal(run(fx), OK(fx.file));
  assert.equal(read(fx.file), `${U}${EXPECTED}excluded_tools: []\n`);
  assert.equal(read(fx.file).split('\n').filter((l) => l.startsWith('# >>> moe serena-ignore')).length, 1);
  fx.put('.serena/project.local.yml', `\u{feff}${EXPECTED}`); // a BOM saved before a leading block
  assert.equal(run(fx), `[info] MOE_SERENA_IGNORE_OVERRIDE: ${fx.file} is up to date (18 patterns)`);

  const off = { env: { ...fx.env, MOE_SERENA_IGNORE_OVERRIDE: '0' } };
  fx.put('.serena/project.local.yml', `${U}${EXPECTED}x: 1\n`);
  assert.equal(run(fx, off), SKIP(`MOE_SERENA_IGNORE_OVERRIDE=0${removed(fx.file)}`));
  assert.equal(read(fx.file), `${U}x: 1\n`);
  assert.equal(run(fx, off), SKIP('MOE_SERENA_IGNORE_OVERRIDE=0'));
  assert.equal(read(fx.file), `${U}x: 1\n`);

  for (const line of ['ignored_paths: ["mine/"]', "'ignore_all_files_in_gitignore': true"]) {
    fx.put('.serena/project.local.yml', `${U}${line}\n${EXPECTED}`);
    assert.equal(run(fx), SKIP(`${fx.file} sets ignore_all_files_in_gitignore or ignored_paths itself${removed(fx.file)}`), line);
    assert.equal(read(fx.file), `${U}${line}\n`, line);
  }
});

const plainSerena = (dir) => {
  write(path.join(dir, '.serena', 'project.yml'), 'project_name: fx\n');
  write(path.join(dir, '.serena', '.gitignore'), '/project.local.yml\n');
  return dir;
};
const PROTECTED = /^MOE_RUNTIME_PROTECTED=1 and MOE_PROTECTED_GIT is not an absolute path$/;
const NOT_IGNORED = /^git does not ignore .*project\.local\.yml, or tracks it$/;
// [name, setup(fx, t) -> run options (null: skipped), reason, the block stays]
const F3_ROWS = [
  ['1 a non-git root', (fx) => ({ root: plainSerena(path.join(fx.base, 'plain')) }), /is not a git work tree/],
  ['2 a subdirectory root', (fx) => ({ root: plainSerena(path.join(fx.root, 'sub')) }), /is not the top level of its git work tree$/],
  ['3 a broken repository', (fx) => {
    const root = plainSerena(path.join(fx.base, 'broken'));
    write(path.join(root, '.git'), `gitdir: ${fx.base.replaceAll('\\', '/')}/missing\n`);
    return { root };
  }, /is not a git work tree/],
  ['4 no git on PATH', (fx) => {
    fx.put('.serena/project.local.yml', U + EXPECTED);
    return { env: withPath({ ...fx.env }, fs.mkdtempSync(path.join(fx.base, 'empty-'))) };
  }, /^git could not run \(ENOENT\)$/, true],
  ['5a protected without MOE_PROTECTED_GIT', (fx) => ({ env: { ...fx.env, MOE_RUNTIME_PROTECTED: '1' } }), PROTECTED],
  ['5b protected with a bare-name git', (fx) => ({ env: { ...fx.env, MOE_RUNTIME_PROTECTED: '1', MOE_PROTECTED_GIT: 'git' } }), PROTECTED],
  ['6 a file git does not ignore', (fx) => { fs.rmSync(path.join(fx.root, '.serena', '.gitignore')); return {}; }, NOT_IGNORED],
  ['7 a tracked file', (fx) => {
    fx.put('.serena/project.local.yml', U);
    fx.git('add', '-f', '.serena/project.local.yml');
    return {};
  }, NOT_IGNORED],
  ['8 a symlinked file', (fx, t) => {
    try {
      fs.symlinkSync(write(path.join(fx.base, 'elsewhere.yml'), 'x: 1\n'), fx.file);
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
      t.skip('this host cannot create symlinks (EPERM)');
      return null;
    }
    return {};
  }, /project\.local\.yml is not a regular file$/],
  ['9 a begin marker without its end', (fx) => {
    fx.put('.serena/project.local.yml', `${U}${BEGIN_LINE}\nignore_all_files_in_gitignore: false\n`);
    return {};
  }, /has Moe block markers that do not pair$/, true],
  ['10 an unreadable ignored_paths', (fx) => {
    fx.put('.serena/project.yml', 'project_name: fx\nignored_paths:\n- *alias\n');
    return {};
  }, /project\.yml ignored_paths is not a sequence of plain or quoted strings$/],
  ['11 a submodule', (fx) => {
    fx.git('init', '-q', 'mod');
    fx.git('-C', 'mod', 'commit', '-q', '--allow-empty', '-m', 'x');
    fx.git('add', 'mod');
    return {};
  }, /^mod is a nested repository or submodule$/],
  ['12 an untracked nested repository', (fx) => { fx.git('init', '-q', 'nested'); return {}; }, /^nested is a nested repository or submodule$/],
  ['13 over the pattern cap', (fx) => {
    fs.appendFileSync(path.join(fx.root, '.gitignore'), Array.from({ length: 5001 }, (_, i) => `p${i}\n`).join(''));
    return {};
  }, /^5019 patterns is over the 5000 cap$/],
  ['14 no project.yml', (fx) => { fs.rmSync(path.join(fx.root, '.serena', 'project.yml')); return {}; }, /project\.yml is missing or not a regular file$/],
  ['15 a flow-mapping user part', (fx) => { fx.put('.serena/project.local.yml', '{read_only: true}\n'); return {}; },
    /project\.local\.yml is not a plain YAML block mapping$/],
  ['16 no argument', () => ({ args: [] }), /^usage: node moe-serena-ignore\.mjs <serena-root>$/],
];

test('F3 (DoD 3): every fail-open row skips, exits 0 and leaves the files byte-identical', async (t) => {
  for (const [name, setup, reason, stays] of F3_ROWS) {
    await t.test(name, (st) => {
      const fx = fixture(st);
      const opts = setup(fx, st);
      if (!opts) return;
      const before = snapshot(fx.base);
      const line = run(fx, opts);
      const m = /^\[info\] MOE_SERENA_IGNORE_SKIPPED: (.*); (.*)$/.exec(line);
      assert.ok(m, line);
      assert.match(m[1], reason);
      assert.equal(m[2], stays ? `the Moe block written earlier stays in ${fx.file}` : 'Serena keeps its own .gitignore walk');
      assert.deepStrictEqual(snapshot(fx.base), before);
    });
  }
});

test('F4: a content skip removes an earlier Moe block', (t) => {
  const fx = fixture(t);
  fx.git('init', '-q', 'nested');
  fx.put('.serena/project.local.yml', U + EXPECTED);
  assert.equal(run(fx), SKIP(`nested is a nested repository or submodule${removed(fx.file)}`));
  assert.equal(read(fx.file), U);
});

test('F5: under MOE_RUNTIME_PROTECTED=1 git comes from MOE_PROTECTED_GIT, not PATH', (t) => {
  const fx = fixture(t);
  const gitBin = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.join(dir, WIN ? 'git.exe' : 'git')).find((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false; // a missing or unreadable PATH entry
      }
    });
  assert.ok(gitBin, 'git on the test PATH');
  const empty = fs.mkdtempSync(path.join(fx.base, 'empty-'));
  const vars = withPath({ ...fx.env, MOE_RUNTIME_PROTECTED: '1', MOE_PROTECTED_GIT: gitBin }, empty);
  assert.equal(run(fx, { env: vars }), OK(fx.file));
  assert.equal(read(fx.file), EXPECTED);
});

test('F6: check-ignore gets ./-prefixed paths, so a leading ":" is no pathspec magic', { skip: WIN && "':' is illegal in Windows names" }, (t) => {
  const fx = fixture(t);
  fx.put(':x/.gitignore', 'nope\n');
  fs.appendFileSync(path.join(fx.root, '.git', 'info', 'exclude'), ':x/\n');
  assert.equal(run(fx), OK(fx.file, 19));
  assert.ok(read(fx.file).includes('  - ":x/"\n'));
  assert.ok(!read(fx.file).includes('nope'));
});

test('F7 (DoD 4): both IDE bundles ship the script, which imports only node: builtins', () => {
  const manifest = JSON.parse(read(path.join(path.dirname(SCRIPT), 'bundle-manifest.json')));
  assert.ok(manifest.copies.find((c) => c.from === 'scripts').files.includes('moe-serena-ignore.mjs'), 'bundle-manifest.json scripts copy');
  const source = read(SCRIPT);
  for (const [, spec] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) assert.ok(spec.startsWith('node:'), spec);
  assert.ok(!source.includes('require('), 'no require(');
});
