import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import { computeDiskStateSignature, defaultGitRunner, type GitRunner } from './diskState.js';

const OID = '9f2c0a1b3d4e5f60718293a4b5c6d7e8f9012345';

function porcelain(changeLines: string[]): string {
  return [
    `# branch.oid ${OID}`,
    '# branch.head moe/work-2026-07-31',
    '# branch.upstream origin/moe/work-2026-07-31',
    '# branch.ab +2 -0',
    ...changeLines,
    '',
  ].join('\n');
}

const TWO_CHANGES = [
  '1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 packages/moe-daemon/src/tools/releaseTask.ts',
  '? packages/moe-daemon/src/util/diskState.ts',
];

/** Fake runner that records its invocation and resolves fixed stdout. */
function runnerFor(stdout: string): GitRunner & { calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = (async (args: string[], cwd: string) => {
    calls.push({ args, cwd });
    return stdout;
  }) as GitRunner & { calls: Array<{ args: string[]; cwd: string }> };
  run.calls = calls;
  return run;
}

describe('computeDiskStateSignature', () => {
  it('builds a v1 signature from the branch oid, change count, and change-line digest', async () => {
    const run = runnerFor(porcelain(TWO_CHANGES));

    const sig = await computeDiskStateSignature('D:/projexts/moes', run);

    expect(sig).toMatch(new RegExp(`^v1:${OID}:2:[0-9a-f]{12}$`));
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].args).toEqual([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '--branch',
    ]);
    expect(run.calls[0].cwd).toBe('D:/projexts/moes');
  });

  it('is stable for identical payloads and changes when a changed file changes', async () => {
    const same = await computeDiskStateSignature('/p', runnerFor(porcelain(TWO_CHANGES)));
    const sameAgain = await computeDiskStateSignature('/p', runnerFor(porcelain(TWO_CHANGES)));
    const different = await computeDiskStateSignature(
      '/p',
      runnerFor(
        porcelain([
          TWO_CHANGES[0].replace('releaseTask.ts', 'claimNextTask.ts'),
          TWO_CHANGES[1],
        ])
      )
    );

    expect(sameAgain).toBe(same);
    expect(different).not.toBe(same);
    // Same HEAD and same count — only the digest tail moved.
    expect(different).toMatch(new RegExp(`^v1:${OID}:2:`));
  });

  it('reports change count 0 for a clean tree and stays stable across calls', async () => {
    const first = await computeDiskStateSignature('/p', runnerFor(porcelain([])));
    const second = await computeDiskStateSignature('/p', runnerFor(porcelain([])));

    expect(first).toMatch(new RegExp(`^v1:${OID}:0:[0-9a-f]{12}$`));
    expect(second).toBe(first);
  });

  it('tolerates CRLF output', async () => {
    const lf = await computeDiskStateSignature('/p', runnerFor(porcelain(TWO_CHANGES)));
    const crlf = await computeDiskStateSignature(
      '/p',
      runnerFor(porcelain(TWO_CHANGES).replace(/\n/g, '\r\n'))
    );

    expect(crlf).toBe(lf);
  });

  it('returns undefined when git is not installed (ENOENT)', async () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    const run = vi.fn().mockRejectedValue(enoent);

    await expect(computeDiskStateSignature('/p', run)).resolves.toBeUndefined();
  });

  it('returns undefined when the directory is not a git repository (exit 128)', async () => {
    const notARepo = Object.assign(
      new Error('Command failed: git status\nfatal: not a git repository (or any of the parent directories): .git'),
      { code: 128 }
    );
    const run = vi.fn().mockRejectedValue(notARepo);

    await expect(computeDiskStateSignature('/p', run)).resolves.toBeUndefined();
  });

  it('returns undefined when the runner times out', async () => {
    const killed = Object.assign(new Error('Command failed: git status'), {
      killed: true,
      signal: 'SIGTERM',
    });
    const run = vi.fn().mockRejectedValue(killed);

    await expect(computeDiskStateSignature('/p', run)).resolves.toBeUndefined();
  });

  it('returns undefined for empty stdout', async () => {
    await expect(computeDiskStateSignature('/p', runnerFor(''))).resolves.toBeUndefined();
  });

  it('returns undefined when the output carries no branch.oid header', async () => {
    const noOid = ['# branch.head main', '? some/file.ts', ''].join('\n');

    await expect(computeDiskStateSignature('/p', runnerFor(noOid))).resolves.toBeUndefined();
  });

  it('never rejects when run against a real directory with the real git runner', async () => {
    // Exercises the actual subprocess path without assuming git exists or that
    // the temp dir is a repository: either outcome is acceptable, a rejection
    // is not.
    const sig = await computeDiskStateSignature(os.tmpdir(), defaultGitRunner);

    if (sig !== undefined) {
      expect(sig.startsWith('v1:')).toBe(true);
    } else {
      expect(sig).toBeUndefined();
    }
  });
});
