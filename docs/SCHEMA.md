# Moe - Data Schema

## Overview

All Moe state is stored in JSON files within the `.moe/` folder. This document defines the canonical schema for each entity.

Implementation notes (current):
- This schema matches `packages/moe-daemon/src/types/schema.ts`.
- Rails enforcement in the daemon checks `forbiddenPatterns`, `requiredPatterns`, `epicRails`, and `taskRails`. Other rail fields are informational for now.

---

## Entity Relationship Diagram

```
┌─────────────┐
│   Project   │
│             │
│ globalRails │
└──────┬──────┘
       │ 1:many
       ▼
┌─────────────┐
│    Epic     │
│             │
│ epicRails   │
└──────┬──────┘
       │ 1:many
       ▼
┌─────────────┐       ┌─────────────┐
│    Task     │ ◀───▶ │   Worker    │
│             │       │             │
│ taskRails   │       │   status    │
│ plan        │       │   branch    │
│ status      │       └─────────────┘
└─────────────┘
```

---

## Project

**File:** `.moe/project.json`

```typescript
interface Project {
  // Identity
  id: string;                    // "proj-abc123" (uuid prefix)
  name: string;                  // "My App"
  rootPath: string;              // "/Users/dev/my-app"
  
  // Global Rails (apply to all tasks)
  globalRails: GlobalRails;
  
  // Settings
  settings: ProjectSettings;
  
  // Timestamps
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
}

interface GlobalRails {
  // Tech stack requirements
  techStack: string[];           // ["TypeScript", "React", "Tailwind"]
  
  // Patterns to avoid
  forbiddenPatterns: string[];   // ["No any types", "No console.log"]
  
  // Patterns to enforce
  requiredPatterns: string[];    // ["All functions must have return types"]
  
  // Code style
  formatting: string;            // "Prettier with project config"
  
  // Testing requirements
  testing: string;               // "Vitest for unit, Playwright for e2e"
  
  // Custom rules (freeform)
  customRules: string[];
}

interface ProjectSettings {
  // Approval mode
  approvalMode: 'CONTROL' | 'SPEED' | 'TURBO';
  
  // Speed mode delay (ms)
  speedModeDelayMs: number;      // default: 2000
  
  // Auto-create branch on task start
  autoCreateBranch: boolean;     // default: true
  
  // Branch naming pattern
  branchPattern: string;         // default: "moe/{epicId}/{taskId}"
  
  // Commit message pattern
  commitPattern: string;         // default: "feat({epicId}): {taskTitle}"
}
```

**Example:**

```json
{
  "id": "proj-a1b2c3d4",
  "name": "Cordum",
  "rootPath": "/Users/yaron/projects/cordum",
  
  "globalRails": {
    "techStack": ["TypeScript", "React 18", "Tailwind CSS", "Prisma"],
    "forbiddenPatterns": [
      "No any types",
      "No console.log in production code",
      "No inline styles",
      "No default exports except pages"
    ],
    "requiredPatterns": [
      "All functions must have explicit return types",
      "All components must be functional",
      "Use Zod for runtime validation"
    ],
    "formatting": "Prettier with project .prettierrc",
    "testing": "Vitest for unit tests, all utils must have tests",
    "customRules": [
      "Follow existing file naming conventions",
      "Use path aliases (@/) for imports"
    ]
  },
  
  "settings": {
    "approvalMode": "CONTROL",
    "speedModeDelayMs": 2000,
    "autoCreateBranch": true,
    "branchPattern": "moe/{epicId}/{taskId}",
    "commitPattern": "feat({epicId}): {taskTitle}"
  },
  
  "createdAt": "2025-02-01T10:00:00Z",
  "updatedAt": "2025-02-02T15:30:00Z"
}
```

---

## Epic

**File:** `.moe/epics/{epic-id}.json`

```typescript
interface Epic {
  // Identity
  id: string;                    // "epic-abc123"
  projectId: string;             // Reference to parent project
  
  // Content
  title: string;                 // "Authentication Module"
  description: string;           // Detailed description (markdown)
  
  // Epic-specific context for AI
  architectureNotes: string;     // "Using JWT in httpOnly cookies..."
  
  // Epic-level rails (add to global)
  epicRails: string[];           // ["Use Supabase Auth", "Follow OAuth 2.0"]
  
  // Status
  status: EpicStatus;
  
  // Ordering
  order: number;                 // 0, 1, 2... for display order
  
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

type EpicStatus = 
  | 'PLANNED'      // Not started
  | 'ACTIVE'       // Has worker(s) assigned
  | 'COMPLETED';   // All tasks done
```

