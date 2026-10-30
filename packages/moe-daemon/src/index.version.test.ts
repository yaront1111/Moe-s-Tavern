import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from './util/version.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const entrypoint = fileURLToPath(new URL('./index.ts', import.meta.url));
let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-cli-version-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe('daemon version CLI', () => {
  it.each(['--version', '-v', 'version'])('%s prints only the package version without initializing a project', (flag) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint, flag], {
      cwd: packageRoot,
      env: { ...process.env, MOE_PROJECT_PATH: project },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(fs.readdirSync(project)).toEqual([]);
  });
});
