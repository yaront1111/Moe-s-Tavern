// Guards the targeted-context guidance (CQ-C10).
//
// The role docs, their references and the explore-before-assume skill used to
// mandate broad rereads: an unconditional `list_memories` on task start, a skill
// reload on every recommendation, and a fresh search for symbols the approved
// plan had already verified. They now tell agents to reuse what Moe supplied and
// to expand only for what the packet marks truncated, omitted, missing or stale.
// These assertions fail if a document drifts back, if a vendored copy in
// src/generated/ goes stale (an IDE user only ever sees the generated copy), or
// if a stable-prefix role doc starts carrying per-task packet content.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_DOCS } from '../generated/initFiles.js';
import { SKILL_FILES } from '../generated/skillFiles.js';

const ROLE_SENTINELS = [
  'what Moe supplied',
  'truncated, omitted or missing',
  'a navigation aid, never a reason to skip a read',
  'once per session',
  // CQ-C06: a delta reader must advance its compaction counter.
  'advance `contextEpoch` after every compaction',
];
const REFERENCE_SENTINELS = ['memory-name inventory', 'once per session'];
// 'no-repository-source' is the limitation buildPacketManifest
// (context/contextPacket.ts) lists when no repository source was served.
const SKILL_SENTINELS = [
  '## Reuse what was already verified',
  'a navigation aid, never a reason to skip a read',
  'no-repository-source',
];
const QA_SENTINEL = 'that is the complete QA read';
const FORBIDDEN = ['On task start, `list_memories`', 'Skills evolve. Read the current version.'];
// The launchers put worker.md, qa.md and architect.md into the stable system
// prefix; per-task packet content there would vary the prefix per task.
const PREFIX_TAGS = ['<claimed_task_context>', '<inbox>', '<routed_mentions>', '<pending_questions>', 'PREFLIGHT_'];
const TASK_ID = /task-[0-9a-f]{32}/;

interface Subject {
  key: string;
  bundle: 'ROLE_DOCS' | 'SKILL_FILES';
  source: string[];
  sentinels: string[];
  stablePrefix: boolean;
}

const role = (key: string, sentinels: string[], stablePrefix: boolean): Subject => ({
  key, bundle: 'ROLE_DOCS', source: ['roles', key], sentinels, stablePrefix,
});

const SUBJECTS: Subject[] = [
  role('worker.md', ROLE_SENTINELS, true),
  role('architect.md', ROLE_SENTINELS, true),
  role('qa.md', [QA_SENTINEL], true),
  role('worker.reference.md', REFERENCE_SENTINELS, false),
  role('architect.reference.md', REFERENCE_SENTINELS, false),
  {
    key: 'explore-before-assume/SKILL.md',
    bundle: 'SKILL_FILES',
    source: ['skills', 'explore-before-assume', 'SKILL.md'],
    sentinels: SKILL_SENTINELS,
    stablePrefix: false,
  },
];

const here = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const docsRoot = path.resolve(here, '..', '..', '..', '..', 'docs');
const hasDocs = fs.existsSync(docsRoot);

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const label = (s: Subject): string => `${s.bundle}['${s.key}']`;
const rawGenerated = (s: Subject): string | undefined =>
  (s.bundle === 'ROLE_DOCS' ? ROLE_DOCS : SKILL_FILES)[s.key];

// A guard that passes without its input is worse than none: a missing or empty
// document throws instead of turning every assertion into a vacuous pass.
const generated = (s: Subject): string => {
  const text = rawGenerated(s);
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error(`targetedContextGuidance: ${label(s)} is missing or empty in the generated bundle`);
  }
  return lf(text);
};

const readDoc = (s: Subject): string => {
  const file = path.join(docsRoot, ...s.source);
  if (!fs.existsSync(file)) throw new Error(`targetedContextGuidance: source doc ${file} is missing`);
  const text = lf(fs.readFileSync(file, 'utf-8'));
  if (text.trim().length === 0) throw new Error(`targetedContextGuidance: source doc ${file} is empty`);
  return text;
};

const sourceLabel = (s: Subject): string => `docs/${s.source.join('/')}`;

const expectNoForbidden = (name: string, text: string): void => {
  for (const phrase of FORBIDDEN) expect(text, `${name} still carries "${phrase}"`).not.toContain(phrase);
};

const expectSentinels = (s: Subject, name: string, text: string): void => {
  for (const phrase of s.sentinels) expect(text, `${name} is missing "${phrase}"`).toContain(phrase);
};

const expectPrefixHygiene = (name: string, text: string): void => {
  for (const tag of PREFIX_TAGS) expect(text, `${name} carries per-task content "${tag}"`).not.toContain(tag);
  expect(text.match(TASK_ID)?.[0], `${name} carries a concrete task id`).toBeUndefined();
};

describe('targeted context guidance', () => {
  it('G1: every guided document is vendored under its expected key', () => {
    for (const s of SUBJECTS) {
      const text = rawGenerated(s);
      expect(typeof text, `${label(s)} is missing from the generated bundle`).toBe('string');
      expect((text ?? '').length, `${label(s)} is empty`).toBeGreaterThan(0);
    }
  });

  it('G2: the generated copies drop the broad-reread mandates', () => {
    for (const s of SUBJECTS) expectNoForbidden(label(s), generated(s));
  });

  it.skipIf(!hasDocs)('G3: the source documents drop the broad-reread mandates', () => {
    for (const s of SUBJECTS) expectNoForbidden(sourceLabel(s), readDoc(s));
  });

  // The positive half fails when a later edit deletes a rule instead of
  // restating it, and when a generated copy still holds the old text.
  it('G4: the generated copies state the targeted-context rules', () => {
    for (const s of SUBJECTS) expectSentinels(s, label(s), generated(s));
  });

  it.skipIf(!hasDocs)('G5: the source documents state the targeted-context rules', () => {
    for (const s of SUBJECTS) expectSentinels(s, sourceLabel(s), readDoc(s));
  });

  it('G6: stable-prefix role docs carry no per-task packet content', () => {
    for (const s of SUBJECTS.filter((subject) => subject.stablePrefix)) {
      expectPrefixHygiene(label(s), generated(s));
      if (hasDocs) expectPrefixHygiene(sourceLabel(s), readDoc(s));
    }
  });
});
