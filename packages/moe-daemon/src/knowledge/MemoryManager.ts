// =============================================================================
// MemoryManager — Persistent knowledge base with BM25 search
// =============================================================================

import fs from 'fs';
import path from 'path';
import { logger } from '../util/logger.js';
import { generateId } from '../util/ids.js';
import { generateAutoTags } from './tokenizer.js';
import {
  createEmptyIndex, indexEntry, removeFromIndex,
  searchAndRank, computeContentHash, checkDuplicate,
  type KnowledgeIndex,
} from './scoring.js';
import type {
  MemoryEntry, MemoryType, MemoryQuery,
  MemorySearchResult, SessionSummary, MEMORY_TYPES,
} from '../types/schema.js';

const MAX_ENTRIES = 3000;
const PRUNE_TARGET = 2500;
const HIGH_CONFIDENCE_KEEP = 1.5;
const PERSIST_DEBOUNCE_MS = 5000;
const MAX_CONTENT_LENGTH = 2000;
const MAX_TAGS = 10;
const MAX_FILES = 20;
const MAX_SUMMARY_LENGTH = 5000;

class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise<void>((resolve) => { this.queue.push(resolve); });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.locked = false;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

export class MemoryManager {
  private readonly knowledgePath: string;
  private readonly archivePath: string;
  private readonly sessionsDir: string;
  private index: KnowledgeIndex;
  private readonly mutex = new AsyncMutex();
  private dirty = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly moePath: string) {
    const memoryDir = path.join(moePath, 'memory');
    this.knowledgePath = path.join(memoryDir, 'knowledge.jsonl');
    this.archivePath = path.join(memoryDir, 'knowledge.archive.jsonl');
    this.sessionsDir = path.join(memoryDir, 'sessions');
    this.index = createEmptyIndex();
  }

  async load(): Promise<void> {
    // Ensure directories exist
    const memoryDir = path.dirname(this.knowledgePath);
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
    if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });
    if (!fs.existsSync(this.knowledgePath)) {
      fs.writeFileSync(this.knowledgePath, '');
      return;
    }

    const raw = fs.readFileSync(this.knowledgePath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const freshIndex = createEmptyIndex();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MemoryEntry;
        if (entry.id && entry.content) {
          indexEntry(entry, freshIndex);
        }
      } catch {
        logger.warn('Skipping malformed knowledge entry');
      }
    }

    this.index = freshIndex;
    logger.info({ count: this.index.docCount }, 'Knowledge base loaded');
  }

  async search(query: MemoryQuery): Promise<MemorySearchResult[]> {
    const results = searchAndRank(query, this.index);

    // Update access counts on returned results
    for (const r of results) {
      r.entry.accessCount++;
      r.entry.lastAccessedAt = new Date().toISOString();
    }
    if (results.length > 0) {
      this.dirty = true;
      this.schedulePersist();
    }

    return results;
  }

  async addEntry(input: {
    content: string;
    type: MemoryType;
    tags?: string[];
    workerId: string;
    taskId?: string;
    epicId?: string;
    files?: string[];
  }): Promise<{ entry: MemoryEntry; wasDuplicate: boolean; mergedWith?: string }> {
    return this.mutex.runExclusive(async () => {
      const content = input.content.slice(0, MAX_CONTENT_LENGTH).trim();
      if (!content) throw new Error('Content is required');

      const hash = computeContentHash(content);

      // Dedup check
      const dupCheck = checkDuplicate(content, hash, this.index);
      if (dupCheck.isDuplicate && dupCheck.existingId) {
        const existing = this.index.entries.get(dupCheck.existingId);
        if (existing) {
          existing.confidence = Math.min(2.0, existing.confidence + 0.1);
          // Merge new tags
          const newTags = input.tags ?? [];
          for (const tag of newTags) {
            if (!existing.tags.includes(tag) && existing.tags.length < MAX_TAGS) {
              existing.tags.push(tag);
            }
          }
          await this.persist();
          return { entry: existing, wasDuplicate: true, mergedWith: dupCheck.existingId };
        }
      }

      const files = (input.files ?? []).slice(0, MAX_FILES);
      const autoTags = generateAutoTags(content, input.type, files);
      const manualTags = (input.tags ?? []).slice(0, MAX_TAGS);
      const allTags = [...new Set([...manualTags, ...autoTags])].slice(0, MAX_TAGS);

      const entry: MemoryEntry = {
        id: generateId('mem'),
        type: input.type,
        content,
        tags: allTags,
        source: {
          files,
          taskId: input.taskId ?? null,
          epicId: input.epicId ?? null,
          workerId: input.workerId ?? null,
        },
        confidence: 1.0,
        accessCount: 0,
        helpfulCount: 0,
        unhelpfulCount: 0,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        supersededBy: null,
        contentHash: hash,
      };

      indexEntry(entry, this.index);

      // Append to JSONL (fast path)
      try {
        fs.appendFileSync(this.knowledgePath, JSON.stringify(entry) + '\n');
      } catch (error) {
        logger.error({ error }, 'Failed to append knowledge entry');
      }

      // Prune if needed
      if (this.index.docCount > MAX_ENTRIES) {
        await this.prune();
      }

      logger.debug({ memoryId: entry.id, type: entry.type }, 'Knowledge entry saved');
      return { entry, wasDuplicate: false };
    });
  }

  async recordFeedback(entryId: string, helpful: boolean): Promise<{ confidence: number } | null> {
    const entry = this.index.entries.get(entryId);
    if (!entry) return null;

    if (helpful) {
      entry.helpfulCount++;
      entry.confidence = Math.min(2.0, entry.confidence + 0.15);
    } else {
      entry.unhelpfulCount++;
      entry.confidence = Math.max(0.0, entry.confidence - 0.25);
    }

    this.dirty = true;
    this.schedulePersist();
    return { confidence: entry.confidence };
  }

  async saveSessionSummary(input: {
    workerId: string;
    taskId: string;
    role: string;
    summary: string;
    memoriesCreated?: string[];
    completedSteps?: string[];
  }): Promise<SessionSummary> {
    const summary: SessionSummary = {
      id: generateId('sess'),
      workerId: input.workerId,
      taskId: input.taskId,
      role: input.role,
      summary: input.summary.slice(0, MAX_SUMMARY_LENGTH),
      memoriesCreated: input.memoriesCreated ?? [],
      completedSteps: input.completedSteps,
      createdAt: new Date().toISOString(),
    };

    const filePath = path.join(this.sessionsDir, `${input.workerId}_${input.taskId}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(summary, null, 2));
    } catch (error) {
      logger.error({ error }, 'Failed to save session summary');
    }

    return summary;
  }

  getLastSession(taskId: string): SessionSummary | null {
    if (!fs.existsSync(this.sessionsDir)) return null;

    try {
      const files = fs.readdirSync(this.sessionsDir)
        .filter(f => f.endsWith('.json') && f.includes(taskId));

      let latest: SessionSummary | null = null;
      let latestTime = 0;

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8');
          const session = JSON.parse(raw) as SessionSummary;
          const time = new Date(session.createdAt).getTime();
          if (time > latestTime) {
            latestTime = time;
            latest = session;
          }
        } catch { /* skip malformed */ }
      }

      return latest;
    } catch {
      return null;
    }
  }

  getEntryCount(): number {
    return this.index.docCount;
  }

  // --- Persistence ---

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.dirty) {
        this.persist().catch(err => logger.error({ error: err }, 'Knowledge persist failed'));
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    this.dirty = false;
    const entries = [...this.index.entries.values()];
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    const tempPath = `${this.knowledgePath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tempPath, lines);
      fs.renameSync(tempPath, this.knowledgePath);
    } catch (error) {
      logger.error({ error }, 'Failed to persist knowledge base');
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  private async prune(): Promise<void> {
    const entries = [...this.index.entries.values()].filter(e => !e.supersededBy);
    if (entries.length <= MAX_ENTRIES) return;

    const now = Date.now();
    const target = entries.length - PRUNE_TARGET;

    // Score each for "keep value"
    const scored = entries.map(e => {
      const ageDays = (now - new Date(e.lastAccessedAt).getTime()) / (1000 * 60 * 60 * 24);
      const recency = Math.pow(0.5, ageDays / 30);
      const usage = Math.log(e.accessCount + 1) / 5;
      const quality = e.confidence / 2;
      const feedback = e.helpfulCount / Math.max(e.helpfulCount + e.unhelpfulCount, 1);
      const keepScore = 0.3 * recency + 0.25 * usage + 0.25 * quality + 0.2 * feedback;
      return { entry: e, keepScore };
    }).sort((a, b) => a.keepScore - b.keepScore);

    // Collect entries to prune (lowest keep-score, skip high-confidence)
    const toPrune: MemoryEntry[] = [];

    // First: superseded entries
    for (const e of this.index.entries.values()) {
      if (e.supersededBy && toPrune.length < target) toPrune.push(e);
    }

    for (const { entry } of scored) {
      if (toPrune.length >= target) break;
      if (entry.confidence >= HIGH_CONFIDENCE_KEEP) continue;
      if (toPrune.includes(entry)) continue;
      toPrune.push(entry);
    }

    // Archive pruned entries
    if (toPrune.length > 0) {
      const archiveLines = toPrune.map(e => JSON.stringify(e)).join('\n') + '\n';
      try {
        fs.appendFileSync(this.archivePath, archiveLines);
      } catch (error) {
        logger.error({ error }, 'Failed to archive pruned entries');
      }

      for (const entry of toPrune) {
        removeFromIndex(entry.id, this.index);
      }

      await this.persist();
      logger.info({ pruned: toPrune.length, remaining: this.index.docCount }, 'Knowledge base pruned');
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty) await this.persist();
  }
}
