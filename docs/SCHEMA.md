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

  // Master switch for the agent wrapper's land-on-every-exit post-flight
  // (the daemon never runs git). true (default): a worker exit at REVIEW/DONE
  // makes a completion commit (feat|fix(task-<id>)) and pushes; any other
  // exit that holds a task (worker/architect/qa) makes a wip(task-<id>)
  // checkpoint; gate/peel/commit failures and Ctrl+C teardown go to a rescue
  // ref under refs/moe/rescue/<taskId>/ (never pushed). Paths are attributed
  // per task (persisted baseline <gitdir>/moe/baseline/<taskId>.tsv +
  // moe.get_commit_scope), staged by :(literal) pathspec into a temp index
  // and landed with commit-tree + update-ref CAS — never `git add -A`, never
  // a bare `git commit`. Commits use the user's configured git identity; no
  // Claude/Codex attribution is added. false disables all three kinds.
  autoCommit?: boolean;          // default: true

  // wip(task-<id>) checkpoint commits on non-REVIEW exits (per-run opt-out
  // MOE_DISABLE_CHECKPOINT=1), and whether they are pushed to origin.
  checkpointCommits?: boolean;   // default: true
  checkpointPush?: boolean;      // default: true

  // Stage board records with the landing: own .moe/tasks/<id>.json always;
  // .moe/epics/*.json, .moe/project.json and non-live-peer task records when
  // changed this session. Live peers' task records are never staged.
  commitBoardState?: boolean;    // default: true

  // false: every wrapper commit is plumbing, so git hooks never run and
  // qualityGate is the sanctioned gate. true: completion commits use
  // porcelain `git commit -- <specs>` (hooks run) with a rescue-ref fallback
  // when a hook rejects; checkpoints and rescues stay plumbing.
  commitHooks?: boolean;         // default: false

  // Attribution policy for the post-flight (details in CONFIGURATION.md).
  attribution?: {
    undeclared?: 'solo' | 'never' | 'always'; // default 'solo': MEASURED paths only when no other worker is live; MOE_ATTRIBUTION=declared → 'never'
    contested?: 'commit' | 'skip';            // default 'commit' (records Moe-Contested trailers); 'skip' → MOE_ATTR_CONTESTED
    exclude?: string[];                       // extra DENY prefixes (project-relative, no absolute/..); default []
  };

  // Optional shell command the worker wrapper runs before the completion
  // commit (e.g. "npm run lint && npx tsc --noEmit"). Non-zero exit sends the
  // work to a rescue ref instead of the branch, posts the failure to the task
  // and PUSH-BLOCKED to #general, and stops the worker loop. Empty/unset
  // disables. Per-run env override: MOE_DISABLE_QUALITY_GATE=1.
  qualityGate?: string;

  // When the gate runs. 'epicFinal' (default): only on the epic's final task
  // (highest order among siblings) — verification stays concentrated and
  // mid-epic tasks stay lean. 'everyTask': every worker completion.
  qualityGateScope?: 'epicFinal' | 'everyTask';

  // Branch a worker is expected to be on when it calls moe.complete_task:
  // a literal branch name or a `*` glob (e.g. "moe/work-*", what the agent
  // wrappers peel onto). Case-sensitive, anchored at both ends. Empty/unset
  // disables the check; a completion that reports no currentBranch is never
  // blocked, only warned to #governors. A literal value (no `*`) also doubles
  // as the wrapper's peel target instead of moe/work-<date>.
  consolidationBranch?: string;

  // Plan-size thresholds enforced by moe.submit_plan: warn past the warn
  // values, hard-reject past the max values. Distinct files = union of
  // affectedFiles across all steps.
  taskSizing?: {
    warnSteps?: number;          // default: 8
    maxSteps?: number;           // default: 12
    warnDistinctFiles?: number;  // default: 5
    maxDistinctFiles?: number;   // default: 10
    // CONTROL mode + no governor online: auto-block warn-zone plans back to
    // PLANNING (reuses the critique block machinery + its cap). Default false.
    autoCritique?: boolean;
  };

  // moe.submit_plan seeds task.budget.wallClockMs = stepCount * pacePerStepMs when no explicit budget is passed; an existing budget is never overwritten.
  pacePerStepMs?: number; // default: 900000 (15 min/step)

  // Per-column WIP limits (optional)
  // Key is TaskStatus, value is max tasks allowed in that column
  // Example: { "REVIEW": 2 } limits review to 2 tasks at a time
  columnLimits?: Record<string, number>;

  // Project-relative globs for files every task appends to. Claim-time
  // fileCollision warnings ignore them, so shared changelogs don't drown the
  // real overlaps. Literal paths, `*` (one segment) and `**` (across
  // directories); forward slashes only. Omitted → ["CHANGELOG.md"]. A supplied
  // array REPLACES that default (list CHANGELOG.md yourself to keep it), and
  // [] disables suppression so every overlap is reported again.
  appendOnlyFiles?: string[];         // default: ["CHANGELOG.md"]

  // Auto-park a task to BACKLOG when moe.release_task records a 3rd
  // empty-progress release (handoffNote.whatIsDone = "nothing"/"none"/"n/a")
  // within 24h. Omitted → enabled; only an explicit false disables it, so
  // projects predating the setting keep the protection.
  refusalCascadeAutoBacklog?: boolean; // default: true

  // Declared shared resources, keyed by resource id (e.g. "benchmark-box").
  // Purely optional: moe.acquire_resource on an undeclared id auto-creates it
  // with the defaults — declare a resource only to override them or to
  // document it. See the Resource entity below. Updates via settings REPLACE
  // the stored map (not a deep merge), so removal is possible.
  resources?: Record<string, ResourceSettings>;
  // interface ResourceSettings {
  //   capacity?: number;     // concurrent leases; default: 1 (valid 1-100)
  //   maxLeaseMs?: number;   // hard per-lease cap before the reaper
  //                          // force-releases; default: 86400000 = 24h
  //                          // (valid 60000-604800000 = 1 min - 7 days)
  //   description?: string;  // ≤500 chars
  // }

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
  rejectionDetails?: RejectionDetails;          // Latest structured QA feedback (cleared on next cycle)
  rejectionHistory?: RejectionHistoryEntry[];   // Newest-first; capped at 20 entries
  failedDodItems?: FailedDodItem[];             // Append-only DoD failure log; capped at last 100
  maxReopens?: number;                          // Per-task override of MAX_REOPENS_DEFAULT (3)
  priorAttempt?: PriorAttempt;                  // Snapshot from moe.request_replan
  priorHandoffs?: HandoffNote[];                // Newest-first; capped at 20

  // Plan-size warnings from the latest submit_plan (warn-zone only; cleared
  // when a compliant plan lands) — lets boards/governors see size pressure.
  planSizeWarnings?: string[];

  // Block bookkeeping — all four set together on the PLANNING/WORKING/REVIEW →
  // BLOCKED flip (moe.report_blocked, or set_task_status for the human/board
  // path), and all cleared together on any unblock so a later resource grant
  // or sweep can't act on stale block state.
  blockedReason?: string | null;         // Why the task is BLOCKED
  blockedResourceId?: string | null;     // Shared-resource id the task is queued on; the grant path
                                         // auto-unblocks on lease grant. Null/absent = needs a human
                                         // (chat answer / moe.unblock_worker { resolveBlocks: true } /
                                         // set_task_status — a bare unblock_worker only frees the seat)
  blockedFromStatus?: TaskStatus | null; // Status to restore when the block clears
  blockedAt?: string | null;             // ISO timestamp of the BLOCKED flip

  // Completion evidence (set by moe.complete_task; surfaced to QA via get_context)
  verification?: {
    command: string;             // Exact verification command the worker ran
    exitCode: number;            // Always 0 (non-zero is rejected at complete_task)
    outputTail?: string;         // Last ≤2000 chars of its output
    reportedAt: string;          // ISO timestamp
  };
  filesModified?: string[];      // ASSERTED paths: completed steps' modifiedFiles ?? affectedFiles (complete_task)
                                 // ∪ non-inferred paths landed via moe.record_commit
  reviewSummary?: string;        // What QA verified at approval — set by qa_approve (required there)

  // Commit ledger — written only by moe.record_commit (wrapper post-flight)
  // and moe.declare_files; the daemon never runs git. Additive, no
  // schemaVersion bump. Never cleared by reopen/qa_reject.
  commits?: TaskCommit[];        // Every landed commit (completion/checkpoint/rescue); idempotent by sha,
                                 // capped at MAX_COMMITS_PER_TASK (50, newest kept)
  declaredFiles?: string[];      // moe.declare_files assertions (ASSERTED attribution tier)
  touchedFiles?: string[];       // Tool-write harvest (stream-json Edit/Write paths), unioned across sessions (ASSERTED tier)
  inferredPaths?: string[];      // MEASURED-tier paths the wrapper landed — PLANNED tier next session, never promoted
  unattributedPaths?: string[];  // Changed paths the last landing could not attribute (replaced each landing; never staged)
  lastCommitOutcome?: {          // Every landing attempt, including refused/failed/nothing
    outcome: 'committed' | 'nothing' | 'refused' | 'failed';
    kind: 'completion' | 'checkpoint' | 'rescue';
    code?: string;               // MOE_COMMIT_* code on refused/failed
    sessionId: string;           // "<workerId>@<preflight-iso>"
    at: string;                  // ISO timestamp
  };

  // Governance / metrics
  metrics?: TaskMetrics;                        // Lifecycle counters
  budget?: TaskBudget;                          // Soft wall-clock cap
  pendingPlanCritique?: PendingPlanCritique;    // Set by submit_plan in CONTROL mode
  planCritiqueResult?: PlanCritiqueResult;      // Set by submit_plan_critique

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
  reviewStartedAt?: string;      // Set on the WORKING → REVIEW flip; qa_approve counts only completion commits recorded at/after it
  reviewCompletedAt?: string;
}

