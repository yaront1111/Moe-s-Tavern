import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { StateManager } from '../state/StateManager.js';
import { getTools } from '../tools/index.js';

/**
 * Doc-contract guard for the retired task time-budget feature.
 *
 * `src/types/schema.ts` marks `settings.pacePerStepMs` and `Task.budget`
 * DEPRECATED and ignored — the 80%/100% warn+escalate clock was removed. The
 * reference docs must say the same thing, or a reader is told a dead control
 * is live. This test reads the documents off disk and asserts the documented
 * contract matches the daemon's actual behaviour.
 *
 * It deliberately does NOT search for the bare word "budget": the reopen cap
 * ("reopen budget"), the chat hop limit and several token budgets are live
 * settings that share the vocabulary. The negative half anchors on the retired
 * identifiers only; the positive half asserts the live settings stay documented
 * and unmarked, so an over-eager later cleanup fails here instead of shipping.
 *
 * `docs/MCP_SERVER.md` carried the same retirement one step further: it
 * documented a whole `moe.set_task_budget` tool that `getTools()` never
 * registered, and an unregistered tool is silently invisible over MCP — an
 * agent following the doc reads its own bad call as a daemon fault. So this
 * guard also walks that document's tool headings against the live registry,
 * generically rather than by name, and the next retired tool is caught too.
 */

const utilDir = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const repoRoot = path.resolve(utilDir, '..', '..', '..', '..');

const DOCS = {
  configuration: path.join(repoRoot, 'docs', 'CONFIGURATION.md'),
  schema: path.join(repoRoot, 'docs', 'SCHEMA.md'),
  mcpServer: path.join(repoRoot, 'docs', 'MCP_SERVER.md'),
} as const;

type DocName = keyof typeof DOCS;

/** A deprecation marker anywhere in the line's text. */
const DEPRECATION_MARKER = /\bdeprecated\b/i;

/**
 * Lines that document the retired setting, field, or interface.
 *
 * `budget.wallClockMs` is qualified deliberately: bare `wallClockMs` is also
 * `TaskMetrics.wallClockMs`, a LIVE counter populated on `moe.qa_approve`, so
 * an unqualified anchor would condemn a field that still exists.
 */
const RETIRED_ANCHORS: RegExp[] = [
  /pacePerStepMs/,
  /TaskBudget/,
  /task\.budget/,
  /budget\.wallClockMs/,
  /^\s*(?:\*\s*)?budget\?:/,
];

/** A comment/annotation line that can carry a neighbouring member's marker. */
const ANNOTATION_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** Claim that a plan submission seeds a task budget, in any tense. */
const SEEDING_CLAIM = /\bseed(s|ed|ing)?\b/i;

/** Claim that the daemon evaluates the removed wall-clock cap. */
const CAP_CHECK_CLAIM = /\bchecks?\b/i;
const CAP_CLOCK_TERMS = /firstClaimAt|wallClockMs/;

/**
 * A documented MCP tool section heading. Every tool section in MCP_SERVER.md
 * is `### moe.<name>`; the wider level range catches a retired tool demoted or
 * promoted to another heading depth rather than deleted.
 */
const TOOL_HEADING = /^#{2,6}\s+(moe\.[a-z_]+)\s*$/;

/**
 * Live settings that must survive the cleanup, still documented, still
 * unmarked. `minHits` guards a term that must appear more than once — the two
 * `maxDescriptionChars` token budgets are byte-identical lines, so a check for
 * mere presence would not notice one of them being scrubbed.
 */
const LIVE_TERMS: Record<string, { term: RegExp; docs: DocName[]; minHits?: number }> = {
  'chat hop limit': { term: /chatMaxAgentHops/, docs: ['configuration', 'schema'] },
  'reopen cap': { term: /maxReopens|MAX_REOPENS_DEFAULT/, docs: ['schema'] },
  'summary preview token budget': {
    term: /summary preview budget/,
    docs: ['mcpServer'],
    minHits: 2,
  },
  'token-budgeted context window': {
    term: /token-budgeted/,
    docs: ['mcpServer'],
    minHits: 2,
  },
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
    for (const [label, { term, docs, minHits }] of Object.entries(LIVE_TERMS)) {
      for (const name of docs) {
        it(`keeps the ${label} documented and unmarked in ${path.basename(DOCS[name])}`, () => {
          const hits = readDoc(name).filter((l) => term.test(l.text));
          const required = minHits ?? 1;
          expect(
            hits.length,
            `The ${label} is live and must stay documented in ${DOCS[name]} on ` +
              `at least ${required} line(s); found ${hits.length}.`,
          ).toBeGreaterThanOrEqual(required);

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

  describe('MCP_SERVER.md tool sections match the registry', () => {
    /**
     * `getTools()` is the only registry, and every factory in it closes over
     * the StateManager rather than reading it, so a bare instance over a
     * throwaway path is enough to enumerate names. Nothing is written: the
     * constructor only joins paths, and `load()` is never called.
     */
    function registeredToolNames(): Set<string> {
      const state = new StateManager({ projectPath: os.tmpdir() });
      const names = getTools(state).map((tool) => tool.name);
      if (names.length === 0) {
        throw new Error(
          'taskTimeBudgetDocs guard got an empty tool registry from getTools(). ' +
            'That cannot be right, and an empty registry would make the ' +
            'documented-tool comparison below pass vacuously.',
        );
      }
      return new Set(names);
    }

    function documentedToolHeadings(): DocLine[] {
      return readDoc('mcpServer').filter((line) => TOOL_HEADING.test(line.text));
    }

    it('reads a non-empty tool registry and a non-empty heading list', () => {
      expect(registeredToolNames().size).toBeGreaterThan(0);
      expect(documentedToolHeadings().length).toBeGreaterThan(0);
    });

    it('documents no tool that getTools() does not register', () => {
      const registered = registeredToolNames();
      const orphans = documentedToolHeadings().filter(
        (line) => !registered.has(line.text.match(TOOL_HEADING)![1]),
      );
      expect(
        orphans,
        `docs/MCP_SERVER.md has a tool section for a name that getTools() in ` +
          `src/tools/index.ts does not register. An unregistered tool is ` +
          `silently invisible over MCP, so an agent following the doc calls a ` +
          `tool that is not there and reads the failure as a daemon fault. ` +
          `Delete the section (or register the tool):\n` +
          `${describeHits('mcpServer', orphans)}`,
      ).toEqual([]);
    });
  });
});
