// npm publishes dist (package.json files ['dist']) and both IDE bundles copy it, so compiled
// tests never belong there. The build emits through tsconfig.build.json, which leaves
// src/**/*.test.ts out, then type-checks the tests with `tsc --noEmit` over tsconfig.json.
// npm test's pretest rebuilds dist before vitest starts, so the scan reads a fresh build.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

describe('dist ships no compiled tests', () => {
  it('holds the entry point and no *.test.* or *.spec.* file', () => {
    const files = fs.readdirSync(new URL('../dist/', import.meta.url), { recursive: true, encoding: 'utf8' });
    expect(files).toContain('index.js');
    expect(files.filter((name) => /\.(?:test|spec)\./.test(name))).toEqual([]);
  });

  it('still type-checks the tests: build runs tsc --noEmit over a tsconfig that includes them', () => {
    expect(read('package.json').scripts.build.split('&&').map((step: string) => step.trim())).toContain('tsc --noEmit');
    expect(read('tsconfig.json')).toMatchObject({ include: ['src'] });
    // tsconfig.build.json's exclude replaces the base exclude instead of merging with it.
    expect(read('tsconfig.json').exclude).toBeUndefined();
  });
});
