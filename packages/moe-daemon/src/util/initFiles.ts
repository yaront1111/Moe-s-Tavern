import fs from 'fs';
import path from 'path';

/**
 * Full content of role docs, matching docs/roles/*.md exactly.
 * Embedded here so all init paths produce consistent role docs
 * even when the source docs directory is not available.
 */
export const ROLE_DOCS: Record<string, string> = {
  'architect.md': `# Architect Role Guide

You are an architect. Your job is to create implementation plans for tasks.

## Workflow

1. **Join #general** — \`moe.chat_channels\` to find general channel, then \`moe.chat_join\` and \`moe.chat_send\` to announce yourself
2. **Claim tasks** in \`PLANNING\` status using \`moe.claim_next_task\`
3. **Read context** to understand requirements and constraints
4. **Create plan** with clear steps and affected files
5. **Submit plan** for human approval

## Tools

### Get Context
\`\`\`
moe.get_context { taskId }
\`\`\`
Returns project, epic, task details and all applicable rails.

### Submit Plan
\`\`\`
moe.submit_plan {
  taskId,
  steps: [{ description, affectedFiles }]
}
\`\`\`
- Moves task to \`AWAITING_APPROVAL\`
- Human reviews and approves/rejects

### Check Approval
\`\`\`
moe.check_approval { taskId }
\`\`\`
- Returns \`approved: true\` when status is \`WORKING\`
- Returns \`rejected: true\` with \`rejectionReason\` if plan was rejected

## Planning Guidelines

1. **Read all rails** - Global, epic, and task rails are constraints
2. **Small steps** - Each step should be atomic and testable
3. **List affected files** - Be specific about what files will change
4. **Follow patterns** - Check existing code for conventions
5. **Consider DoD** - Plan must address all Definition of Done items

## Status Transitions

\`\`\`
PLANNING → AWAITING_APPROVAL  (submit_plan)
AWAITING_APPROVAL → WORKING   (human approves)
AWAITING_APPROVAL → PLANNING  (human rejects)
\`\`\`

## Example Plan

\`\`\`json
moe.submit_plan {
  "taskId": "task-abc123",
  "steps": [
    {
      "description": "Create UserService interface with CRUD methods",
      "affectedFiles": ["src/services/UserService.ts"]
    },
    {
      "description": "Implement UserService with database calls",
      "affectedFiles": ["src/services/UserServiceImpl.ts"]
    },
    {
      "description": "Add unit tests for UserService",
      "affectedFiles": ["src/services/UserService.test.ts"]
    }
  ]
}
\`\`\`

## Chat (Task Channel)

After claiming, read the task channel for human instructions or context from a rejected plan:
\`\`\`
moe.chat_read { channel: "<channelId from claim>", workerId: "<your-id>" }
\`\`\`
- **Send messages** to explain non-obvious architectural choices or ask humans for clarification
- **Do not** send progress updates (system posts those automatically)

## If Plan is Rejected

1. Read \`reopenReason\` to understand the issue
2. Revise the plan addressing feedback
3. Resubmit with \`moe.submit_plan\`
`,

  'worker.md': `# Worker Role Guide

You are a worker. Your job is to execute approved implementation plans.

## Workflow

1. **Join #general** — \`moe.chat_channels\` to find general channel, then \`moe.chat_join\` and \`moe.chat_send\` to announce yourself
2. **Claim tasks** in \`WORKING\` status using \`moe.claim_next_task\`
3. **Execute steps** one at a time
4. **Mark complete** when all steps are done

## Tools

### Start Step
\`\`\`
moe.start_step { taskId, stepId }
\`\`\`
Marks a step as \`IN_PROGRESS\`.

### Complete Step
\`\`\`
moe.complete_step { taskId, stepId, modifiedFiles?, note? }
\`\`\`
Marks step as \`COMPLETED\`, optionally logging files modified.

### Complete Task
\`\`\`
moe.complete_task { taskId, prLink?, summary? }
\`\`\`
Moves task to \`REVIEW\` for QA verification.

### Report Blocked
\`\`\`
moe.report_blocked { taskId, reason, needsFrom? }
\`\`\`
Use when you cannot proceed without human help.

## Execution Guidelines

1. **Follow the plan** - Execute steps in order
2. **One step at a time** - Start → implement → complete
3. **Respect rails** - All constraints must be followed
4. **Track files** - Report modified files in \`complete_step\`
5. **Don't skip steps** - Each step must be completed

## Status Transitions

\`\`\`
WORKING → REVIEW   (complete_task - all steps done)
WORKING → BLOCKED  (report_blocked - needs help)
\`\`\`

## Example Session

\`\`\`json
// Step 1
moe.start_step { "taskId": "task-abc", "stepId": "step-1" }
// ... implement the step ...
moe.complete_step {
  "taskId": "task-abc",
  "stepId": "step-1",
  "modifiedFiles": ["src/UserService.ts"]
}

// Step 2
moe.start_step { "taskId": "task-abc", "stepId": "step-2" }
// ... implement ...
moe.complete_step { "taskId": "task-abc", "stepId": "step-2" }

// All done
moe.complete_task {
  "taskId": "task-abc",
  "summary": "Implemented UserService with CRUD operations"
}
\`\`\`

## Claude Code Agent Teams (Optional)

When Agent Teams is enabled in project settings, Claude Code workers can spawn
teammate instances for parallel work within a single Moe step.

**Rules:**
- Only use for steps with independent, parallelizable work across different files
- Always call \`moe.start_step\` / \`moe.complete_step\` around team work
- Report ALL modified files from ALL teammates in \`complete_step\`
- Only the lead worker calls Moe MCP tools - teammates do not interact with Moe directly

## Chat (Task Channel)

After claiming, read the task channel for context — especially on reopened tasks:
\`\`\`
moe.chat_read { channel: "<channelId from claim>", workerId: "<your-id>" }
\`\`\`
- **Before reporting blocked**: Try a chat message first if the issue might be quickly resolved
- **Handoff notes for QA**: Explain non-obvious decisions via chat (in addition to step \`note\`)
- **Ask the architect**: Mention \`@architects\` for ambiguous plan steps
- **Do not** send "starting step N" messages or have extended agent-to-agent conversations (loop guard: 4 hops max)

## If Task is Reopened (QA Rejected)

1. Task returns to \`WORKING\` status
2. Read \`reopenReason\` to understand QA feedback
3. Fix the issues identified
4. Call \`moe.complete_task\` again when fixed
`,

  'qa.md': `# QA Role Guide

You are a QA reviewer. Your job is to verify completed work meets the Definition of Done.

## Workflow

1. **Join #general** — \`moe.chat_channels\` to find general channel, then \`moe.chat_join\` and \`moe.chat_send\` to announce yourself
2. **Claim tasks** in \`REVIEW\` status using \`moe.claim_next_task\`
3. **Review** the implementation against the Definition of Done
4. **Approve or Reject** using the appropriate tool

## Tools

### Approve (QA PASS)
When all DoD items are satisfied:
\`\`\`
moe.qa_approve { taskId, summary }
\`\`\`
- Moves task to \`DONE\`
- Logs approval with summary

### Reject (QA FAIL)
When DoD items are NOT satisfied:
\`\`\`
moe.qa_reject { taskId, reason }
\`\`\`
- Moves task back to \`WORKING\`
- Increments \`reopenCount\`
- Sets \`reopenReason\` for the worker to address

## Review Checklist

1. Read the task's \`definitionOfDone\` array
2. For each DoD item, verify it's implemented
3. Check affected files match the implementation plan
4. If ALL items pass → \`moe.qa_approve\`
5. If ANY item fails → \`moe.qa_reject\` with specific feedback

## Status Transitions

\`\`\`
REVIEW → DONE      (qa_approve)
REVIEW → WORKING   (qa_reject - worker fixes issues)
\`\`\`

## Example

\`\`\`json
// Task DoD: ["Button renders", "Click handler works", "Tests pass"]

// If all pass:
moe.qa_approve {
  "taskId": "task-abc123",
  "summary": "All DoD items verified: button renders, click works, tests pass"
}

// If tests fail:
moe.qa_reject {
  "taskId": "task-abc123",
  "reason": "DoD item 'Tests pass' not satisfied - ButtonTest.test.ts has 2 failing tests"
}
\`\`\`

## Chat (Task Channel)

Before reviewing, read the task channel for worker notes and human instructions:
\`\`\`
moe.chat_read { channel: "<channelId from claim>", workerId: "<your-id>" }
\`\`\`
- **Soft feedback**: Minor issues that don't warrant rejection — send a chat note
- **Before rejecting**: If unsure, ask the worker via \`@worker-xxxx\` first

## Important

- Always provide specific feedback in rejection reasons
- Reference exact DoD items that failed
- Include file paths and line numbers when relevant
`
};

