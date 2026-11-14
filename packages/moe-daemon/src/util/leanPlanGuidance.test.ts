// Guards the lean-plan and least-code guidance.
//
// On Moe's own board the median plan had grown to 9,700 characters of step text
// (726 plans, October-November 2026), under instructions that told architects to
// write for a reader with no access to the code and to paste the code in. The
// role docs and planning skills now ask for the simplest change in short steps.
// These assertions fail if a document drifts back (writing-plans is vendored, so
// a re-vendor would restore the old premise), if a copy in src/generated/ goes
// stale (an IDE user only ever sees the generated copy), or if a document names
// a step-text threshold other than the one submit_plan warns on.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_DOCS } from '../generated/initFiles.js';
import { SKILL_FILES } from '../generated/skillFiles.js';
import { WARN_STEP_DESCRIPTION_CHARS } from './planSize.js';

const WARN = String(WARN_STEP_DESCRIPTION_CHARS);
const FORBIDDEN = ['zero context for our codebase', 'repeat the code', 'paste code so the worker', '8-phase'];

interface Subject {
  bundle: Record<string, string>;
  key: string;
  source: string[];
  required: string[];
}

const role = (key: string, required: string[]): Subject => ({ bundle: ROLE_DOCS, key, source: ['roles', key], required });
const skill = (name: string, required: string[]): Subject => ({
  bundle: SKILL_FILES, key: `${name}/SKILL.md`, source: ['skills', name, 'SKILL.md'], required,
});

const SUBJECTS: Subject[] = [
  role('worker.md', ['Least code that meets the DoD']),
  role('architect.md', ['Plan the simplest change that meets the DoD', WARN]),
  role('architect.reference.md', [`>${WARN} a step`]),
  role('qa.md', ['Never push a worker to over-build']),
  role('governor.md', ['never block a plan, or ask for more text']),
  skill('moe-planning', ['Write only what the worker cannot get elsewhere', `past ${WARN} characters`]),
  skill('writing-plans', ['has the repository open', `warns past ${WARN}`]),
];

const here = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const docsRoot = path.resolve(here, '..', '..', '..', '..', 'docs');
const hasDocs = fs.existsSync(docsRoot);

const expectGuidance = (name: string, text: string | undefined, required: string[]): void => {
  // A missing document must fail here, not pass every `not.toContain` below.
  expect(text, `${name} is missing`).toBeTruthy();
  for (const phrase of required) expect(text, `${name} is missing "${phrase}"`).toContain(phrase);
  for (const phrase of FORBIDDEN) expect(text, `${name} still carries "${phrase}"`).not.toContain(phrase);
};

describe('lean plan guidance', () => {
  it('the generated copies carry it', () => {
    for (const s of SUBJECTS) expectGuidance(`generated ${s.key}`, s.bundle[s.key], s.required);
  });

  it.skipIf(!hasDocs)('the source documents carry it', () => {
    for (const s of SUBJECTS) {
      const file = path.join(docsRoot, ...s.source);
      expectGuidance(`docs/${s.source.join('/')}`, fs.readFileSync(file, 'utf-8'), s.required);
    }
  });

  it.skipIf(!hasDocs)('docs/MCP_SERVER.md documents the threshold submit_plan warns on', () => {
    const text = fs.readFileSync(path.join(docsRoot, 'MCP_SERVER.md'), 'utf-8');
    expect(text).toContain(`longer than ${WARN} characters (\`WARN_STEP_DESCRIPTION_CHARS\``);
  });
});
