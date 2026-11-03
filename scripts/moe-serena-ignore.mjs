#!/usr/bin/env node
// moe-serena-ignore.mjs: hand Serena git's own ignore set (task-c6a24053, consumer task-e3e81c45).
// Serena 1.6.2's startup .gitignore walk ignores .git/info/exclude and core.excludesFile, so it walks
// every directory they exclude (minutes on a big tree). This keeps one Moe block in
// <root>/.serena/project.local.yml that turns the walk off and lists the patterns the walk would have
// built, plus git's, converted exactly as Serena converts .gitignore lines.
//
// Usage: node moe-serena-ignore.mjs <serena-root>. It always exits 0 and prints exactly one line:
//   [OK] MOE_SERENA_IGNORE_OVERRIDE: wrote <file> (<n> patterns; Serena's .gitignore walk is off)
//   [info] MOE_SERENA_IGNORE_OVERRIDE: <file> is up to date (<n> patterns)
//   [info] MOE_SERENA_IGNORE_SKIPPED: <reason>; Serena keeps its own .gitignore walk
// Opt out with MOE_SERENA_IGNORE_OVERRIDE=0, or by setting ignore_all_files_in_gitignore or ignored_paths
// in project.local.yml yourself: either removes the Moe block and writes nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const BEGIN = "# >>> moe serena-ignore (managed by Moe's scripts/moe-serena-ignore.mjs; edits inside are overwritten) >>>";
const WHY = [
  "# Serena's own .gitignore walk ignores .git/info/exclude and core.excludesFile, and walks every",
  "# directory they exclude. Moe turns that walk off and lists the same patterns, plus git's, below.",
  '# To opt out, set MOE_SERENA_IGNORE_OVERRIDE=0, or set ignore_all_files_in_gitignore or ignored_paths',
  '# yourself outside this block; Moe then removes this block.',
];
export const END = '# <<< moe serena-ignore <<<';

// Python's str.splitlines() breaks and str.isspace() set, which Serena's parser uses.
const SPLIT = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u{2028}\u{2029}]/u;
const WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const LSTRIP = new RegExp(`^[${WS}]+`);
const RSTRIP = new RegExp(`[${WS}]+$`);

/** Serena 1.6.2 GitignoreParser._parse_gitignore_content; relDir is '/'-separated, '' at the root. */
export function convertGitignore(text, relDir, platform = process.platform) {
  const win = platform === 'win32';
  const rooted = (p) => p.startsWith('/') || (win && (p.startsWith('\\') || p[1] === ':'));
  const join = (a, b) => (rooted(b) ? b : `${a}/${b}`); // posixpath/ntpath.join for two parts
  const out = [];
  for (let line of text.split(SPLIT)) {
    line = line.replace(RSTRIP, '');
    if (!line || line.replace(LSTRIP, '').startsWith('#')) continue;
    const neg = line.startsWith('!');
    line = (neg ? line.slice(1) : line).replace(LSTRIP, '').replace(RSTRIP, '');
    if (!line) continue;
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    let p;
    if (!relDir) p = anchored ? `/${line}` : line;
    else p = anchored || line.startsWith('**/') ? join(relDir, line) : join(`${relDir}/**`, line);
    p = (neg ? '!' : '') + p;
    out.push(win ? p.replaceAll('\\', '/') : p);
  }
  return out;
}

