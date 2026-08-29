// =============================================================================
// Moe Schema (Daemon)
// =============================================================================

export type TaskStatus =
  | 'BACKLOG'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'WORKING'
  | 'REVIEW'
  // Waiting on something outside the fleet's control — a shared resource lease
  // (task.blockedResourceId set; auto-unblocked by the resource grant path) or
  // a human answer (no resourceId; cleared ONLY via
  // moe.unblock_worker { resolveBlocks: true } or set_task_status — a plain
  // moe.unblock_worker frees the worker's SEAT and leaves the task BLOCKED).
  // NOT agent-claimable and NOT counted as churn: the agent wrapper suppresses
  // CLI relaunch for a held BLOCKED task instead of burning resume attempts
  // against a wall. BLOCKED is a wait state, never a terminal — delivered work
  // still goes through moe.complete_task.
  | 'BLOCKED'
  | 'DONE'
  | 'ARCHIVED';

export type StepStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

export type TaskPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type WorkerType = 'CLAUDE' | 'CODEX' | 'GEMINI';

export type WorkerStatus =
  | 'IDLE'
  | 'READING_CONTEXT'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'CODING'
  | 'BLOCKED'
  | 'GOVERNING'
  // Terminal presence state: the worker is gone (graceful deregister). Its
  // tasks have been released; the record is retained for post-mortem/
  // idempotency and pruned later once it owns nothing.
  | 'DEAD';

export type EpicStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';

export interface GlobalRails {
  techStack: string[];
  forbiddenPatterns: string[];
  requiredPatterns: string[];
  formatting: string;
  testing: string;
  customRules: string[];
}

/**
 * Plan-size thresholds enforced by moe.submit_plan. Oversized plans are the
 * leading cause of QA-reject churn (frontier models' 80%-reliability horizon
 * is ~30-60 human-minutes), so the daemon warns past the warn thresholds and
 * hard-rejects past the max thresholds with "split the task" guidance.
 * Distinct-file counts are the union of affectedFiles across all steps.
 */
export interface TaskSizingSettings {
  warnSteps?: number;          // default: 8
  maxSteps?: number;           // default: 12
  warnDistinctFiles?: number;  // default: 5
  maxDistinctFiles?: number;   // default: 10
  /**
   * CONTROL mode only: when true and NO governor is online, submit_plan
   * auto-blocks warn-zone plans (over warnSteps/warnDistinctFiles but under
   * the hard caps) back to PLANNING with "split the task" concerns, reusing
   * the governor-critique block machinery and its MAX_CRITIQUE_BLOCKS cap.
   * Default false — with a human or governor reviewing plans, the warnings
   * on the response/banner are their signal instead.
   */
  autoCritique?: boolean;
}

/**
 * How the agent wrapper attributes dirty paths the task never declared
 * (neither a completed step's modifiedFiles/affectedFiles, task.filesModified,
 * declare_files, nor a tool-write harvest). Read by the wrapper from
 * project.json and echoed by moe.get_commit_scope as `policy`.
 */
export interface AttributionSettings {
  /**
   * 'solo' (default): an undeclared path changed since the task's baseline is
   * committed as MEASURED (marked inferred) only when no other worker is
   * active; otherwise it is reported as unattributed. 'never': declared-only.
   * 'always': commit measured changes even with peers active (single-worker
   * projects). Env `MOE_ATTRIBUTION=declared` forces 'never' per run.
   */
  undeclared?: 'solo' | 'never' | 'always';
  /** A path both this task asserted and a peer declared: 'commit' (default) or 'skip'. */
  contested?: 'commit' | 'skip';
  /** Extra project-relative prefixes the wrapper never stages (added to the built-in DENY list). */
  exclude?: string[];
}

