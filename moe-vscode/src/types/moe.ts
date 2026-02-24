/**
 * Moe TypeScript types for the VS Code extension.
 *
 * These types mirror the canonical daemon schema defined in:
 *   packages/moe-daemon/src/types/schema.ts
 *
 * Keep in sync with that file when the daemon schema changes.
 */

// =============================================================================
// Union / Enum Types
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

export type TeamRole = 'architect' | 'worker' | 'qa';

export type ProposalType = 'ADD_RAIL' | 'MODIFY_RAIL' | 'REMOVE_RAIL';

export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export type QAIssueType = 'test_failure' | 'lint' | 'security' | 'missing_feature' | 'regression' | 'other';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

// =============================================================================
// Data Interfaces
// =============================================================================

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

export const CURRENT_SCHEMA_VERSION = 4;

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
}

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

// =============================================================================
// Activity Log
// =============================================================================

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
  'PROPOSAL_PURGED'
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

// =============================================================================
// State Snapshot
// =============================================================================

export interface MoeStateSnapshot {
  project: Project;
  epics: Epic[];
  tasks: Task[];
  workers: Worker[];
  proposals: RailProposal[];
  teams: Team[];
}

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  projectPath: string;
}

// =============================================================================
// WebSocket Message Types
// =============================================================================

/**
 * Messages sent from the client (VS Code extension) to the daemon via /ws.
 * Matches the PluginMessage union in WebSocketServer.ts.
 */
export type PluginOutboundMessage =
  | { type: 'PING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_ACTIVITY_LOG'; payload?: { limit?: number } }
  | { type: 'CREATE_TASK'; payload: Record<string, unknown> }
  | { type: 'UPDATE_TASK'; payload: { taskId: string; updates: Record<string, unknown> } }
  | { type: 'DELETE_TASK'; payload: { taskId: string } }
  | { type: 'CREATE_EPIC'; payload: Record<string, unknown> }
  | { type: 'UPDATE_EPIC'; payload: { epicId: string; updates: Record<string, unknown> } }
  | { type: 'DELETE_EPIC'; payload: { epicId: string } }
  | { type: 'REORDER_TASK'; payload: { taskId: string; beforeId: string | null; afterId: string | null } }
  | { type: 'APPROVE_TASK'; payload: { taskId: string } }
  | { type: 'REJECT_TASK'; payload: { taskId: string; reason: string } }
  | { type: 'REOPEN_TASK'; payload: { taskId: string; reason: string } }
  | { type: 'APPROVE_PROPOSAL'; payload: { proposalId: string } }
  | { type: 'REJECT_PROPOSAL'; payload: { proposalId: string } }
  | { type: 'UPDATE_SETTINGS'; payload: Record<string, unknown> }
  | { type: 'CREATE_TEAM'; payload: { name: string; role: string; maxSize?: number } }
  | { type: 'UPDATE_TEAM'; payload: { teamId: string; updates: Record<string, unknown> } }
  | { type: 'DELETE_TEAM'; payload: { teamId: string } }
  | { type: 'ADD_TEAM_MEMBER'; payload: { teamId: string; workerId: string } }
  | { type: 'REMOVE_TEAM_MEMBER'; payload: { teamId: string; workerId: string } }
  | { type: 'ARCHIVE_DONE_TASKS'; payload?: { epicId?: string } }
  | { type: 'ADD_TASK_COMMENT'; payload: { taskId: string; content: string; author?: string } };

/**
 * Messages sent from the daemon to the client via /ws.
 * Matches the StateChangeEvent union in StateManager.ts plus direct responses.
 */
export type DaemonInboundMessage =
  | { type: 'PONG' }
  | { type: 'STATE_SNAPSHOT'; payload: MoeStateSnapshot }
  | { type: 'TASK_CREATED'; payload: Task }
  | { type: 'TASK_UPDATED'; payload: Task }
  | { type: 'TASK_DELETED'; payload: Task }
  | { type: 'EPIC_CREATED'; payload: Epic }
  | { type: 'EPIC_UPDATED'; payload: Epic }
  | { type: 'EPIC_DELETED'; payload: Epic }
  | { type: 'WORKER_CREATED'; payload: Worker }
  | { type: 'WORKER_UPDATED'; payload: Worker }
  | { type: 'WORKER_DELETED'; payload: Worker }
  | { type: 'PROPOSAL_CREATED'; payload: RailProposal }
  | { type: 'PROPOSAL_UPDATED'; payload: RailProposal }
  | { type: 'SETTINGS_UPDATED'; payload: Project }
  | { type: 'TEAM_CREATED'; payload: Team }
  | { type: 'TEAM_UPDATED'; payload: Team }
  | { type: 'TEAM_DELETED'; payload: Team }
  | { type: 'ACTIVITY_LOG'; payload: ActivityEvent[] }
  | { type: 'ERROR'; message: string }
  | { type: 'DAEMON_SHUTTING_DOWN' };

// =============================================================================
// Type Guard
// =============================================================================

const DAEMON_MESSAGE_TYPES = new Set([
  'PONG', 'STATE_SNAPSHOT', 'TASK_CREATED', 'TASK_UPDATED', 'TASK_DELETED',
  'EPIC_CREATED', 'EPIC_UPDATED', 'EPIC_DELETED',
  'WORKER_CREATED', 'WORKER_UPDATED', 'WORKER_DELETED',
  'PROPOSAL_CREATED', 'PROPOSAL_UPDATED', 'SETTINGS_UPDATED',
  'TEAM_CREATED', 'TEAM_UPDATED', 'TEAM_DELETED',
  'ACTIVITY_LOG', 'ERROR', 'DAEMON_SHUTTING_DOWN'
]);

/**
 * Type guard for safe parsing of incoming WebSocket messages.
 */
export function isDaemonMessage(msg: unknown): msg is DaemonInboundMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const obj = msg as Record<string, unknown>;
  return typeof obj.type === 'string' && DAEMON_MESSAGE_TYPES.has(obj.type);
}
