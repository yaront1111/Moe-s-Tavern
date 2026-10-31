// Guards the single QA rule for an empty `task.commits` at REVIEW.
//
// docs/roles/qa.md and docs/skills/moe-qa-loop/SKILL.md used to contradict each
// other ('Do NOT wait' vs 'wait for it before reviewing'), so QA behaviour was
// whichever text the agent read last. Both now state one rule: a bounded wait,
// then, with no completion entry for the round and no isolated-clone delivery,
// a moe.qa_reject citing the landing evidence — in either mode (shared, or
// worktree mode where the control checkout's HEAD is refs/heads/moe/control).
// QA never commits in the control checkout: the agent Git-write guard refuses
// it (MOE_AGENT_GIT_REFUSED) and the wrapper is the only Git-write actor.
// These assertions fail if any document drifts back, AND if the vendored
// copies in src/generated/ go stale — an IDE user only ever sees the
// generated copy.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_DOCS } from '../generated/initFiles.js';
import { SKILL_FILES } from '../generated/skillFiles.js';

const FORBIDDEN = ['Do NOT wait', 'wait for it before reviewing'];
const SENTINELS = ['bounded wait, not a blocker', 'up to ~2 minutes', 'record_commit'];
// The empty-ledger route, identical in both modes: reject, never a QA commit.
const ROUTE_SENTINELS = [
  'refs/heads/moe/control',
  'commit in the control checkout',
  'in either mode',
  'MOE_AGENT_GIT_REFUSED',
  'lastCommitOutcome',
  'counts toward the reopen cap',
  'Landing gap:',
  '#governors',
];
// 'shared mode only' pinned the shared-mode self-landing that the agent
// Git-write guard made impossible, so it retires with that self-landing.
const RETIRED = [
  'land it yourself',
  'you self-landed',
  'shared mode only',
  'path recipe',
  'Bash(git add:',
  'Bash(git commit:',
  'MOE_ALLOW_AGENT_GIT_WRITES',
  '--no-verify',
];

const QA_ROLE_KEY = 'qa.md';
const QA_REFERENCE_KEY = 'qa.reference.md';
const QA_SKILL_KEY = 'moe-qa-loop/SKILL.md';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const docsRoot = path.resolve(here, '..', '..', '..', '..', 'docs');
const hasDocs = fs.existsSync(docsRoot);

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const readDoc = (...segments: string[]): string =>
  lf(fs.readFileSync(path.join(docsRoot, ...segments), 'utf-8'));

