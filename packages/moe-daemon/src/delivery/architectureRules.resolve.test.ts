import { describe, expect, it } from 'vitest';
import { evaluateArchitecture, parseArchitectureRules, resolveImport } from './architectureRules.js';

const decoy = ['src/state.ts', 'src/state/index.ts'];

describe('resolveImport directory forms', () => {
  it.each<[string, string, string, string[], string | null]>([
    ['1 dot', 'src/state/x.ts', '.', decoy, 'src/state/index.ts'],
    ['2 dot-slash', 'src/state/x.ts', './', decoy, 'src/state/index.ts'],
    ['3 dotdot', 'src/state/sub/x.ts', '..', decoy, 'src/state/index.ts'],
    ['4 dotdot-slash', 'src/state/sub/x.ts', '../', decoy, 'src/state/index.ts'],
    ['5 trailing slash (task repro)', 'src/ui/v.ts', '../state/', decoy, 'src/state/index.ts'],
    ['6 trailing /.', 'src/ui/v.ts', '../state/.', decoy, 'src/state/index.ts'],
    ['7 trailing /..', 'src/ui/v.ts', '../state/..', ['src.ts', 'src/index.ts'], 'src/index.ts'],
    ['8 backslash trailing separator', 'src/ui/v.ts', '..\\state\\', decoy, 'src/state/index.ts'],
    ['9 decoy only', 'src/ui/v.ts', '../state/', ['src/state.ts'], null],
    ['10 exact joined path is never a candidate', 'src/ui/v.ts', '../state/', ['src/state', 'src/state/index.tsx'], 'src/state/index.tsx'],
    ['11 RESOLVE_EXTENSIONS order', 'src/ui/v.ts', '../state/', ['src/state/index.js', 'src/state/index.ts'], 'src/state/index.ts'],
    ['12 control: plain form keeps file-first', 'src/ui/v.ts', '../state', decoy, 'src/state.ts'],
    ['13 control: plain directory', 'src/x.ts', './dir', ['src/dir/index.ts'], 'src/dir/index.ts'],
  ])('%s', (_name, from, specifier, tree, expected) => {
    expect(resolveImport(from, specifier, new Set(tree))).toBe(expected);
  });
});

describe('evaluateArchitecture with a decoy sibling file', () => {
  const rules = parseArchitectureRules(JSON.stringify({
    version: 1, rules: [{ id: 'ui-no-state', from: ['src/ui'], forbid: ['src/state'], reason: 'r' }],
  }));
  const changed = [{ path: 'src/ui/v.ts', text: "import x from '../state/';" }];

  it('fails on the directory index despite the decoy', () => {
    expect(evaluateArchitecture(rules, changed, new Set(decoy))).toStrictEqual({
      outcome: 'failed',
      selectedRules: ['ui-no-state'],
      violations: [{ ruleId: 'ui-no-state', file: 'src/ui/v.ts', line: 1, specifier: '../state/', resolved: 'src/state/index.ts' }],
      uncertain: [],
    });
  });

  it('is inconclusive when only the decoy exists', () => {
    expect(evaluateArchitecture(rules, changed, new Set(['src/state.ts']))).toStrictEqual({
      outcome: 'inconclusive',
      selectedRules: ['ui-no-state'],
      violations: [],
      uncertain: [{ file: 'src/ui/v.ts', line: 1, reason: 'unresolved-relative' }],
    });
  });
});