**Example:**

```json
{
  "id": "epic-e1f2g3h4",
  "projectId": "proj-a1b2c3d4",
  
  "title": "Authentication Module",
  "description": "Implement complete user authentication including signup, login, logout, and password reset flows.",
  
  "architectureNotes": "We're using Supabase Auth with JWT stored in httpOnly cookies. The frontend should never directly handle tokens - all auth state comes from the /api/auth/me endpoint.",
  
  "epicRails": [
    "Use Supabase Auth SDK",
    "Never expose tokens to frontend",
    "All auth endpoints under /api/auth/"
  ],
  
  "status": "ACTIVE",
  "order": 0,
  
  "createdAt": "2025-02-01T10:00:00Z",
  "updatedAt": "2025-02-02T15:30:00Z"
}
```

---

## Task

**File:** `.moe/tasks/{task-id}.json`

```typescript
interface Task {
  // Identity
  id: string;                    // "task-abc123"
  epicId: string;                // Reference to parent epic
  
  // Content
  title: string;                 // "Create login form"
  description: string;           // Detailed description (markdown)
  
  // Definition of Done (human-defined)
  definitionOfDone: string[];    // Checklist of completion criteria
  
  // Task-specific rails (add to epic + global)
  taskRails: string[];           // ["Use the existing Input component"]
  
  // Implementation Plan (AI-generated)
  implementationPlan: ImplementationStep[];
  
  // Status
  status: TaskStatus;
  
  // Assignment
  assignedWorkerId: string | null;
  
  // Git
  branch: string | null;         // "moe/epic-e1f2/task-abc123"
  prLink: string | null;         // "https://github.com/..."
  
  // Reopening
  reopenCount: number;           // How many times sent back
  reopenReason: string | null;   // Why it was reopened
  
  // Creation
  createdBy: 'HUMAN' | 'WORKER'; // Workers can propose subtasks
  parentTaskId: string | null;   // For subtasks
  
  // Ordering
  order: number;
  
  // Timestamps
  createdAt: string;
  updatedAt: string;
}

type TaskStatus =
  | 'BACKLOG'           // Not started, in queue
  | 'PLANNING'          // Worker is creating plan
  | 'AWAITING_APPROVAL' // Plan ready for human review
  | 'WORKING'           // Worker executing plan
  | 'REVIEW'            // Work done, PR ready
  | 'DONE';             // Merged, complete

interface ImplementationStep {
  stepId: string;                // "step-1"
  description: string;           // "Create LoginForm component"
  status: StepStatus;
  affectedFiles: string[];       // ["src/components/LoginForm.tsx"]
  startedAt?: string;            // When step started
  completedAt?: string;          // When step finished
}

type StepStatus =
  | 'PENDING'       // Not started
  | 'IN_PROGRESS'   // Currently executing
  | 'COMPLETED';    // Done
```

**Example:**

