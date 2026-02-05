import type { ToolDefinition } from './index.js';
import type { StateManager } from '../state/StateManager.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function initProjectTool(_state: StateManager): ToolDefinition {
  return {
    name: 'moe.init_project',
    description: 'Initialize a Moe project by creating .moe folder structure. If project is already initialized, returns current status.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Path to project root (defaults to current project)' },
        name: { type: 'string', description: 'Project name (defaults to folder name)' },
        force: { type: 'boolean', description: 'Force re-initialization if already exists' }
      },
      additionalProperties: false
    },
    handler: async (args, state) => {
      const params = (args || {}) as {
        projectPath?: string;
        name?: string;
        force?: boolean;
      };

      const projectPath = params.projectPath || state.projectPath;
      const moePath = path.join(projectPath, '.moe');

      // Check if already initialized
      if (fs.existsSync(moePath)) {
        if (!params.force) {
          const projectFile = path.join(moePath, 'project.json');
          if (fs.existsSync(projectFile)) {
            const project = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
            return {
              success: true,
              alreadyInitialized: true,
              project: {
                id: project.id,
                name: project.name,
                rootPath: project.rootPath
              },
              message: 'Project already initialized. Use force:true to re-initialize.'
            };
          }
        }
      }

      // Create directory structure
      const dirs = ['epics', 'tasks', 'workers', 'proposals', 'roles'];
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
          commitPattern: 'feat({epicId}): {taskTitle}'
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

      return {
        success: true,
        alreadyInitialized: false,
        project: {
          id: projectId,
          name,
          rootPath: projectPath
        },
        message: `Project initialized at ${projectPath}`
      };
    }
  };
}
