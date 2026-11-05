import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import { PlanReviewPanel, STALE_REJECT, seedRevisionAttribute, showApprovalRefusal, stepTextHtml } from './PlanReviewPanel';
import type {
    HandoffNote,
    ImplementationStep,
    Task,
    TaskComment,
    TaskPriority,
} from '../types/moe';

// =============================================================================
// Blocker presentation
// =============================================================================

/**
 * Why a BLOCKED task is parked. Each cause clears differently, which is the
 * whole point of naming it: a dependency wait clears itself when its
 * prerequisites finish, a resource wait clears on the lease grant, and a plain
 * external block needs a person.
 *
 * This is a copy of the contract the JetBrains plugin ships and owns
 * (moe-jetbrains/src/main/kotlin/com/moe/toolwindow/TaskBlockerPresentation.kt,
 * task-aec72949166b42a99b4279ba4615ac4b); the precedence is not re-derived
 * here. It lives beside the only TypeScript renderer that consumes it, the way
 * the JetBrains rule lives in its own `toolwindow` package rather than in the
 * model. media/board.js and media/taskDetail.js are plain browser scripts with
 * no bundler, so they cannot import it and each carries its own copy;
 * tests/task-blocker-visibility.test.cjs drives one shared fixture table
 * through all three, so drift fails a test instead of shipping.
 */
export type BlockCause = 'RESOURCE_WAIT' | 'DEPENDENCY_WAIT' | 'EXTERNAL_BLOCK';

/** The only status that can carry a live block. */
export const BLOCKED_STATUS = 'BLOCKED';

/** Short cause label: the card chip, and the detail headline. */
export const BLOCK_CAUSE_LABEL: Record<BlockCause, string> = {
    RESOURCE_WAIT: 'Resource wait',
    DEPENDENCY_WAIT: 'Dependency wait',
    EXTERNAL_BLOCK: 'External block',
};

/** What clears each cause — the only actionable part of a parked task. */
export const BLOCK_CAUSE_CLEARS: Record<BlockCause, string> = {
    RESOURCE_WAIT: 'Clears automatically when the shared resource lease is granted.',
    DEPENDENCY_WAIT:
        'Clears automatically when every recorded prerequisite reaches a finished state (DONE or ARCHIVED).',
    EXTERNAL_BLOCK: 'Needs a person: a human or governor has to clear this block.',
};

export const ATTENTION_LABEL = 'Awaiting human review';
export const ATTENTION_CLEARS = 'Needs a person: a human or QA has to review this task.';
export const BLOCKER_SECTION_TITLE = 'Blocker';
export const BLOCKER_REASON_LABEL = 'Reported reason';
export const BLOCKER_REASON_MISSING = 'No reason was recorded.';
export const BLOCKER_PREREQUISITES_LABEL = 'Prerequisites recorded as waited on';
export const BLOCKER_RESOURCE_LABEL = 'Resource';
export const BLOCKER_FROM_STATUS_LABEL = 'Blocked from';
export const BLOCKER_BLOCKED_AT_LABEL = 'Blocked at';

/** A non-blank string, or null for anything else: missing, null, wrong type. */
function nonBlankString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The prerequisite ids the task RECORDED as waited on, in the order the daemon
 * sent them, duplicates kept, each id verbatim.
 *
 * These are NOT "unfinished tasks" — the daemon counts finished, archived and
 * deleted ids as satisfied — so no caller may present them as a count of
 * outstanding work. Blank entries can never identify a task and are dropped, so
 * a list of nothing but blanks falls through to the next cause. A missing, null
 * or wrong-shaped field yields an empty list rather than throwing.
 */
export function blockedPrerequisiteIds(task: Task): string[] {
    const ids: unknown = task?.blockedOnTaskIds;
    if (!Array.isArray(ids)) {
        return [];
    }
    return ids.filter((id: unknown): id is string => nonBlankString(id) !== null);
}

/**
 * Why `task` is parked, or null when it is not actively blocked.
 *
 * The status gate is load-bearing: a task that has left BLOCKED usually still
 * carries its blocker fields, and rendering those as a live block is worse than
 * rendering nothing.
 *
 * Within BLOCKED the order is fixed: a resource wait wins over a dependency
 * wait, because the daemon's dependency auto-unblock deliberately skips
 * resource-waiting rows and the lease grant clears all block metadata, so a row
 * carrying both is really waiting on the lease. A blank or whitespace-only
 * resource id falls through to the dependency branch. Total function: no input
 * shape throws, and nothing here reads a clock or parses blockedAt as a date.
 */
export function blockCause(task: Task): BlockCause | null {
    if (!task || task.status !== BLOCKED_STATUS) {
        return null;
    }
    if (nonBlankString(task.blockedResourceId) !== null) {
        return 'RESOURCE_WAIT';
    }
    if (blockedPrerequisiteIds(task).length > 0) {
        return 'DEPENDENCY_WAIT';
    }
    return 'EXTERNAL_BLOCK';
}

/**
 * The daemon's own attention flag, read verbatim. Never inferred from status,
 * from the reason text or from a critique verdict, and honoured on any status —
 * the QA reject path normally sets it on a REVIEW task, and it survives a task
 * leaving BLOCKED.
 */
export function needsHumanAttention(task: Task): boolean {
    return task?.needsHumanReview === true;
}

/**
 * The recorded facts about the block, captioned, in the JetBrains order. Each
 * one is omitted when missing or blank, and blockedAt is passed through exactly
 * as sent: no date parsing, no reformatting.
 */
export function blockerFacts(task: Task): string[] {
    const facts: string[] = [];
    const resource = nonBlankString(task?.blockedResourceId);
    if (resource) { facts.push(`${BLOCKER_RESOURCE_LABEL}: ${resource}`); }
    const fromStatus = nonBlankString(task?.blockedFromStatus);
    if (fromStatus) { facts.push(`${BLOCKER_FROM_STATUS_LABEL}: ${fromStatus}`); }
    const blockedAt = nonBlankString(task?.blockedAt);
    if (blockedAt) { facts.push(`${BLOCKER_BLOCKED_AT_LABEL}: ${blockedAt}`); }
    return facts;
}

// =============================================================================
// Delivery presentation
// =============================================================================