type TaskStatus =
  | 'BACKLOG'           // Not started, in queue
  | 'PLANNING'          // Worker is creating plan
  | 'AWAITING_APPROVAL' // Plan ready for human review
  | 'WORKING'           // Worker executing plan
  | 'REVIEW'            // Work done, PR ready
  | 'BLOCKED'           // Parked on something outside the fleet's control — a shared-resource
                        // lease (blockedResourceId set; auto-unblocked on grant) or a human
                        // answer. Not agent-claimable; the wrapper suppresses CLI relaunch
  | 'DONE'              // Merged, complete
  | 'ARCHIVED';         // Shelved out of agent context

interface ImplementationStep {
  stepId: string;                // "step-1"
  description: string;           // "Create LoginForm component" (≤10000 chars; max 100 steps/plan)
  status: StepStatus;
  affectedFiles: string[];       // project-relative paths; max 50/step — must exist on disk
  newFiles?: string[];           // paths this step CREATES; exempt from the existence check; max 50/step
  startedAt?: string;            // When step started
  completedAt?: string;          // When step finished
  note?: string;                 // Optional note from complete_step
  modifiedFiles?: string[];      // EVERY file this step created/modified (complete_step; omitted → warning).
                                 // ASSERTED attribution tier: the wrapper commits it regardless of its baseline
  amendments?: StepAmendment[];  // Append-only revisions from moe.amend_plan_step (oldest first, max 10)
  activeAmendmentId?: string;    // Which amendment is in force; absent = follow `description`
}