```json
{
  "id": "task-t1u2v3w4",
  "epicId": "epic-e1f2g3h4",
  
  "title": "Create login form component",
  "description": "Build a login form with email and password fields, validation, error handling, and loading state.",
  
  "definitionOfDone": [
    "LoginForm component renders correctly",
    "Form validates email format",
    "Form shows loading spinner during submission",
    "Form displays API errors to user",
    "Form redirects to /dashboard on success"
  ],
  
  "taskRails": [
    "Use existing Input and Button components",
    "Use react-hook-form for form state",
    "Use Zod for validation schema"
  ],
  
  "implementationPlan": [
    {
      "stepId": "step-1",
      "description": "Create validation schema with Zod",
      "status": "COMPLETED",
      "affectedFiles": ["src/lib/validations/auth.ts"],
      "startedAt": "2025-02-02T14:00:00Z",
      "completedAt": "2025-02-02T14:05:00Z"
    },
    {
      "stepId": "step-2",
      "description": "Create LoginForm component with react-hook-form",
      "status": "IN_PROGRESS",
      "affectedFiles": ["src/components/auth/LoginForm.tsx"],
      "startedAt": "2025-02-02T14:05:00Z"
    },
    {
      "stepId": "step-3",
      "description": "Add error handling and loading state",
      "status": "PENDING",
      "affectedFiles": ["src/components/auth/LoginForm.tsx"]
    },
    {
      "stepId": "step-4",
      "description": "Write unit tests",
      "status": "PENDING",
      "affectedFiles": ["src/components/auth/LoginForm.test.tsx"]
    }
  ],
  
  "status": "WORKING",
  
  "assignedWorkerId": "worker-w1x2y3z4",
  "branch": "moe/epic-e1f2/task-t1u2",
  "prLink": null,
  
  "reopenCount": 0,
  "reopenReason": null,
  
  "createdBy": "HUMAN",
  "parentTaskId": null,
  
  "order": 1,
  
  "createdAt": "2025-02-02T10:00:00Z",
  "updatedAt": "2025-02-02T14:05:00Z"
}
```

---

## Worker

**File:** `.moe/workers/{worker-id}.json`

```typescript
interface Worker {
  // Identity
  id: string;                    // "worker-abc123"
  type: WorkerType;              // AI provider
  
  // Assignment
  projectId: string;
  epicId: string;
  
  // Current work
  currentTaskId: string | null;
  status: WorkerStatus;
  
  // Git
  branch: string;                // "moe/epic-e1f2/worker-abc123"
  modifiedFiles: string[];       // Files touched this session
  
  // Runtime
  startedAt: string;
  lastActivityAt: string;
  
  // Errors
  lastError: string | null;
  errorCount: number;
}

type WorkerType = 
  | 'CLAUDE'    // Claude Code CLI
  | 'CODEX'     // OpenAI Codex CLI
  | 'GEMINI';   // Google Gemini CLI

type WorkerStatus =
  | 'IDLE'              // Connected, no task
  | 'READING_CONTEXT'   // Loading project/epic/task
  | 'PLANNING'          // Creating implementation plan
  | 'AWAITING_APPROVAL' // Plan submitted, waiting
  | 'CODING'            // Executing steps
  | 'BLOCKED';          // Stuck, needs human help
```

**Example:**

```json
{
  "id": "worker-w1x2y3z4",
  "type": "CLAUDE",
  
  "projectId": "proj-a1b2c3d4",
  "epicId": "epic-e1f2g3h4",
  
  "currentTaskId": "task-t1u2v3w4",
  "status": "CODING",
  
  "branch": "moe/epic-e1f2/worker-w1x2",
  "modifiedFiles": [
    "src/lib/validations/auth.ts",
    "src/components/auth/LoginForm.tsx"
  ],
  
  "startedAt": "2025-02-02T13:00:00Z",
  "lastActivityAt": "2025-02-02T14:05:00Z",
  
  "lastError": null,
  "errorCount": 0
}
```

---

## Proposal (Rail Change Request)

**File:** `.moe/proposals/{proposal-id}.json`

```typescript
interface RailProposal {
  // Identity
  id: string;                    // "prop-abc123"
  
  // Source
  workerId: string;              // Who proposed it
  taskId: string;                // Context
  
  // The proposal
  proposalType: ProposalType;
  targetScope: 'GLOBAL' | 'EPIC' | 'TASK';
  
  currentValue: string | null;   // Existing rail (if modifying)
  proposedValue: string;         // New rail
  reason: string;                // Why the change
  
  // Resolution
  status: ProposalStatus;
  resolvedAt: string | null;
  resolvedBy: 'HUMAN' | 'AUTO';
  
  // Timestamp
  createdAt: string;
}

type ProposalType =
  | 'ADD_RAIL'
  | 'MODIFY_RAIL'
  | 'REMOVE_RAIL';

type ProposalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED';
```

**Example:**

