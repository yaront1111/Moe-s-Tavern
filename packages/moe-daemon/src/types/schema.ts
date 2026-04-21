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
  | 'BLOCKED';

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

export type TeamRole = 'architect' | 'worker' | 'qa';

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
 * Runtime-driven workflow hint attached to tool responses. Tells the agent
 * which MCP tool to call next and why — so the agent follows a server-authored
 * state machine instead of a prompt-authored workflow. Purely advisory; the
 * enforcement layer in util/enforcement.ts is what actually blocks out-of-order
 * calls. But a well-populated nextAction means the agent rarely hits enforcement
 * in the first place.
 */
export interface NextAction {
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
  /**
   * Optional skill name (e.g. 'verification-before-completion') the agent
   * should invoke via the host's Skill tool before performing the next action.
   * Skills live under .moe/skills/<name>/SKILL.md. Purely advisory — agents
   * can ignore. See packages/moe-daemon/src/util/recommendSkill.ts.
   */
  recommendedSkill?: string;
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
  'WORKER_UNBLOCKED',
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
  'DECISION_REJECTED'
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

// =============================================================================
// Memory System
// =============================================================================

export type MemoryType = 'convention' | 'gotcha' | 'pattern' | 'decision' | 'procedure' | 'insight';

export const MEMORY_TYPES: MemoryType[] = ['convention', 'gotcha', 'pattern', 'decision', 'procedure', 'insight'];

export interface MemorySource {
  files: string[];
  taskId: string | null;
  epicId: string | null;
  workerId: string | null;
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  source: MemorySource;
  confidence: number;
  accessCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  createdAt: string;
  lastAccessedAt: string;
  supersededBy: string | null;
  contentHash: string;
}

export interface SessionSummary {
  id: string;
  workerId: string;
  taskId: string;
  role: string;
  summary: string;
  memoriesCreated: string[];
  completedSteps?: string[];
  createdAt: string;
}

export interface PlanningNotes {
  approachesConsidered?: string;
  codebaseInsights?: string;
  risks?: string;
  keyFiles?: string[];
}

export interface MemoryQuery {
  query?: string;
  types?: MemoryType[];
  tags?: string[];
  epicId?: string;
  files?: string[];
  limit?: number;
  minConfidence?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}
