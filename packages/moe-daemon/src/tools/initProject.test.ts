import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../state/StateManager.js';
import { initProjectTool } from './initProject.js';
import {
  CLAUDE_SETTINGS_CONTENT,
  REQUIRE_CLAIM_PS1_CONTENT,
  REQUIRE_CLAIM_SH_CONTENT,
} from '../util/claudeHook.js';

describe('moe.init_project Claude hook opt-in', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function makeProjectDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-init-project-test-'));
    tempDirs.push(dir);
    return dir;
  }

  async function initProject(projectPath: string, args: Record<string, unknown> = {}) {
    const state = new StateManager({ projectPath });
    const tool = initProjectTool(state);
    return tool.handler({ projectPath, ...args }, state);
  }

  it('declares enableClaudeHook as an optional boolean input', () => {
    const state = new StateManager({ projectPath: makeProjectDir() });
    const tool = initProjectTool(state);
    const schema = tool.inputSchema as { properties: Record<string, unknown> };

    expect(schema.properties.enableClaudeHook).toMatchObject({
      type: 'boolean',
    });
  });

  it('does not emit Claude hook files when enableClaudeHook is omitted', async () => {
    const projectPath = makeProjectDir();

    await initProject(projectPath);

    expect(fs.existsSync(path.join(projectPath, '.claude'))).toBe(false);
  });

  it('emits Claude hook files when enableClaudeHook is true', async () => {
    const projectPath = makeProjectDir();

    await initProject(projectPath, { enableClaudeHook: true });

    expect(fs.existsSync(path.join(projectPath, '.claude', 'settings.json'))).toBe(true);
  });

  it('adds Claude hook files to an already-initialized project without reinitializing .moe', async () => {
    const projectPath = makeProjectDir();
    await initProject(projectPath, { name: 'Original Project' });
    const projectJsonPath = path.join(projectPath, '.moe', 'project.json');
    const originalProjectJson = fs.readFileSync(projectJsonPath, 'utf-8');

    const result = await initProject(projectPath, { enableClaudeHook: true }) as {
      alreadyInitialized: boolean;
      claudeHook?: { settingsWritten?: boolean; shHookWritten?: boolean; ps1HookWritten?: boolean };
    };

    expect(result.alreadyInitialized).toBe(true);
    expect(result.claudeHook).toMatchObject({
      settingsWritten: true,
      shHookWritten: true,
      ps1HookWritten: true,
    });
    expect(fs.readFileSync(projectJsonPath, 'utf-8')).toBe(originalProjectJson);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf-8')).toBe(CLAUDE_SETTINGS_CONTENT);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.sh'), 'utf-8')).toBe(REQUIRE_CLAIM_SH_CONTENT);
    expect(fs.readFileSync(path.join(projectPath, '.claude', 'hooks', 'moe-require-claim.ps1'), 'utf-8')).toBe(REQUIRE_CLAIM_PS1_CONTENT);
  });
});
