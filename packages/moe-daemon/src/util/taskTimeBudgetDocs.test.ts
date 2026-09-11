import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Doc-contract guard for the retired task time-budget feature.
 *
 * `src/types/schema.ts` marks `settings.pacePerStepMs` and `Task.budget`
 * DEPRECATED and ignored — the 80%/100% warn+escalate clock was removed. The
 * reference docs must say the same thing, or a reader is told a dead control
 * is live. This test reads both documents off disk and asserts the documented
 * contract matches the daemon's actual behaviour.
 *
 * It deliberately does NOT search for the bare word "budget": the reopen cap
 * ("reopen budget") and the chat hop limit are live settings that share the
 * vocabulary. The negative half anchors on the retired identifiers only; the
 * positive half asserts the live settings stay documented and unmarked, so an
 * over-eager later cleanup fails here instead of shipping.
 */

const utilDir = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const repoRoot = path.resolve(utilDir, '..', '..', '..', '..');

const DOCS = {
  configuration: path.join(repoRoot, 'docs', 'CONFIGURATION.md'),
  schema: path.join(repoRoot, 'docs', 'SCHEMA.md'),
} as const;

type DocName = keyof typeof DOCS;

/** A deprecation marker anywhere in the line's text. */
const DEPRECATION_MARKER = /\bdeprecated\b/i;

/** Lines that document the retired setting, field, or interface. */
const RETIRED_ANCHORS: RegExp[] = [
  /pacePerStepMs/,
  /TaskBudget/,
  /task\.budget/,
  /^\s*(?:\*\s*)?budget\?:/,
];

/** A comment/annotation line that can carry a neighbouring member's marker. */
const ANNOTATION_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Claim that a plan submission seeds a task budget, in any tense. */
const SEEDING_CLAIM = /\bseed(s|ed|ing)?\b/i;

/** Claim that the daemon evaluates the removed wall-clock cap. */
const CAP_CHECK_CLAIM = /\bchecks?\b/i;
const CAP_CLOCK_TERMS = /firstClaimAt|wallClockMs/;

/** Live settings that must survive the cleanup, still documented, still unmarked. */
const LIVE_TERMS: Record<string, { term: RegExp; docs: DocName[] }> = {
  'chat hop limit': { term: /chatMaxAgentHops/, docs: ['configuration', 'schema'] },
  'reopen cap': { term: /maxReopens|MAX_REOPENS_DEFAULT/, docs: ['schema'] },
};

interface DocLine {
  /** 1-indexed, so failure messages point at a real editor line. */
  number: number;
  text: string;
}

function readDoc(name: DocName): DocLine[] {
  const file = DOCS[name];
  if (!fs.existsSync(file)) {
    throw new Error(
      `taskTimeBudgetDocs guard cannot find ${file}. This guard asserts the ` +
        `documented contract against the daemon's behaviour; a missing input ` +
        `means it is guarding nothing, so it fails instead of passing silently.`,
    );
  }
  const raw = fs.readFileSync(file, 'utf-8');
  if (raw.trim().length === 0) {
    throw new Error(`taskTimeBudgetDocs guard read ${file} but it is empty.`);
  }
  return raw.split(/\r?\n/).map((text, i) => ({ number: i + 1, text }));
}

function isRetiredAnchor(text: string): boolean {
  return RETIRED_ANCHORS.some((re) => re.test(text));
}

/**
 * The line itself plus its immediately adjacent annotation: the contiguous run
 * of comment lines directly above it, and the single line below. A JSDoc block
 * above `interface TaskBudget {` is that interface's annotation.
 */
function annotationWindow(lines: DocLine[], index: number): string[] {
  const window = [lines[index].text];
  for (let i = index - 1; i >= 0 && ANNOTATION_LINE.test(lines[i].text); i--) {
    window.push(lines[i].text);
  }
  if (index + 1 < lines.length) window.push(lines[index + 1].text);
  return window;
}

function describeHits(name: DocName, hits: DocLine[]): string {
  return hits.map((l) => `${path.basename(DOCS[name])}:${l.number}: ${l.text.trim()}`).join('\n');
}

describe('task time-budget documentation contract', () => {
  it('finds both reference documents on disk', () => {
    for (const name of Object.keys(DOCS) as DocName[]) {
      expect(readDoc(name).length, `${DOCS[name]} should have content`).toBeGreaterThan(0);
    }
  });

  for (const name of Object.keys(DOCS) as DocName[]) {
    describe(path.basename(DOCS[name]), () => {
      it('marks every retired time-budget line as deprecated', () => {
        const lines = readDoc(name);
        const unmarked = lines.filter(
          (line, i) =>
            isRetiredAnchor(line.text) &&
            !annotationWindow(lines, i).some((t) => DEPRECATION_MARKER.test(t)),
        );
        expect(
          unmarked,
          `These lines document the retired task time-budget (pacePerStepMs / ` +
            `Task.budget / TaskBudget) without a deprecation marker on the line ` +
            `or in its adjacent annotation, while schema.ts marks both DEPRECATED ` +
            `and ignored:\n${describeHits(name, unmarked)}`,
        ).toEqual([]);
      });

      it('never claims a plan submission seeds a task budget', () => {
        const lines = readDoc(name);
        const claims = lines.filter(
          (l) => SEEDING_CLAIM.test(l.text) && /budget/i.test(l.text),
        );
        expect(
          claims,
          `moe.submit_plan no longer seeds any task budget — pacePerStepMs is ` +
            `accepted and ignored:\n${describeHits(name, claims)}`,
        ).toEqual([]);
      });

      it('never claims the daemon checks a wall-clock cap', () => {
        const lines = readDoc(name);
        const claims = lines.filter(
          (l) => CAP_CHECK_CLAIM.test(l.text) && CAP_CLOCK_TERMS.test(l.text),
        );
        expect(
          claims,
          `The firstClaimAt + wallClockMs check was removed with the 80%/100% ` +
            `warn feature; no document may describe it as live:\n${describeHits(name, claims)}`,
        ).toEqual([]);
      });
    });
  }

  describe('live settings survive the cleanup', () => {
    for (const [label, { term, docs }] of Object.entries(LIVE_TERMS)) {
      for (const name of docs) {
        it(`keeps the ${label} documented and unmarked in ${path.basename(DOCS[name])}`, () => {
          const hits = readDoc(name).filter((l) => term.test(l.text));
          expect(
            hits.length,
            `The ${label} is live and must stay documented in ${DOCS[name]}.`,
          ).toBeGreaterThan(0);

          const marked = hits.filter((l) => DEPRECATION_MARKER.test(l.text));
          expect(
            marked,
            `The ${label} is a live setting, separate from the retired task ` +
              `time budget, and must not be marked deprecated:\n${describeHits(name, marked)}`,
          ).toEqual([]);
        });
      }
    }
  });
});
