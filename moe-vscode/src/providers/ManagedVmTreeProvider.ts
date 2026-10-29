import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import { ManagedVmCommand, ManagedVmReport, actions, notes, readiness, rows, runVmControl, strongProfile, unreadable } from '../util/ManagedVm';

interface VmNode { label: string; children?: VmNode[] }
const CLEAN_UP = 'Clean up owned';
const CONFIRM = 'Delete Moe-owned VMs whose attempt the daemon reports closed and whose job lease is free? Every other VM, including any VM Moe did not record, is kept.';

/** The Managed VMs view (parity with the JetBrains tab, CQ-I03): owned-VM status from CQ-I03a's vm-control.mjs plus refresh,
 * reconcile and cleanup, one run at a time. It never edits the execution profile or delivery policy; every rule lives in util/ManagedVm. */
export class ManagedVmTreeProvider implements vscode.TreeDataProvider<VmNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly subscription: vscode.Disposable;
    private status: ManagedVmReport | undefined;
    private outcome: ManagedVmReport | undefined;
    private running: AbortController | undefined;
    private disposed = false;

    constructor(private readonly extensionPath: string, private readonly client: MoeDaemonClient) {
        this.subscription = client.onStateChanged(() => this.changed.fire());
    }

    getTreeItem(node: VmNode): vscode.TreeItem { return new vscode.TreeItem(node.label, node.children?.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None); }

    getChildren(node?: VmNode): VmNode[] {
        if (node) { return node.children ?? []; }
        // The first render starts the first status run, so a view nobody opens never spawns the producer.
        if (!this.status && !this.running) { void this.refresh(); }
        const settings = this.client.currentState?.project?.settings as unknown as Record<string, unknown> | undefined;
        const shown = (value: unknown) => (!settings ? 'unknown (not connected)' : typeof value === 'string' && value !== '' ? value : 'legacy');
        const owned = rows(this.status);
        return [...readiness(this.status), strongProfile(this.status), `Profile: ${shown(settings?.executionProfile)} · Delivery: ${shown(settings?.deliveryPolicy)}`]
            .map((label): VmNode => ({ label }))
            .concat({ label: `Owned VMs (${owned.length})`, children: owned.map(r => ({ label: `${r.instance} · ${r.phase} · ${r.state} · tries ${r.launchTries} · ${r.taskId}` })) },
                [...notes(this.status), ...notes(this.outcome)].map(label => ({ label })));
    }

    refresh(): Promise<void> { return this.run('status'); }
    reconcile(): Promise<void> { return this.run('reconcile'); }
    async cleanup(): Promise<void> {
        if (!actions(this.status, this.running !== undefined).cleanup) { return; }
        if (await vscode.window.showWarningMessage(CONFIRM, { modal: true }, CLEAN_UP) === CLEAN_UP) { await this.run('cleanup'); }
    }

    dispose(): void {
        this.disposed = true;
        this.running?.abort();
        this.subscription.dispose();
        this.changed.dispose();
    }

    /** Single flight: re-checks the allowed actions, so a double invoke or a stale button starts nothing. */
    private async run(command: ManagedVmCommand): Promise<void> {
        if (this.disposed || !actions(this.status, this.running !== undefined)[command === 'status' ? 'refresh' : command]) { return; }
        const controller = new AbortController();
        this.running = controller;
        this.update();
        const report = await Promise.resolve(vscode.window.withProgress({
            location: command === 'cleanup' ? vscode.ProgressLocation.Notification : { viewId: 'moe.managedVms' },
            title: `Managed VMs: ${command}`, cancellable: command === 'cleanup'
        }, (_progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            return this.execute(command, controller.signal);
        })).catch(() => unreadable('failed'));
        this.running = undefined;
        if (command === 'status') { this.status = report; } else { this.outcome = report; }
        this.update();
        if (command !== 'status') { await this.run('status'); }
    }

    private execute(command: ManagedVmCommand, signal: AbortSignal): Promise<ManagedVmReport> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const script = path.join(this.extensionPath, 'bundled', 'scripts', 'local-runner', 'vm-control.mjs');
        if (!root) { return Promise.resolve(unreadable('no-project')); }
        if (!fs.existsSync(script)) { return Promise.resolve(unreadable('script-missing')); }
        return runVmControl(execFile, this.client.resolveDaemonRuntime().node, script, command, root, signal);
    }

    /** Toolbar enablement follows the same actions() the run re-checks. */
    private update(): void {
        if (this.disposed) { return; }
        const allowed = actions(this.status, this.running !== undefined);
        void vscode.commands.executeCommand('setContext', 'moe.managedVms.canReconcile', allowed.reconcile);
        void vscode.commands.executeCommand('setContext', 'moe.managedVms.canCleanup', allowed.cleanup);
        this.changed.fire();
    }
}