/**
 * The runner-reported delivery evidence of a task, as display rows. A port of
 * the contract JetBrains ships and owns (DeliveryPresentation.rows in
 * moe-jetbrains/src/main/kotlin/com/moe/toolwindow/, plus the type guards of
 * MoeJson.parseDelivery, because this client receives the raw wire JSON).
 * tests/delivery-corpus.test.cjs replays the shared corpus
 * moe-jetbrains/src/test/resources/client-delivery.json through it, so drift
 * fails a test instead of shipping. Kept inside this file with no new import:
 * peer tests load the panel under node:vm with a strict require map.
 *
 * What a run REPORTED is never proof the daemon executed a check, and the
 * policy verdict (requiredCheckSatisfied) is never inferred from the run.
 */
export type DeliveryOutcome = 'PASS' | 'FAIL';

export interface DeliveryRow {
    labelKey: string;
    value: string;
    fullValue: string;
    outcome: DeliveryOutcome | null;
}

export const DELIVERY_TITLE_KEY = 'moe.delivery.title';

/** English labels, equal to the moe.delivery.* entries of JetBrains' MoeBundle.properties (the test compares them). */
export const DELIVERY_LABELS: Record<string, string> = {
    'moe.delivery.title': 'Delivery',
    'moe.delivery.candidateSha': 'Candidate SHA',
    'moe.delivery.candidateBase': 'Candidate base',
    'moe.delivery.checkCommand': 'Reported check command',
    'moe.delivery.checkPassed': 'Reported check passed - exit code',
    'moe.delivery.checkFailed': 'Reported check failed - exit code',
    'moe.delivery.checkNotPassed': 'Reported check did not pass - exit code',
    'moe.delivery.checkOutcome': 'Reported check outcome',
    'moe.delivery.checkSource': 'Reported check source',
    'moe.delivery.requiredCheckCounted': 'Required check counted by policy',
    'moe.delivery.requiredCheckNotCounted': 'Required check not counted by policy',
    'moe.delivery.receiptTarget': 'Reported delivery target',
    'moe.delivery.landedRevision': 'Reported landed revision',
    'moe.delivery.attemptPhase': 'Owning attempt phase',
};