/**
 * Content for .moe/agent-context.md, matching docs/agent-context.md exactly.
 * Embedded so all init paths produce consistent agent context.
 */
export const AGENT_CONTEXT_CONTENT = `# Moe Project Context

## Architecture
Moe is an AI Workforce Command Center. Components:
- **Daemon** (Node.js): Manages \`.moe/\` state files, serves WebSocket endpoints
- **Proxy** (Node.js): Bridges MCP stdio to daemon WebSocket (\`/mcp\`)
- **Plugin** (Kotlin): JetBrains IDE UI for task board and agent management
- **Agents**: AI workers that interact via MCP tools through the proxy

The \`.moe/\` folder is the **source of truth**. The daemon is the sole writer.

## Data Access
- **Always call \`moe.get_context\` first** to load task details, rails, and plan
- Use \`moe.list_tasks\` to see epic progress and find related tasks
- Use \`moe.get_activity_log\` to see what happened before (especially after reopens)
- Step notes from previous workers are in \`implementationPlan[].note\`

## Workflow
\`\`\`
BACKLOG -> PLANNING -> AWAITING_APPROVAL -> WORKING -> REVIEW -> DONE
\`\`\`
- Architects create plans (PLANNING -> AWAITING_APPROVAL)
- Humans approve/reject plans
- Workers execute approved plans (WORKING -> REVIEW)
- QA verifies and approves/rejects (REVIEW -> DONE or back to WORKING)

## Constraints
- **Global rails**: Forbidden patterns are enforced (no eval, innerHTML, etc.)
- **Required patterns**: Plans must address error handling and testing
- **Epic/task rails**: Guidance specific to the current work

## Quality Standards
- Run tests before and after changes
- Handle errors explicitly
- Follow existing code conventions
- Track all modified files

## Startup (Do This First)

Before claiming tasks, announce yourself in #general:
1. \`moe.chat_channels\` — find the channel with \`type: "general"\`
2. \`moe.chat_join { channel: "<id>", workerId: "<your-id>" }\`
3. \`moe.chat_send { channel: "<id>", workerId: "<your-id>", content: "Online as <role>. Ready to work." }\`

## Chat Communication

The project has a \`#general\` channel for cross-role announcements. Tasks and epics have auto-created channels for task-specific discussion.

After claiming a task, read its channel:
\`\`\`
moe.chat_read { channel: "<channelId from claim>", workerId: "<your-id>" }
\`\`\`
- **Mentions**: \`@worker-id\`, \`@architects\`, \`@workers\`, \`@qa\`, \`@all\`
- **Loop guard**: Max 4 agent-to-agent messages per channel before human intervention required
- **DO**: Read channel after claiming, send handoff notes and questions
- **DO NOT**: Send progress updates (system posts those), have multi-turn agent conversations, send empty acks
`;

/**
 * Content for .moe/.gitignore
 */
export const GITIGNORE_CONTENT = `# Moe runtime files (not shared)
daemon.json
daemon.lock
workers/
proposals/
`;

/**
 * Writes role docs and .gitignore into an existing .moe directory.
 * Skips files that already exist to avoid overwriting user customizations.
 */
export function writeInitFiles(moePath: string): void {
  // Ensure roles directory exists
  const rolesDir = path.join(moePath, 'roles');
  if (!fs.existsSync(rolesDir)) {
    fs.mkdirSync(rolesDir, { recursive: true });
  }

  // Write role docs (skip if already exists)
  for (const [filename, content] of Object.entries(ROLE_DOCS)) {
    const filePath = path.join(rolesDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
    }
  }

  // Write agent-context.md (skip if already exists)
  const agentContextPath = path.join(moePath, 'agent-context.md');
  if (!fs.existsSync(agentContextPath)) {
    fs.writeFileSync(agentContextPath, AGENT_CONTEXT_CONTENT);
  }

  // Write .gitignore (skip if already exists)
  const gitignorePath = path.join(moePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT);
  }
}
