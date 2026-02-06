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

1. **Claim tasks** in \`PLANNING\` status using \`moe.claim_next_task\`
2. **Read context** to understand requirements and constraints
3. **Create plan** with clear steps and affected files
4. **Submit plan** for human approval

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

## If Plan is Rejected

1. Read \`reopenReason\` to understand the issue
2. Revise the plan addressing feedback
3. Resubmit with \`moe.submit_plan\`
`,

  'worker.md': `# Worker Role Guide

You are a worker. Your job is to execute approved implementation plans.

## Workflow

1. **Claim tasks** in \`WORKING\` status using \`moe.claim_next_task\`
2. **Execute steps** one at a time
3. **Mark complete** when all steps are done

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

## If Task is Reopened (QA Rejected)

1. Task returns to \`WORKING\` status
2. Read \`reopenReason\` to understand QA feedback
3. Fix the issues identified
4. Call \`moe.complete_task\` again when fixed
`,

  'qa.md': `# QA Role Guide

You are a QA reviewer. Your job is to verify completed work meets the Definition of Done.

## Workflow

1. **Claim tasks** in \`REVIEW\` status using \`moe.claim_next_task\`
2. **Review** the implementation against the Definition of Done
3. **Approve or Reject** using the appropriate tool

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

## Important

- Always provide specific feedback in rejection reasons
- Reference exact DoD items that failed
- Include file paths and line numbers when relevant
`
};

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

  // Write .gitignore (skip if already exists)
  const gitignorePath = path.join(moePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT);
  }
}