/** A non-null, non-array object, or null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** A non-empty string member, or null: missing, empty and wrong-typed all mean "no row", never coerced. */
function reportedText(record: Record<string, unknown> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Display rows in JetBrains' order. Total function: a malformed member means
 * no row for it, and nothing here throws. A candidate SHA is the tree SHA when
 * that is non-empty, else the short SHA (an empty tree SHA must fall back, so a
 * bare `??` on the raw member would be wrong). SHA rows show 8 characters and
 * keep the whole value as `fullValue`; every other row has fullValue === value.
 */
export function deliveryRows(delivery: unknown): DeliveryRow[] {
    const root = asRecord(delivery);
    if (!root) { return []; }
    const rows: DeliveryRow[] = [];
    const addValue = (labelKey: string, value: string | null, sha = false): void => {
        if (value) { rows.push({ labelKey, value: sha ? value.slice(0, 8) : value, fullValue: value, outcome: null }); }
    };
    const addVerdict = (labelKey: string, value: string, outcome: DeliveryOutcome): void => {
        rows.push({ labelKey, value, fullValue: value, outcome });
    };
    const candidate = asRecord(root.currentCandidate);
    addValue('moe.delivery.candidateSha', reportedText(candidate, 'treeSha') ?? reportedText(candidate, 'shortSha'), true);
    addValue('moe.delivery.candidateBase', reportedText(candidate, 'baseRevision'), true);
    const run = asRecord(root.latestCheckRun);
    const outcome = reportedText(run, 'outcome');
    addValue('moe.delivery.checkCommand', reportedText(run, 'command'));
    // The daemon stores any safe integer; a string is never coerced to a code.
    const code = run?.exitCode;
    if (typeof code === 'number' && Number.isSafeInteger(code)) {
        // Mirrors the daemon gate rule: only exit 0 with no outcome or exactly "passed" reads as passed.
        const passed = code === 0 && (outcome === null || outcome === 'passed');
        const labelKey = passed ? 'moe.delivery.checkPassed'
            : code !== 0 ? 'moe.delivery.checkFailed' : 'moe.delivery.checkNotPassed';
        addVerdict(labelKey, String(code), passed ? 'PASS' : 'FAIL');
    }
    addValue('moe.delivery.checkOutcome', outcome);
    const source = reportedText(run, 'source');
    addValue('moe.delivery.checkSource', source === 'runner-observed' || source === 'agent-reported' ? source : null);
    if (root.requiredCheckSatisfied === true) {
        addVerdict('moe.delivery.requiredCheckCounted', 'yes', 'PASS');
    } else if (root.requiredCheckSatisfied === false) {
        addVerdict('moe.delivery.requiredCheckNotCounted', 'no', 'FAIL');
    }
    const receipt = asRecord(root.deliveryReceipt);
    addValue('moe.delivery.receiptTarget', reportedText(receipt, 'target'));
    addValue('moe.delivery.landedRevision', reportedText(receipt, 'landedRevision'), true);
    addValue('moe.delivery.attemptPhase', reportedText(root, 'attemptPhase'));
    return rows;
}

/**
 * deliveryRows with each English label looked up: the one lookup behind the
 * initial markup (which escapes it) and the live update (DOM text in media/taskDetail.js).
 */
export function deliveryDisplay(delivery: unknown) {
    return {
        title: DELIVERY_LABELS[DELIVERY_TITLE_KEY],
        rows: deliveryRows(delivery).map(row => ({ ...row, label: DELIVERY_LABELS[row.labelKey] ?? row.labelKey })),
    };
}

// =============================================================================
// Release Agent
// =============================================================================

/**
 * The text of JetBrains' Release Agent action (moe.button.releaseAgent,
 * moe.message.releasedInUI, moe.message.releaseAgent, releaseAgentForce,
 * releaseAgentForceTitle and releaseAgentForceStale in MoeBundle.properties,
 * used by TaskDetailDialog and MoeToolWindowPanel.handleReleaseAgent), copied
 * exactly: tests/task-release.test.cjs reads that bundle and compares. The
 * confirm text keeps its {0} (worker id) and {1} (task title) placeholders. It
 * is shown as plain text in a modal, so it is never HTML-escaped.
 */
const RELEASE_AGENT_LABEL = 'Release Agent';
const RELEASED_FROM_BOARD = 'Released from board';
const RELEASE_AGENT_CONFIRM = 'Release agent "{0}" from "{1}"? The task stays claimable where it is (Working stays Working, unassigned; Review if all steps are done) and the agent goes idle — the next agent may pick it up immediately. To pull the task away from the fleet instead, drag it to Backlog.';
const RELEASE_AGENT_FORCE = 'Agent "{0}" is mid-step: step {1} of "{2}" is IN_PROGRESS, so a normal release is refused. Force the release only if you believe "{0}" is dead (hung or crashed). A live agent would lose the task in the middle of its step. Force release?';
const RELEASE_AGENT_FORCE_TITLE = 'Force Release Agent';
const RELEASE_AGENT_FORCE_STALE = 'Nothing was sent. The task changed while you were confirming, and agent "{0}" no longer holds step {1} IN_PROGRESS. Reopen the task and try again.';

/** Plain-text bundle substitution, never re-scanning inserted values. */
function formatBundleText(template: string, ...values: string[]): string {
    return template.replace(/\{(\d)\}/g, (match, index: string) => values[Number(index)] ?? match);
}

/** Mirror the daemon guard: the holder leases the first IN_PROGRESS step. */
function stepLease(task: Task | undefined): { holder: string; stepId: string } | null {
    const holder = nonBlankString(task?.assignedWorkerId);
    if (holder === null || !Array.isArray(task?.implementationPlan)) { return null; }
    const step = task.implementationPlan.find(entry => entry?.status === 'IN_PROGRESS');
    return step ? { holder, stepId: step.stepId } : null;
}

/** The Release Agent button's label when the task has an agent to release, else null: one rule for the initial page and every live update. */
function releaseAgentLabel(task: Task): string | null {
    return nonBlankString(task.assignedWorkerId) !== null ? RELEASE_AGENT_LABEL : null;
}

/**
 * Task Detail Panel - a full-featured editor panel for viewing and editing tasks.
 *
 * Features:
 * - Editable fields: title, description, DoD, priority
 * - Implementation plan display with status icons and color coding
 * - Comments section with add-comment input
 * - Action buttons: Save, Approve, Reject, Reopen, Release Agent, Prev, Next, Delete
 * - PR link display
 * - Live updates via state change subscription
 */
export class TaskDetailPanel implements vscode.Disposable {
    public static readonly viewType = 'moe.taskDetail';

    /** Per-task singleton map */
    private static currentPanels: Map<string, TaskDetailPanel> = new Map();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly client: MoeDaemonClient;
    private readonly taskId: string;
    private readonly disposables: vscode.Disposable[] = [];
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;
    /** True while an approval this panel sent has not been refused or carried out. */
    private approvalPending = false;

    /**
     * Create a new panel or reveal an existing one for the given task.
     */
    static createOrShow(
        extensionUri: vscode.Uri,
        client: MoeDaemonClient,
        taskId: string
    ): TaskDetailPanel {
        const existing = TaskDetailPanel.currentPanels.get(taskId);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            return existing;
        }

        const task = client.currentState?.tasks.find(t => t.id === taskId);
        const titleSuffix = task
            ? (task.title.length > 40 ? task.title.substring(0, 40) + '...' : task.title)
            : taskId;

        const panel = vscode.window.createWebviewPanel(
            TaskDetailPanel.viewType,
            `Task: ${titleSuffix}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );

        const instance = new TaskDetailPanel(extensionUri, panel, client, taskId);
        TaskDetailPanel.currentPanels.set(taskId, instance);
        return instance;
    }

    private constructor(
        extensionUri: vscode.Uri,
        panel: vscode.WebviewPanel,
        client: MoeDaemonClient,
        taskId: string
    ) {
        this.extensionUri = extensionUri;
        this.panel = panel;
        this.client = client;
        this.taskId = taskId;

        // Initial render
        const task = this.findTask();
        this.panel.webview.html = this.getWebviewContent(task);

        // Handle messages from webview
        this.disposables.push(
            this.panel.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg))
        );

        // Live updates: subscribe to state changes
        this.disposables.push(
            this.client.onStateChanged(() => {
                this.debouncedUpdate();
            })
        );

        // A refused approval must reach the user: locally (no usable token) or
        // from the daemon (stale revision, or an omission it refuses).
        this.disposables.push(
            this.client.onError(event => this.handleClientError(event))
        );
        // A refusal can no longer arrive for an approval sent on a dropped socket.
        this.disposables.push(
            this.client.onConnectionChanged(state => {
                if (state !== 'connected') { this.approvalPending = false; }
            })
        );

        // Cleanup on panel close
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private findTask(): Task | undefined {
        return this.client.currentState?.tasks.find(t => t.id === this.taskId);
    }

    /** True while the task still awaits plan approval; otherwise says nothing was rejected. */
    private awaitingApproval(): boolean {
        if (this.findTask()?.status === 'AWAITING_APPROVAL') { return true; }
        vscode.window.showWarningMessage(STALE_REJECT);
        return false;
    }

    /**
     * Approve with the revision the webview rendered. The token comes from the
     * page's message and is never read from the client's cached state: the
     * newest revision is not the reviewed one. The client refuses anything that
     * is not a revision, and that refusal arrives in handleClientError.
     */
    private approveRendered(expectedPlanRevision: unknown): void {
        this.approvalPending = true;
        if (this.client.approveTask(this.taskId, expectedPlanRevision as number)) {
            vscode.window.showInformationMessage('Plan approval sent');
        } else if (this.approvalPending) {
            // False with no APPROVE_TASK refusal for this task: nothing was sent.
            this.approvalPending = false;
            vscode.window.showWarningMessage('Not connected to Moe daemon — task was not approved.');
        }
    }

    private handleClientError(event: {
        operation?: string;
        message: string;
        codeName?: string;
        context?: { taskId?: string };
    }): void {
        if (event.operation === 'RELEASE_TASK') {
            if (event.context?.taskId === this.taskId) {
                vscode.window.showErrorMessage('Agent was not released: ' + event.message);
            }
            return;
        }
        if (!this.approvalPending || event.operation !== 'APPROVE_TASK') { return; }
        if (event.context?.taskId !== this.taskId) { return; }
        this.approvalPending = false;
        // An open review for this task already reports the refusal itself.
        if (PlanReviewPanel.isOpenFor(this.taskId)) { return; }
        void showApprovalRefusal(this.extensionUri, this.client, this.taskId, event);
    }

    private debouncedUpdate(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            const task = this.findTask();
            if (task?.status !== 'AWAITING_APPROVAL') {
                // Approved, moved or gone: no refusal can still belong to us.
                this.approvalPending = false;
            }
            if (task) {
                // The page rebuilds the Delivery section and the Release Agent
                // button from these, with the initial render's rows and rule.
                this.panel.webview.postMessage({
                    type: 'updateTask',
                    task,
                    delivery: deliveryDisplay(task.delivery),
                    releaseAgentLabel: releaseAgentLabel(task),
                });
            }
        }, 200);
    }

    private async handleWebviewMessage(msg: Record<string, unknown>): Promise<void> {
        try {
            switch (msg.type) {
                case 'save': {
                    const updates: { title?: string; description?: string; definitionOfDone?: string[]; priority?: TaskPriority } = {};
                    if (typeof msg.title === 'string') { updates.title = msg.title; }
                    if (typeof msg.description === 'string') { updates.description = msg.description; }
                    if (Array.isArray(msg.definitionOfDone)) { updates.definitionOfDone = msg.definitionOfDone as string[]; }
                    if (typeof msg.priority === 'string') { updates.priority = msg.priority as TaskPriority; }
                    if (!this.client.updateTaskDetails(this.taskId, updates)) {
                        vscode.window.showWarningMessage('Not connected to Moe daemon — task was not saved.');
                        break;
                    }
                    vscode.window.showInformationMessage('Task saved');
                    break;
                }

                case 'approve':
                    this.approveRendered(msg.expectedPlanRevision);
                    break;

                case 'promptReject': {
                    // The Reject button stays on the page after the task moves on: judge the task as it is now,
                    // before the prompt and again after it, since the plan can move while the reason is typed.
                    if (!this.awaitingApproval()) { break; }
                    const reason = await vscode.window.showInputBox({
                        prompt: 'Rejection reason',
                        placeHolder: 'Why is this plan being rejected?',
                    });
                    if (reason) {
                        if (!this.awaitingApproval()) { break; }
                        if (this.client.rejectTask(this.taskId, reason)) {
                            vscode.window.showInformationMessage('Task rejected');
                        } else {
                            vscode.window.showWarningMessage('Not connected to Moe daemon — task was not rejected.');
                        }
                    }
                    break;
                }

                case 'reopen': {
                    const reopenReason = typeof msg.reason === 'string' ? msg.reason : '';
                    if (reopenReason) {
                        if (this.client.reopenTask(this.taskId, reopenReason)) {
                            vscode.window.showInformationMessage('Task reopened');
                        } else {
                            vscode.window.showWarningMessage('Not connected to Moe daemon — task was not reopened.');
                        }
                    } else {
                        const inputReason = await vscode.window.showInputBox({
                            prompt: 'Reopen reason',
                            placeHolder: 'Why is this task being reopened?',
                        });
                        if (inputReason) {
                            if (this.client.reopenTask(this.taskId, inputReason)) {
                                vscode.window.showInformationMessage('Task reopened');
                            } else {
                                vscode.window.showWarningMessage('Not connected to Moe daemon — task was not reopened.');
                            }
                        }
                    }
                    break;
                }

                case 'releaseAgent': {
                    // Live updates add and remove the button, but a click can
                    // still race one: judge the task as it is now, not as rendered.
                    const current = this.findTask();
                    const workerId = nonBlankString(current?.assignedWorkerId);
                    if (!current || workerId === null) {
                        vscode.window.showInformationMessage('No agent is assigned to this task.');
                        break;
                    }
                    // Only the click-time snapshot chooses force; the cache
                    // recheck below can refuse it, never authorize a new lease.
                    const lease = stepLease(current);
                    const title = current.title;
                    const choice = await vscode.window.showWarningMessage(
                        formatBundleText(RELEASE_AGENT_CONFIRM, workerId, title),
                        { modal: true },
                        RELEASE_AGENT_LABEL
                    );
                    if (choice !== RELEASE_AGENT_LABEL) { break; }
                    let released: boolean;
                    if (lease) {
                        const forceChoice = await vscode.window.showWarningMessage(
                            formatBundleText(RELEASE_AGENT_FORCE, lease.holder, lease.stepId, title),
                            { modal: true },
                            RELEASE_AGENT_FORCE_TITLE
                        );
                        if (forceChoice !== RELEASE_AGENT_FORCE_TITLE) { break; }
                        const latestLease = stepLease(this.findTask());
                        if (!latestLease || latestLease.holder !== lease.holder || latestLease.stepId !== lease.stepId) {
                            vscode.window.showWarningMessage(formatBundleText(RELEASE_AGENT_FORCE_STALE, lease.holder, lease.stepId));
                            break;
                        }
                        released = this.client.releaseTask(this.taskId, RELEASED_FROM_BOARD, true);
                    } else {
                        released = this.client.releaseTask(this.taskId, RELEASED_FROM_BOARD);
                    }
                    if (!released) {
                        vscode.window.showWarningMessage('Not connected to Moe daemon — agent was not released.');
                    }
                    break;
                }

                case 'delete': {
                    const confirmed = await vscode.window.showWarningMessage(
                        'Delete this task? This cannot be undone.',
                        { modal: true },
                        'Delete'
                    );
                    if (confirmed === 'Delete') {
                        if (!this.client.deleteTask(this.taskId)) {
                            vscode.window.showWarningMessage('Not connected to Moe daemon — task was not deleted.');
                            break;
                        }
                        vscode.window.showInformationMessage('Task deleted');
                        this.dispose();
                    }
                    break;
                }

                case 'addComment': {
                    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
                    if (content && !this.client.addTaskComment(this.taskId, content)) {
                        vscode.window.showWarningMessage('Not connected to Moe daemon — comment was not added.');
                        // The page cleared its input on send: hand the text back so it is not lost.
                        void this.panel.webview.postMessage({ type: 'commentNotSent', content });
                    }
                    break;
                }

                case 'prev':
                case 'next': {
                    const workflowOrder = ['BACKLOG', 'PLANNING', 'AWAITING_APPROVAL', 'WORKING', 'REVIEW', 'DONE'];
                    const currentStatus = typeof msg.currentStatus === 'string' ? msg.currentStatus : '';
                    const idx = workflowOrder.indexOf(currentStatus);
                    if (idx < 0) { break; }

                    if (msg.type === 'next') {
                        if (idx >= workflowOrder.length - 1) { break; }
                        if (currentStatus === 'AWAITING_APPROVAL') {
                            this.approveRendered(msg.expectedPlanRevision);
                        } else {
                            this.client.updateTaskStatus(this.taskId, workflowOrder[idx + 1]);
                        }
                    } else {
                        if (idx <= 0) { break; }
                        if (currentStatus === 'REVIEW' || currentStatus === 'DONE') {
                            const reason = (await vscode.window.showInputBox({
                                prompt: 'Reason for reopening',
                                placeHolder: 'Why is this task being reopened?',
                            }))?.trim();
                            if (reason) {
                                if (this.client.reopenTask(this.taskId, reason)) {
                                    vscode.window.showInformationMessage('Task reopened');
                                } else {
                                    vscode.window.showWarningMessage('Not connected to Moe daemon — task was not reopened.');
                                }
                            }
                        } else {
                            // Twin: media/board.js previousMove and JetBrains BoardMoves.previous. WORKING goes
                            // back to PLANNING, never AWAITING_APPROVAL, which /ws refuses from WORKING.
                            const target = currentStatus === 'PLANNING' ? 'BACKLOG'
                                : currentStatus === 'WORKING' || currentStatus === 'AWAITING_APPROVAL' ? 'PLANNING' : undefined;
                            if (target) { this.client.updateTaskStatus(this.taskId, target); }
                        }
                    }
                    break;
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Task action failed: ${errMsg}`);
        }
    }

    private getWebviewContent(task: Task | undefined): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'taskDetail.js'));

        if (!task) {
            return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
    <title>Task Detail</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
        }
        .not-found {
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="not-found">
        <h2>Task not found</h2>
        <p>The task may have been deleted or is no longer available.</p>
    </div>
</body>
</html>`;
        }

        const epics = this.client.currentState?.epics || [];
        const epic = epics.find(e => e.id === task.epicId);
        const epicTitle = epic ? escapeHtml(epic.title) : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource};">
    <title>Task: ${escapeHtml(task.title)}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        /* Header */
        .task-header {
            padding: 12px 20px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .header-left { display: flex; align-items: center; gap: 10px; }
        .status-badge {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: bold;
            color: #fff;
        }
        .status-BACKLOG { background: #9E9E9E; }
        .status-PLANNING { background: #ff9800; }
        .status-AWAITING_APPROVAL { background: #ffc107; color: #000; }
        .status-WORKING { background: #2196f3; }
        .status-BLOCKED { background: #ff9800; }
        .status-REVIEW { background: #9c27b0; }
        .status-DONE { background: #4caf50; }
        .task-id-header {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            font-family: monospace;
        }

        /* Main content */
        .main-content {
            flex: 1;
            overflow-y: auto;
            padding: 16px 20px;
        }

        /* Form fields */
        .field { margin-bottom: 14px; }
        .field-label {
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .field-row {
            display: flex;
            gap: 12px;
            margin-bottom: 14px;
        }
        .field-row .field { flex: 1; margin-bottom: 0; }
        input[type="text"], textarea, select {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            border-radius: 3px;
            outline: none;
        }
        input[type="text"]:focus, textarea:focus, select:focus {
            border-color: var(--vscode-focusBorder);
        }
        textarea { resize: vertical; line-height: 1.5; }

        /* Section headers */
        .section-title {
            font-size: 13px;
            font-weight: bold;
            margin: 16px 0 10px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-panel-border);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        /* PR Link */
        .pr-link {
            margin-bottom: 14px;
            font-size: 12px;
        }
        .pr-link a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .pr-link a:hover {
            text-decoration: underline;
        }

        /* Step cards */
        .step-card {
            margin-bottom: 8px;
            padding: 8px 10px;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
            border-left: 3px solid #9e9e9e;
        }
        .step-card.completed { border-left-color: #4caf50; }
        .step-card.in-progress { border-left-color: #2196f3; }
        .step-card.pending { border-left-color: #9e9e9e; }
        .step-header {
            font-size: 11px;
            font-weight: bold;
            margin-bottom: 3px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .step-icon-completed { color: #4caf50; }
        .step-icon-in-progress { color: #2196f3; }
        .step-icon-pending { color: var(--vscode-descriptionForeground); }
        .step-description {
            font-size: 12px;
            line-height: 1.4;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .step-amended {
            margin-top: 4px;
            font-size: 11px;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
        }
        .step-files {
            margin-top: 4px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .step-files span { margin-right: 4px; }

        /* Comments */
        .comments-section {
            margin-top: 16px;
        }
        .comments-list {
            max-height: 200px;
            overflow-y: auto;
            margin-bottom: 8px;
        }
        .comment-item {
            padding: 6px 10px;
            margin-bottom: 6px;
            border-radius: 4px;
            border-left: 3px solid var(--vscode-panel-border);
            font-size: 12px;
        }
        .comment-human {
            border-left-color: #2196f3;
            background: rgba(33, 150, 243, 0.08);
        }
        .comment-agent {
            border-left-color: #4caf50;
            background: rgba(76, 175, 80, 0.08);
        }
        .comment-header {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            margin-bottom: 3px;
            color: var(--vscode-descriptionForeground);
        }
        .comment-author { font-weight: bold; }
        .comment-content { white-space: pre-wrap; word-wrap: break-word; }
        .comment-input-row {
            display: flex;
            gap: 6px;
        }
        .comment-input-row input { flex: 1; }
        .no-comments {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            font-size: 12px;
            padding: 4px 0;
        }

        /* Action bar */
        .actions {
            display: flex;
            gap: 8px;
            padding: 12px 20px;
            border-top: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
            flex-wrap: wrap;
        }
        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 3px;
            font-family: var(--vscode-font-family);
            font-size: 12px;
            cursor: pointer;
        }
        .btn:disabled { opacity: 0.5; cursor: default; }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-approve { background: #4caf50; color: #fff; }
        .btn-approve:hover:not(:disabled) { background: #43a047; }
        .btn-reject { background: #f44336; color: #fff; }
        .btn-reject:hover:not(:disabled) { background: #e53935; }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-danger {
            background: none;
            color: #f44336;
            border: 1px solid #f44336;
        }
        .btn-danger:hover:not(:disabled) {
            background: rgba(244, 67, 54, 0.1);
        }
        .btn-comment {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-comment:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .spacer { flex: 1; }
        .muted-text {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            font-style: italic;
        }
        /* Metrics */
        .kpi-row {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            margin: 8px 0 12px;
        }
        .kpi {
            display: flex;
            flex-direction: column;
            min-width: 100px;
        }
        .kpi-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }
        .kpi-value {
            font-size: 16px;
            font-weight: bold;
        }
        .critique-panel {
            padding: 8px 10px;
            margin: 6px 0 10px;
            border-radius: 4px;
            border-left: 3px solid;
        }
        .critique-block {
            background: rgba(244, 67, 54, 0.08);
            border-left-color: #f44336;
        }
        .critique-pass {
            background: rgba(76, 175, 80, 0.08);
            border-left-color: #4caf50;
        }
        .critique-header {
            font-weight: bold;
            margin-bottom: 4px;
        }
        .critique-concerns {
            margin: 4px 0 0 16px;
            padding: 0;
            font-size: 12px;
        }
        .handoff-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 10px;
            margin-bottom: 8px;
        }
        .handoff-card-title {
            font-weight: bold;
            font-size: 12px;
            margin-bottom: 4px;
        }
        .handoff-section {
            margin-top: 4px;
            font-size: 12px;
        }
        .handoff-section-label {
            font-weight: bold;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .handoff-section-body {
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .failed-dod-list {
            margin-left: 16px;
            font-size: 12px;
        }
        .blocker-cause { font-weight: bold; }
        .blocker-text {
            font-size: 12px;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .delivery-section { margin-bottom: 12px; }
        .delivery-value {
            font-size: 12px;
            font-family: var(--vscode-editor-font-family);
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .delivery-pass .delivery-value { color: var(--vscode-testing-iconPassed); }
        .delivery-fail .delivery-value { color: var(--vscode-testing-iconFailed); }
    </style>
</head>
<body>
    <div class="task-header">
        <div class="header-left">
            <span class="status-badge status-${escapeHtml(task.status)}" id="statusBadge">${escapeHtml(humanizeStatus(task.status))}</span>
            ${epicTitle ? '<span style="font-size:11px;color:var(--vscode-descriptionForeground);">' + epicTitle + '</span>' : ''}
        </div>
        <span class="task-id-header">${escapeHtml(task.id)}</span>
    </div>

    <div class="main-content">
        <!-- Blocker / attention: read-only, and first, because "why did this
             stop" is the question a parked task raises. Live-refreshed in
             media/taskDetail.js; the wrapper stays even when empty so the
             update handler has one node of its own to fill and to clear. -->
        <div id="blockerSection">${this.renderBlocker(task)}</div>

        <!-- Delivery: read-only runner-reported evidence; nothing when there is
             none. Live-refreshed (added, rebuilt, removed) in media/taskDetail.js. -->
        ${this.renderDelivery(task)}

        <!-- Editable fields -->
        <div class="field-row">
            <div class="field" style="flex:0 0 140px;">
                <div class="field-label">Priority</div>
                <select id="prioritySelect">
                    <option value="CRITICAL"${task.priority === 'CRITICAL' ? ' selected' : ''}>Critical</option>
                    <option value="HIGH"${task.priority === 'HIGH' ? ' selected' : ''}>High</option>
                    <option value="MEDIUM"${task.priority === 'MEDIUM' ? ' selected' : ''}>Medium</option>
                    <option value="LOW"${task.priority === 'LOW' ? ' selected' : ''}>Low</option>
                </select>
            </div>
            <div class="field">
                <div class="field-label">Title</div>
                <input type="text" id="titleInput" value="${escapeHtml(task.title)}" />
            </div>
        </div>

        <div class="field">
            <div class="field-label">Description</div>
            <textarea id="descriptionInput" rows="6">${escapeHtml(task.description)}</textarea>
        </div>

        <div class="field">
            <div class="field-label">Definition of Done (one item per line)</div>
            <textarea id="dodInput" rows="4">${escapeHtml((task.definitionOfDone || []).join('\n'))}</textarea>
        </div>

        ${task.reopenReason ? `<div class="field">
            <div class="field-label">Reopen Reason</div>
            <textarea id="reopenReasonInput" rows="2" ${task.status !== 'REVIEW' && task.status !== 'DONE' ? 'readonly style="opacity:0.7;"' : ''}>${escapeHtml(task.reopenReason)}</textarea>
        </div>` : ''}

        ${task.prLink && safeHttpUrl(task.prLink) ? `<div class="pr-link">
            <div class="field-label">Pull Request</div>
            <a href="${escapeHtml(task.prLink)}" title="Open PR">${escapeHtml(task.prLink)}</a>
        </div>` : ''}

        <!-- Implementation Plan -->
        <div class="section-title" id="planTitle">Implementation Plan</div>
        <div id="planContent">${this.renderSteps(task.implementationPlan || [])}</div>

        ${this.renderMetrics(task)}

        <!-- Comments -->
        <div class="comments-section">
            <div class="section-title">Comments</div>
            <div class="comments-list" id="commentsList">${this.renderComments(task.comments || [])}</div>
            <div class="comment-input-row">
                <input type="text" id="commentInput" placeholder="Ask a question or leave a comment..." />
                <button class="btn btn-comment" id="askBtn">Ask Question</button>
            </div>
        </div>
    </div>

    <div class="actions" id="actionsBar">
        <button class="btn btn-primary" id="saveBtn">Save</button>
        ${task.status === 'AWAITING_APPROVAL' ? '<button class="btn btn-approve" id="approveBtn">Approve</button>' : ''}
        ${task.status === 'AWAITING_APPROVAL' ? '<button class="btn btn-reject" id="rejectBtn">Reject</button>' : ''}
        ${task.status === 'REVIEW' || task.status === 'DONE' ? '<button class="btn btn-secondary" id="reopenBtn">Reopen</button>' : ''}
        ${releaseAgentLabel(task) !== null ? `<button class="btn btn-secondary" id="releaseAgentBtn">${RELEASE_AGENT_LABEL}</button>` : ''}
        <button class="btn btn-secondary" id="prevBtn" ${task.status === 'BACKLOG' ? 'disabled' : ''} title="Move back in workflow">Prev</button>
        <button class="btn btn-secondary" id="nextBtn" ${task.status === 'DONE' ? 'disabled' : ''} title="Move forward in workflow">Next</button>
        <span class="spacer"></span>
        <button class="btn btn-danger" id="deleteBtn">Delete</button>
    </div>

    <div id="initial-data" data-task-id="${escapeHtml(task.id)}" data-task-status="${escapeHtml(task.status)}"${seedRevisionAttribute(task)} style="display:none;"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }

    /**
     * The read-only blocker / attention section, or '' when the task is neither
     * actively blocked nor flagged for human review.
     *
     * Display only: no unblock action, no retry, no navigation to the
     * prerequisites, no network or state lookup. Every daemon-supplied string —
     * the reason, the recorded prerequisite ids, the resource id, the source
     * status and the timestamp — goes through `escapeHtml`, because a
     * blockedReason is arbitrary agent-written text. The element order matches
     * the JetBrains dialog so the two IDEs read the same.
     *
     * media/taskDetail.js rebuilds exactly this node sequence from DOM text
     * nodes on every live update.
     */
    private renderBlocker(task: Task): string {
        const cause = blockCause(task);
        const attention = needsHumanAttention(task);
        if (!cause && !attention) {
            return '';
        }
        const parts: string[] = [];
        // Only titled "Blocker" when there really is a live block: a task
        // flagged for review is not necessarily blocked.
        parts.push(`<div class="section-title">${escapeHtml(cause ? BLOCKER_SECTION_TITLE : ATTENTION_LABEL)}</div>`);
        if (cause) {
            parts.push(`<div class="blocker-cause">${escapeHtml(BLOCK_CAUSE_LABEL[cause])}</div>`);
            parts.push(`<div class="muted-text">${escapeHtml(BLOCK_CAUSE_CLEARS[cause])}</div>`);
            parts.push(`<div class="field-label">${escapeHtml(BLOCKER_REASON_LABEL)}</div>`);
            // A missing or blank reason shows the neutral fallback, never an
            // empty element.
            parts.push(`<div class="blocker-text">${escapeHtml(nonBlankString(task.blockedReason) || BLOCKER_REASON_MISSING)}</div>`);
        }
        if (attention) {
            parts.push(`<div class="blocker-cause">${escapeHtml(ATTENTION_LABEL)}</div>`);
            parts.push(`<div class="muted-text">${escapeHtml(ATTENTION_CLEARS)}</div>`);
        }
        if (cause) {
            const ids = blockedPrerequisiteIds(task);
            if (ids.length > 0) {
                parts.push(`<div class="field-label">${escapeHtml(BLOCKER_PREREQUISITES_LABEL)}</div>`);
                parts.push(`<div class="blocker-text">${escapeHtml(ids.join('\n'))}</div>`);
            }
            const facts = blockerFacts(task);
            if (facts.length > 0) {
                parts.push(`<div class="blocker-text">${escapeHtml(facts.join('\n'))}</div>`);
            }
        }
        return parts.join('');
    }

    /**
     * The read-only Delivery section, or '' when the task has no delivery
     * evidence to show. Display only: no action, no copy button, no client call.
     * Every value is runner-reported text, so it goes through `escapeHtml`, in
     * the element and in the `title` attribute that carries the full value.
     * tests/delivery-corpus.test.cjs matches this exact one-line-per-row markup.
     * Live updates post the same `deliveryDisplay` rows, which media/taskDetail.js
     * writes as DOM text and which tests/task-detail-live.test.cjs holds equal to this.
     */
    private renderDelivery(task: Task): string {
        const { title, rows } = deliveryDisplay(task.delivery);
        if (rows.length === 0) {
            return '';
        }
        const body = rows.map(row => {
            const outcome = row.outcome ? ` delivery-${row.outcome.toLowerCase()}` : '';
            return `<div class="delivery-row${outcome}"><div class="field-label">${escapeHtml(row.label)}</div>`
                + `<div class="delivery-value" title="${escapeHtml(row.fullValue)}">${escapeHtml(row.value)}</div></div>`;
        });
        return `<div class="delivery-section" id="deliverySection"><div class="section-title">${escapeHtml(title)}</div>${body.join('')}</div>`;
    }

    private renderSteps(steps: ImplementationStep[]): string {
        if (steps.length === 0) {
            return '<p class="muted-text">No implementation steps defined</p>';
        }

        return steps.map((step, i) => {
            const status = (step.status || 'PENDING').toUpperCase();
            const cssClass = status === 'COMPLETED' ? 'completed'
                : status === 'IN_PROGRESS' ? 'in-progress' : 'pending';
            const iconClass = status === 'COMPLETED' ? 'step-icon-completed'
                : status === 'IN_PROGRESS' ? 'step-icon-in-progress' : 'step-icon-pending';
            const icon = status === 'COMPLETED' ? '\u2713'
                : status === 'IN_PROGRESS' ? '\u25B6' : '\u25CB';

            let filesHtml = '';
            if (step.affectedFiles && step.affectedFiles.length > 0) {
                filesHtml = `<div class="step-files"><span>Files:</span> ${step.affectedFiles.map(f => escapeHtml(f)).join(', ')}</div>`;
            }

            return `<div class="step-card ${cssClass}">
                <div class="step-header"><span class="${iconClass}">${icon}</span><span>Step ${i + 1}: ${escapeHtml(status)}</span></div>
                ${stepTextHtml(step)}
                ${filesHtml}
            </div>`;
        }).join('');
    }

    private renderMetrics(task: Task): string {
        const metrics = task.metrics;
        const handoffs = task.priorHandoffs || [];
        const failedDod = task.failedDodItems || [];
        const critique = task.planCritiqueResult;

        if (!metrics && handoffs.length === 0 && failedDod.length === 0 && !critique) {
            return '';
        }

        const parts: string[] = [];
        parts.push('<div class="section-title">Metrics</div>');

        // KPI row
        const kpis: string[] = [];
        if (metrics?.plannedStepCount != null || metrics?.executedStepCount != null) {
            const exec = metrics?.executedStepCount ?? '-';
            const planned = metrics?.plannedStepCount ?? '-';
            kpis.push(kpi('Steps', `${exec} / ${planned}`));
        }
        let usedMs = metrics?.wallClockMs;
        if (usedMs == null && metrics?.firstClaimAt) {
            const from = Date.parse(metrics.firstClaimAt);
            const toIso = metrics?.doneAt;
            const to = toIso ? Date.parse(toIso) : Date.now();
            if (!Number.isNaN(from) && !Number.isNaN(to)) {
                usedMs = Math.max(0, to - from);
            }
        }
        if (usedMs != null) {
            kpis.push(kpi('Wall-clock', humaniseDuration(usedMs)));
        }
        const reopens = metrics?.reopenCount ?? task.reopenCount;
        if (reopens > 0 || metrics?.reopenCount != null) {
            kpis.push(kpi('Reopens', String(reopens)));
        }
        if (metrics?.rejectCount != null) {
            kpis.push(kpi('Rejects', String(metrics.rejectCount)));
        }
        if (kpis.length > 0) {
            parts.push(`<div class="kpi-row">${kpis.join('')}</div>`);
        }

        // Critique
        if (critique) {
            const block = critique.verdict === 'block';
            const cls = block ? 'critique-block' : 'critique-pass';
            const reviewedLine = (critique.reviewedBy || critique.reviewedAt)
                ? `<div class="muted-text">${escapeHtml(critique.reviewedBy || 'unknown')} ${escapeHtml(critique.reviewedAt || '')}</div>`
                : '';
            const concernsHtml = (critique.concerns && critique.concerns.length > 0)
                ? `<ul class="critique-concerns">${critique.concerns.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
                : '';
            parts.push(`<div class="critique-panel ${cls}">
                <div class="critique-header">Plan critique: ${escapeHtml(critique.verdict.toUpperCase())}</div>
                ${concernsHtml}
                ${reviewedLine}
            </div>`);
        }

        // Failed DoD
        if (failedDod.length > 0) {
            const counts = new Map<string, number>();
            for (const f of failedDod) {
                counts.set(f.item, (counts.get(f.item) || 0) + 1);
            }
            const items = Array.from(counts.entries())
                .map(([item, n]) => `<li>${escapeHtml(item)}${n > 1 ? ` (${n} failures)` : ''}</li>`)
                .join('');
            parts.push(`<div class="field-label" style="margin-top:8px;">Failed DoD items</div>
                <ul class="failed-dod-list">${items}</ul>`);
        }

        // Prior handoffs
        if (handoffs.length > 0) {
            parts.push(`<div class="field-label" style="margin-top:8px;">Prior hand-offs (${handoffs.length})</div>`);
            for (let i = 0; i < handoffs.length; i++) {
                parts.push(renderHandoff(i + 1, handoffs[i]));
            }
        }

        return parts.join('\n');
    }

    private renderComments(comments: TaskComment[]): string {
        if (!comments || comments.length === 0) {
            return '<p class="no-comments">No comments yet</p>';
        }

        return comments.map(c => {
            const isAgent = isAgentAuthor(c.author);
            const cls = isAgent ? 'comment-agent' : 'comment-human';
            const timestamp = (c.timestamp || '').substring(0, 19);
            return `<div class="comment-item ${cls}">
                <div class="comment-header">
                    <span class="comment-author">${escapeHtml(c.author || 'Unknown')}</span>
                    <span>${escapeHtml(timestamp)}</span>
                </div>
                <div class="comment-content">${escapeHtml(c.content)}</div>
            </div>`;
        }).join('');
    }

    dispose(): void {
        TaskDetailPanel.currentPanels.delete(this.taskId);
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
        this.panel.dispose();
    }
}