// One in-place revision of a step's instructions (moe.amend_plan_step), so an
// architect/governor can correct a step without a full re-plan.
interface StepAmendment {
  amendmentId: string;           // "amend-1", "amend-2", … (sequential per step)
  description: string;           // FULL replacement instructions for the step — never a delta (≤5000 chars)
  reason: string;                // Why it was amended; posted to the assigned worker (≤2000 chars)
  amendedBy: string;             // workerId of the architect/governor
  amendedAt: string;             // ISO timestamp
}

type StepStatus =
  | 'PENDING'       // Not started
  | 'IN_PROGRESS'   // Currently executing
  | 'COMPLETED';    // Done
```

**Amendment resolution.** `ImplementationStep.description` is the step **as originally planned and is
never mutated** — that is the audit trail. The instructions a worker must actually follow are the
*effective* description: `activeAmendmentId ? amendments[matching].description : description`. A
dangling `activeAmendmentId` (no matching entry) degrades to the original description rather than
erroring. `moe.complete_step` echoes the effective text back (see `effectiveDescription` / `amended`
in docs/MCP_SERVER.md) so a worker following an amendment does not read as plan drift. Amending never
changes step status. Amendment **approval** flows are deliberately out of scope — an amendment takes
effect immediately.

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

### `affectedFiles` validation

`ImplementationStep.affectedFiles` (and `moe.submit_plan` step input) is normalized + validated server-side:

- Absolute paths and any segment containing `..` (parent traversal) are **rejected** with `INVALID_INPUT`.
- Path separators are normalized to `/` and entries are deduplicated.
- Max 50 entries per step; max 100 steps per plan; max 10000 chars per step description.
- Overlap with another `WORKING` task's `affectedFiles` surfaces as a `fileCollision[]` warning on `moe.claim_next_task` — advisory only, never blocks the claim.
- Every `affectedFiles` entry must **exist on disk** under the project root at submit time, or `moe.submit_plan` rejects the plan with `INVALID_INPUT` and lists the missing paths. This catches stale-doc plans (and package-relative paths like `src/x.ts` where the project root wants `packages/moe-daemon/src/x.ts`) at submit time instead of at step 1. The check fails open — an unreadable project root, or any stat error other than `ENOENT`/`ENOTDIR`, is treated as "exists".

### `newFiles`

`ImplementationStep.newFiles` (and the `moe.submit_plan` step input) declares the paths a step will **create**. Same normalization and 50-entry cap as `affectedFiles`. Declared paths are exempt from the existence check above, plan-wide — a file declared in step 1's `newFiles` may be cited in step 2's `affectedFiles`. They still count toward the plan-size distinct-file total (deduped against `affectedFiles`) and are still scanned by the rails check, so the exemption cannot be used to dodge either gate. The key is omitted from persisted steps when empty. Do not park files that already exist in `newFiles` to silence the gate — that hides a wrong path from the next worker and from collision detection.

### Task subtypes

```typescript
/**
 * One landed commit, reported by the agent wrapper via `moe.record_commit`.
 * `completion`/`checkpoint` entries point at a branch commit; `rescue` entries
 * point at `refs/moe/rescue/<taskId>/<ts>` (never pushed). Idempotent by `sha`;
 * `task.commits` is capped at MAX_COMMITS_PER_TASK (50), newest kept.
 */