describe('QA empty-task.commits policy — the two documents agree', () => {
  // Without this, a renamed skill directory or a dropped ROLE_DOCS key would
  // turn every assertion below into a vacuous pass on `undefined`.
  it('vendors both QA policy documents under the expected keys', () => {
    for (const [label, text] of [
      [`ROLE_DOCS['${QA_ROLE_KEY}']`, ROLE_DOCS[QA_ROLE_KEY]],
      [`ROLE_DOCS['${QA_REFERENCE_KEY}']`, ROLE_DOCS[QA_REFERENCE_KEY]],
      [`SKILL_FILES['${QA_SKILL_KEY}']`, SKILL_FILES[QA_SKILL_KEY]],
    ] as const) {
      expect(typeof text, `${label} is missing from the generated bundle`).toBe('string');
      expect((text ?? '').length, `${label} is empty`).toBeGreaterThan(0);
    }
  });

  const generatedSubjects = (): Array<[string, string]> => [
    [`ROLE_DOCS['${QA_ROLE_KEY}']`, lf(ROLE_DOCS[QA_ROLE_KEY])],
    [`SKILL_FILES['${QA_SKILL_KEY}']`, lf(SKILL_FILES[QA_SKILL_KEY])],
  ];

  const diskSubjects = (): Array<[string, string]> => [
    ['docs/roles/qa.md', readDoc('roles', 'qa.md')],
    ['docs/skills/moe-qa-loop/SKILL.md', readDoc('skills', 'moe-qa-loop', 'SKILL.md')],
  ];

  it('drops the contradictory phrases from the generated copies', () => {
    for (const [label, text] of generatedSubjects()) {
      for (const phrase of FORBIDDEN) {
        expect(text, `${label} still carries "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it.skipIf(!hasDocs)('drops the contradictory phrases from the source documents', () => {
    for (const [label, text] of diskSubjects()) {
      for (const phrase of FORBIDDEN) {
        expect(text, `${label} still carries "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  // The positive half: fails if a future edit deletes the rule instead of
  // restating it, and fails if a generated copy is stale (it would still hold
  // the old text while the source already holds the new one).
  it('states the reconciled rule in the generated copies', () => {
    for (const [label, text] of generatedSubjects()) {
      for (const sentinel of SENTINELS) {
        expect(text, `${label} is missing the rule phrase "${sentinel}"`).toContain(sentinel);
      }
    }
  });

  it.skipIf(!hasDocs)('states the reconciled rule in the source documents', () => {
    for (const [label, text] of diskSubjects()) {
      for (const sentinel of SENTINELS) {
        expect(text, `${label} is missing the rule phrase "${sentinel}"`).toContain(sentinel);
      }
    }
  });

  it('anchors the rule to the 2026-09-06 measurement in the QA reference doc', () => {
    const reference = lf(ROLE_DOCS[QA_REFERENCE_KEY]);
    expect(reference).toContain('2026-09-06');
    expect(reference).toContain('one completion in three');
  });

  const allQaSubjects = (): Array<[string, string]> => [
    ...generatedSubjects(),
    [QA_REFERENCE_KEY, lf(ROLE_DOCS[QA_REFERENCE_KEY])],
    ...(hasDocs
      ? [...diskSubjects(), ['docs/roles/qa.reference.md', readDoc('roles', 'qa.reference.md')] as [string, string]]
      : []),
  ];

  it('records isolated-clone delivery before the empty-ledger reject', () => {
    for (const [label, text] of allQaSubjects()) {
      expect(text, label).toContain('isolated-clone delivery');
      expect(text, label).toContain('fresh remote fetch');
      expect(text, label).toContain('record_commit');
      expect(text, label).toContain('Never self-land clone-delivered bytes');
      expect(text, label).toContain('rails permit');
    }
  });

  // The agent Git-write guard refuses a QA commit in the control checkout in
  // both modes, so every QA document, source and vendored, must route an empty
  // ledger to moe.qa_reject and must not teach a QA commit or a guard bypass.
  it('rejects an empty ledger in either mode and never teaches a QA commit', () => {
    for (const [label, text] of allQaSubjects()) {
      for (const phrase of ROUTE_SENTINELS) {
        expect(text, `${label} is missing the route phrase "${phrase}"`).toContain(phrase);
      }
      for (const phrase of RETIRED) {
        expect(text, `${label} still carries the retired phrase "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it.skipIf(!hasDocs)('troubleshooting sends QA to the reject, not a self-land', () => {
    const doc = readDoc('TROUBLESHOOTING.md');
    const heading = '### `qa_approve` returned `NO-COMPLETION-COMMIT`';
    const start = doc.indexOf(heading);
    expect(start, `TROUBLESHOOTING.md is missing the heading ${heading}`).toBeGreaterThanOrEqual(0);
    const end = doc.indexOf('\n### ', start + heading.length);
    const section = doc.slice(start, end === -1 ? undefined : end);
    expect(section).toContain('moe.qa_reject');
    expect(section).toContain('#agent-git-write-refusal');
    expect(doc).not.toContain('then a self-land');
    expect(doc).not.toContain('landed the row itself');
  });

  it('workers explicitly own the isolated-clone ledger exception', () => {
    for (const name of ['worker.md', 'worker.reference.md']) {
      const subjects = [lf(ROLE_DOCS[name]), ...(hasDocs ? [readDoc('roles', name)] : [])];
      for (const text of subjects) {
        expect(text, name).toContain('isolated-clone delivery');
        expect(text, name).toContain('moe.record_commit');
        expect(text, name).toContain('fresh remote fetch');
        expect(text, name).toContain('sessionId');
        expect(text, name).not.toContain('are wrapper-called — do not call them yourself');
      }
    }
  });
});