```json
{
  "id": "prop-p1q2r3s4",
  
  "workerId": "worker-w1x2y3z4",
  "taskId": "task-t1u2v3w4",
  
  "proposalType": "MODIFY_RAIL",
  "targetScope": "GLOBAL",
  
  "currentValue": "Use Axios for HTTP requests",
  "proposedValue": "Use native fetch for HTTP requests",
  "reason": "Codebase has 0 Axios imports. All existing code uses fetch. Consistency suggests updating the rail.",
  
  "status": "PENDING",
  "resolvedAt": null,
  "resolvedBy": null,
  
  "createdAt": "2025-02-02T14:10:00Z"
}
```

---

## Activity Event

**File:** `.moe/activity.log` (append-only, one JSON per line)

```typescript
interface ActivityEvent {
  id: string;                    // "evt-abc123"
  timestamp: string;             // ISO 8601
  
  // Context
  projectId: string;
  epicId?: string;
  taskId?: string;
  workerId?: string;
  
  // Event
  event: ActivityEventType;
  payload: Record<string, unknown>;
}

type ActivityEventType =
  // Project
  | 'PROJECT_CREATED'
  | 'PROJECT_SETTINGS_UPDATED'
  | 'GLOBAL_RAILS_UPDATED'
  
  // Epic
  | 'EPIC_CREATED'
  | 'EPIC_UPDATED'
  | 'EPIC_STARTED'
  | 'EPIC_COMPLETED'
  
  // Task
  | 'TASK_CREATED'
  | 'TASK_UPDATED'
  | 'TASK_STARTED'
  | 'PLAN_SUBMITTED'
  | 'PLAN_APPROVED'
  | 'PLAN_REJECTED'
  | 'STEP_STARTED'
  | 'STEP_COMPLETED'
  | 'TASK_COMPLETED'
  | 'PR_OPENED'
  | 'TASK_REOPENED'
  
  // Worker
  | 'WORKER_CONNECTED'
  | 'WORKER_DISCONNECTED'
  | 'WORKER_ERROR'
  | 'WORKER_BLOCKED'
  
  // Proposal
  | 'PROPOSAL_CREATED'
  | 'PROPOSAL_APPROVED'
  | 'PROPOSAL_REJECTED';
```

**Example (one line per event):**

```jsonl
{"id":"evt-001","timestamp":"2025-02-02T10:00:00Z","projectId":"proj-a1b2","event":"PROJECT_CREATED","payload":{"name":"Cordum"}}
{"id":"evt-002","timestamp":"2025-02-02T10:05:00Z","projectId":"proj-a1b2","epicId":"epic-e1f2","event":"EPIC_CREATED","payload":{"title":"Auth Module"}}
{"id":"evt-003","timestamp":"2025-02-02T10:10:00Z","projectId":"proj-a1b2","epicId":"epic-e1f2","taskId":"task-t1u2","event":"TASK_CREATED","payload":{"title":"Login form"}}
{"id":"evt-004","timestamp":"2025-02-02T13:00:00Z","projectId":"proj-a1b2","workerId":"worker-w1x2","event":"WORKER_CONNECTED","payload":{"type":"CLAUDE","epicId":"epic-e1f2"}}
{"id":"evt-005","timestamp":"2025-02-02T14:00:00Z","projectId":"proj-a1b2","taskId":"task-t1u2","workerId":"worker-w1x2","event":"PLAN_SUBMITTED","payload":{"stepCount":4}}
```

---

## Schema Versioning and Migrations

The daemon supports schema versioning to safely evolve the `.moe/` file structure over time.

### Schema Version Field

**File:** `.moe/project.json`

```typescript
interface Project {
  // ... other fields
  schemaVersion: number;  // Current: 2
}
```

### Migration System

Migrations are defined in `packages/moe-daemon/src/migrations/` and run automatically when the daemon loads a project with an older schema version.

**Migration file structure:**
```typescript
// migrations/v1_to_v2.ts
export function migrate(data: Record<string, unknown>): Record<string, unknown> {
  // Transform data from v1 to v2 format
  return { ...data, newField: 'default' };
}
```

### Rollback Strategy

**On migration failure:**
- The migration system returns the original data unchanged
- The daemon logs an error but continues with the unmigrated data
- No data is lost or corrupted

**Recommended backup procedure:**
1. Before upgrading the daemon, backup the `.moe/` folder:
   ```bash
   cp -r .moe .moe.backup
   ```
