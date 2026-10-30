// Guards the freed-seat guidance in the worker reference.
//
// The reference used to tell a worker whose own non-resource report_blocked freed
// its seat to claim the next task inside that same session, but the runtime
// answers with sessionHandoff END_SESSION and takes the next task from a fresh
// wrapper preflight. These assertions fail if the document drifts back, AND if
// the vendored copy in src/generated/ goes stale — an IDE user only ever sees
// the generated copy.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROLE_DOCS } from '../generated/initFiles.js';

const REFERENCE_KEY = 'worker.reference.md';
const STALE = '`nextAction` → `claim_next_task`';
const SENTINELS = ['sessionHandoff', 'END_SESSION', 'fresh wrapper preflight'];
const KEPT = 'Resource blocks (`resourceId`) keep the seat parked';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const docsRoot = path.resolve(here, '..', '..', '..', '..', 'docs');
const hasDocs = fs.existsSync(docsRoot);

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

describe('worker reference — a freed blocked seat ends its session', () => {
  const subjects = (): Array<[string, string | undefined]> => {
    const list: Array<[string, string | undefined]> = [
      [`ROLE_DOCS['${REFERENCE_KEY}']`, ROLE_DOCS[REFERENCE_KEY]],
    ];
    if (hasDocs) {
      list.push([
        `docs/roles/${REFERENCE_KEY}`,
        fs.readFileSync(path.join(docsRoot, 'roles', REFERENCE_KEY), 'utf-8'),
      ]);
    }
    return list;
  };

  it('directs the freed seat to END_SESSION, not an in-session claim', () => {
    for (const [label, raw] of subjects()) {
      // A missing or empty copy must fail, never pass vacuously.
      expect(typeof raw, `${label} is missing`).toBe('string');
      expect((raw ?? '').length, `${label} is empty`).toBeGreaterThan(0);
      const text = lf(raw as string);
      expect(text, `${label} still tells a freed seat to claim`).not.toContain(STALE);
      for (const sentinel of SENTINELS) {
        expect(text, `${label} lacks "${sentinel}"`).toContain(sentinel);
      }
      expect(text, `${label} lost the resource-hold guidance`).toContain(KEPT);
    }
  });
});