export interface ProjectSettings {
  approvalMode: 'CONTROL' | 'SPEED' | 'TURBO';
  speedModeDelayMs: number;
  autoCreateBranch: boolean;
  branchPattern: string;
  commitPattern: string;
  agentCommand: string;
  enableAgentTeams: boolean;
  columnLimits?: Record<string, number>;
  chatEnabled?: boolean;              // default: true
  chatMaxAgentHops?: number;          // default: 4 (loop guard threshold)
  /** Plan-size warn/reject thresholds for moe.submit_plan; see TaskSizingSettings. */
  taskSizing?: TaskSizingSettings;
  /**
   * Soft wall-clock milliseconds budgeted per plan step. moe.submit_plan
   * multiplies this by the step count to seed task.budget.wallClockMs when the
   * architect supplies no explicit budget. default: 900000 (15 min/step).
   */
  pacePerStepMs?: number;
  /**
   * Shell command (e.g. "npm run lint && npx tsc --noEmit") the worker
   * wrapper runs in the project directory before the post-flight auto-commit.
   * Non-zero exit blocks the commit/push and posts the failure to the task.
   * Empty/unset disables the gate. Env override: MOE_DISABLE_QUALITY_GATE=1.
   */
  qualityGate?: string;
  /**
   * When the gate runs. 'epicFinal' (default): only on the epic's final task
   * (highest order among siblings) — verification is concentrated, mid-epic
   * tasks stay lean and rely on their plan-named complete_task verification.
   * 'everyTask': the gate runs on every worker task completion.
   */
  qualityGateScope?: 'epicFinal' | 'everyTask';
  /**
   * Branch a worker is expected to be on when it calls `moe.complete_task`.
   * Either a literal branch name or a `*` glob (e.g. "moe/work-*", which is
   * what the agent wrappers peel onto). Matching is case-sensitive because git
   * branch names are. Empty/unset disables the check entirely; a completion
   * that reports no `currentBranch` is never blocked, only warned to
   * #governors, so wrapper rollout stays graceful.
   */
  consolidationBranch?: string;
  /**
   * Master switch for the agent wrapper's git activity. When true (default)
   * the wrapper lands the task's attributed paths on every session exit: a
   * `feat|fix(task-<id>)` completion commit when a worker session ends in
   * REVIEW/DONE, a `wip(task-<id>)` checkpoint on every other exit (see
   * `checkpointCommits`), and a `refs/moe/rescue/<taskId>/<ts>` rescue ref
   * when a commit cannot land on the branch. Staging is pathspec-only
   * (`:(literal)` per attributed path via a temp index) — never `git add -A`.
   * Commits use the user's configured git identity. `false` disables
   * completion, checkpoint and rescue commits alike (logged, not silent).
   */
  autoCommit?: boolean;               // default: true
  /**
   * `wip(task-<id>)` checkpoint commits on non-REVIEW exits and for
   * architect/qa sessions holding a task. Env `MOE_DISABLE_CHECKPOINT=1`
   * skips them per run. default: true
   */
  checkpointCommits?: boolean;
  /** Push checkpoint commits to origin; `false` keeps them local. default: true */
  checkpointPush?: boolean;
  /**
   * Let the wrapper commit board state alongside the task's paths: the task's
   * own `.moe/tasks/<id>.json` always, plus `.moe/epics/*.json`,
   * `.moe/project.json` and task records not held by a live peer when they
   * changed this session. default: true
   */
  commitBoardState?: boolean;
  /**
   * `true` → completion commits use porcelain `git commit -- <specs>` so
   * pre-commit/commit-msg hooks run (rescue-ref fallback on rejection);
   * checkpoints always use plumbing. default: false (plumbing everywhere —
   * `settings.qualityGate` is the sanctioned gate).
   */
  commitHooks?: boolean;
  /** Attribution policy for paths the task never declared; see AttributionSettings. */
  attribution?: AttributionSettings;
  /**
   * How long (ms) a worker may go without a moe.* tool call before Layer-3
   * staleness sweeps act on it. Raise this for projects whose verification
   * steps (builds, test suites) legitimately run long with no moe.* calls in
   * between — the agent wrapper's heartbeat sidecar covers most of this
   * already, so it mainly matters when the sidecar itself can't run.
   * default: 1800000 (30 min)
   */
  staleWorkerTimeoutMs?: number;
  /**
   * How long (ms) a REVIEW task's owner may be silent before the task is
   * released back to the QA pool. Scoped to REVIEW only. default: same as
   * staleWorkerTimeoutMs.
   */
  reviewStaleTimeoutMs?: number;
  /**
   * Project-relative globs for files every task appends to (changelogs,
   * release notes). Claim-time fileCollision warnings ignore them so real
   * overlaps stay visible. Literal paths, `*` (one segment) and `**` (across
   * directories) are supported; forward slashes only. Omitted → the runtime
   * default DEFAULT_APPEND_ONLY_FILES (`['CHANGELOG.md']`); a supplied array
   * REPLACES that default, and `[]` disables suppression entirely.
   */
  appendOnlyFiles?: string[];
  /**
   * Auto-park a task to BACKLOG when a third release inside 24h reports no
   * progress (`handoffNote.whatIsDone` says "nothing"/"none"/"n/a"). Mirrors
   * the blocked-timeout park: a task no agent can move is human-triage work,
   * not scheduler fuel. Omitted → enabled; only an explicit `false` disables
   * it, so old project files keep the protection. See moe.release_task in
   * docs/MCP_SERVER.md.
   */
  refusalCascadeAutoBacklog?: boolean; // default: true
  /**
   * Declared shared resources, keyed by resource id (e.g. "benchmark-box").
   * Purely optional: acquiring an undeclared id auto-creates it with the
   * ResourceSettings defaults (capacity 1, maxLeaseMs 24h). Declare a resource
   * here only to override those or to document it.
   */
  resources?: Record<string, ResourceSettings>;
}

