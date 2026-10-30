import { appendFileSync } from 'node:fs';

// TOOL witnesses for a `codex exec --json` stream: every path an event proves this session wrote is appended,
// TOP-relative and one per line, to MOE_TOOL_WRITES_FILE, the file the Claude stream parser fills. The rules are
// ported from STREAM_JSON_PARSER in scripts/moe-agent.sh (to_top_rel, result_text, serena_changed, harvest), not
// redesigned. Codex has no Edit/Write: a completed file_change item (apply_patch) stands in for them. Fail closed:
// only item.completed with status 'completed' witnesses, because codex reports an MCP isError as status 'failed'
// with its result present and error null.
const WARN = '  [WARN] tool write outside the repo not harvested: ';
const SERENA_TOOLS = new Set(['replace_symbol_body', 'insert_after_symbol', 'insert_before_symbol', 'create_text_file',
  'replace_regex', 'replace_content', 'delete_lines', 'replace_lines', 'insert_at_line',
  'rename_symbol', 'safe_delete_symbol', 'replace_in_files']);
const REPLACED_HEADER = /^Replaced \d+ occurrence\(s\) in \d+ file\(s\):$/;
const REPLACED_FILE = /^ {2}(.+): \d+$/;
const ABSOLUTE = /^(\/|[A-Za-z]:\/)/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slashes = value => (value || '').replace(/\\/g, '/');

// The text parts of an MCP result, with Serena's {"result": <text>, "diagnostics...": ...} envelope unwrapped.
function resultText(result) {
  let text = result.content;
  if (Array.isArray(text)) {
    text = text.filter(part => object(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  }
  if (typeof text !== 'string') return '';
  text = text.trim();
  let envelope = null;
  try { envelope = text.startsWith('{') ? JSON.parse(text) : null; } catch { /* not an envelope: keep the text */ }
  return object(envelope) && typeof envelope.result === 'string' ? envelope.result.trim() : text;
}

// The Serena-relative paths a call demonstrably changed; a result that does not prove the edit witnesses nothing.
function serenaChanged(tool, args, result) {
  const relativePath = args.relative_path;
  if (!['safe_delete_symbol', 'rename_symbol', 'replace_in_files'].includes(tool)) return [relativePath];
  const text = resultText(result);
  if (tool === 'safe_delete_symbol') return text === 'OK' ? [relativePath] : [];
  // The rename result names no file: the declaring file is witnessed, the files it rewrote are not (documented gap).
  if (tool === 'rename_symbol') return text.startsWith('Successfully renamed') ? [relativePath] : [];
  const lines = text.split(/\r\n|\r|\n/);
  if (!REPLACED_HEADER.test(lines[0])) return [];
  const changed = [];
  for (const line of lines.slice(1)) {
    const match = REPLACED_FILE.exec(line);
    if (!match) break;
    changed.push(match[1]);
  }
  return changed;
}

export function createWitnessWriter(env = process.env, platform = process.platform) {
  const file = env.MOE_TOOL_WRITES_FILE || '';
  const top = slashes(env.MOE_GIT_TOP).replace(/\/+$/, '');
  const rel = env.MOE_GIT_REL || '';
  const serenaRoot = slashes(env.MOE_SERENA_PROJECT_ROOT).replace(/\/+$/, '');
  const fold = ['win32', 'darwin'].includes(platform) ? value => value.toLowerCase() : value => value;

  // to_top_rel, plus two tightenings: an absolute path whose remainder is blank or has a '..' segment is refused too,
  // and so is any path holding a control character, because a line break would append a second, forged line.
  function toTopRel(raw) {
    let p = slashes(raw.trim());
    if (platform === 'win32') p = p.replace(/^\/([A-Za-z])\//, (_, drive) => `${drive.toUpperCase()}:/`);
    const absolute = ABSOLUTE.test(p);
    if (absolute) {
      if (!top || !fold(p).startsWith(fold(`${top}/`))) return null;
      p = p.slice(top.length + 1);
    } else {
      while (p.startsWith('./')) p = p.slice(2);
    }
    if (!p || /[\u0000-\u001f]/.test(p) || p.split('/').includes('..')) return null;
    return absolute ? p : rel + p;
  }

  // Serena resolves relative paths against ITS project root, so join them there before mapping onto TOP.
  function serenaPath(raw) {
    const p = typeof raw === 'string' ? slashes(raw.trim()) : '';
    return p && serenaRoot && !ABSOLUTE.test(p) ? `${serenaRoot}/${p}` : raw;
  }

  function written(evt) {
    const item = evt?.type === 'item.completed' ? evt.item : null;
    if (!object(item) || item.status !== 'completed') return [];
    if (item.type === 'file_change') return Array.isArray(item.changes) ? item.changes.map(change => change?.path) : [];
    if (item.type !== 'mcp_tool_call' || !SERENA_TOOLS.has(item.tool) || item.error != null
      || !object(item.result) || !object(item.arguments)) return [];
    return serenaChanged(item.tool, item.arguments, item.result).map(serenaPath);
  }

  return {
    event(evt) {
      if (!file) return;
      try {
        for (const raw of written(evt)) {
          if (typeof raw !== 'string' || !raw.trim()) continue;
          const witness = toTopRel(raw);
          if (witness === null) { console.log(WARN + raw); continue; }
          try { appendFileSync(file, `${witness}\n`, 'utf8'); } catch { /* best-effort, as the parser's except: pass */ }
        }
      } catch { /* a malformed event never breaks the stream */ }
    },
  };
}
