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
┌─────────────┐       ┌─────────────┐
│    Epic     │──────▶│  Channel    │◀──────┐
│             │ auto  │             │ auto  │
│ epicRails   │       │ messages[]  │       │
└──────┬──────┘       └─────────────┘       │
       │ 1:many                             │
       ▼                                    │
┌─────────────┐       ┌─────────────┐       │
│    Task     │ ◀───▶ │   Worker    │       │
│             │       │             │       │
│ taskRails   │       │ chatCursors │       │
│ plan        │       │   branch    │       │
│ status      │───────┘   teamId    │       │
└──────┬──────┘       └──────┬──────┘       │
       │ auto                │              │
       └─────────────────────┼──────────────┘
                             ▼
                      ┌─────────────┐
                      │    Team     │
                      │   role      │
                      │   members   │
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

  // Auto-commit + push on worker `complete_task`. When true (default), the
  // agent wrapper runs `git add -A && git commit && git push` against the
  // current branch after a worker moves a task to REVIEW (first pass or
  // retry after qa_reject). Commits use the user's configured git identity;
  // no Claude/Codex attribution is added. Set false to disable.
  autoCommit?: boolean;          // default: true

  // Per-column WIP limits (optional)
  // Key is TaskStatus, value is max tasks allowed in that column
  // Example: { "REVIEW": 2 } limits review to 2 tasks at a time
  columnLimits?: Record<string, number>;

  // Chat settings (all optional, defaults applied at runtime)
  chatEnabled?: boolean;              // default: true — enable/disable chat system
  chatMaxAgentHops?: number;          // default: 4 — loop guard threshold per channel
  chatAutoCreateChannels?: boolean;   // default: true — auto-create channels for epics/tasks
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

  // Ownership + ordering bookkeeping (Phase 3; both optional)
  contextFetchedBy?: string[];   // De-duplicated workerIds that invoked moe.get_context for this task
  stepsCompleted?: string[];     // Ordered stepIds already marked COMPLETED

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

  // Team membership
  teamId: string | null;         // Reference to Team (null = solo worker)

  // Chat cursors — per-channel last-read message ID
  chatCursors?: Record<string, string>;  // { channelId: lastReadMessageId }
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
  "errorCount": 0,

  "teamId": null
}
```

---

## Team

**File:** `.moe/teams/{team-id}.json`

Teams are logical groupings of workers. Teams can be role-based (architect/worker/qa) or project-wide (no role). Team members bypass the per-epic per-status constraint, allowing multiple workers to work on different tasks in the same epic simultaneously.

```typescript
type TeamRole = 'architect' | 'worker' | 'qa';

interface Team {
  // Identity
  id: string;                    // "team-abc123"
  projectId: string;             // Reference to parent project

  // Configuration
  name: string;                  // "Coders"
  role: TeamRole | null;         // Optional team role (null = project team)
  memberIds: string[];           // Worker IDs belonging to this team
  maxSize: number;               // Maximum members (default 10)

  // Timestamps
  createdAt: string;
  updatedAt: string;
}
```

**Example:**

```json
{
  "id": "team-a1b2c3d4",
  "projectId": "proj-a1b2c3d4",
  "name": "Coders",
  "role": null,
  "memberIds": ["worker-w1x2y3z4", "worker-w5x6y7z8"],
  "maxSize": 10,
  "createdAt": "2025-02-03T10:00:00Z",
  "updatedAt": "2025-02-03T10:05:00Z"
}
```

**Key behavior:** When a worker belongs to a team, `claim_next_task` allows them to claim tasks in an epic that already has another team member working on it (same status). Solo workers (no team) retain the existing one-worker-per-status-per-epic constraint.

---

## Chat Channel

**File:** `.moe/channels/{channel-id}.json`

Channels organize chat messages by topic. Channels can be auto-created for epics and tasks when `chatAutoCreateChannels` is enabled.

```typescript
interface ChatChannel {
  // Identity
  id: string;                    // "chan-{uuid}"
  name: string;                  // "general", "epic-auth", "task-login"

  // Type and linking
  type: 'general' | 'epic' | 'task' | 'custom';
  linkedEntityId: string | null; // epicId or taskId (if type is epic/task)