export interface Project {
  id: string;
  schemaVersion: number;
  name: string;
  rootPath: string;
  globalRails: GlobalRails;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

export const CURRENT_SCHEMA_VERSION = 6;

/**
 * Default cap on QA reopen cycles. After this many rejections, qa_reject
 * sends the task back to PLANNING for re-planning instead of WORKING.
 * Override per-task via `task.maxReopens`.
 */
export const MAX_REOPENS_DEFAULT = 3;

/**
 * Default cap on governor plan-critique `block` flips before the task is parked
 * for a human instead of bounced back to PLANNING again. Governor block →
 * architect re-plan → block is its own loop (separate from the qa_reject reopen
 * cap), so it gets its own bound. Tracked via `task.critiqueBlockCount`.
 */
export const MAX_CRITIQUE_BLOCKS_DEFAULT = 2;

export type TeamRole = 'architect' | 'worker' | 'qa' | 'governor';

export interface Team {
  id: string;
  projectId: string;
  name: string;
  role: TeamRole | null;
  memberIds: string[];
  /**
   * Members whose WORKER RECORD was evicted (stale sweep, DEAD prune, startup
   * purge) while they still belonged to this team. The record — and with it
   * worker.teamId — dies on eviction, so the membership tombstone has to live
   * on the team, which survives. Read only to auto-rejoin a returning worker;
   * never counted toward maxSize and never routed to. Cleared the moment the
   * worker joins, or deliberately leaves, any team.
   */
  formerMemberIds?: string[];
  maxSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface Epic {
  id: string;
  projectId: string;
  title: string;
  description: string;
  architectureNotes: string;
  epicRails: string[];
  status: EpicStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One in-place revision of a plan step's instructions, recorded by
 * moe.amend_plan_step so an architect/governor can correct a step without a
 * full re-plan.
 *
 * `description` is the FULL replacement text for the step, never a delta.
 * Amendments are append-only and the step's original `description` is never
 * mutated, so the audit trail of what was originally asked stays intact.
 */
export interface StepAmendment {
  amendmentId: string;
  /** Full replacement instructions for the step (not a diff). */
  description: string;
  /** Why the step was amended — surfaced to the worker in chat. */
  reason: string;
  amendedBy: string;
  amendedAt: string;
}

export interface ImplementationStep {
  stepId: string;
  /**
   * The step as originally planned. Never rewritten by an amendment — read
   * `effectiveStepDescription(step)` (util/planAmendments.ts) for the text a
   * worker must actually follow.
   */
  description: string;
  status: StepStatus;
  affectedFiles: string[];
  /**
   * Paths this step will CREATE. They are exempt from the submit_plan on-disk
   * existence check and count toward the plan-size distinct-file total exactly
   * like affectedFiles. Optional so tasks persisted before this field keep
   * their shape.
   */
  newFiles?: string[];
  startedAt?: string;
  completedAt?: string;
  note?: string;
  /**
   * Every path the worker created or modified while doing this step, as
   * reported to moe.complete_step. This is the ASSERTED attribution tier: a
   * completed step's `modifiedFiles ?? affectedFiles` is committed by the
   * wrapper regardless of the pre-task baseline, so omitting it degrades the
   * task's commit to planned/measured attribution.
   */
  modifiedFiles?: string[];
  /**
   * Append-only revision history from moe.amend_plan_step, oldest first.
   * Absent on steps that were never amended.
   */
  amendments?: StepAmendment[];
  /**
   * Which entry in `amendments` is currently in force. The effective
   * description a worker must follow is
   * `activeAmendmentId ? amendments[matching].description : description`; a
   * dangling id degrades to the original description rather than throwing.
   * Amending does not change step status semantics in any way.
   */
  activeAmendmentId?: string;
}

export type QAIssueType = 'test_failure' | 'lint' | 'security' | 'missing_feature' | 'regression' | 'other';

export interface QAIssue {
  type: QAIssueType;
  description: string;
  file?: string;
  line?: number;
}

export interface TaskComment {
  id: string;
  author: string;
  content: string;
  timestamp: string;
}

export interface RejectionDetails {
  failedDodItems?: string[];
  issues?: QAIssue[];
}

/**
 * Historical rejection entry kept across QA reject cycles. Adds the rejection
 * `reason` and timestamp on top of the raw structured details so the worker
 * (and architect) can audit recurring failure patterns.
 */
export interface RejectionHistoryEntry {
  reason: string;
  rejectedAt: string;
  reopenCount: number;
  failedDodItems?: string[];
  issues?: QAIssue[];
}

/**
 * Snapshot of the work performed in a prior task attempt — preserved by
 * `moe.request_replan` so the architect can see what was built before
 * the task was flipped back to PLANNING.
 */
export interface PriorAttempt {
  attemptedAt: string;
  reason: string;
  implementationPlan: ImplementationStep[];
  stepsCompleted: string[];
}

/**
 * Handoff note recorded when a worker releases a task. Allows the next
 * claimer to read what was done, what remains, and any pitfalls the
 * previous worker encountered. Stored in `Task.priorHandoffs` (newest-first).
 */
export interface HandoffNote {
  whatIsDone: string;
  whatRemains: string;
  pitfalls?: string;
  openQuestions?: string;
  releasedBy?: string;
  releasedAt: string;
  reason?: string;
  /**
   * Opaque git-derived signature of the working tree at release time, captured
   * best-effort by `release_task`. `claim_next_task` recomputes it and sets
   * `staleHandoffDiskState` when it differs, so the next claimer knows the
   * note's claims — especially refusal reasons like "this file does not
   * compile" — may describe a tree that no longer exists. Absent when the
   * daemon could not compute it (no git, not a repo, timeout); absence must
   * never be treated as "unchanged".
   */
  diskState?: string;
}

/**
 * Per-task metrics auto-populated by the daemon across the task lifecycle.
 * `firstClaimAt` is set on the first claim_next_task; `doneAt` and
 * `wallClockMs` populate when the task hits DONE (qa_approve).
 */
export interface TaskMetrics {
  plannedStepCount?: number;
  /** Distinct affectedFiles across all plan steps — refreshed with each submit_plan. */
  plannedDistinctFileCount?: number;
  executedStepCount?: number;
  reopenCount?: number;
  rejectCount?: number;
  wallClockMs?: number;     // first claim → DONE
  firstClaimAt?: string;    // ISO
  doneAt?: string;          // ISO
  /**
   * Total number of agent tool invocations attributed to this task — sourced
   * from the AGENT_TOOL_EVENT WS hook posted by @moe/claude-plugin.
   */
  agentToolCallCount?: number;
  /**
   * Per-tool call counts, e.g. { Bash: 4, Read: 12, moe.complete_step: 1 }.
   * Populated alongside `agentToolCallCount`. Optional so legacy tasks don't
   * change shape until a new event lands.
   */
  agentToolBreakdown?: Record<string, number>;
}

/**
 * Soft budget on first-claim → DONE wall-clock duration. Daemon posts a
 * one-shot warning at 80% and an escalation at 100% to `#governors`.
 *
 * // TODO: token budget once Agent SDK is wired
 */
export interface TaskBudget {
  wallClockMs?: number;
  warnedAt?: string;
  escalatedAt?: string;
}

/**
 * Plan critique state. Governors call `moe.submit_plan_critique` after a
 * plan is submitted to flag concerns BEFORE human approval. A `block`
 * verdict flips the task back to PLANNING; `pass` is informational.
 */
export interface PendingPlanCritique {
  criticWorkerId: string;
  requestedAt: string;
}

export interface PlanCritiqueResult {
  verdict: 'pass' | 'block';
  concerns?: string[];
  reviewedBy: string;
  reviewedAt: string;
}

/**
 * Verification evidence required by moe.complete_task: the exact command the
 * worker ran to prove the task done, its exit code (must be 0), and the tail
 * of its output. Persisted on the task and surfaced to QA via get_context so
 * rejections can be anchored to evidence instead of the worker's say-so.
 * This is attestation, not execution — the daemon never runs the command
 * (tool dispatch is serialized on the global state mutex); QA re-runs it.
 */
export interface TaskVerification {
  command: string;
  exitCode: number;
  outputTail?: string;
  reportedAt: string; // ISO
}

export type TaskCommitKind = 'completion' | 'checkpoint' | 'rescue';

export type TaskCommitOutcome = 'committed' | 'nothing' | 'refused' | 'failed';

/**
 * One git landing recorded by moe.record_commit (the agent wrapper's
 * post-flight, best-effort). Append-only ledger, idempotent by sha, capped at
 * MAX_COMMITS_PER_TASK (newest kept). `kind`: 'completion' = feat|fix commit on
 * the shared branch after a worker session ended in REVIEW/DONE; 'checkpoint'
 * = wip commit on any other exit; 'rescue' = snapshot on
 * refs/moe/rescue/<taskId>/<ts> (never a branch, never pushed). The daemon
 * never runs git — this is attestation, verified by QA via `git show <sha>`.
 */
export interface TaskCommit {
  sha: string;
  /** Rebase-stable tree id (`rev-parse <sha>^{tree}`); absent when the wrapper could not compute it. */
  treeId?: string;
  /** Branch name or `refs/moe/rescue/…` ref the commit landed on. */
  ref: string;
  kind: TaskCommitKind;
  /** Task status the wrapper resolved at landing time (e.g. REVIEW, BLOCKED, UNKNOWN). */
  status?: string;
  role: string;
  /** `<workerId>@<preflight-iso>` — matches the commit's `Moe-Session:` trailer. */
  sessionId: string;
  /** Project-relative paths the commit carried (≤500; see pathsTruncated). */
  paths: string[];
  pathsTruncated?: boolean;
  /** Subset of `paths` attributed by measurement only (never promoted to filesModified). */
  inferredPaths?: string[];
  /** Paths a peer task also declared, committed under the `contested: 'commit'` policy. */
  contested?: { path: string; taskId: string }[];
  pushed?: boolean;
  recordedBy: string;
  recordedAt: string; // ISO
  /** Worker that landed another task's lingering baseline (orphan recovery). */
  recoveredBy?: string;
  message?: string;
}

/** Result of the most recent moe.record_commit call for the task, whatever its outcome. */
export interface TaskLastCommitOutcome {
  outcome: TaskCommitOutcome;
  kind: TaskCommitKind;
  /** Refusal/failure code (e.g. MOE_COMMIT_REFUSED_NO_OWNED_PATHS, MOE_COMMIT_FAILED_REF_CONTENTION). */
  code?: string;
  sessionId: string;
  at: string; // ISO
}

/**
 * Per-DoD-item rejection record. Multiple rejections on the same item
 * indicate a structural problem the architect — not the worker — should fix.
 */
export interface FailedDodItem {
  item: string;
  rejectedAt: string;
  rejectedBy: string;
}

/**
 * Runtime-driven workflow hint attached to tool responses. Tells the agent
 * which MCP tool to call next and why — so the agent follows a server-authored
 * state machine instead of a prompt-authored workflow. Purely advisory; the
 * enforcement layer in util/enforcement.ts is what actually blocks out-of-order
 * calls. But a well-populated nextAction means the agent rarely hits enforcement
 * in the first place.
 */
/**
 * Skill the daemon recommends the agent load before invoking `NextAction.tool`.
 *
 * `name` matches a directory under `.moe/skills/<name>/SKILL.md`. `reason` is
 * a short "why now" the agent can latch onto to resist rationalizing past the
 * recommendation ("I'm blocking, not planning"). See
 * `packages/moe-daemon/src/util/recommendSkill.ts` for the phase→skill table.
 */
export interface SkillRecommendation {
  name: string;
  reason: string;
}

export interface NextAction {
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
  /**
   * Optional skill (e.g. 'verification-before-completion') the agent should
   * invoke via the host's Skill tool before performing the next action.
   * Advisory — agents can ignore — but the agent-wrapper emits a JIT
   * system-reminder naming this skill when it is set.
   */
  recommendedSkill?: SkillRecommendation;
}

export interface Task {
  id: string;
  epicId: string;
  title: string;
  description: string;
  definitionOfDone: string[];
  taskRails: string[];
  implementationPlan: ImplementationStep[];
  status: TaskStatus;
  assignedWorkerId: string | null;
  branch: string | null;
  prLink: string | null;
  reopenCount: number;
  reopenReason: string | null;
  rejectionDetails?: RejectionDetails;
  /**
   * Accumulated history of QA rejections for this task. Newest entry first.
   * Allows triage of recurring failure patterns and prevents the previous
   * "overwrite-and-lose" behavior.
   */
  rejectionHistory?: RejectionHistoryEntry[];
  /**
   * Hard cap on QA reopen cycles before the task is auto-flipped back to
   * PLANNING (architect picks it up rather than the worker spinning on the
   * same rejection). Defaults to MAX_REOPENS_DEFAULT (3).
   */
  maxReopens?: number;
  /**
   * Snapshot of the prior implementation attempt — populated by
   * `moe.request_replan` when work is shipped back to PLANNING.
   */
  priorAttempt?: PriorAttempt;
  createdBy: 'HUMAN' | 'WORKER';
  parentTaskId: string | null;
  priority: TaskPriority;
  order: number;
  createdAt: string;
  updatedAt: string;
  planSubmittedAt?: string;
  planApprovedAt?: string;
  workStartedAt?: string;
  completedAt?: string;
  reviewStartedAt?: string;
  reviewCompletedAt?: string;
  /** What QA verified at approval (commands re-run, DoD items checked) — set by qa_approve. */
  reviewSummary?: string;
  comments: TaskComment[];
  hasPendingQuestion?: boolean;
  contextFetchedBy?: string[];
  stepsCompleted?: string[];
  /**
   * Handoff notes accumulated when workers release the task. Newest-first.
   * Surfaced to the next claimer via `moe.get_handoff_history`.
   */
  priorHandoffs?: HandoffNote[];
  /**
   * Plan-size warnings from the latest submit_plan (warn-zone only — plans past
   * the hard caps are rejected outright). Cleared when a compliant plan lands.
   * Persisted so boards/governors can see size pressure without reading chat.
   */
  planSizeWarnings?: string[];
  /** Verification evidence submitted with complete_task; see TaskVerification. */
  verification?: TaskVerification;
  /**
   * Union of per-step modifiedFiles (falling back to affectedFiles) captured
   * at complete_task, so QA sees the changed-file set without depending on
   * the worker having volunteered it per step. moe.record_commit unions each
   * committed commit's non-inferred paths into it, so it grows across
   * checkpoint/completion landings. ASSERTED attribution tier.
   */
  filesModified?: string[];
  /**
   * Git landings recorded for this task by moe.record_commit (newest last,
   * capped at MAX_COMMITS_PER_TASK). Survives qa_reject reopens — it is
   * history, not completion evidence; qa_approve looks for a completion
   * commit recorded after `reviewStartedAt`.
   */
  commits?: TaskCommit[];
  /** Paths explicitly declared via moe.declare_files (ASSERTED tier; governor/worker lever). */
  declaredFiles?: string[];
  /** Paths the agent's editing tools were observed writing (stream-json harvest; ASSERTED tier). */
  touchedFiles?: string[];
  /** Paths committed by measurement only (MEASURED tier); PLANNED tier next session, never promoted. */
  inferredPaths?: string[];
  /**
   * Dirty paths the last session changed but could not attribute (peers
   * active, policy 'solo'/'never'). Reported, never staged. Replaced on every
   * record_commit that reports them; cleared by declaring them
   * (moe.declare_files) and landing them.
   */
  unattributedPaths?: string[];
  /** Outcome of the most recent moe.record_commit for this task, every outcome included. */
  lastCommitOutcome?: TaskLastCommitOutcome;
  /** Auto-populated lifecycle metrics; see TaskMetrics. */
  metrics?: TaskMetrics;
  /** Soft wall-clock budget on first-claim → DONE; see TaskBudget. */
  budget?: TaskBudget;
  /** Set when submit_plan posts a critique request to governors. */
  pendingPlanCritique?: PendingPlanCritique;
  /** Result of a governor's plan critique; informational unless verdict='block'. */
  planCritiqueResult?: PlanCritiqueResult;
  /**
   * Append-only log of DoD items that failed QA review. Used to auto-flip
   * the task back to PLANNING when the SAME item fails ≥2 times, even if
   * the global reopen cap hasn't been hit.
   */
  failedDodItems?: FailedDodItem[];
  /**
   * Set true when a task exhausts BOTH its reopen budget AND the single
   * architect re-plan that follows (qa_reject hard cap), or exhausts the
   * governor plan-critique block cap. The task is parked in place (status
   * unchanged, assignee cleared) and excluded from the QA claim pool until a
   * human clears it (qa_approve / set_task_status reopen / release_task / board
   * move). This is what breaks the qa_reject and critique-block churn loops.
   */
  needsHumanReview?: boolean;
  /**
   * Count of governor plan-critique `block` verdicts that flipped this task
   * back to PLANNING. Bounded by MAX_CRITIQUE_BLOCKS_DEFAULT; deliberately
   * separate from `reopenCount` so critique blocks don't corrupt the qa_reject
   * cap or reopen metrics.
   */
  critiqueBlockCount?: number;
  /**
   * Why the task is BLOCKED (from report_blocked). Cleared only when the
   * block itself is resolved — resource grant, set_task_status, or
   * moe.unblock_worker { resolveBlocks: true }. A plain unblock_worker frees
   * the worker's seat and leaves this intact on the still-BLOCKED task.
   */
  blockedReason?: string | null;
  /**
   * Shared-resource id the task is queued on while BLOCKED. When the lease is
   * granted the daemon auto-unblocks the task (status → blockedFromStatus).
   * Null/absent means the block needs a human (chat answer, set_task_status,
   * or unblock_worker { resolveBlocks: true }).
   */
  blockedResourceId?: string | null;
  /** Status to restore when the block clears. Set on the WORKING/PLANNING/REVIEW → BLOCKED flip. */
  blockedFromStatus?: TaskStatus | null;
  /** ISO timestamp of the BLOCKED flip. Cleared when the block is resolved (not on a seat-only unblock). */
  blockedAt?: string | null;
}

export interface Worker {
  id: string;
  type: WorkerType;
  projectId: string;
  epicId: string;
  currentTaskId: string | null;
  status: WorkerStatus;
  branch: string;
  modifiedFiles: string[];
  startedAt: string;
  lastActivityAt: string;
  lastError: string | null;
  errorCount: number;
  teamId: string | null;
  chatCursors?: Record<string, string>; // channelId → lastReadMessageId (default: {})
}

// =============================================================================
// Shared resources — daemon-owned leases over exclusive-use infrastructure
// (a benchmark box, a staging DB, a GPU). Replaces per-project marker files +
// pid-probe scripts: agents acquire/queue via moe.* tools, the daemon grants
// FIFO-by-priority as capacity frees, and a task BLOCKED on a resource is
// auto-unblocked when its lease is granted.
// =============================================================================

/** An active lease. Keyed by taskId so it survives CLI respawns and daemon-restart worker purges. */
export interface ResourceLease {
  taskId: string;
  workerId: string;
  /** What the holder is doing — surfaced to queued agents and list_resources. */
  note?: string;
  /** Holder's own wall-clock estimate (ms), informational only. */
  etaMs?: number;
  acquiredAt: string;
  /** Hard cap: the reaper force-releases past this (acquiredAt + maxLeaseMs). */
  expiresAt: string;
}

export interface ResourceQueueEntry {
  taskId: string;
  workerId: string;
  note?: string;
  requestedAt: string;
}

/** Runtime state of one shared resource; persisted at .moe/resources/<id>.json (daemon sole-writer). */
export interface ResourceState {
  id: string;
  holders: ResourceLease[];
  queue: ResourceQueueEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Optional per-resource declaration in settings.resources; undeclared resources get the defaults. */
export interface ResourceSettings {
  /** Concurrent leases allowed. default: 1 */
  capacity?: number;
  /** Hard lease cap in ms before the reaper force-releases. default: 86400000 (24h) */
  maxLeaseMs?: number;
  description?: string;
}

export type ProposalType = 'ADD_RAIL' | 'MODIFY_RAIL' | 'REMOVE_RAIL';
export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface RailProposal {
  id: string;
  workerId: string;
  taskId: string;
  proposalType: ProposalType;
  targetScope: 'GLOBAL' | 'EPIC' | 'TASK';
  currentValue: string | null;
  proposedValue: string;
  reason: string;
  status: ProposalStatus;
  resolvedAt: string | null;
  resolvedBy: 'HUMAN' | 'AUTO' | null;
  createdAt: string;
}

export const ACTIVITY_EVENT_TYPES = [
  'PROJECT_CREATED',
  'PROJECT_SETTINGS_UPDATED',
  'GLOBAL_RAILS_UPDATED',
  'EPIC_CREATED',
  'EPIC_UPDATED',
  'EPIC_DELETED',
  'EPIC_STARTED',
  'EPIC_COMPLETED',
  'EPIC_ARCHIVED',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_DELETED',
  'TASK_STARTED',
  'PLAN_SUBMITTED',
  'PLAN_APPROVED',
  'PLAN_AUTO_APPROVED',
  'PLAN_REJECTED',
  'STEP_STARTED',
  'STEP_COMPLETED',
  'TASK_COMPLETED',
  'PR_OPENED',
  'TASK_REOPENED',
  'QA_APPROVED',
  'QA_REJECTED',
  'WORKER_CREATED',
  'WORKER_CONNECTED',
  'WORKER_DISCONNECTED',
  'WORKER_ERROR',
  'WORKER_BLOCKED',
  'WORKER_REPLACED',
  'WORKER_RELEASED',
  'WORKER_UNBLOCKED',
  'WORKER_GOVERNING',
  'WORKER_TIMEOUT',
  'TASK_BLOCKED',
  'TASK_UNBLOCKED',
  // Reserved for the (deferred, not yet built) unassigned-BLOCKED park sweep.
  'TASK_BLOCK_PARKED',
  'TASK_COMMIT_RECORDED',
  'TASK_FILES_DECLARED',
  'RESOURCE_ACQUIRED',
  'RESOURCE_QUEUED',
  'RESOURCE_RELEASED',
  'RESOURCE_GRANTED',
  'RESOURCE_LEASE_EXPIRED',
  'PROPOSAL_CREATED',
  'PROPOSAL_APPROVED',
  'PROPOSAL_REJECTED',
  'TEAM_CREATED',
  'TEAM_UPDATED',
  'TEAM_DELETED',
  'TEAM_MEMBER_ADDED',
  'TEAM_MEMBER_REMOVED',
  'TASK_ARCHIVED',
  'TASK_COMMENT_ADDED',
  'PROPOSAL_PURGED',
  'MESSAGE_CREATED',
  'CHANNEL_CREATED',
  'CHANNEL_DELETED',
  'PIN_CREATED',
  'PIN_REMOVED',
  'PIN_TOGGLED',
  'DECISION_PROPOSED',
  'DECISION_APPROVED',
  'DECISION_REJECTED',
  'AGENT_TOOL_EVENT'
] as const;

export type ActivityEventType = typeof ACTIVITY_EVENT_TYPES[number];

export interface ActivityEvent {
  id: string;
  timestamp: string;
  projectId: string;
  epicId?: string;
  taskId?: string;
  workerId?: string;
  event: ActivityEventType;
  payload: Record<string, unknown>;
}

export interface MoeStateSnapshot {
  project: Project;
  epics: Epic[];
  tasks: Task[];
  workers: Worker[];
  proposals: RailProposal[];
  teams: Team[];
  channels: ChatChannel[];
  decisions: Decision[];
  resources: ResourceState[];
}

// =============================================================================
// Chat Types
// =============================================================================

export interface ChatMessage {
  id: string;                    // "msg-{uuid}"
  channel: string;               // channel ID
  sender: string;                // workerId or "human" or "system"
  content: string;               // message text (max 10KB)
  replyTo: string | null;        // parent message ID for threading
  mentions: string[];            // parsed @mentions (workerId strings)
  timestamp: string;             // ISO 8601
  decisionId?: string;           // linked decision ID (if this message proposes a decision)
}

export interface ChatChannel {
  id: string;                    // "chan-{uuid}"
  name: string;                  // "general", "epic-auth", "task-login"
  type: 'general' | 'role' | 'custom';
  linkedEntityId: string | null; // epicId or taskId if type is epic/task
  createdAt: string;
}

export interface PinEntry {
  messageId: string;
  pinnedBy: string;
  pinnedAt: string;
  done: boolean;
  doneAt: string | null;
}

export type DecisionStatus = 'proposed' | 'approved' | 'rejected';

export interface Decision {
  id: string;
  proposedBy: string;
  content: string;
  status: DecisionStatus;
  approvedBy: string | null;
  channel: string | null;
  messageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  projectPath: string;
  /** Present only when the daemon listens beyond loopback (e.g. '0.0.0.0' for WSL agents). */
  bindHost?: string;
}

export interface PlanningNotes {
  approachesConsidered?: string;
  codebaseInsights?: string;
  risks?: string;
  keyFiles?: string[];
}
