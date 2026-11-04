// Type-only imports: the transpiled module has no require(), so the esbuild bundle and every strict
// vm require map in tests/ are unaffected (see tests/task-notifier.test.cjs).
import type * as vscode from 'vscode';
import type { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { Task, TaskStatus } from '../types/moe';

const VIEW_TASK = 'View Task';

export interface TaskNotification {
    kind: 'info' | 'warning';
    title: string;
    message: string;
    action?: { label: string; command: string; taskId: string };
}

/**
 * What to tell the human when `task` arrives and the cache held `previousStatus` (undefined = not cached).
 * Ports the JetBrains rule (MoeMessageDispatcher.kt 'TASK_UPDATED'/'TASK_CREATED' branch, texts from
 * MoeNotificationService.kt): only a status CHANGE into AWAITING_APPROVAL, BLOCKED, REVIEW or DONE notifies.
 */
export function taskNotification(previousStatus: TaskStatus | undefined, task: Task): TaskNotification | undefined {
    if (previousStatus === task.status) {
        return undefined;
    }
    // VS Code renders [label](command:...) in notification text as a clickable command link
    // (linkedText.ts LINK_REGEX, opened with allowCommands: true) and task titles are agent-written,
    // so break every "](". A title without one is unchanged and the JetBrains texts hold exactly.
    const name = String(task.title).replace(/\]\(/g, '] (');
    const view = { label: VIEW_TASK, command: 'moe.openTaskDetail', taskId: task.id };
    switch (task.status) {
        case 'AWAITING_APPROVAL':
            return { kind: 'info', title: 'Plan Awaiting Approval', message: `Task "${name}" has a plan ready for review`, action: view };
        case 'BLOCKED':
            return { kind: 'warning', title: 'Task Blocked', message: `Task "${name}" is blocked and needs attention`, action: view };
        case 'REVIEW':
            return { kind: 'info', title: 'Task Ready for Review', message: `Task "${name}" is ready for code review`, action: view };
        case 'DONE':
            return { kind: 'info', title: 'Task Completed', message: `Task "${name}" has been marked as done` };
        default:
            return undefined;
    }
}

/**
 * Shows a notice for each TASK_UPDATED/TASK_CREATED frame that changes a task's status. The client fires
 * onTaskUpdated BEFORE it writes the frame into currentState, so the cache still holds the previous status
 * here (guarded by tests/task-notifier.test.cjs row F). Never writes the cache. Disposing the returned
 * subscription stops all notices.
 */
export function registerTaskNotifier(
    client: Pick<MoeDaemonClient, 'currentState' | 'onTaskUpdated'>,
    window: Pick<typeof vscode.window, 'showInformationMessage' | 'showWarningMessage'>,
    commands: Pick<typeof vscode.commands, 'executeCommand'>
): vscode.Disposable {
    return client.onTaskUpdated(task => {
        const state = client.currentState;
        // JetBrains ignores TASK_* frames until the first STATE_SNAPSHOT.
        if (!state || !task) {
            return;
        }
        const notice = taskNotification(state.tasks.find(t => t.id === task.id)?.status, task);
        if (!notice) {
            return;
        }
        const action = notice.action;
        const items: string[] = action ? [action.label] : [];
        const line = `${notice.title}: ${notice.message}`;
        const shown = notice.kind === 'warning'
            ? window.showWarningMessage(line, ...items)
            : window.showInformationMessage(line, ...items);
        // Thenable has no .catch: a failed open (command gone, panel creation throws) must reach the human
        // as a warning, not as an unhandled rejection in the extension host.
        shown
            .then(pick => (action && pick === action.label ? commands.executeCommand(action.command, action.taskId) : undefined))
            .then(undefined, (err: unknown) => window.showWarningMessage(
                `Moe: could not open task ${task.id}: ${err instanceof Error ? err.message : String(err)}`));
    });
}
