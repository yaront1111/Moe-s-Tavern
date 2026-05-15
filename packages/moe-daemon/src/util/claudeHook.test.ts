import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAUDE_SETTINGS_CONTENT,
  REQUIRE_CLAIM_PS1_CONTENT,
  REQUIRE_CLAIM_SH_CONTENT,
  writeClaudeHook,
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

describe('writeClaudeHook', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
          throw error;
        }
      }
    }
    tempDirs = [];
  });

  function makeProjectDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claude-hook-test-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeExecutable(filePath: string, content: string) {
    fs.writeFileSync(filePath, content);
    fs.chmodSync(filePath, 0o755);
  }


  it('writes settings and both platform hook scripts with trailing newlines', () => {
    const projectPath = makeProjectDir();

    writeClaudeHook(projectPath);

    expect(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8')).toBe(CLAUDE_SETTINGS_CONTENT);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.sh'), 'utf-8')).toBe(REQUIRE_CLAIM_SH_CONTENT);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.ps1'), 'utf-8')).toBe(REQUIRE_CLAIM_PS1_CONTENT);
    expect(CLAUDE_SETTINGS_CONTENT.endsWith('\n')).toBe(true);
    expect(REQUIRE_CLAIM_SH_CONTENT.endsWith('\n')).toBe(true);
    expect(REQUIRE_CLAIM_PS1_CONTENT.endsWith('\n')).toBe(true);
  });

  it('does not clobber existing hook script customizations', () => {
    const projectPath = makeProjectDir();
    const hooksDir = path.join(projectPath, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'moe-require-claim.sh'), '# custom sh\n');
    fs.writeFileSync(path.join(hooksDir, 'moe-require-claim.ps1'), '# custom ps1\n');

    writeClaudeHook(projectPath);

    expect(fs.readFileSync(path.join(hooksDir, 'moe-require-claim.sh'), 'utf-8')).toBe('# custom sh\n');
    expect(fs.readFileSync(path.join(hooksDir, 'moe-require-claim.ps1'), 'utf-8')).toBe('# custom ps1\n');
  });

  it('merges the PreToolUse matcher into an existing settings.json', () => {
    const projectPath = makeProjectDir();
    const claudeDir = path.join(projectPath, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'Read',
              hooks: [{ type: 'command', command: 'echo read' }],
            },
          ],
        },
      }, null, 2)
    );

    writeClaudeHook(projectPath);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(settings.hooks.PreToolUse.map((entry) => entry.matcher)).toEqual([
      'Read',
      'mcp__moe__moe_(start_step|complete_step|complete_task|submit_plan|qa_approve|qa_reject)',
    ]);
  });

  it('emits valid settings JSON scoped to ownership-sensitive Moe MCP tools', () => {
    const settings = JSON.parse(CLAUDE_SETTINGS_CONTENT) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const [entry] = settings.hooks.PreToolUse;

    expect(() => new RegExp(entry.matcher)).not.toThrow();
    expect(entry.matcher).toBe('mcp__moe__moe_(start_step|complete_step|complete_task|submit_plan|qa_approve|qa_reject)');
    expect(entry.matcher).not.toContain('get_context');
    expect(entry.matcher).not.toContain('list_tasks');
    expect(entry.hooks.map((hook) => hook.command)).toEqual([
      'bash .claude/hooks/moe-require-claim.sh',
      'pwsh -NoProfile -File .claude/hooks/moe-require-claim.ps1',
    ]);
  });

  describe('bash hook script', () => {
    function writeBashHook(projectPath: string, moeCallContent?: string): string {
      const hooksDir = path.join(projectPath, '.claude', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'moe-require-claim.sh');
      writeExecutable(hookPath, REQUIRE_CLAIM_SH_CONTENT);

      if (moeCallContent) {
        const scriptsDir = path.join(projectPath, 'scripts');
        fs.mkdirSync(scriptsDir, { recursive: true });
        writeExecutable(path.join(scriptsDir, 'moe-call.sh'), moeCallContent);
      }

      return hookPath;
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

    it('stays compact enough for hook-time readability', () => {
      expect(REQUIRE_CLAIM_SH_CONTENT.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
    });

    it('allows ungated tools without requiring a claim check', () => {
      const projectPath = makeProjectDir();
      writeBashHook(projectPath);
      const result = runBashHook(projectPath, 'mcp__moe__moe_get_context');
      if (!result) return;

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('blocks gated tools when list_tasks has no active claim', () => {
      const projectPath = makeProjectDir();
      writeBashHook(projectPath, '#!/usr/bin/env bash\necho \'{"tasks":[]}\'\n');
      const result = runBashHook(projectPath, 'mcp__moe__moe_start_step');
      if (!result) return;

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('No active claim for worker worker-1');
    });

    it('allows gated tools when list_tasks returns an active claim', () => {
      const projectPath = makeProjectDir();
      writeBashHook(projectPath, '#!/usr/bin/env bash\necho \'{"tasks":[{"assignedWorkerId":"worker-1","status":"WORKING"}]}\'\n');
      const result = runBashHook(projectPath, 'mcp__moe__moe_start_step');
      if (!result) return;

      expect(result.status).toBe(0);
    });
  });

  describe('PowerShell hook script', () => {
    function writePsHook(projectPath: string, moeCallContent?: string): string {
      const hooksDir = path.join(projectPath, '.claude', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'moe-require-claim.ps1');
      fs.writeFileSync(hookPath, REQUIRE_CLAIM_PS1_CONTENT);

      if (moeCallContent) {
        const scriptsDir = path.join(projectPath, 'scripts');
        fs.mkdirSync(scriptsDir, { recursive: true });
        writeExecutable(path.join(scriptsDir, 'moe-call.sh'), moeCallContent);
      }

      return hookPath;
    }

    function runPsHook(projectPath: string, hookPath: string, toolName: string) {
      return spawnSync('pwsh', ['-NoProfile', '-File', hookPath], {
        input: JSON.stringify({ tool_name: toolName }),
        cwd: projectPath,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectPath, MOE_WORKER_ID: 'worker-1' },
        encoding: 'utf-8',
        timeout: 15000,
      });
    }

    it('stays under the PowerShell hook line budget', () => {
      expect(REQUIRE_CLAIM_PS1_CONTENT.trimEnd().split('\n').length).toBeLessThanOrEqual(80);
    });

    it('blocks gated tools when list_tasks has no active claim', () => {
      const projectPath = makeProjectDir();
      if (!findRunnableBash(projectPath)) return;
      const hookPath = writePsHook(projectPath, '#!/usr/bin/env bash\necho \'{"tasks":[]}\'\n');

      const result = runPsHook(projectPath, hookPath, 'mcp__moe__moe_start_step');

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('No active claim for worker worker-1');
    }, 30000);

    it('allows gated tools when list_tasks returns an active claim', () => {
      const projectPath = makeProjectDir();
      if (!findRunnableBash(projectPath)) return;
      const hookPath = writePsHook(projectPath, '#!/usr/bin/env bash\necho \'{"tasks":[{"assignedWorkerId":"worker-1","status":"REVIEW"}]}\'\n');

      const result = runPsHook(projectPath, hookPath, 'mcp__moe__moe_start_step');

      expect(result.status).toBe(0);
    });
  });
});