// ============================================================================
// Utility functions (module-scoped)
// ============================================================================

function safeHttpUrl(url: string): boolean {
    if (!url) { return false; }
    const trimmed = String(url).trim().toLowerCase();
    return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

function escapeHtml(text: string): string {
    if (!text) { return ''; }
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function humanizeStatus(status: string): string {
    return status.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

function humaniseDuration(ms: number | undefined): string {
    if (ms == null) { return '-'; }
    if (ms <= 0) { return '0s'; }
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (days > 0) { return hours > 0 ? `${days}d ${hours}h` : `${days}d`; }
    if (hours > 0) { return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`; }
    if (minutes > 0) {
        return (seconds > 0 && minutes < 5) ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }
    return `${seconds}s`;
}

function kpi(label: string, value: string): string {
    return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}</div></div>`;
}

// The title matches the JetBrains header (TaskDetailDialog.handoffBlocks): "#N released by X (time): reason",
// each part only when its field is a non-blank string, so a malformed note renders "#N" instead of throwing.
function renderHandoff(index: number, h: HandoffNote): string {
    const part = (prefix: string, value: unknown, suffix = ''): string =>
        typeof value === 'string' && value.trim() ? prefix + escapeHtml(value) + suffix : '';
    const title = `#${index}` + part(' released by ', h.releasedBy) + part(' (', h.releasedAt, ')') + part(': ', h.reason);
    function block(label: string, value: string | undefined): string {
        const body = value && value.trim() ? escapeHtml(value) : '—';
        return `<div class="handoff-section">
            <div class="handoff-section-label">${escapeHtml(label)}</div>
            <div class="handoff-section-body">${body}</div>
        </div>`;
    }
    return `<div class="handoff-card">
        <div class="handoff-card-title">${title}</div>
        ${block('What is done', h.whatIsDone)}
        ${block('What remains', h.whatRemains)}
        ${block('Pitfalls', h.pitfalls)}
        ${block('Open questions', h.openQuestions)}
    </div>`;
}

function isAgentAuthor(author: string | undefined): boolean {
    if (!author) { return false; }
    const lower = author.toLowerCase();
    return lower === 'worker' || lower === 'architect' || lower === 'qa'
        || lower.includes('agent') || lower.includes('bot')
        || lower.includes('claude') || lower.includes('codex')
        || lower.includes('gemini') || lower.includes('grok');
}

