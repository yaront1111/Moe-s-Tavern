// =============================================================================
// BM25 search scoring + composite ranking for knowledge base
// =============================================================================

import { tokenize, tokenizeFilePath } from './tokenizer.js';
import type { MemoryEntry, MemoryQuery } from '../types/schema.js';
import crypto from 'crypto';

// BM25 parameters (Okapi defaults)
const K1 = 1.2;
const B = 0.75;

// Composite score weights
const W_TEXT = 0.45;
const W_TAG = 0.15;
const W_FILE = 0.15;
const W_RECENCY = 0.10;
const W_QUALITY = 0.15;

// Recency half-life in days
const RECENCY_HALF_LIFE_DAYS = 30;

// Duplicate detection threshold (Jaccard similarity)
const DUPLICATE_THRESHOLD = 0.7;

// --- Index types ---

export interface DocTermFreq {
  tf: number;
}

export interface PostingList {
  df: number;
  docs: Map<string, DocTermFreq>;
}

export interface KnowledgeIndex {
  entries: Map<string, MemoryEntry>;
  invertedIndex: Map<string, PostingList>;
  tagIndex: Map<string, Set<string>>;
  typeIndex: Map<string, Set<string>>;
  epicIndex: Map<string, Set<string>>;
  fileIndex: Map<string, Set<string>>;
  hashIndex: Map<string, string>;
  docCount: number;
  avgDocLength: number;
  docLengths: Map<string, number>;
}

export function createEmptyIndex(): KnowledgeIndex {
  return {
    entries: new Map(),
    invertedIndex: new Map(),
    tagIndex: new Map(),
    typeIndex: new Map(),
    epicIndex: new Map(),
    fileIndex: new Map(),
    hashIndex: new Map(),
    docCount: 0,
    avgDocLength: 0,
    docLengths: new Map(),
  };
}

export function indexEntry(entry: MemoryEntry, index: KnowledgeIndex): void {
  index.entries.set(entry.id, entry);

  // Tokenize content for inverted index
  const tokens = tokenize(entry.content);
  index.docLengths.set(entry.id, tokens.length);
  index.docCount++;

  // Recompute average doc length
  let totalLen = 0;
  for (const len of index.docLengths.values()) totalLen += len;
  index.avgDocLength = index.docCount > 0 ? totalLen / index.docCount : 0;

  // Build term frequencies
  const termFreqs = new Map<string, number>();
  for (const token of tokens) {
    termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
  }

  // Update inverted index
  for (const [term, tf] of termFreqs) {
    let posting = index.invertedIndex.get(term);
    if (!posting) {
      posting = { df: 0, docs: new Map() };
      index.invertedIndex.set(term, posting);
    }
    if (!posting.docs.has(entry.id)) {
      posting.df++;
    }
    posting.docs.set(entry.id, { tf });
  }

  // Secondary indices
  for (const tag of entry.tags) {
    const tagLower = tag.toLowerCase();
    if (!index.tagIndex.has(tagLower)) index.tagIndex.set(tagLower, new Set());
    index.tagIndex.get(tagLower)!.add(entry.id);
  }

  if (!index.typeIndex.has(entry.type)) index.typeIndex.set(entry.type, new Set());
  index.typeIndex.get(entry.type)!.add(entry.id);

  if (entry.source.epicId) {
    if (!index.epicIndex.has(entry.source.epicId)) index.epicIndex.set(entry.source.epicId, new Set());
    index.epicIndex.get(entry.source.epicId)!.add(entry.id);
  }

  for (const file of entry.source.files) {
    const fileTokens = tokenizeFilePath(file);
    for (const ft of fileTokens) {
      if (!index.fileIndex.has(ft)) index.fileIndex.set(ft, new Set());
      index.fileIndex.get(ft)!.add(entry.id);
    }
  }

  index.hashIndex.set(entry.contentHash, entry.id);
}

export function removeFromIndex(entryId: string, index: KnowledgeIndex): void {
  const entry = index.entries.get(entryId);
  if (!entry) return;

  // Remove from inverted index
  const tokens = tokenize(entry.content);
  const termFreqs = new Map<string, number>();
  for (const token of tokens) termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
  for (const term of termFreqs.keys()) {
    const posting = index.invertedIndex.get(term);
    if (posting) {
      posting.docs.delete(entryId);
      posting.df = posting.docs.size;
      if (posting.docs.size === 0) index.invertedIndex.delete(term);
    }
  }

  // Remove from secondary indices
  for (const tag of entry.tags) {
    index.tagIndex.get(tag.toLowerCase())?.delete(entryId);
  }
  index.typeIndex.get(entry.type)?.delete(entryId);
  if (entry.source.epicId) index.epicIndex.get(entry.source.epicId)?.delete(entryId);
  for (const file of entry.source.files) {
    for (const ft of tokenizeFilePath(file)) {
      index.fileIndex.get(ft)?.delete(entryId);
    }
  }
  index.hashIndex.delete(entry.contentHash);

  index.entries.delete(entryId);
  index.docLengths.delete(entryId);
  index.docCount = Math.max(0, index.docCount - 1);

  // Recompute avg
  let totalLen = 0;
  for (const len of index.docLengths.values()) totalLen += len;
  index.avgDocLength = index.docCount > 0 ? totalLen / index.docCount : 0;
}

// --- BM25 scoring ---