interface TaskCommit {
  sha: string;
  treeId?: string;
  ref: string;                 // branch name, or refs/moe/rescue/<taskId>/<ts>
  kind: 'completion' | 'checkpoint' | 'rescue';
  status?: string;             // task status the wrapper resolved at landing (REVIEW/DONE/WORKING/BLOCKED/…/UNKNOWN)
  role: string;                // worker | architect | qa
  sessionId: string;           // "<workerId>@<preflight-iso>" — the commit's Moe-Session trailer
  paths: string[];             // landed paths (≤500)
  pathsTruncated?: boolean;
  inferredPaths?: string[];    // MEASURED-tier subset of `paths`
  contested?: { path: string; taskId: string }[];   // asserted here but also declared by a live peer
  pushed?: boolean;
  recordedBy: string;          // workerId that reported it
  recordedAt: string;          // ISO 8601
  recoveredBy?: string;        // set when another worker landed a lingering baseline
  message?: string;
}

interface RejectionDetails {
  failedDodItems?: string[];
  issues?: QAIssue[];
}

interface QAIssue {
  type: 'test_failure' | 'lint' | 'security' | 'missing_feature' | 'regression' | 'other';
  description: string;       // ≤500 chars
  file?: string;
  line?: number;
}

/** Historical QA rejection entry. Stored newest-first in `task.rejectionHistory`, capped at 20. */
interface RejectionHistoryEntry {
  reason: string;            // ≤2000 chars
  rejectedAt: string;        // ISO 8601
  reopenCount: number;       // value after this rejection
  failedDodItems?: string[];
  issues?: QAIssue[];
}

