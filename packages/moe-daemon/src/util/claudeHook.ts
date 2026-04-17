import fs from 'fs';
import path from 'path';

/**
 * Emits Claude Code hook artifacts into the target project:
 *  - .claude/settings.json  (registers a PreToolUse hook on Edit/Write/Bash)
 *  - .claude/hooks/moe-require-claim.js  (the hook body — cross-platform node)
 *
 * The hook is opt-in: it does nothing unless both MOE_WORKER_ID is set in the
 * environment AND the project has a .moe/ directory. That way Claude Code
 * sessions running outside Moe are unaffected.
 *
 * Runtime contract: the hook blocks Edit/Write/Bash unless the worker identified
 * by MOE_WORKER_ID currently owns (task.assignedWorkerId) a task in PLANNING,
 * WORKING, or REVIEW. Claim via moe.claim_next_task to clear the block.
 */

const SETTINGS_JSON = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/moe-require-claim.js\\""
          }
        ]
      }
    ]
  }
}
`;

const HOOK_JS = `#!/usr/bin/env node
// PreToolUse hook for Claude Code + Moe.
// Blocks Edit/Write/Bash unless the current worker has an active claim on a
// task in PLANNING, WORKING, or REVIEW. Emitted by moe.init_project; safe to
// delete if you do not want the hook.
//
// Exits:
//   0  = allow the tool
//   2  = block (stderr is shown to the model)
const fs = require('fs');
const path = require('path');

const workerId = process.env.MOE_WORKER_ID;
if (!workerId) {
  // No Moe worker context (user is running Claude Code directly, not via moe-agent).
  process.exit(0);
}

const projectRoot =
  process.env.MOE_PROJECT_PATH ||
  process.env.CLAUDE_PROJECT_DIR ||
  process.cwd();

const tasksDir = path.join(projectRoot, '.moe', 'tasks');
if (!fs.existsSync(tasksDir)) {
  // Not a Moe-initialized project.
  process.exit(0);
}

const ACTIVE_STATUSES = new Set(['PLANNING', 'WORKING', 'REVIEW']);
let hasClaim = false;

try {
  for (const file of fs.readdirSync(tasksDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(tasksDir, file), 'utf-8');
      const task = JSON.parse(raw);
      if (task.assignedWorkerId === workerId && ACTIVE_STATUSES.has(task.status)) {
        hasClaim = true;
        break;
      }
    } catch {
      /* ignore malformed task files */
    }
  }
} catch {
  // If we cannot read the tasks dir, do not block — let the tool through rather
  // than cause a confusing outage.
  process.exit(0);
}

if (!hasClaim) {
  process.stderr.write(
    \`[moe] BLOCKED: worker "\${workerId}" has no active claim. \` +
    \`Call moe.claim_next_task (with statuses matching your role) before editing files.\\n\`
  );
  process.exit(2);
}
process.exit(0);
`;

export interface ClaudeHookWriteResult {
  settingsWritten: boolean;
  settingsSkippedReason?: 'user-existing';
  hookWritten: boolean;
  hookSkippedReason?: 'user-modified';
}

export function writeClaudeHookFiles(projectRoot: string): ClaudeHookWriteResult {
  const claudeDir = path.join(projectRoot, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  const hookPath = path.join(hooksDir, 'moe-require-claim.js');

  const result: ClaudeHookWriteResult = { settingsWritten: false, hookWritten: false };

  // Settings: preserve user's existing file (they may have other hooks). If we
  // own the file (exact content match), safe to rewrite.
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, SETTINGS_JSON);
    result.settingsWritten = true;
  } else {
    result.settingsSkippedReason = 'user-existing';
  }

  // Hook script: don't silently clobber user edits. If the file exists and
  // doesn't match our canonical content, skip the write and surface it.
  if (fs.existsSync(hookPath)) {
    try {
      const existing = fs.readFileSync(hookPath, 'utf-8');
      if (existing === HOOK_JS) {
        // No-op: same content.
      } else {
        result.hookSkippedReason = 'user-modified';
      }
    } catch {
      // If we can't read, leave it alone.
      result.hookSkippedReason = 'user-modified';
    }
  } else {
    fs.writeFileSync(hookPath, HOOK_JS);
    result.hookWritten = true;
  }

  // Make the hook executable on POSIX. On Windows this is a no-op.
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    /* chmod not supported (Windows) — node handles it via the file extension */
  }

  return result;
}
