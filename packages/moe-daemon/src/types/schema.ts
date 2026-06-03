// =============================================================================
// Moe Schema (Daemon)
// =============================================================================

export type TaskStatus =
  | 'BACKLOG'
  | 'PLANNING'
  | 'AWAITING_APPROVAL'
  | 'WORKING'
  | 'REVIEW'
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
  // Terminal presence state: the worker is gone (graceful deregister or
  // liveness-timeout). Its tasks have been released; the record is retained
  // for post-mortem/idempotency and pruned later by the stale-worker sweep.
  | 'DEAD';

export type EpicStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED';

export interface GlobalRails {
  techStack: string[];
  forbiddenPatterns: string[];
  requiredPatterns: string[];
  formatting: string;
  testing: string;
  customRules: string[];
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
  /**
   * Auto-commit + push on worker `complete_task`. When true (default), the
   * agent wrapper runs `git add -A && git commit && git push` on the current
   * branch after a worker moves a task to REVIEW (first pass OR retry after
   * qa_reject). Commits use the user's configured git identity — no
   * Claude/Codex attribution. Set false to disable.
   */
  autoCommit?: boolean;               // default: true
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

export type TeamRole = 'architect' | 'worker' | 'qa' | 'governor';

export interface Team {
  id: string;
  projectId: string;
  name: string;
  role: TeamRole | null;
  memberIds: string[];
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

export interface ImplementationStep {
  stepId: string;
  description: string;
  status: StepStatus;
  affectedFiles: string[];
  startedAt?: string;
  completedAt?: string;
  note?: string;
  modifiedFiles?: string[];
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
}

/**
 * Per-task metrics auto-populated by the daemon across the task lifecycle.
 * `firstClaimAt` is set on the first claim_next_task; `doneAt` and
 * `wallClockMs` populate when the task hits DONE (qa_approve).
 */
export interface TaskMetrics {
  plannedStepCount?: number;
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
  comments: TaskComment[];
  hasPendingQuestion?: boolean;
  contextFetchedBy?: string[];
  stepsCompleted?: string[];
  /**
   * Handoff notes accumulated when workers release the task. Newest-first.
   * Surfaced to the next claimer via `moe.get_handoff_history`.
   */
  priorHandoffs?: HandoffNote[];
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
}

export interface PlanningNotes {
  approachesConsidered?: string;
  codebaseInsights?: string;
  risks?: string;
  keyFiles?: string[];
}