/**
 * Per-DoD-item rejection record. Append-only, capped at last 100 entries.
 * When the same `item` appears ≥2 times, `moe.qa_reject` auto-flips the task
 * back to PLANNING regardless of the global reopen cap — the spec, not the
 * worker, is treated as the bug.
 */
interface FailedDodItem {
  item: string;
  rejectedAt: string;        // ISO 8601
  rejectedBy: string;        // workerId of the rejecting QA agent
}

/** Snapshot preserved by `moe.request_replan` before clearing the plan. */
interface PriorAttempt {
  attemptedAt: string;       // ISO 8601
  reason: string;            // ≤2000 chars
  implementationPlan: ImplementationStep[];
  stepsCompleted: string[];
}

/**
 * Handoff note recorded when a worker releases a task. Stored newest-first in
 * `task.priorHandoffs`, capped at 20. Surfaced via `moe.get_handoff_history`.
 */
interface HandoffNote {
  whatIsDone: string;        // ≤4000 chars; required
  whatRemains: string;       // ≤4000 chars; required
  pitfalls?: string;         // ≤4000 chars
  openQuestions?: string;    // ≤4000 chars
  releasedBy?: string;       // workerId
  releasedAt: string;        // ISO 8601
  reason?: string;           // ≤2000 chars; copied from release_task `reason`
  // Best-effort git-status-derived signature of the working tree at release
  // time (`v1:<head-oid>:<changeCount>:<digest>`; compared only for equality).
  // `claim_next_task` recomputes it and returns `staleHandoffDiskState: true`
  // when it differs. Absent when the daemon could not compute it (no git, not
  // a repo, timeout) — absence means "unknown", never "unchanged".
  diskState?: string;
}

/**
 * Auto-populated lifecycle counters. `firstClaimAt` is stamped on the first
 * `moe.claim_next_task`; `wallClockMs` + `doneAt` populate on `moe.qa_approve`.
 * `plannedStepCount` is refreshed every time a plan is (re-)submitted.
 */
interface TaskMetrics {
  plannedStepCount?: number;
  plannedDistinctFileCount?: number;  // distinct affectedFiles + newFiles across all plan steps
  executedStepCount?: number;
  reopenCount?: number;
  rejectCount?: number;
  wallClockMs?: number;      // first claim → DONE
  firstClaimAt?: string;     // ISO 8601
  doneAt?: string;           // ISO 8601
  agentToolCallCount?: number;             // sum of AGENT_TOOL_EVENT for this task
  agentToolBreakdown?: Record<string, number>;  // tool name → count
}

/**
 * Soft wall-clock budget. The daemon checks `firstClaimAt + wallClockMs` on
 * every WORKING-path tool call and posts a one-shot warning at 80% then an
 * escalation at 100% to `#governors`. No hard kill — purely advisory.
 */
interface TaskBudget {
  wallClockMs?: number;
  warnedAt?: string;         // ISO 8601 — set once the 80% mark trips
  escalatedAt?: string;      // ISO 8601 — set once the 100% mark trips
}

/** Set by `moe.submit_plan` (CONTROL mode) when a governor exists to critique. */
interface PendingPlanCritique {
  criticWorkerId: string;
  requestedAt: string;
}

/** Written by `moe.submit_plan_critique`; clears `pendingPlanCritique`. */
interface PlanCritiqueResult {
  verdict: 'pass' | 'block';
  concerns?: string[];       // each ≤1000 chars; required when verdict='block'
  reviewedBy: string;        // workerId or "governor"
  reviewedAt: string;        // ISO 8601
}
```

### Reopen cap

```typescript
export const MAX_REOPENS_DEFAULT = 3;
```

`moe.qa_reject` auto-flips a task from `WORKING` back to `PLANNING` when either:

1. `reopenCount ≥ task.maxReopens ?? MAX_REOPENS_DEFAULT`, or
2. The same DoD item has been recorded in `failedDodItems[]` two or more times.

In both cases the architect (not the worker) is expected to pick up the re-plan; the daemon cross-posts a heads-up to `#architects` and emits a `TASK_REOPENED` activity event with the rejection history.

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
  | 'BLOCKED'           // Stuck, needs human help
  | 'GOVERNING'         // Governor overseeing in-flight work via chat (set by moe.enter_governance)
  | 'DEAD';             // Terminal: deregistered. Tasks released, record
                        // retained for idempotency/post-mortem, dropped from the UI, pruned later.
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
type TeamRole = 'architect' | 'worker' | 'qa' | 'governor';

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

