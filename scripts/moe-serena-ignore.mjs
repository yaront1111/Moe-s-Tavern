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
import path from 'node:path';
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

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const [a, b] = [fs.realpathSync(process.argv[1]), fs.realpathSync(SELF)];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // step 3: the CLI
}