const PLAIN = /^(?:[A-Za-z_/]|\.(?![0-9]))[\w./*?+=@~ -]*$/;
const NOT_STRING = /^(?:null|Null|NULL|true|True|TRUE|false|False|FALSE|yes|Yes|YES|no|No|NO|on|On|ON|off|Off|OFF|[yYnN]|\.(?:inf|Inf|INF|nan|NaN|NAN))$/;
const QUOTED = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')/;
const TAIL = /^(?:[ \t]*|[ \t]+#.*)$/; // nothing left but whitespace or a comment
const KEY = /^(?:ignored_paths|"ignored_paths"|'ignored_paths')[ \t]*:(?=[ \t]|$)(.*)$/;

/** One scalar at the start of s: [value, rest], or null. A plain one ends at ',' or ']' in flow. */
function scalar(s, flow) {
  const q = QUOTED.exec(s);
  if (q) {
    if (q[2] !== undefined) return [q[2].replaceAll("''", "'"), s.slice(q[0].length)];
    try {
      return [JSON.parse(`"${q[1]}"`), s.slice(q[0].length)];
    } catch {
      return null; // a YAML-only escape or a raw control character
    }
  }
  const raw = flow ? /^[^,\]]*/.exec(s)[0] : s.replace(/[ \t]#.*$/, '');
  const v = raw.trim();
  return PLAIN.test(v) && !NOT_STRING.test(v) ? [v, s.slice(raw.length)] : null;
}

function flowSequence(s) {
  const out = [];
  s = s.replace(/^[ \t]*\[[ \t]*/, '');
  if (s.startsWith(']')) return TAIL.test(s.slice(1)) ? out : null;
  for (;;) {
    const r = scalar(s, true);
    if (!r) return null;
    out.push(r[0]);
    s = r[1].replace(/^[ \t]*/, '');
    if (s.startsWith(']')) return TAIL.test(s.slice(1)) ? out : null;
    if (!s.startsWith(',')) return null;
    s = s.slice(1).replace(/^[ \t]*/, '');
  }
}

function blockSequence(lines) {
  const out = [];
  let indent = null;
  for (const line of lines) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    const m = /^( *)- +(\S.*)$/.exec(line);
    if (!m) {
      if (/^\S/.test(line) && !/^-(?:\s|$)/.test(line)) break; // the next top-level key
      return null; // a continuation, a tab indent or a bare '-'
    }
    if ((indent ??= m[1]) !== m[1]) return null;
    const r = scalar(m[2], false);
    if (!r || !TAIL.test(r[1])) return null;
    out.push(r[0]);
  }
  return out;
}

/** project.yml's top-level ignored_paths as Serena reads it; null when it cannot be read safely. */
export function parseIgnoredPaths(text) {
  const lines = text.replace(/^\u{feff}/u, '').split('\n').map((l) => l.replace(/\r$/, ''));
  const at = lines.flatMap((l, i) => (KEY.test(l) ? [i] : []));
  if (at.length === 0) return [];
  if (at.length > 1) return null;
  const rest = KEY.exec(lines[at[0]])[1];
  if (TAIL.test(rest)) return blockSequence(lines.slice(at[0] + 1));
  return /^[ \t]*\[/.test(rest) ? flowSequence(rest) : null;
}

/** The managed block, LF, ending in '\n'; each pattern a JSON (so YAML double-quoted) string. */
export function renderBlock(patterns) {
  const items = patterns.map((p) => `  - ${JSON.stringify(p)}`.replace(/[\x7f-\x9f\u{2028}\u{2029}\u{feff}\u{fffe}\u{ffff}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return [BEGIN, ...WHY, 'ignore_all_files_in_gitignore: false', 'ignored_paths:', ...items, END, ''].join('\n');
}

// ---- the CLI ----
const BEGIN_PREFIX = '# >>> moe serena-ignore';
const MAX_PATTERNS = 5000, GIT_TIMEOUT_MS = 20_000, BUDGET_MS = 60_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); // ignoreBOM KEEPS a BOM, as Python's utf-8 does
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
const SCRUB = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|(?:LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS)$/i;
const OWN_KEY = /^(["']?)(?:ignore_all_files_in_gitignore|ignored_paths)\1[ \t]*:(?:[ \t]|$)/;
const MAP_KEY = /^("[^"]*"|'[^']*'|[^\s#'"{}[\],&*!|>%@`?:-][^:#]*?)[ \t]*:(?:[ \t]|$)/;

/** access: change nothing. content: git works but the list would be wrong, so an earlier block goes. */
class Skip extends Error {
  constructor(reason, kind = 'access') {
    super(reason);
    this.kind = kind;
  }
}
const content = (reason) => new Skip(reason, 'content');
const fail = (reason, kind = 'access') => { throw new Skip(reason, kind); };
/** fn(), or onError(error) when it throws; onError may rethrow. */
function tryOr(fn, onError) {
  try {
    return fn();
  } catch (error) {
    return onError(error);
  }
}
const absentOr = (onOther) => (error) => (ABSENT.has(error.code) ? undefined : onOther(error));

/** undefined when absent, null when not UTF-8; any other read error is thrown. */
function readText(file) {
  const buf = tryOr(() => fs.readFileSync(file), absentOr((error) => { throw error; }));
  return buf && tryOr(() => UTF8.decode(buf), () => null);
}

/** Steps 2-3: project.local.yml's text, mode and Moe block. */
function readLocal(file, state) {
  const unreadable = (error) => fail(`cannot read ${file} (${error.code})`);
  const st = tryOr(() => fs.lstatSync(file), absentOr(unreadable));
  if (!st) return { text: '', mode: 0o666, block: false, user: '' };
  if (!st.isFile()) throw new Skip(`${file} is not a regular file`);
  let text = tryOr(() => readText(file), unreadable);
  if (text === null) throw new Skip(`${file} is not valid UTF-8`);
  text ??= ''; // removed since the lstat
  const begins = [], ends = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const bare = line.replace(/\r$/, '');
    const bom = at === 0 && bare.startsWith('\u{feff}') ? 1 : 0; // a BOM an editor put before a leading block stays the user's
    if (bare.startsWith(BEGIN_PREFIX, bom)) begins.push(at + bom);
    else if (bare.trimEnd() === END) ends.push(at + line.length + 1);
    at += line.length + 1;
  }
  state.marked = begins.length + ends.length > 0;
  const local = { text, mode: st.mode & 0o777, block: state.marked, user: text };
  if (!state.marked) return local;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) throw new Skip(`${file} has Moe block markers that do not pair`);
  [local.before, local.after] = [text.slice(0, begins[0]), text.slice(ends[0])];
  local.user = local.before + local.after;
  return local;
}

/** Step 6: git, never by bare name under MOE_RUNTIME_PROTECTED=1, inside one budget for the whole run. */
function gitRunner(root, env, deadline) {
  const strict = env.MOE_RUNTIME_PROTECTED === '1';
  const bin = strict ? env.MOE_PROTECTED_GIT || '' : 'git';
  if (strict && !path.isAbsolute(bin)) throw new Skip('MOE_RUNTIME_PROTECTED=1 and MOE_PROTECTED_GIT is not an absolute path');
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !SCRUB.test(key)));
  const git = (args, allow = [0], input = undefined) => {
    git.budget();
    const r = spawnSync(bin, args, { cwd: root, env: childEnv, input, encoding: 'utf8',
      timeout: Math.min(GIT_TIMEOUT_MS, deadline - Date.now()), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (r.error) throw new Skip(`git could not run (${r.error.code ?? r.error.message})`);
    if (!allow.includes(r.status)) throw new Skip(`git ${args[0]} failed (exit ${r.status ?? r.signal})`);
    return r;
  };
  git.budget = () => Date.now() >= deadline && fail('the .gitignore discovery took over 60 s');
  return git;
}

/** Steps 7-8: root is a work tree's top level, and git ignores project.local.yml. */
function checkRoot(root, file, git) {
  const top = git(['rev-parse', '--show-toplevel'], [0, 128]);
  if (top.status === 128) throw new Skip(`${root} is not a git work tree (git rev-parse exit 128)`);
  const real = (p) => (process.platform === 'win32' ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
  tryOr(() => real(top.stdout.replace(/\r?\n$/, '')) === real(root), () => false) || fail(`${root} is not the top level of its git work tree`);
  if (git(['check-ignore', '-q', '.serena/project.local.yml'], [0, 1]).status === 1) fail(`git does not ignore ${file}, or tracks it`);
}

/** Step 9: the user part leaves the keys to Moe and takes appended keys. */
function checkUser(user, file) {
  const lines = user.replace(/^\u{feff}/u, '').split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.some((line) => OWN_KEY.test(line))) throw content(`${file} sets ignore_all_files_in_gitignore or ignored_paths itself`);
  let key = false;
  for (const line of lines) {
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    if (/^[ \t]/.test(line) ? key : (key = MAP_KEY.test(line))) continue;
    throw content(`${file} is not a plain YAML block mapping`); // appending after it could break Serena's YAML load
  }
}

/** Step 11: breadth-first, parents first, each level sorted and pruned by ONE check-ignore call. */
function walk(root, git, addSource) {
  for (let level = ['']; level.length;) {
    const next = [];
    for (const rel of level) {
      git.budget();
      const dir = rel ? path.join(root, rel) : root;
      const entries = tryOr(() => fs.readdirSync(dir, { withFileTypes: true }), // Serena skips EACCES, EPERM and absent dirs too
        (error) => (['EACCES', 'EPERM', ...ABSENT].includes(error.code) ? [] : fail(`cannot read ${dir} (${error.code})`)));
      for (const entry of entries) {
        if (entry.name === '.git') {
          if (rel) throw content(`${rel} is a nested repository or submodule`); // Serena's walk reads its .gitignore files
        } else if (entry.name === '.gitignore' && entry.isFile()) addSource(path.join(dir, entry.name), rel);
        else if (entry.isDirectory()) next.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
    next.sort();
    const out = next.length ? git(['check-ignore', '--no-index', '-z', '--stdin'], [0, 1], next.map((d) => `./${d}\0`).join('')).stdout : '';
    const ignored = new Set(out.split('\0').map((p) => p.replace(/^\.\//, ''))); // './': a raw ':' is pathspec magic
    level = next.filter((d) => !ignored.has(d));
  }
}

/** Steps 10-12: every pattern, in Serena's order. */
function collect(root, projectYml, env, git) {
  const yml = tryOr(() => readText(projectYml), () => null); // unreadable, or not UTF-8
  const own = typeof yml === 'string' ? parseIgnoredPaths(yml) : null;
  if (!own) throw content(`${projectYml} ignored_paths is not a sequence of plain or quoted strings`);
  const patterns = ['/.git', ...own];
  const addSource = (file, relDir) => {
    const text = tryOr(() => readText(file), (error) => fail(`cannot read ${file} (${error.code})`, 'content'));
    if (text === null) throw content(`${file} is not valid UTF-8`);
    if (text !== undefined) for (const p of convertGitignore(text, relDir)) patterns.push(p);
  };
  const cfg = git(['config', '--path', '--get', 'core.excludesFile'], [0, 1]);
  const value = cfg.stdout.replace(/\r?\n$/, '');
  const home = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  if (cfg.status === 1 || value) addSource(cfg.status === 1 ? path.join(home, 'git', 'ignore') : path.resolve(root, value), '');
  addSource(path.resolve(root, git(['rev-parse', '--git-path', 'info/exclude']).stdout.replace(/\r?\n$/, '')), '');
  walk(root, git, addSource);
  if (patterns.length > MAX_PATTERNS) throw content(`${patterns.length} patterns is over the ${MAX_PATTERNS} cap`);
  return patterns;
}

/** Step 13: a temp file in .serena/, then one rename; concurrent seats write identical bytes. */
function writeAtomic(file, text, mode) {
  const tmp = path.join(path.dirname(file), `.project.local.yml.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') tryOr(() => fs.rmSync(tmp, { force: true }), () => {}); // never another writer's file
    throw new Skip(`cannot write ${file} (${error.code ?? error.message})`);
  }
}

function main(argv, env, state) {
  if (!argv[0]) throw new Skip('usage: node moe-serena-ignore.mjs <serena-root>');
  const root = path.resolve(argv[0]);
  if (!tryOr(() => fs.statSync(root).isDirectory(), () => false)) throw new Skip(`${root} is not a directory`);
  const file = (state.file = path.join(root, '.serena', 'project.local.yml'));
  const local = readLocal(file, state);
  const optOut = env.MOE_SERENA_IGNORE_OVERRIDE === '0';
  if (optOut && !local.block) throw new Skip('MOE_SERENA_IGNORE_OVERRIDE=0');
  const projectYml = path.join(root, '.serena', 'project.yml');
  // Serena's autogenerate copies its template over project.local.yml when it creates project.yml.
  if (!tryOr(() => fs.lstatSync(projectYml).isFile(), () => false)) throw new Skip(`${projectYml} is missing or not a regular file`);
  const git = gitRunner(root, env, Date.now() + BUDGET_MS);
  checkRoot(root, file, git);
  try {
    if (optOut) throw content('MOE_SERENA_IGNORE_OVERRIDE=0');
    checkUser(local.user, file);
    const patterns = collect(root, projectYml, env, git);
    const block = renderBlock(patterns);
    const fresh = local.block ? local.before + block + local.after
      : local.user + (local.user && !local.user.endsWith('\n') ? '\n' : '') + block;
    if (fresh === local.text) return `[info] MOE_SERENA_IGNORE_OVERRIDE: ${file} is up to date (${patterns.length} patterns)`;
    writeAtomic(file, fresh, local.mode);
    return `[OK] MOE_SERENA_IGNORE_OVERRIDE: wrote ${file} (${patterns.length} patterns; Serena's .gitignore walk is off)`;
  } catch (error) {
    if (!(error instanceof Skip) || error.kind !== 'content') throw error;
    if (!local.block) return skipLine(error.message);
    writeAtomic(file, local.user, local.mode);
    return skipLine(`${error.message} (removed the Moe block from ${file})`);
  }
}

function skipLine(reason, stays = null) {
  const tail = stays ? `the Moe block written earlier stays in ${stays}` : 'Serena keeps its own .gitignore walk';
  return `[info] MOE_SERENA_IGNORE_SKIPPED: ${reason}; ${tail}`;
}

/** Exactly one line, on every path; an unexpected error is an access skip. */
function cli(argv, env) {
  const state = { file: null, marked: false };
  try {
    return main(argv, env, state);
  } catch (error) {
    const reason = error instanceof Skip ? error.message : `internal error: ${error?.message ?? error}`;
    return skipLine(reason, state.marked ? state.file : null);
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const [a, b] = [fs.realpathSync(process.argv[1]), fs.realpathSync(SELF)];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

// Never process.exit: the line is written and the process ends with exit code 0.
if (invokedDirectly()) process.stdout.write(`${cli(process.argv.slice(2), process.env).replace(/[\r\n]+/g, ' ')}\n`);
