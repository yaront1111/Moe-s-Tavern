// =============================================================================
// Architecture rules — the pure, IO-free engine of CQ-V10 (task-db328cda)
// =============================================================================
//
// Parses a versioned project import-rule document, extracts import specifiers
// from changed JS/TS source text, and evaluates forbidden edges for only the
// rules the changed code selects. No Git, no filesystem, no module state: the
// CQ-V10 candidate/CLI wiring consumes these exact names.

import { invalidInput } from '../util/errors.js';
import { normalizeAffectedFile } from '../util/affectedFiles.js';

export interface ArchitectureRule {
  readonly id: string;
  readonly from: readonly string[];
  readonly forbid: readonly string[];
  readonly reason: string;
}
export interface ArchitectureRules { readonly version: 1; readonly rules: readonly ArchitectureRule[] }
export interface ImportRef { readonly line: number; readonly specifier: string }
export interface ImportUncertainty {
  readonly line: number;
  readonly reason: 'dynamic-import' | 'non-literal-require' | 'unresolved-relative';
}
export interface ArchitectureFinding {
  readonly ruleId: string;
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly resolved: string;
}
export interface ArchitectureResult {
  readonly outcome: 'passed' | 'failed' | 'inconclusive';
  readonly selectedRules: readonly string[];
  readonly violations: readonly ArchitectureFinding[];
  readonly uncertain: readonly (ImportUncertainty & { readonly file: string })[];
}

const ROOT_KEYS = ['version', 'rules'];
const RULE_KEYS = ['id', 'from', 'forbid', 'reason'];
const RULE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RULES = 100;
const MAX_PREFIXES = 32;
const MAX_REASON = 300;

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidInput(field, 'must be an object');
  return value as Record<string, unknown>;
}

function onlyKeys(input: Record<string, unknown>, allowed: readonly string[], prefix: string, what: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw invalidInput(prefix + key, `is not a supported ${what} field`);
  }
}

function prefixesAt(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PREFIXES) {
    throw invalidInput(field, `must be an array of 1-${MAX_PREFIXES} path prefixes`);
  }
  return value.map((entry: unknown, index) => {
    const itemField = `${field}[${index}]`;
    const normalized = normalizeAffectedFile(entry, itemField);
    if (entry !== normalized) throw invalidInput(itemField, `must be normalized: ${normalized}`);
    return normalized;
  });
}

function ruleAt(value: unknown, field: string, ids: Set<string>): ArchitectureRule {
  const input = objectAt(value, field);
  onlyKeys(input, RULE_KEYS, `${field}.`, 'architecture rule');
  const { id, reason } = input;
  if (typeof id !== 'string' || !RULE_ID.test(id)) {
    throw invalidInput(`${field}.id`, 'must be 1-64 lowercase alphanumeric, dot, underscore or hyphen characters, starting alphanumeric');
  }
  if (ids.has(id)) throw invalidInput(`${field}.id`, 'must be unique');
  ids.add(id);
  const from = prefixesAt(input.from, `${field}.from`);
  const forbid = prefixesAt(input.forbid, `${field}.forbid`);
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > MAX_REASON) {
    throw invalidInput(`${field}.reason`, `must be a string of 1-${MAX_REASON} characters`);
  }
  return { id, from, forbid, reason };
}

/** Strictly validate a version-1 rules document and return a fresh canonical copy. */
export function parseArchitectureRules(text: string): ArchitectureRules {
  if (typeof text !== 'string') throw invalidInput('architectureRules', 'must be JSON text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidInput('architectureRules', `must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = objectAt(parsed, 'architectureRules');
  onlyKeys(root, ROOT_KEYS, '', 'architecture rules');
  if (root.version !== 1) throw invalidInput('version', 'must be 1');
  const { rules } = root;
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_RULES) {
    throw invalidInput('rules', `must be an array of 1-${MAX_RULES} rules`);
  }
  const ids = new Set<string>();
  return { version: 1, rules: rules.map((entry: unknown, index) => ruleAt(entry, `rules[${index}]`, ids)) };
}