  // Timestamps
  createdAt: string;             // ISO 8601
}
```

**Example:**

```json
{
  "id": "chan-a1b2c3d4",
  "name": "epic-auth",
  "type": "epic",
  "linkedEntityId": "epic-e1f2g3h4",
  "createdAt": "2025-02-01T10:00:00Z"
}
```

---

## Chat Message

**File:** `.moe/messages/{channel-id}.jsonl` (append-only, one JSON per line)

Messages use JSONL (JSON Lines) format for high-volume append-only writes. Each channel has its own message file. Messages are fetched on-demand per channel and are NOT included in `STATE_SNAPSHOT`.

```typescript
interface ChatMessage {
  // Identity
  id: string;                    // "msg-{uuid}"
  channel: string;               // channel ID

  // Content
  sender: string;                // workerId, "human", or "system"
  content: string;               // message text (max 10KB)

  // Threading and mentions
  replyTo: string | null;        // parent message ID for threading
  mentions: string[];            // parsed @mentions (workerId strings)

  // Decision linking (optional)
  decisionId?: string;           // Links to a Decision entity (set by chat_decision tool)

  // Timestamps
  timestamp: string;             // ISO 8601
}
```

**Example (one line per message in `.moe/messages/chan-a1b2c3d4.jsonl`):**

```jsonl
{"id":"msg-f1e2d3c4","channel":"chan-a1b2c3d4","sender":"worker-w1x2y3z4","content":"Starting work on the login form","replyTo":null,"mentions":[],"timestamp":"2025-02-02T14:00:00Z"}
{"id":"msg-a5b6c7d8","channel":"chan-a1b2c3d4","sender":"human","content":"@worker-w1x2y3z4 make sure to add validation","replyTo":"msg-f1e2d3c4","mentions":["worker-w1x2y3z4"],"timestamp":"2025-02-02T14:05:00Z"}
```

### @Mention Routing

Messages with `@workerId` mentions are parsed and stored in the `mentions` array. The chat router uses per-channel hop counters to prevent runaway agent-to-agent conversations:

- Each agent-to-agent routed message increments the hop counter for that channel
- When `chatMaxAgentHops` (default 4) is exceeded, routing pauses until a human message resets the counter
- Human messages always reset the hop counter to 0

### Storage Layout

```
.moe/
├── channels/
│   ├── chan-a1b2c3d4.json      # Channel metadata (general)
│   ├── chan-e5f6g7h8.json      # Channel metadata (epic-linked)
│   └── chan-i9j0k1l2.json      # Channel metadata (task-linked)
├── messages/
│   ├── chan-a1b2c3d4.jsonl     # Messages for general channel
│   ├── chan-e5f6g7h8.jsonl     # Messages for epic channel
│   └── chan-i9j0k1l2.jsonl     # Messages for task channel
```

**Note:** Schema version will be bumped to 5 in the migration task to create `channels/` and `messages/` directories.

---

## Decision

**File:** `.moe/decisions/{decision-id}.json`

Decisions are proposals that require human approval. Agents can propose decisions during chat conversations, and humans approve or reject them from the IDE UI.

```typescript
interface Decision {
  // Identity
  id: string;                    // "dec-{uuid}"

  // Content
  proposedBy: string;            // workerId who proposed the decision
  content: string;               // Decision text (max 10KB)

  // Status
  status: DecisionStatus;
  approvedBy: string | null;     // Who approved/rejected (workerId or "human")

  // Channel linking (optional)
  channel: string | null;        // Channel where decision was proposed
  messageId: string | null;      // System message posted to channel

  // Timestamps
  createdAt: string;             // ISO 8601
  resolvedAt: string | null;     // When approved/rejected
}

type DecisionStatus =
  | 'proposed'    // Awaiting human decision
  | 'approved'    // Human approved
  | 'rejected';   // Human rejected