## Resource

**File:** `.moe/resources/{resource-id}.json`

Runtime state of one shared resource — daemon-owned leases over exclusive-use infrastructure (a benchmark box, a staging DB, a GPU). Agents acquire or queue via the `moe.acquire_resource` / `moe.release_resource` / `moe.list_resources` / `moe.wait_for_resource` tools (contracts in docs/MCP_SERVER.md, `## Shared Resources`); the daemon grants FIFO-by-priority as capacity frees, and a task `BLOCKED` on a resource (`task.blockedResourceId`) is auto-unblocked when its lease is granted. Per-resource configuration lives in `settings.resources` on the Project (see `ResourceSettings` above); the file here holds only runtime state. The resource id doubles as the filename and must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.

```typescript
interface ResourceState {
  id: string;                    // "benchmark-box" — the resource id, also the filename
  holders: ResourceLease[];      // Active leases; length ≤ resolved capacity (default 1)
  queue: ResourceQueueEntry[];   // Waiters; granted in priority-then-FIFO order
  createdAt: string;             // ISO 8601 — first acquire auto-creates the file
  updatedAt: string;             // ISO 8601
}

// An active lease. Keyed by taskId — NOT workerId — so it survives CLI
// respawns and the daemon-restart worker purge.
interface ResourceLease {
  taskId: string;
  workerId: string;              // Most recent worker acting for the task
  note?: string;                 // What the holder is running (≤500 chars)
  etaMs?: number;                // Holder's own wall-clock estimate; informational only
  acquiredAt: string;            // ISO 8601
  expiresAt: string;             // Hard cap: acquiredAt + maxLeaseMs; the reap pass
                                 // force-releases past this (bounds a crashed holder)
}

interface ResourceQueueEntry {
  taskId: string;
  workerId: string;
  note?: string;
  requestedAt: string;           // ISO 8601 — FIFO tiebreak within equal task priority
}
```

**Example:**

```json
{
  "id": "benchmark-box",
  "holders": [
    {
      "taskId": "task-t1u2v3w4",
      "workerId": "worker-w1x2y3z4",
      "note": "full perf sweep on the auth service",
      "etaMs": 7200000,
      "acquiredAt": "2026-08-02T10:00:00Z",
      "expiresAt": "2026-08-03T10:00:00Z"
    }
  ],
  "queue": [
    {
      "taskId": "task-q5r6s7t8",
      "workerId": "worker-w5x6y7z8",
      "note": "baseline run before the cache change",
      "requestedAt": "2026-08-02T10:15:00Z"
    }
  ],
  "createdAt": "2026-08-02T10:00:00Z",
  "updatedAt": "2026-08-02T10:15:00Z"
}
```

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
  | 'TASK_BLOCKED'       // Task flipped to BLOCKED (moe.report_blocked / set_task_status)
  | 'TASK_UNBLOCKED'     // Block cleared: resource grant, moe.unblock_worker { resolveBlocks: true }, or set_task_status
  | 'TASK_BLOCK_PARKED'    // reserved: deferred unassigned-BLOCKED park sweep (settings.parkUnassignedBlocked), never emitted yet
  | 'TASK_COMMIT_RECORDED' // moe.record_commit persisted a landing outcome (commit appended, or refused/failed/nothing recorded)
  | 'TASK_FILES_DECLARED'  // moe.declare_files unioned paths into task.declaredFiles
  
  // Worker
  | 'WORKER_CONNECTED'
  | 'WORKER_DISCONNECTED'
  | 'WORKER_ERROR'
  | 'WORKER_BLOCKED'
  | 'WORKER_RELEASED'    // Task released from worker via moe.release_task
  | 'WORKER_GOVERNING'   // Governor entered governance mode via moe.enter_governance

  // Shared resources
  | 'RESOURCE_ACQUIRED'      // Lease granted directly on moe.acquire_resource
  | 'RESOURCE_QUEUED'        // Capacity full — task enqueued
  | 'RESOURCE_RELEASED'      // Lease released (payload `forced: true` on governor/reaper force-release)
  | 'RESOURCE_GRANTED'       // Queue entry promoted to a lease as capacity freed
  | 'RESOURCE_LEASE_EXPIRED' // Reap pass force-released a lease past expiresAt
  
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
  | 'DECISION_REJECTED'

  // Telemetry — one entry per `AGENT_TOOL_EVENT` WS message from the IDE plugin's
  // PostToolUse hook. Payload: { workerId, tool, durationMs? }
  | 'AGENT_TOOL_EVENT';
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
  schemaVersion: number;  // Current: 6 (CURRENT_SCHEMA_VERSION in packages/moe-daemon/src/types/schema.ts)
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

