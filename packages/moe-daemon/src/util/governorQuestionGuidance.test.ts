// Guards the governor's open-question guidance.
//
// A governor that asks the human a question is out of moe.chat_wait until the
// answer arrives, while its heartbeat stays fresh. In November 2026, three
// governor sessions sat in open questions for 3.5 to 9 hours. Eight rows waited
// on governor moves, and one late answer was carried out on a row that had
// moved meanwhile. These assertions fail if governor.md loses the warning, or
// if the generated copy (the only one an IDE user sees) goes stale.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_DOCS } from '../generated/initFiles.js';

const REQUIRED = [
  'An open question stops your loop',
  'post in `#governors` what you are about to wait on',
  'If the premise of your question no longer holds',
];

const here = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const governorDoc = path.resolve(here, '..', '..', '..', '..', 'docs', 'roles', 'governor.md');

const expectGuidance = (name: string, text: string | undefined): void => {
  expect(text, `${name} is missing`).toBeTruthy();
  for (const phrase of REQUIRED) expect(text, `${name} is missing "${phrase}"`).toContain(phrase);
};

describe('governor open-question guidance', () => {
  it('the generated copy carries it', () => {
    expectGuidance('generated governor.md', ROLE_DOCS['governor.md']);
  });

  it.skipIf(!fs.existsSync(governorDoc))('the source document carries it', () => {
    expectGuidance('docs/roles/governor.md', fs.readFileSync(governorDoc, 'utf-8'));
  });
});