```

**Example:**

```json
{
  "id": "dec-a1b2c3d4",
  "proposedBy": "worker-w1x2y3z4",
  "content": "Should we use Redis for session storage instead of in-memory?",
  "status": "proposed",
  "approvedBy": null,
  "channel": "chan-e5f6g7h8",
  "messageId": "msg-m1n2o3p4",
  "createdAt": "2025-02-02T14:00:00Z",
  "resolvedAt": null
}
```

### Storage Layout

```
.moe/
├── decisions/
│   ├── dec-a1b2c3d4.json       # Individual decision files
│   └── dec-e5f6g7h8.json
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
  | 'PROPOSAL_REJECTED'

  // Team
  | 'TEAM_CREATED'
  | 'TEAM_UPDATED'
  | 'TEAM_DELETED'
  | 'TEAM_MEMBER_ADDED'
  | 'TEAM_MEMBER_REMOVED'

  // Chat
  | 'MESSAGE_CREATED'
  | 'CHANNEL_CREATED'

  // Decisions
  | 'DECISION_PROPOSED'
  | 'DECISION_APPROVED'
  | 'DECISION_REJECTED';
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
  schemaVersion: number;  // Current: 4
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
// Project:  "proj-a1b2c3d4"
// Epic:     "epic-e1f2g3h4"
// Task:     "task-t1u2v3w4"
// Worker:   "worker-w1x2y3z4"
// Step:     "step-s1t2u3v4"
// Proposal: "prop-p1q2r3s4"
// Event:    "evt-e1f2g3h4"
// Channel:  "chan-c1d2e3f4"
// Message:  "msg-m1n2o3p4"
// Decision: "dec-d1e2f3g4"
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
- Solo workers (no team): one worker per status per epic
- Team workers: multiple workers of same role allowed per epic
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
                           │ done                         │
                           ▼                              │
                    ┌──────────────┐                      │
                    │              │                      │
                    │     DONE     │◀─────────────────────┘
                    │              │      (can reopen DONE)
                    └──────────────┘
```

**Note:** Any column can have a WIP limit via `columnLimits` in project settings.

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

---

## Memory System

### MemoryEntry

Stored in `.moe/memory/knowledge.jsonl` (one JSON object per line).

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | `"mem-{uuid8}"` |
| `type` | MemoryType | `convention`, `gotcha`, `pattern`, `decision`, `procedure`, `insight` |
| `content` | string | The knowledge text (max 2000 chars) |
| `tags` | string[] | Searchable tags (max 10, auto-generated + manual) |
| `source.files` | string[] | Related file paths |
| `source.taskId` | string\|null | Originating task |
| `source.epicId` | string\|null | Originating epic |
| `source.workerId` | string\|null | Who created this memory |
| `confidence` | number | 0.0-2.0, starts at 1.0. Rises when helpful, falls when unhelpful. |
| `accessCount` | number | How many times this memory has been retrieved |
| `helpfulCount` | number | Agent feedback: marked helpful |
| `unhelpfulCount` | number | Agent feedback: marked unhelpful |
| `createdAt` | string | ISO 8601 timestamp |
| `lastAccessedAt` | string | ISO 8601 timestamp |
| `supersededBy` | string\|null | ID of newer entry that replaces this |
| `contentHash` | string | First 8 chars of SHA-256 (deduplication) |

### SessionSummary

Stored in `.moe/memory/sessions/{workerId}_{taskId}.json`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | `"sess-{uuid8}"` |
| `workerId` | string | Which agent wrote this |
| `taskId` | string | Which task this covers |
| `role` | string | architect, worker, or qa |
| `summary` | string | What was accomplished and key findings |
| `memoriesCreated` | string[] | IDs of memories saved during this session |
| `completedSteps` | string[] | Step IDs completed (workers) |
| `createdAt` | string | ISO 8601 timestamp |

### PlanningNotes

Stored on task as `task.planningNotes` when architect submits a plan.

| Field | Type | Description |
|-------|------|-------------|
| `approachesConsidered` | string | What alternatives were evaluated and why rejected |
| `codebaseInsights` | string | Patterns, conventions, architecture discovered |
| `risks` | string | Edge cases and potential issues |
| `keyFiles` | string[] | Critical files the worker should understand |

### Memory Data Files

```
.moe/memory/
├── knowledge.jsonl           # Append-only knowledge base (JSONL)
├── knowledge.archive.jsonl   # Archived entries after pruning
└── sessions/                 # Session summaries
    └── {workerId}_{taskId}.json
```
