const count = n => Number.isSafeInteger(n) && n >= 0;
const counter = n => count(n) ? n : null;
const sum = values => values.every(count) && count(values.reduce((a, b) => a + b, 0))
  ? values.reduce((a, b) => a + b, 0) : null;

// Keep provider input accounting distinct. Reasoning, when explicitly exposed,
// is a subset of output; it is never added to the input + output total.
export function normalizeUsage(provider, usage) {
  const input = counter(usage?.input_tokens);
  let read = counter(provider === 'claude' ? usage?.cache_read_input_tokens : usage?.cached_input_tokens);
  const write = provider === 'claude' ? counter(usage?.cache_creation_input_tokens) : null;
  if (provider !== 'claude' && input !== null && read !== null && read > input) read = null;
  const inputTokens = provider === 'claude' ? sum([input, read, write]) : input;
  const outputTokens = counter(usage?.output_tokens);
  const reasoning = [usage?.reasoning_tokens, usage?.reasoning_output_tokens,
    usage?.output_tokens_details?.reasoning_tokens].filter(value => value !== undefined);
  const reasoningTokens = reasoning.length && reasoning.every(count) &&
    reasoning.every(value => value === reasoning[0]) && outputTokens !== null && reasoning[0] <= outputTokens
    ? reasoning[0] : null;
  return {
    inputTokens, cacheReadTokens: read, cacheWriteTokens: write,
    uncachedInputTokens: provider === 'claude' ? input : input !== null && read !== null ? input - read : null,
    outputTokens, reasoningTokens, totalTokens: sum([inputTokens, outputTokens]),
  };
}

// Anthropic input excludes read/write tokens. Codex input includes cached input.
// Missing counters are unknown, never silently reported as a zero cache hit.
export function formatUsage(provider, usage) {
  const prefix = `[prompt-cache] provider=${provider}`;
  const normalized = normalizeUsage(provider, usage);
  const output = ` output=${normalized.outputTokens ?? 'unknown'} reasoning=${normalized.reasoningTokens ?? 'unknown'} total=${normalized.totalTokens ?? 'unknown'}`;
  const input = usage?.input_tokens;
  const read = provider === 'claude' ? usage?.cache_read_input_tokens : usage?.cached_input_tokens;
  const write = provider === 'claude' ? usage?.cache_creation_input_tokens : undefined;
  if (!count(input) || !count(read) || (provider === 'claude' ? !count(write) : read > input)) {
    return `${prefix} usage=unknown${output}`;
  }
  const total = provider === 'claude' ? input + read + write : input;
  if (!Number.isSafeInteger(total)) return `${prefix} usage=unknown${output}`;
  const uncached = provider === 'claude' ? input : input - read;
  const hit = total ? `${(100 * read / total).toFixed(1)}%` : 'n/a';
  return `${prefix} input=${total} read=${read} write=${write ?? 'unknown'} uncached=${uncached} hit=${hit}${output}`;
}

export function renderCodexEvent(evt) {
  if (!evt || typeof evt !== 'object') return [];
  if (evt.type === 'turn.completed') return [formatUsage('codex', evt.usage)];
  if (evt.type === 'error' || evt.type === 'turn.failed') return [`[error] ${evt.message || evt.error?.message || 'Codex turn failed'}`];
  const item = evt.item;
  if (evt.type === 'item.completed' && item?.type === 'agent_message') return [item.text || ''];
  if (evt.type === 'item.started' && item?.type === 'command_execution') return [`  → ${item.command || 'command'}`];
  if (evt.type === 'item.completed' && item?.type === 'command_execution') return [item.aggregated_output || '', `  [command exit=${item.exit_code ?? '?'}]`];
  if (evt.type === 'item.started' && item?.type === 'mcp_tool_call') return [`  → ${item.server}.${item.tool}`];
  if (evt.type === 'item.completed' && item?.type === 'file_change') return [`  [files] ${(item.changes || []).map(change => change.path).join(', ')}`];
  return [];
}