// -----------------------------------------------------------------------------
// Lexer: one linear pass over the text, emitting only significant tokens.
// Comments vanish, string and template text become cooked values, and regex
// bodies become opaque tokens, so none of them is ever read as code.
// -----------------------------------------------------------------------------

type TokenKind = 'id' | 'str' | 'tpl' | 'punct' | 'other';
interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly member: boolean;
  readonly control: boolean;
}

const REGEX_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'], ['r', '\r'], ['t', '\t'], ['b', '\b'], ['f', '\f'], ['v', '\v'],
]);
const SUBSTITUTION_OPEN: Token = { kind: 'punct', value: '{', line: 0, member: false, control: false };
const TEMPLATE_END: Token = { kind: 'other', value: '`', line: 0, member: false, control: false };

/** Length of the JS line terminator at `i` (CRLF counts as one), or 0. */
function breakLen(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 13) return text.charCodeAt(i + 1) === 10 ? 2 : 1;
  return c === 10 || c === 0x2028 || c === 0x2029 ? 1 : 0;
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdStart = (c: number) => isLetter(c) || c === 36 || c === 95 || c >= 0x80;

/** Callers have already ruled out whitespace at an identifier's first character. */
function isIdPart(text: string, j: number): boolean {
  const c = text.charCodeAt(j);
  return c < 0x80 ? isIdStart(c) || isDigit(c) : !/\s/.test(text[j]);
}

function hexValue(c: number): number {
  if (isDigit(c)) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  return c >= 65 && c <= 70 ? c - 55 : -1;
}

