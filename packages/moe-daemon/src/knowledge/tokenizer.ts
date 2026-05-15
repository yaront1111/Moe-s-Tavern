// =============================================================================
// Tokenizer for knowledge base search
// Handles natural language, code identifiers, and file paths
// =============================================================================

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'it', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'not', 'with', 'this', 'that', 'from',
  'by', 'be', 'as', 'are', 'was', 'were', 'been', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'can', 'so', 'if', 'then', 'than', 'when', 'how', 'what',
  'which', 'who', 'where', 'why', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only',
  'own', 'same', 'too', 'very', 'just', 'about', 'after', 'also',
  'any', 'because', 'before', 'between', 'during', 'into', 'its',
  'our', 'out', 'over', 'their', 'them', 'these', 'those', 'through',
  'under', 'up', 'we', 'you', 'your', 'he', 'she', 'they', 'i',
  'me', 'my', 'us', 'use', 'used', 'using'
]);

export function stemToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return token.slice(0, -3) + 'y';
  if (token.endsWith('tion') && token.length > 5) return token.slice(0, -4);
  if (token.endsWith('ness') && token.length > 5) return token.slice(0, -4);
  if (token.endsWith('ment') && token.length > 5) return token.slice(0, -4);
  if (token.endsWith('able') && token.length > 5) return token.slice(0, -4);
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('ly') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('er') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 3 && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  // Split camelCase and PascalCase BEFORE lowercasing: "StateManager" → "State Manager"
  const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  const lower = camelSplit.toLowerCase();
  // Split on non-alphanumeric, require min 3 chars
  const raw = lower.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  // Remove stop words, then stem
  return raw.filter(t => !STOP_WORDS.has(t)).map(stemToken);
}

export function tokenizeFilePath(filePath: string): string[] {
  const segments = filePath.toLowerCase().split(/[\\/\\.]+/).filter(s => s.length > 1);
  const camelTokens: string[] = [];
  for (const seg of segments) {
    const split = seg.replace(/([a-z])([A-Z])/gi, '$1 $2').split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    camelTokens.push(...split);
  }
  return [...new Set([...segments.filter(s => s.length >= 3), ...camelTokens.map(stemToken).filter(t => t.length >= 3)])];
}

export function generateAutoTags(content: string, type: string, files: string[]): string[] {
  const tokens = tokenize(content);
  if (tokens.length === 0) return [type];

  // Count token frequency
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  // Score: frequency * length bonus (longer tokens are more specific)
  const scored = [...freq.entries()]
    .map(([token, count]) => ({ token, score: count * Math.log(token.length + 1) }))
    .sort((a, b) => b.score - a.score);

  const tags = scored.filter(s => s.token.length >= 3).slice(0, 5).map(s => s.token);
  if (!tags.includes(type)) tags.push(type);

  // Add key file path components
  for (const file of files.slice(0, 3)) {
    const parts = file.split(/[\\/]/).filter(p => p && p !== '.' && p !== '..');
    const meaningful = parts.slice(-2).join('/').toLowerCase();
    if (meaningful && !tags.includes(meaningful) && tags.length < 10) {
      tags.push(meaningful);
    }
  }

  return tags.slice(0, 10);
}