2. Upgrade the daemon
3. Start the daemon - migrations run automatically
4. If issues occur, restore the backup:
   ```bash
   rm -rf .moe && mv .moe.backup .moe
   ```

**Migration logging:**
- All migrations are logged to stderr with `from` and `to` versions
- Check logs for: `Schema migrations applied`

**Testing migrations:**
- Each migration has corresponding tests in `migrations/*.test.ts`
- Tests verify both forward migration and data integrity

---

## ID Generation

All IDs use a prefix + short UUID format:

```typescript
function generateId(prefix: string): string {
  const uuid = crypto.randomUUID().split('-')[0]; // First 8 chars
  return `${prefix}-${uuid}`;
}

// Examples:
// Project: "proj-a1b2c3d4"
// Epic:    "epic-e1f2g3h4"
// Task:    "task-t1u2v3w4"
// Worker:  "worker-w1x2y3z4"
// Step:    "step-s1t2u3v4"
// Proposal: "prop-p1q2r3s4"
// Event:   "evt-e1f2g3h4"
```

---

## Validation Rules

### Project
- `name` required, 1-100 chars
- `techStack` at least 1 item
- `approvalMode` must be valid enum

### Epic
- `title` required, 1-200 chars
- `projectId` must exist
- `order` must be unique within project

### Task
- `title` required, 1-200 chars
- `epicId` must exist
- `definitionOfDone` at least 1 item
- `order` must be unique within epic
- `status` transitions must be valid (see state machine)

### Worker
- `epicId` must exist
- Only one worker per epic (for now)
- `branch` must be unique

---

## State Machines

### Task Status Transitions

```
                    ┌──────────────┐
                    │              │
             ┌──────│   BACKLOG    │◀─────────────────────┐
             │      │              │                      │
             │      └──────┬───────┘                      │
             │             │ assign worker               │
             │             ▼                              │
             │      ┌──────────────┐                      │
             │      │              │                      │
             │      │   PLANNING   │                      │
             │      │              │                      │
             │      └──────┬───────┘                      │
             │             │ submit plan                 │
             │             ▼                              │
             │      ┌──────────────┐                      │
             │      │   AWAITING   │──────────────────────┤
             │      │   APPROVAL   │      reject          │
             │      └──────┬───────┘                      │
             │             │ approve                     │
             │             ▼                              │
             │      ┌──────────────┐                      │
   reopen    │      │              │                      │
             │      │   WORKING    │──────────────────────┘
             │      │              │      reopen
             │      └──────┬───────┘
             │             │ complete
             │             ▼
             │      ┌──────────────┐
             │      │              │
             └──────│    REVIEW    │──────────────────────┐
                    │              │      reopen          │
                    └──────┬───────┘                      │
                           │ merge                       │
                           ▼                              │
                    ┌──────────────┐                      │
                    │              │                      │
                    │     DONE     │◀─────────────────────┘
                    │              │      (can reopen DONE)
                    └──────────────┘
```

### Worker Status Transitions

```
         ┌──────────────┐
         │              │
    ┌───▶│     IDLE     │◀──────────────────┐
    │    │              │                   │
    │    └──────┬───────┘                   │
    │           │ get task                  │
    │           ▼                           │
    │    ┌──────────────┐                   │
    │    │   READING    │                   │
    │    │   CONTEXT    │                   │
    │    └──────┬───────┘                   │
    │           │                           │
    │           ▼                           │
    │    ┌──────────────┐                   │
    │    │              │                   │
    │    │   PLANNING   │                   │
    │    │              │                   │
    │    └──────┬───────┘                   │
    │           │ submit plan               │
    │           ▼                           │
    │    ┌──────────────┐                   │
    │    │   AWAITING   │───────────────────┤
    │    │   APPROVAL   │    rejected       │
    │    └──────┬───────┘                   │
    │           │ approved                  │
    │           ▼                           │
    │    ┌──────────────┐                   │
    │    │              │                   │
    │    │    CODING    │───────────────────┤
    │    │              │    task done      │
    │    └──────┬───────┘                   │
    │           │ stuck                     │
    │           ▼                           │
    │    ┌──────────────┐                   │
    │    │              │                   │
    └────│   BLOCKED    │───────────────────┘
         │              │    resolved
         └──────────────┘
```