function hexRun(text: string, start: number, count: number): number {
  let value = 0;
  for (let k = start; k < start + count; k++) {
    const digit = hexValue(text.charCodeAt(k));
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}

/** Legacy octal escape, live in sloppy CommonJS (`\056` is '.'): up to three digits, at most 0o377. */
function legacyOctal(text: string, start: number): [string, number] {
  const limit = start + (text[start] <= '3' ? 3 : 2);
  let k = start;
  let value = 0;
  for (; k < limit && text[k] >= '0' && text[k] <= '7'; k++) value = value * 8 + text.charCodeAt(k) - 48;
  return [String.fromCharCode(value), k];
}

/** Cook the escape whose backslash is at `j`; returns its text and the index after it. */
function escapeAt(text: string, j: number): [string, number] {
  const c = text[j + 1];
  if (c === undefined) return ['', j + 1];
  if (c >= '0' && c <= '7') return legacyOctal(text, j + 1);
  const simple = SIMPLE_ESCAPES.get(c);
  if (simple !== undefined) return [simple, j + 2];
  const fixed = c === 'x' ? hexRun(text, j + 2, 2) : c === 'u' && text[j + 2] !== '{' ? hexRun(text, j + 2, 4) : -1;
  if (fixed >= 0) return [String.fromCharCode(fixed), j + (c === 'x' ? 4 : 6)];
  if (c === 'u' && text[j + 2] === '{') {
    let k = j + 3;
    let value = 0;
    for (; hexValue(text.charCodeAt(k)) >= 0 && value <= 0x10ffff; k++) value = value * 16 + hexValue(text.charCodeAt(k));
    if (k > j + 3 && text[k] === '}' && value <= 0x10ffff) return [String.fromCodePoint(value), k + 1];
  }
  return [c, j + 2];
}

class Lexer {
  readonly tokens: Token[] = [];
  private i = 0;
  private line = 1;
  private prev: Token | null = null;
  /** One open-brace depth per template substitution being lexed. */
  private readonly braces: number[] = [];
  /** Per open paren: does it follow if/while/for/with, so a regex may follow its `)`? */
  private readonly parens: boolean[] = [];
  /** After a failed regex scan, every `/` before this index is division (keeps the pass linear). */
  private regexOffUntil = 0;

  constructor(private readonly text: string) {}

  run(): Token[] {
    const start = this.text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (this.text.startsWith('#!', start)) {
      this.i = start;
      this.skipLine();
    }
    while (this.i < this.text.length) this.step();
    return this.tokens;
  }

  private emit(kind: TokenKind, value: string, line: number, control = false): void {
    const p = this.prev;
    const member = kind === 'id' && p !== null && p.kind === 'punct' && (p.value === '.' || p.value === '#');
    const token: Token = { kind, value, line, member, control };
    this.tokens.push(token);
    this.prev = token;
  }

  private step(): void {
    const { text, i } = this;
    const br = breakLen(text, i);
    if (br) {
      this.line++;
      this.i += br;
      return;
    }
    const ch = text[i];
    const next = text[i + 1];
    if (/\s/.test(ch)) this.i++;
    else if (ch === '/' && next === '/') this.skipLine();
    else if (ch === '/' && next === '*') this.skipBlock();
    else if (ch === '/') this.slash();
    else if (ch === '"' || ch === "'") this.quoted(ch);
    else if (ch === '`') {
      this.i++;
      this.templateText(true);
    } else if (isIdStart(text.charCodeAt(i)) || (ch === '\\' && next === 'u')) this.identifier();
    else if (isDigit(text.charCodeAt(i)) || (ch === '.' && isDigit(text.charCodeAt(i + 1)))) this.number();
    else this.punct(ch);
  }

  private skipLine(): void {
    while (this.i < this.text.length && !breakLen(this.text, this.i)) this.i++;
  }

  private skipBlock(): void {
    const { text } = this;
    let j = this.i + 2;
    while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) {
      const br = breakLen(text, j);
      if (br) this.line++;
      j += br || 1;
    }
    this.i = Math.min(j + 2, text.length);
  }

  private quoted(quote: string): void {
    const { text } = this;
    const line = this.line;
    let j = this.i + 1;
    let value = '';
    while (j < text.length && text[j] !== quote) {
      const c = text.charCodeAt(j);
      if (c === 10 || c === 13) break; // recovery: an unescaped LF or CR ends the string
      if (c === 0x2028 || c === 0x2029) this.line++;
      if (text[j] === '\\') {
        const [cooked, after] = this.escape(j);
        value += cooked;
        j = after;
      } else value += text[j++];
    }
    this.i = text[j] === quote ? j + 1 : j;
    this.emit('str', value, line);
  }

  /** Cook the escape at `j`; a backslash line continuation counts a line and cooks to nothing. */
  private escape(j: number): [string, number] {
    const br = breakLen(this.text, j + 1);
    if (!br) return escapeAt(this.text, j);
    this.line++;
    return ['', j + 1 + br];
  }

  /** Template text from `this.i`: just past a backtick, or past a substitution's closing brace. */
  private templateText(head: boolean): void {
    const { text } = this;
    const line = this.line;
    let j = this.i;
    let value = '';
    while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) {
      const br = breakLen(text, j);
      if (br) {
        this.line++;
        value += text[j] === '\r' ? '\n' : text[j];
        j += br;
      } else if (text[j] === '\\') {
        const [cooked, after] = this.escape(j);
        value += cooked;
        j = after;
      } else value += text[j++];
    }
    const substitution = text[j] === '$';
    if (substitution) this.braces.push(0);
    this.i = substitution ? j + 2 : Math.min(j + 1, text.length);
    if (head) this.emit(substitution ? 'other' : 'tpl', substitution ? '`' : value, line);
    if (substitution) this.prev = SUBSTITUTION_OPEN;
    else if (!head) this.prev = TEMPLATE_END;
  }

  private identifier(): void {
    const { text } = this;
    let j = this.i;
    let name = '';
    while (j < text.length) {
      if (text[j] === '\\' && text[j + 1] === 'u') {
        const [ch, after] = escapeAt(text, j);
        name += ch;
        j = after;
      } else if (isIdPart(text, j)) name += text[j++];
      else break;
    }
    this.i = j;
    this.emit('id', name, this.line);
  }

  private number(): void {
    const isPart = (c: number) => isLetter(c) || isDigit(c) || c === 95 || c === 46;
    let j = this.i + 1;
    while (isPart(this.text.charCodeAt(j))) j++;
    this.i = j;
    this.emit('other', '0', this.line);
  }

  private slash(): void {
    const p = this.prev;
    const regexAllowed = this.i >= this.regexOffUntil && (p === null
      || (p.kind === 'punct' && ((p.value !== ')' && p.value !== ']') || p.control))
      || (p.kind === 'id' && !p.member && REGEX_KEYWORDS.has(p.value)));
    const end = regexAllowed ? this.regexEnd(this.i + 1) : -1;
    if (end < 0) {
      this.emit('punct', '/', this.line);
      this.i++;
      return;
    }
    this.emit('other', '/', this.line);
    this.i = end;
  }

  /** Index past the regex whose body starts at `j`, or -1 if a line break or EOF comes first. */
  private regexEnd(j: number): number {
    const { text } = this;
    let inClass = false;
    for (; j < text.length && !breakLen(text, j); j++) {
      const ch = text[j];
      if (ch === '\\') {
        j++;
        if (j >= text.length || breakLen(text, j)) break;
      } else if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        j++;
        while (isLetter(text.charCodeAt(j))) j++;
        return j;
      }
    }
    this.regexOffUntil = j;
    return -1;
  }

  private punct(ch: string): void {
    const depth = this.braces.length - 1;
    if (ch === '.' && this.text.startsWith('...', this.i)) {
      this.i += 3;
      this.emit('punct', '...', this.line);
      return;
    }
    this.i++;
    if (ch === '}' && depth >= 0 && this.braces[depth] === 0) {
      this.braces.pop();
      this.templateText(false);
      return;
    }
    if (depth >= 0 && (ch === '{' || ch === '}')) this.braces[depth] += ch === '{' ? 1 : -1;
    const p = this.prev;
    if (ch === '(') this.parens.push(p !== null && p.kind === 'id' && !p.member && CONTROL_KEYWORDS.has(p.value));
    this.emit('punct', ch, this.line, ch === ')' && (this.parens.pop() ?? false));
  }
}

