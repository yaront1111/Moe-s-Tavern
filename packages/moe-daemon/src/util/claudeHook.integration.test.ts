import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { initProjectTool } from '../tools/initProject.js';
import {
  CLAUDE_SETTINGS_CONTENT,
  REQUIRE_CLAIM_PS1_CONTENT,
  REQUIRE_CLAIM_SH_CONTENT,
} from './claudeHook.js';

function bashCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.MOE_TEST_BASH) candidates.push(process.env.MOE_TEST_BASH);
  if (process.platform === 'win32') {
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe'));
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  const finder = process.platform === 'win32' ? ['where.exe', ['bash']] : ['which', ['-a', 'bash']];
  const found = spawnSync(finder[0] as string, finder[1] as string[], { encoding: 'utf-8', timeout: 3000 });
  candidates.push(...found.stdout.split(/\r?\n/).filter(Boolean));
  return [...new Set(candidates)];
}

function findRunnableBash(cwd: string): string | null {
  for (const candidate of bashCandidates()) {
    const result = spawnSync(candidate, ['-lc', 'printf ok'], { cwd, encoding: 'utf-8', timeout: 3000 });
    if (result.status === 0 && result.stdout === 'ok') return candidate;
  }
  return null;
}

describe('Claude PreToolUse hook integration', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
    }
    tempDirs = [];
  });

  function makeProjectDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claude-hook-integration-'));
    tempDirs.push(dir);
    return dir;
  }

  async function initWithHook(projectPath: string) {
    const state = new StateManager({ projectPath });
    const tool = initProjectTool(state);
    await tool.handler({ projectPath, enableClaudeHook: true }, state);
  }

  function writeFakeMoeCall(projectPath: string, tasksJson: string) {
    const scriptsDir = path.join(projectPath, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const moeCallPath = path.join(scriptsDir, 'moe-call.sh');
    fs.writeFileSync(moeCallPath, `#!/usr/bin/env bash\necho '${tasksJson}'\n`);
    fs.chmodSync(moeCallPath, 0o755);
  }


  function runBashHook(projectPath: string, toolName: string) {
    const bash = findRunnableBash(projectPath);
    if (!bash) return null;
    return spawnSync(
      bash,
      ['-lc', 'MOE_WORKER_ID=worker-1 CLAUDE_PROJECT_DIR="$(pwd)" .claude/hooks/moe-require-claim.sh'],
      {
        input: JSON.stringify({ tool_name: toolName }),
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 5000,
      }
    );
  }

  function runPowerShellHook(projectPath: string, toolName: string) {
    const hookPath = path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.ps1');
    return spawnSync('pwsh', ['-NoProfile', '-File', hookPath], {
      input: JSON.stringify({ tool_name: toolName }),
      cwd: projectPath,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectPath, MOE_WORKER_ID: 'worker-1' },
      encoding: 'utf-8',
      timeout: 15000,
    });
  }

  it('init_project with enableClaudeHook writes settings and both hook scripts', async () => {
    const projectPath = makeProjectDir();

    await initWithHook(projectPath);

    expect(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8')).toBe(CLAUDE_SETTINGS_CONTENT);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.sh'), 'utf-8')).toBe(REQUIRE_CLAIM_SH_CONTENT);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.ps1'), 'utf-8')).toBe(REQUIRE_CLAIM_PS1_CONTENT);
  });

  it('bash hook blocks without a claim and allows with an active claim', { timeout: 30000 }, async () => {
    const projectPath = makeProjectDir();
    await initWithHook(projectPath);
    writeFakeMoeCall(projectPath, '{"tasks":[]}');

    const blocked = runBashHook(projectPath, 'mcp__moe__moe_start_step');
    if (!blocked) return;
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('No active claim for worker worker-1');

    writeFakeMoeCall(projectPath, '{"tasks":[{"assignedWorkerId":"worker-1","status":"WORKING"}]}');
    const allowed = runBashHook(projectPath, 'mcp__moe__moe_start_step');
    if (!allowed) return;
    expect(allowed.status).toBe(0);
  });

  it('bash hook bypasses read-only Moe tools regardless of claim state', { timeout: 15000 }, async () => {
    const projectPath = makeProjectDir();
    await initWithHook(projectPath);

    const result = runBashHook(projectPath, 'mcp__moe__moe_get_context');
    if (!result) return;

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('PowerShell hook mirrors the claim check when pwsh is available', { timeout: 30000 }, async () => {
    if (!spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf-8' }).stdout) {
      return;
    }
    const projectPath = makeProjectDir();
    if (!findRunnableBash(projectPath)) return;
    await initWithHook(projectPath);
    writeFakeMoeCall(projectPath, '{"tasks":[{"assignedWorkerId":"worker-1","status":"REVIEW"}]}');

    const result = runPowerShellHook(projectPath, 'mcp__moe__moe_complete_task');

    expect(result.status).toBe(0);
  });
});
