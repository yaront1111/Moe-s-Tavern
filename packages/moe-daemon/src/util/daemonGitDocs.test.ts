import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { StateManager } from '../state/StateManager.js';
import { getTools } from '../tools/index.js';

/**
 * Doc-contract guard for the daemon's one git call.
 *
 * The docs used to say the daemon "never runs git". It runs exactly one git
 * command: `util/diskState.ts` fingerprints the working tree with a read-only
 * `git --no-optional-locks status --porcelain=v2 --branch` for handoff notes,
 * called from claim_next_task and release_task. What holds is narrower: the
 * daemon never writes git state, lands, pushes or runs the gate, and it never
 * checks a runner's report against git (docs/ARCHITECTURE.md "Delivery Path").
 *
 * The negative half scans every document, not a list of files, so the false
 * phrase cannot come back in the next doc either. The positive half ties the
 * true statement in ARCHITECTURE.md to the code it describes, so an edit of
 * either one fails here instead of drifting.
 *
 * The same rule covers the code: every registered MCP tool description (agents
 * read those in tools/list) and every non-test daemon source line. Test files
 * are skipped on purpose, because a test name such as "never touches git" can
 * be true of the one unit it tests.
 */

const utilDir = path.dirname(fileURLToPath(import.meta.url));
// src/util -> src -> moe-daemon -> packages -> repo root
const repoRoot = path.resolve(utilDir, '..', '..', '..', '..');

// ponytail: per-line scan, so a phrase wrapped across two lines slips through.
// Join the lines first if a wrapped copy ever shows up.
const NEVER_RUNS_GIT = /never (?:runs|executes|touches) git|runs no git|does not run git/i;

const GIT_STATUS_COMMAND = 'git --no-optional-locks status --porcelain=v2 --branch';
const GIT_STATUS_ARGS_SOURCE = "['--no-optional-locks', 'status', '--porcelain=v2', '--branch']";

const SRC = 'packages/moe-daemon/src';

const WHAT_HOLDS =
  'It runs one read-only `git status` (util/diskState.ts) for handoff ' +
  'fingerprints. Say what holds instead: it never writes git state, lands, ' +
  'pushes or runs the gate, and never checks a report against git.';

/** CLAUDE.md plus every Markdown file under docs/, as repo-relative forward-slash paths. */
function docFiles(): string[] {
  const docs = fs
    .readdirSync(path.join(repoRoot, 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file.split(path.sep).join('/')}`);
  return ['CLAUDE.md', ...docs];
}

/** Every non-test .ts file under the daemon's src/, as src-relative forward-slash paths. */
function sourceFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, SRC), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => file.split(path.sep).join('/'));
}

/** Throws on a missing file: a guard with no input must fail, not pass. */
function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf-8');
}

/** `label:line` for every line of `text` that says the daemon never runs git. */
function neverRunsGitLines(label: string, text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, i) => (NEVER_RUNS_GIT.test(line) ? [`${label}:${i + 1}`] : []));
}

describe('daemon git documentation contract', () => {
  it('no doc says the daemon never runs git', () => {
    const files = docFiles();
    // A scan that finds nothing would pass vacuously. docs/roles/worker.md
    // proves the walk goes below docs/.
    expect(files).toEqual(
      expect.arrayContaining([
        'CLAUDE.md',
        'docs/ARCHITECTURE.md',
        'docs/CONFIGURATION.md',
        'docs/DEVELOPMENT.md',
        'docs/MCP_SERVER.md',
        'docs/SCHEMA.md',
        'docs/roles/worker.md',
      ]),
    );

    const hits = files.flatMap((file) => neverRunsGitLines(file, read(file)));
    expect(hits, `These lines say the daemon never runs git. ${WHAT_HOLDS}`).toEqual([]);
  });

  it('no registered tool description says the daemon never runs git', () => {
    const tools = getTools(new StateManager({ projectPath: os.tmpdir() }));
    // An empty registry would pass vacuously; these two tools once said it.
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['moe.record_candidate', 'moe.record_delivery_receipt']),
    );

    // Property descriptions inside inputSchema reach agents too.
    const hits = tools
      .filter(
        (tool) =>
          NEVER_RUNS_GIT.test(tool.description) ||
          NEVER_RUNS_GIT.test(JSON.stringify(tool.inputSchema)),
      )
      .map((tool) => tool.name);
    expect(
      hits,
      `These tool descriptions, which agents read in tools/list, say the daemon never runs git. ${WHAT_HOLDS}`,
    ).toEqual([]);
  });

  it('no daemon source comment says the daemon never runs git', () => {
    const files = sourceFiles();
    // An empty or non-recursive walk would pass vacuously; each of these sits
    // in a subdirectory of src/.
    expect(files).toEqual(
      expect.arrayContaining([
        'delivery/policy.ts',
        'state/candidateStore.ts',
        'tools/recordCandidate.ts',
        'util/diskState.ts',
      ]),
    );

    const hits = files.flatMap((file) => neverRunsGitLines(file, read(`${SRC}/${file}`)));
    expect(hits, `These daemon source lines say the daemon never runs git. ${WHAT_HOLDS}`).toEqual([]);
  });

  it('the architecture doc names the one read-only git call, exactly as util/diskState.ts runs it', () => {
    expect(read('docs/ARCHITECTURE.md')).toContain(GIT_STATUS_COMMAND);
    expect(read('packages/moe-daemon/src/util/diskState.ts')).toContain(GIT_STATUS_ARGS_SOURCE);
  });
});