// -----------------------------------------------------------------------------
// Recognizer: token patterns for import, export and require.
// -----------------------------------------------------------------------------

const CLAUSE_PUNCT: ReadonlySet<string> = new Set(['{', '}', ',', '*']);
const isPunct = (t: Token | undefined, value: string) => t !== undefined && t.kind === 'punct' && t.value === value;
const isLiteral = (t: Token | undefined): t is Token => t !== undefined && (t.kind === 'str' || t.kind === 'tpl');

/** Index of the `(` that calls the token at `k` (plain or optional call), or -1. */
function callOpen(tokens: readonly Token[], k: number): number {
  if (isPunct(tokens[k + 1], '(')) return k + 1;
  return isPunct(tokens[k + 1], '?') && isPunct(tokens[k + 2], '.') && isPunct(tokens[k + 3], '(') ? k + 3 : -1;
}

/** Walk an import/export clause from `k`; return its `from` specifier, if it has one. */
function clauseSource(tokens: readonly Token[], k: number): Token | undefined {
  for (let m = k; m < tokens.length; m++) {
    const t = tokens[m];
    if (t.kind === 'id') {
      if (t.value === 'import' || t.value === 'export') return undefined;
      if (t.value === 'from' && tokens[m + 1]?.kind === 'str') return tokens[m + 1];
    } else if (t.kind !== 'str' && !(t.kind === 'punct' && CLAUSE_PUNCT.has(t.value))) return undefined;
  }
  return undefined;
}

/** Every string-literal import specifier in JS/TS text, plus each call whose target it cannot read. */
export function extractImports(text: string): { imports: ImportRef[]; uncertain: ImportUncertainty[] } {
  const tokens = new Lexer(text).run();
  const imports: ImportRef[] = [];
  const uncertain: ImportUncertainty[] = [];
  const found = (t: Token) => imports.push({ line: t.line, specifier: t.value });
  tokens.forEach((t, k) => {
    if (t.kind !== 'id' || t.member) return;
    const next = tokens[k + 1];
    if (t.value === 'require') {
      const open = callOpen(tokens, k);
      if (open < 0) return;
      const arg = tokens[open + 1];
      if (isLiteral(arg) && isPunct(tokens[open + 2], ')')) found(arg);
      else uncertain.push({ line: t.line, reason: 'non-literal-require' });
    } else if (t.value === 'import' && isPunct(next, '(')) {
      const arg = tokens[k + 2];
      if (isLiteral(arg) && (isPunct(tokens[k + 3], ')') || isPunct(tokens[k + 3], ','))) found(arg);
      else uncertain.push({ line: t.line, reason: 'dynamic-import' });
    } else if (t.value === 'import' && next?.kind === 'str') found(next);
    else if ((t.value === 'import' && !isPunct(next, '.')) || t.value === 'export') {
      const source = clauseSource(tokens, k + 1);
      if (source) found(source);
    }
  });
  return { imports, uncertain };
}

