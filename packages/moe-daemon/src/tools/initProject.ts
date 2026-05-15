import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { writeInitFiles } from '../util/initFiles.js';
import { writeSkillFiles } from '../util/skillFiles.js';
import { writeClaudeHook } from '../util/claudeHook.js';
import { resolveMemorySettings } from '../util/memorySettings.js';

export function initProjectTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.init_project',
    description: 'Initialize a Moe project by creating .moe folder structure. If project is already initialized, returns current status.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to project root (defaults to current project)' },
        name: { type: 'string', description: 'Project name (defaults to folder name)' },
        force: { type: 'boolean', description: 'Force re-initialization if already exists' },
        enableClaudeHook: {
          type: 'boolean',
          description: 'Opt in to emitting Claude Code PreToolUse hook files (default: false)'
        }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        projectPath?: string;
        name?: string;
        force?: boolean;
        enableClaudeHook?: boolean;
      };

      const projectPath = params.projectPath || state.projectPath;
      const moePath = path.join(projectPath, '.moe');

      // Check if already initialized
      if (fs.existsSync(moePath)) {
        if (!params.force) {
          const projectFile = path.join(moePath, 'project.json');
          if (fs.existsSync(projectFile)) {
            const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
            const hookResult = params.enableClaudeHook ? writeClaudeHook(projectPath) : null;
            return {
              success: true,
              alreadyInitialized: true,
              project: {
                id: project.id,
                name: project.name,
                rootPath: project.rootPath
              },
              message: 'Project already initialized. Use force:true to re-initialize.',
              ...(hookResult ? { claudeHook: hookResult, notes: buildClaudeHookNotes(projectPath, hookResult) } : {})
            };
          }
        }
      }

      // Create directory structure
      const dirs = ['epics', 'tasks', 'workers', 'proposals', 'roles', 'channels', 'messages', 'pins', 'decisions'];
      fs.mkdirSync(moePath, { recursive: true });
      for (const dir of dirs) {
        fs.mkdirSync(path.join(moePath, dir), { recursive: true });
      }

      // Generate project ID
      const projectId = `proj-${crypto.randomUUID().slice(0, 8)}`;
      const name = params.name || path.basename(projectPath);

      // Create project.json
      const project = {
        id: projectId,
        schemaVersion: 6,
        name,
        rootPath: projectPath,
        globalRails: {
          techStack: [],
          forbiddenPatterns: [],
          requiredPatterns: [],
          formatting: '',
          testing: '',
          customRules: []
        },
        settings: {
          approvalMode: 'CONTROL',
          speedModeDelayMs: 2000,
          autoCreateBranch: true,
          branchPattern: 'moe/{epicId}/{taskId}',
          commitPattern: 'feat({epicId}): {taskTitle}',
          agentCommand: 'claude',
          enableAgentTeams: false,
          chatEnabled: true,
          chatMaxAgentHops: 4,
          memory: resolveMemorySettings(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      fs.writeFileSync(
        path.join(moePath, 'project.json'),
        JSON.stringify(project, null, 2)
      );

      // Create empty activity.log
      fs.writeFileSync(path.join(moePath, 'activity.log'), '');

      // Create default "general" chat channel
      const channelId = `chan-${crypto.randomUUID().slice(0, 8)}`;
      const generalChannel = {
        id: channelId,
        name: 'general',
        type: 'general',
        linkedEntityId: null,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(
        path.join(moePath, 'channels', `${channelId}.json`),
        JSON.stringify(generalChannel, null, 2)
      );
      fs.writeFileSync(path.join(moePath, 'messages', `${channelId}.jsonl`), '');

      // Create role-based channels: #workers, #architects, #qa, #governors
      for (const roleName of ['workers', 'architects', 'qa', 'governors']) {
        const roleChannelId = `chan-${crypto.randomUUID().slice(0, 8)}`;
        const roleChannel = {
          id: roleChannelId,
          name: roleName,
          type: 'role',
          linkedEntityId: null,
          createdAt: new Date().toISOString()
        };
        fs.writeFileSync(
          path.join(moePath, 'channels', `${roleChannelId}.json`),
          JSON.stringify(roleChannel, null, 2)
        );
        fs.writeFileSync(path.join(moePath, 'messages', `${roleChannelId}.jsonl`), '');
      }

      // Write role docs and .gitignore
      writeInitFiles(moePath);

      // Write the curated skill pack (.moe/skills/<name>/SKILL.md + manifest)
      writeSkillFiles(moePath);

      // Write optional Claude Code PreToolUse hook files only when explicitly
      // requested. Phase 6 is defense-in-depth; init_project must not impose
      // Claude-specific hooks on projects by default.
      const hookResult = params.enableClaudeHook ? writeClaudeHook(projectPath) : null;

      return {
        success: true,
        alreadyInitialized: false,
        project: {
          id: projectId,
          name,
          rootPath: projectPath
        },
        message: `Project initialized at ${projectPath}`,
        ...(hookResult ? { claudeHook: hookResult, notes: buildClaudeHookNotes(projectPath, hookResult) } : {})
      };
    }
  };
}

function buildClaudeHookNotes(projectPath: string, hookResult: ReturnType<typeof writeClaudeHook>): string[] {
  const hookNotes: string[] = [];

  // Build a hook-status line for the success message so the user knows
  // whether the hook is active and how to opt out.
  if (hookResult.settingsWritten || hookResult.hookWritten) {
    hookNotes.push(`Claude Code PreToolUse hook installed at ${projectPath}/.claude/`);
  }
  if (hookResult.settingsMerged) {
    hookNotes.push(`Merged Moe PreToolUse matcher into existing .claude/settings.json`);
  }
  if (hookResult.settingsSkippedReason === 'invalid-json') {
    hookNotes.push(`Preserved invalid .claude/settings.json — fix it and rerun init_project if you want claim-gating`);
  }
  if (hookResult.settingsSkippedReason === 'write-failed') {
    hookNotes.push(`Could not write .claude/settings.json — see daemon logs`);
  }
  if (hookResult.hookSkippedReason === 'user-modified') {
    hookNotes.push(`Preserved user-modified .claude/hooks/moe-require-claim.sh/.ps1 — delete to accept the Moe-canonical version`);
  }
  if (hookNotes.length === 0) {
    hookNotes.push(`Claude Code hook already up-to-date`);
  }

  return hookNotes;
}
