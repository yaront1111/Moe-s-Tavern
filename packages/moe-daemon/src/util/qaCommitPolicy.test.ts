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
});
