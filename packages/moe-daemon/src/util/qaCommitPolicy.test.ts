// Guards the single QA rule for an empty `task.commits` at REVIEW.
//
// docs/roles/qa.md and docs/skills/moe-qa-loop/SKILL.md used to contradict each
// other ('Do NOT wait' vs 'wait for it before reviewing'), so QA behaviour was
// whichever text the agent read last. Both now state one rule: a bounded wait,
// then self-land the row's own paths. These assertions fail if either document
// drifts back, AND if the vendored copies in src/generated/ go stale — an IDE
// user only ever sees the generated copy.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_DOCS } from '../generated/initFiles.js';
import { SKILL_FILES } from '../generated/skillFiles.js';

const FORBIDDEN = ['Do NOT wait', 'wait for it before reviewing'];
const SENTINELS = ['bounded wait, not a blocker', 'up to ~2 minutes', 'land it yourself', 'record_commit'];

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

  it('records isolated-clone delivery before considering shared-tree fallback', () => {
    for (const [label, text] of [
      ...generatedSubjects(),
      [QA_REFERENCE_KEY, lf(ROLE_DOCS[QA_REFERENCE_KEY])],
      ...(hasDocs ? [...diskSubjects(), ['docs/roles/qa.reference.md', readDoc('roles', 'qa.reference.md')]] : []),
    ]) {
      expect(text, label).toContain('isolated-clone delivery');
      expect(text, label).toContain('fresh remote fetch');
      expect(text, label).toContain('record_commit');
      expect(text, label).toContain('Never self-land clone-delivered bytes');
      expect(text, label).toContain('rails permit');
    }
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

  // 2026-10-24, a project with settings.autoCommit false: worker.md said the
  // wrapper commits modifiedFiles, so a worker left its bytes in the shared tree
  // (session ended commit=none, task.commits []), and QA could not repair a clone
  // delivery whose commit carried no Moe-Session trailer.
  it('workers own commit, trailer and record_commit when the wrapper lands nothing', () => {
    for (const name of ['worker.md', 'worker.reference.md']) {
      const subjects = [lf(ROLE_DOCS[name]), ...(hasDocs ? [readDoc('roles', name)] : [])];
      for (const text of subjects) {
        expect(text, name).toContain('With `settings.autoCommit` on (the default)');
        expect(text, name).toMatch(/with `settings\.autoCommit` false/i);
        expect(text, name).toContain('Moe-Session: <value of $MOE_SESSION_ID>');
        expect(text, name).toContain('git rev-parse <sha>^{tree}');
        expect(text, name).toContain('complete_task');
        expect(text, name).toContain('QA holds a REVIEW row whose `task.commits` is empty');
      }
    }
    for (const text of [lf(ROLE_DOCS['worker.md']), ...(hasDocs ? [readDoc('roles', 'worker.md')] : [])]) {
      expect(text).toContain("role: 'worker', sessionId: $MOE_SESSION_ID");
      expect(text).not.toContain('— that list is what the wrapper commits');
    }
  });

  it('QA neither waits for nor self-lands a row when autoCommit is false', () => {
    for (const [label, text] of [...generatedSubjects(), ...(hasDocs ? diskSubjects() : [])]) {
      expect(text, label).toContain('the wrapper commits, pushes and records nothing, so skip the wait and never self-land');
      expect(text, label).toContain('hold a row whose `task.commits` is still empty');
    }
  });
});
