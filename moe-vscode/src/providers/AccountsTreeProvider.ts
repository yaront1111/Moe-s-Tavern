import * as vscode from 'vscode';
import type { MoeDaemonClient } from '../services/MoeDaemonClient';
import { chips, parseAccountRotation, resolveAccountText, rows } from '../util/AccountPresentation';

interface AccountNode { label: string; description?: string; tooltip?: string; id?: string; contextValue?: string }
interface AccountParts { items: AccountNode[]; description?: string; message?: string }
interface Clock { now(): number; zone(): string }
type AccountsClient = Pick<MoeDaemonClient, 'connectionState' | 'isStateReady' | 'accountRotation' | 'onAccountsChanged' | 'onConnectionChanged' | 'onStateChanged'>;
type AccountsView = Pick<vscode.TreeView<AccountNode>, 'description' | 'message'>;

/** AccountPresentation.SEPARATOR in JetBrains: the chips joined on the view's description line. */
const SEPARATOR = '  ·  ';
const COLUMNS = ['signIn', 'fiveHour', 'weekly', 'status', 'vmToken'] as const;
const text = (key: string, ...args: (string | number)[]): string => resolveAccountText({ key, args });
const column = (name: (typeof COLUMNS)[number]): string => text(`moe.accounts.column.${name}`);
const localClock = (): Clock => ({ now: () => Date.now(), zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });

/**
 * The read-only Claude accounts view (parity with the JetBrains Accounts tab, AccountsPanel.render): one item per
 * AccountPresentation row, the chips line as the view description, the account-file error or missing-CLI note as the
 * view message, and one state item when there is nothing to list. All English comes from AccountPresentation.
 */
export class AccountsTreeProvider implements vscode.TreeDataProvider<AccountNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    private view: AccountsView | undefined;
    private disposed = false;

    constructor(private readonly client: AccountsClient, private readonly clock: Clock = localClock()) {
        // A STATE_SNAPSHOT flips isStateReady and carries the first rotation, so onStateChanged matters as well as onAccountsChanged.
        this.subscriptions = [client.onAccountsChanged(() => this.refresh()), client.onConnectionChanged(() => this.refresh()), client.onStateChanged(() => this.refresh())];
    }

    /** What the view shows right now. Total: every input is a state, none throws. */
    parts(): AccountParts {
        if (this.client.connectionState !== 'connected') { return { items: [{ label: text('moe.accounts.notConnected') }] }; }
        const rotation = parseAccountRotation(this.client.accountRotation);
        if (rotation === null) { return { items: [{ label: text(this.client.isStateReady ? 'moe.accounts.unsupported' : 'moe.accounts.notConnected') }] }; }
        const now = this.clock.now();
        const zone = this.clock.zone();
        const line = chips(rotation, now, zone).map(resolveAccountText).join(SEPARATOR);
        const items = rows(rotation, now, zone).map((row): AccountNode => ({
            id: row.id,
            contextValue: 'moe.account',
            label: `${row.position}. ${row.label}`,
            description: `${resolveAccountText(row.status)} · ${column('fiveHour')}: ${resolveAccountText(row.fiveHour)} · ${column('weekly')}: ${resolveAccountText(row.weekly)}`,
            tooltip: COLUMNS.map(name => `${column(name)}: ${resolveAccountText(row[name])}`).join('\n')
        }));
        return {
            items: items.length > 0 || rotation.error !== null ? items : [{ label: text('moe.accounts.empty') }], // an error rotation is carried by the message
            description: line === '' ? undefined : text('moe.accounts.header', line),
            message: rotation.error !== null ? text('moe.accounts.error', rotation.error) : rotation.cli === null ? text('moe.accounts.noCli') : undefined
        };
    }

    getChildren(node?: AccountNode): AccountNode[] { return node ? [] : this.parts().items; }

    getTreeItem(node: AccountNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.description;
        item.tooltip = node.tooltip;
        item.contextValue = node.contextValue;
        return item;
    }

    /** The TreeView carries the chips line (description) and the note (message), which a tree item cannot. */
    attach(view: AccountsView): void {
        if (this.disposed) { return; }
        this.view = view;
        this.apply();
    }

    /** Re-renders everything, relative reset times included. A no-op once disposed. */
    refresh(): void {
        if (this.disposed) { return; }
        this.apply();
        this.changed.fire();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.changed.dispose();
        this.view = undefined;
    }

    private apply(): void {
        if (!this.view) { return; }
        const { description, message } = this.parts();
        this.view.description = description;
        this.view.message = message;
    }
}
