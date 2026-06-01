// Shared text-budget helper. (The former project knowledge-base settings that
// lived here were removed when memory moved to the Serena MCP server; only this
// generic truncation helper remains, consumed by the chat/task/pending-question
// payload trimmers.)

export function truncateForBudget(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = '…';
  return {
    text: text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix,
    truncated: true,
  };
}