function bm25Score(queryTokens: string[], entryId: string, index: KnowledgeIndex): number {
  const docLength = index.docLengths.get(entryId) ?? 0;
  if (docLength === 0) return 0;

  let score = 0;
  const N = index.docCount;

  for (const token of queryTokens) {
    const posting = index.invertedIndex.get(token);
    if (!posting) continue;
    const docEntry = posting.docs.get(entryId);
    if (!docEntry) continue;

    const tf = docEntry.tf;
    const df = posting.df;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLength / index.avgDocLength)));
    score += idf * tfNorm;
  }

  return score;
}

// --- Composite scoring ---

export function searchAndRank(
  query: MemoryQuery,
  index: KnowledgeIndex
): { entry: MemoryEntry; score: number }[] {
  const now = Date.now();
  const queryTokens = query.query ? tokenize(query.query) : [];
  const queryFilePaths = query.files ?? [];
  const queryFileTokens = new Set(queryFilePaths.flatMap(tokenizeFilePath));
  const queryTags = query.tags?.map(t => t.toLowerCase()) ?? [];
  const minConfidence = query.minConfidence ?? 0.3;
  const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);

  // Filter candidates by hard constraints
  let candidateIds: Set<string> | null = null;

  if (query.types && query.types.length > 0) {
    const typeSet = new Set<string>();
    for (const t of query.types) {
      const ids = index.typeIndex.get(t);
      if (ids) for (const id of ids) typeSet.add(id);
    }
    candidateIds = typeSet;
  }

  if (query.epicId) {
    const epicSet = index.epicIndex.get(query.epicId) ?? new Set();
    if (candidateIds) {
      candidateIds = setIntersect(candidateIds, epicSet);
    } else {
      candidateIds = epicSet;
    }
  }

  const entries = candidateIds
    ? [...candidateIds].map(id => index.entries.get(id)).filter(Boolean) as MemoryEntry[]
    : [...index.entries.values()];

  const results: { entry: MemoryEntry; score: number }[] = [];

  for (const entry of entries) {
    if (entry.supersededBy) continue;
    if (entry.confidence < minConfidence) continue;

    // BM25 text score
    const bm25 = queryTokens.length > 0 ? bm25Score(queryTokens, entry.id, index) : 0;
    // Normalize via sigmoid centered at 2
    const textScore = 1 / (1 + Math.exp(-bm25 + 2));

    // Tag match
    let tagScore = 0;
    if (queryTags.length > 0) {
      const entryTags = new Set(entry.tags.map(t => t.toLowerCase()));
      const matches = queryTags.filter(qt => entryTags.has(qt)).length;
      tagScore = matches / queryTags.length;
    }

    // File path overlap
    let fileScore = 0;
    if (queryFileTokens.size > 0 && entry.source.files.length > 0) {
      const entryFileTokens = new Set(entry.source.files.flatMap(tokenizeFilePath));
      let overlap = 0;
      for (const token of queryFileTokens) {
        if (entryFileTokens.has(token)) overlap++;
      }
      fileScore = overlap / queryFileTokens.size;
    }

    // Recency
    const ageDays = (now - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

    // Quality
    const totalFeedback = entry.helpfulCount + entry.unhelpfulCount;
    const helpfulRatio = totalFeedback > 0 ? entry.helpfulCount / totalFeedback : 0.5;
    const confidenceNorm = entry.confidence / 2;
    const qualityScore = totalFeedback >= 3
      ? 0.4 * confidenceNorm + 0.6 * helpfulRatio
      : 0.7 * confidenceNorm + 0.3 * helpfulRatio;

    const finalScore =
      W_TEXT * textScore +
      W_TAG * tagScore +
      W_FILE * fileScore +
      W_RECENCY * recencyScore +
      W_QUALITY * qualityScore;

    if (finalScore > 0.05) {
      results.push({ entry, score: finalScore });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --- Deduplication ---

export function computeContentHash(content: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

export function checkDuplicate(
  newContent: string,
  newHash: string,
  index: KnowledgeIndex
): { isDuplicate: boolean; existingId: string | null; similarity: number } {
  // Phase 1: Exact hash match
  const existingId = index.hashIndex.get(newHash);
  if (existingId && index.entries.has(existingId)) {
    return { isDuplicate: true, existingId, similarity: 1.0 };
  }

  // Phase 2: Jaccard similarity against BM25 candidates
  const newTokens = new Set(tokenize(newContent));
  if (newTokens.size === 0) return { isDuplicate: false, existingId: null, similarity: 0 };

  const queryTokens = [...newTokens];
  // Get top candidates via BM25
  const candidates = searchAndRank(
    { query: newContent, limit: 20, minConfidence: 0 },
    index
  );

  let maxSimilarity = 0;
  let bestMatchId: string | null = null;

  for (const { entry } of candidates) {
    const candidateTokens = new Set(tokenize(entry.content));
    let intersection = 0;
    for (const token of newTokens) {
      if (candidateTokens.has(token)) intersection++;
    }
    const union = newTokens.size + candidateTokens.size - intersection;
    const similarity = union > 0 ? intersection / union : 0;

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatchId = entry.id;
    }
  }

  return {
    isDuplicate: maxSimilarity >= DUPLICATE_THRESHOLD,
    existingId: bestMatchId,
    similarity: maxSimilarity,
  };
}

// --- Helpers ---

function setIntersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}