### Resource
- Resource ids (`settings.resources` keys, `.moe/resources/` filenames, and every tool `resourceId` param) must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (1-64 chars: letters, digits, `.`, `_`, `-`; no leading punctuation)
- `settings.resources` updates **replace** the stored map (not a deep merge — removing a resource must be possible); unknown per-resource fields are rejected
- `capacity` integer 1-100 (default 1); `maxLeaseMs` integer 60000-604800000 (1 min - 7 days; default 86400000 = 24h); `description` ≤500 chars
- Malformed or below-minimum values that reach the stored file by other means degrade to the defaults at resolve time rather than erroring

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

**BLOCKED** is a side state omitted from the diagram above:

```
  PLANNING ─┐
  WORKING  ─┼──▶ BLOCKED     moe.report_blocked (agents) or set_task_status (human/board);
  REVIEW   ─┘                records blockedReason / blockedResourceId / blockedFromStatus / blockedAt

  BLOCKED ──▶ WORKING | PLANNING | REVIEW    restore to blockedFromStatus: the resource grant
                                             path (auto, when blockedResourceId's lease lands),
                                             moe.unblock_worker { resolveBlocks: true }, or set_task_status
                                             (a bare unblock_worker frees the seat only — BLOCKED stays)
  BLOCKED ──▶ BACKLOG                        manual park for human triage
```

`BLOCKED` is deliberately **not** reachable from the human-gated columns (`BACKLOG`/`AWAITING_APPROVAL`) — nothing is running there to block. It is not agent-claimable: `claim_next_task`/`wait_for_task` reject it, and the agent wrapper suppresses CLI relaunch onto a held `BLOCKED` task (after landing any lingering baseline as a recovery checkpoint, so a blocked task's files still reach the branch). It is a wait state, never a terminal: `report_blocked` with every step already `COMPLETED` warns `ALL_STEPS_COMPLETE` and points at `complete_task`. Releases (daemon restart purge, deregister, `release_task`) and a seat-only `unblock_worker` keep a `BLOCKED` task `BLOCKED` — the blocker is still there; the blocked-timeout sweep parks a human-blocked task to `BACKLOG` but **skips** resource-waiting ones (`blockedResourceId` set), whose bound is the lease reaper instead. Leaving `BLOCKED` by any route clears all four `blocked*` fields.

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

## PlanningNotes

Stored on task as `task.planningNotes` when architect submits a plan.

| Field | Type | Description |
|-------|------|-------------|
| `approachesConsidered` | string | What alternatives were evaluated and why rejected |
| `codebaseInsights` | string | Patterns, conventions, architecture discovered |
| `risks` | string | Edge cases and potential issues |
| `keyFiles` | string[] | Critical files the worker should understand |

## Cross-Session Memory

Moe stores no memory entities under `.moe/`. Cross-session knowledge is owned by the **Serena MCP server**, which persists a flat per-name markdown store at `.serena/memories/*.md` (outside `.moe/`, not part of this schema). See [MEMORY.md](MEMORY.md) for the tools and naming convention.