// -----------------------------------------------------------------------------
// Resolution and evaluation
// -----------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

/** Windows CommonJS treats a backslash as a separator, so both checks fold it to '/'. */
function isRelative(specifier: string): boolean {
  const s = specifier.replaceAll('\\', '/');
  return s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');
}

const covers = (prefix: string, path: string) => path === prefix || path.startsWith(`${prefix}/`);
const coversAny = (prefixes: readonly string[], path: string) => prefixes.some(prefix => covers(prefix, path));
/** Code-unit order: identical on every host locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Map a relative specifier onto the tree; null for an external or unmatched one. */
export function resolveImport(fromPath: string, specifier: string, treePaths: ReadonlySet<string>): string | null {
  const spec = specifier.replaceAll('\\', '/');
  if (!isRelative(spec)) return null;
  const segments = fromPath.split('/').slice(0, -1);
  for (const segment of spec.split('/')) {
    if (segment === '..') {
      if (segments.pop() === undefined) return null;
    } else if (segment !== '' && segment !== '.') segments.push(segment);
  }
  const joined = segments.join('/');
  const index = joined ? `${joined}/index` : 'index';
  const candidates = spec.endsWith('.js')
    ? RESOLVE_EXTENSIONS.map(ext => joined.slice(0, -3) + ext)
    : [...(joined ? [joined, ...RESOLVE_EXTENSIONS.map(ext => joined + ext)] : []), ...RESOLVE_EXTENSIONS.map(ext => index + ext)];
  return candidates.find(candidate => treePaths.has(candidate)) ?? null;
}

/** Fail closed: a mis-normalized changed path would otherwise silently select no rule. */
function checkChangedPaths(changed: readonly { path: string }[]): void {
  const seen = new Set<string>();
  changed.forEach(({ path }, index) => {
    const field = `changed[${index}].path`;
    if (normalizeAffectedFile(path, field) !== path) throw invalidInput(field, 'must be normalized');
    if (seen.has(path)) throw invalidInput(field, 'must be unique');
    seen.add(path);
  });
}

/** Evaluate the rules the changed paths select against the changed source files they cover. */
export function evaluateArchitecture(
  rules: ArchitectureRules,
  changed: readonly { path: string; text: string }[],
  treePaths: ReadonlySet<string>,
): ArchitectureResult {
  checkChangedPaths(changed);
  const selected = rules.rules.filter(rule => changed.some(entry => coversAny(rule.from, entry.path)));
  const violations: ArchitectureFinding[] = [];
  const uncertain: (ImportUncertainty & { readonly file: string })[] = [];
  for (const entry of changed) {
    const file = entry.path;
    const owners = selected.filter(rule => coversAny(rule.from, file));
    if (!owners.length || !SCANNED_EXTENSIONS.some(ext => file.endsWith(ext))) continue;
    const found = extractImports(entry.text);
    for (const { line, reason } of found.uncertain) uncertain.push({ file, line, reason });
    for (const { line, specifier } of found.imports) {
      const resolved = resolveImport(file, specifier, treePaths);
      if (resolved === null) {
        if (isRelative(specifier)) uncertain.push({ file, line, reason: 'unresolved-relative' });
        continue;
      }
      for (const rule of owners) {
        if (coversAny(rule.forbid, resolved)) violations.push({ ruleId: rule.id, file, line, specifier, resolved });
      }
    }
  }
  violations.sort((a, b) => byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.specifier, b.specifier) || byCodeUnit(a.resolved, b.resolved));
  uncertain.sort((a, b) => byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.reason, b.reason));
  const outcome = violations.length ? 'failed' : uncertain.length ? 'inconclusive' : 'passed';
  return { outcome, selectedRules: selected.map(rule => rule.id).sort(byCodeUnit), violations, uncertain };
}
