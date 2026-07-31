import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Structural guards for the state/ split. These do not test behaviour — the
// behavioural coverage lives in each module's own suite — they stop the split
// from silently rotting back into one god file or into a runtime import cycle.

const STATE_DIR = path.join(process.cwd(), 'src', 'state');
const STATE_MANAGER = path.join(STATE_DIR, 'StateManager.ts');
const MAX_STATE_MANAGER_LINES = 1500;

const EXTRACTED_MODULES = [
  'validators',
  'persistence',
  'activityLog',
  'chatStore',
  'teamStore',
  'sweeps',
  'taskStore',
  'workerStore',
];

/** Read a file, failing the assertion with the offending path instead of a bare ENOENT. */
function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${path.relative(process.cwd(), filePath)}: ${reason}`);
  }
}

/**
 * Relative imports that survive to RUNTIME.
 *
 * Type-only imports must be skipped, in both spellings — a whole-clause
 * `import type { X } from './y.js'` and an inline `import { type X } from
 * './y.js'`. Every extracted module does `import type { StateManager }` while
 * StateManager imports that module for real; TypeScript erases the type side,
 * so counting it would make the cycle test fail on the very design it guards.
 */
function runtimeLocalImports(source: string): string[] {
  const out: string[] = [];
  // Anchored per statement and forbidding a nested `import`: a lazy [\s\S]*?
  // happily spans from `import fs from 'fs'` to the NEXT relative specifier,
  // which reports a type-only import as a runtime one and invents a cycle.
  const importRe = /^import\s+(type\s+)?((?:(?!\bimport\b)[\s\S])*?)from\s+'(\.[^']*)'/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const [, typeKeyword, clause, specifier] = match;
    if (typeKeyword) continue; // import type { ... } from './x.js'
    const bindings = clause.trim();
    // `import { type A, type B } from './x.js'` is also fully erased.
    const names = bindings.replace(/^\{|\}$/g, '').split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    out.push(specifier);
  }
  return out;
}

function moduleNameOf(specifier: string): string {
  return path.basename(specifier).replace(/\.js$/, '');
}

function buildStateGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const files = fs.readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  for (const file of files) {
    const name = file.replace(/\.ts$/, '');
    const source = readFile(path.join(STATE_DIR, file));
    // Scope to src/state/** only. StateManager's ../tools/* edges are
    // pre-existing and belong to submit_plan / wait_for_task, not to this split.
    const edges = runtimeLocalImports(source)
      .filter((spec) => !spec.includes('/'.concat('..')) && !spec.startsWith('../'))
      .map(moduleNameOf)
      .filter((dep) => files.includes(`${dep}.ts`));
    graph.set(name, edges);
  }
  return graph;
}

/** First cycle found, as a readable path, or null. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  function walk(node: string): string[] | null {
    if (done.has(node)) return null;
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return null;
}

describe('state module split', () => {
  it('keeps StateManager.ts under the size budget', () => {
    const lineCount = readFile(STATE_MANAGER).split('\n').length;
    expect(
      lineCount,
      `StateManager.ts is ${lineCount} lines (budget ${MAX_STATE_MANAGER_LINES}). ` +
      'Extract the new concern into its own src/state module instead of growing this file.'
    ).toBeLessThan(MAX_STATE_MANAGER_LINES);
  });

  it('has no runtime import cycles inside src/state', () => {
    const graph = buildStateGraph();
    // Sanity: the graph must actually have edges, otherwise this test passes vacuously.
    expect([...graph.values()].some((edges) => edges.length > 0)).toBe(true);

    const cycle = findCycle(graph);
    expect(
      cycle,
      cycle ? `Runtime import cycle in src/state: ${cycle.join(' -> ')}` : ''
    ).toBeNull();
  });

  it('keeps every extracted module present and named for one concern', () => {
    for (const name of EXTRACTED_MODULES) {
      const modulePath = path.join(STATE_DIR, `${name}.ts`);
      expect(fs.existsSync(modulePath), `missing extracted module src/state/${name}.ts`).toBe(true);
    }
  });
});
