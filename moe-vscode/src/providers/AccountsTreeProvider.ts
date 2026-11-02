import * as vscode from 'vscode';
import type { MoeDaemonClient } from '../services/MoeDaemonClient';
import { actions, chips, isValidLabel, parseAccountRotation, resolveAccountText, rows } from '../util/AccountPresentation';
import type { AccountActions } from '../util/AccountPresentation';

interface AccountNode { label: string; description?: string; tooltip?: string; id?: string; contextValue?: string }
interface AccountParts { items: AccountNode[]; description?: string; message?: string }
interface Clock { now(): number; zone(): string }
type AccountsClient = Pick<MoeDaemonClient, 'connectionState' | 'isStateReady' | 'accountRotation' | 'onAccountsChanged' | 'onConnectionChanged' | 'onStateChanged'
    | 'onAccountAdded' | 'addAccount' | 'removeAccount' | 'moveAccount' | 'renameAccount' | 'setAccountSwitchPercent'>;
type AccountsView = Pick<vscode.TreeView<AccountNode>, 'description' | 'message'>;

/** AccountPresentation.SEPARATOR in JetBrains: the chips joined on the view's description line. */
const SEPARATOR = '  ·  ';
const COLUMNS = ['signIn', 'fiveHour', 'weekly', 'status', 'vmToken'] as const;
const text = (key: string, ...args: (string | number)[]): string => resolveAccountText({ key, args });
const column = (name: (typeof COLUMNS)[number]): string => text(`moe.accounts.column.${name}`);
const localClock = (): Clock => ({ now: () => Date.now(), zone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });

/** MoeBundle.properties English for the account actions; tests/accounts-actions.test.cjs holds it equal to the bundle. */
export const ACCOUNT_ACTION_TEXT: Readonly<Record<string, string>> = Object.freeze({
    'moe.accounts.add.title': 'Add Claude Account',
    'moe.accounts.add.prompt': 'Name for the new account (optional, up to 64 characters). A terminal tab opens next so you can sign it in with your Claude subscription.',
    'moe.accounts.rename.title': 'Rename Claude Account',
    'moe.accounts.rename.prompt': 'New name (up to 64 characters; leave it empty to use the account id):',
    'moe.accounts.remove.confirm': 'Remove {0} from the list? Remove only keeps its Claude sign-in on this machine and deletes its VM token. Sign out and remove signs it out first, in a terminal tab.',
    'moe.accounts.remove.signOut': 'Sign out and remove',
    'moe.accounts.remove.only': 'Remove only',
    'moe.accounts.terminal.tab': 'Claude accounts',
    'moe.accounts.terminal.unavailable': 'Moe could not open a terminal tab. The command is on your clipboard; run it in the terminal where your agents run:\n{0}',
    'moe.accounts.switchAt': 'Switch to the next account at',
    'moe.accounts.switchAt.unit': '% of any usage window'
});
const say = (key: string, ...args: string[]): string => (ACCOUNT_ACTION_TEXT[key] ?? key).replace(/\{(\d+)\}/g, (placeholder, n: string) => args[Number(n)] ?? placeholder);
const NOT_CONNECTED = 'Not connected to Moe daemon — the account change was not sent.';
const LABEL_HINT = 'Use at most 64 characters and no control characters.';
const PERCENT_HINT = 'Enter a whole number from 1 to 100.';
const validLabel = (value: string): string | undefined => (isValidLabel(value) ? undefined : LABEL_HINT);
/** A whole number 1..100 (blanks around it allowed), else null. */
const percentOf = (value: string): number | null => {
    const n = /^\s*\d{1,3}\s*$/.test(value) ? Number(value) : NaN;
    return n >= 1 && n <= 100 ? n : null;
};
/** Row menu tokens (package.json `viewItem =~ /\bcanX\b/`) and the AccountPresentation.actions flag behind each. */
const ROW_TOKENS: readonly [string, (a: AccountActions) => boolean][] = [
    ['canSignIn', a => a.signIn], ['canRename', a => a.rename], ['canMoveUp', a => a.moveUp], ['canMoveDown', a => a.moveDown],
    ['canRemove', a => a.removeOnly || a.signOutAndRemove]
];

// psQuote, shQuote and assertSafeArg are copied from util/AgentLauncher.ts: the provider loads under closed require maps.
// assertSafeArg is widened from CR, LF and NUL to every C0 control and DEL, because sendText types each character into the
// shell's line editor, where Ctrl-U or Ctrl-W would erase the quoting typed before it.
// psQuote doubles each of ', U+2018, U+2019, U+201A and U+201B (PowerShell's single quotes; EscapeSingleQuotedStringContent).
const psQuote = (value: string): string => `'${String(value).replace(/['‘’‚‛]/g, '$&$&')}'`;
const shQuote = (value: string): string => `'${String(value).replace(/'/g, `'\\''`)}'`;
function assertSafeArg(label: string, value: string): void {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) { throw new Error(`Invalid ${label}: contains control characters`); }
    }
}

/**
 * JetBrains TerminalAgentLauncher.buildAccountsCommand: `<node> <cli.js> --accounts-file <file> <args>`, every word quoted.
 * Windows gets it through PowerShell -EncodedCommand, AgentLauncher's injection-safe form. Throws on CR, LF or NUL in any word.
 */
export function accountsCommandLine(cli: { node: string; script: string }, registryFile: string, args: string[], windows: boolean): string {
    const words = [cli.node, cli.script, '--accounts-file', registryFile, ...args];
    words.forEach(word => assertSafeArg('accounts command word', word));
    if (!windows) { return words.map(shQuote).join(' '); }
    return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(`& ${words.map(psQuote).join(' ')}`, 'utf16le').toString('base64')}`;
}

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
    private registered = false;
    /** Set by a sent add: the next ACCOUNT_ADDED signs that account in, as JetBrains AccountsPanel does. */
    private awaitingAdd = false;

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
            contextValue: this.contextFor(row.id),
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

    /** A row's contextValue: 'moe.account', plus one token per enabled row action once registerCommands() has run. */
    contextFor(id: string | null): string {
        if (!this.registered) { return 'moe.account'; } // VSC-14's read-only view: no command behind any menu
        const allowed = this.allowed(id);
        return ['moe.account', ...ROW_TOKENS.filter(([, on]) => on(allowed)).map(([token]) => token)].join(' ');
    }

    /** Registers the seven account commands and turns on menu enablement. Once only; before it nothing touches vscode.commands. */
    registerCommands(): vscode.Disposable[] {
        if (this.registered || this.disposed) { throw new Error('AccountsTreeProvider.registerCommands() runs once, before dispose()'); }
        this.registered = true;
        this.subscriptions.push(this.client.onAccountAdded(id => this.signInAdded(id)));
        const handlers: Record<string, (node?: AccountNode) => Promise<void>> = {
            'moe.accounts.add': () => this.add(),
            'moe.accounts.signIn': node => this.signIn(node),
            'moe.accounts.remove': node => this.remove(node),
            'moe.accounts.moveUp': node => this.move(node, -1),
            'moe.accounts.moveDown': node => this.move(node, 1),
            'moe.accounts.rename': node => this.rename(node),
            'moe.accounts.setSwitchPercent': () => this.setSwitchPercent()
        };
        const disposables = Object.entries(handlers).map(([command, handler]) => vscode.commands.registerCommand(command, handler));
        this.refresh();
        return disposables;
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
        this.publish();
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

    private connected(): boolean { return this.client.connectionState === 'connected'; }

    /** Fresh every time: a menu can be stale, so every action re-checks before it asks and again before it sends. */
    private allowed(id: string | null): AccountActions { return actions(parseAccountRotation(this.client.accountRotation), id, this.connected()); }

    private account(node?: AccountNode): { id: string; label: string } | undefined {
        return node?.id === undefined ? undefined : parseAccountRotation(this.client.accountRotation)?.accounts.find(account => account.id === node.id);
    }

    /** The view/title keys (package.json `when`). A refused setContext only leaves a menu stale, and the handlers re-check. */
    private publish(): void {
        if (!this.registered) { return; }
        const allowed = this.allowed(null);
        for (const [key, on] of [['moe.accounts.canAdd', allowed.add], ['moe.accounts.canSwitchAt', allowed.switchAt]] as const) {
            Promise.resolve(vscode.commands.executeCommand('setContext', key, on)).catch(() => undefined);
        }
    }

    private async add(): Promise<void> {
        await this.guard(async () => {
            if (!this.allowed(null).add) { return; }
            const label = await vscode.window.showInputBox({ title: say('moe.accounts.add.title'), prompt: say('moe.accounts.add.prompt'), value: '', validateInput: validLabel });
            if (label === undefined || !isValidLabel(label) || !this.allowed(null).add) { return; }
            this.awaitingAdd = this.sent(this.client.addAccount(label)); // ACCOUNT_ADDED arrives later, from the socket
        });
    }

    private async signIn(node?: AccountNode): Promise<void> {
        await this.guard(() => { if (node?.id !== undefined && this.allowed(node.id).signIn) { this.runCli(['login', node.id]); } });
    }

    /** JetBrains AccountsPanel.remove: Sign out and remove (CLI) and Remove only (daemon), as each is allowed. */
    private async remove(node?: AccountNode): Promise<void> {
        await this.guard(async () => {
            const account = this.account(node);
            if (account === undefined) { return; }
            const [signOut, only] = [say('moe.accounts.remove.signOut'), say('moe.accounts.remove.only')];
            const allowed = this.allowed(account.id);
            const choices = [...(allowed.signOutAndRemove ? [signOut] : []), ...(allowed.removeOnly ? [only] : [])];
            if (choices.length === 0) { return; }
            const choice = await vscode.window.showWarningMessage(say('moe.accounts.remove.confirm', account.label), { modal: true }, ...choices);
            const now = this.allowed(account.id);
            if (choice === only && now.removeOnly) { this.sent(this.client.removeAccount(account.id)); }
            // The CLI signs the account out first and keeps it listed if that fails.
            if (choice === signOut && now.signOutAndRemove) { this.runCli(['remove', account.id, '--sign-out']); }
        });
    }

    private async move(node: AccountNode | undefined, offset: -1 | 1): Promise<void> {
        await this.guard(() => {
            const id = node?.id;
            if (id !== undefined && this.allowed(id)[offset < 0 ? 'moveUp' : 'moveDown']) { this.sent(this.client.moveAccount(id, offset)); }
        });
    }

    /** An unchanged label sends nothing; an empty one is sent, and the daemon then shows the account id (JetBrains parity). */
    private async rename(node?: AccountNode): Promise<void> {
        await this.guard(async () => {
            const account = this.account(node);
            if (account === undefined || !this.allowed(account.id).rename) { return; }
            const label = await vscode.window.showInputBox({ title: say('moe.accounts.rename.title'), prompt: say('moe.accounts.rename.prompt'), value: account.label, validateInput: validLabel });
            if (label === undefined || !isValidLabel(label) || label.trim() === account.label || !this.allowed(account.id).rename) { return; }
            this.sent(this.client.renameAccount(account.id, label));
        });
    }

    private async setSwitchPercent(): Promise<void> {
        await this.guard(async () => {
            const rotation = parseAccountRotation(this.client.accountRotation);
            if (rotation === null || !this.allowed(null).switchAt) { return; }
            const input = await vscode.window.showInputBox({
                title: say('moe.accounts.switchAt'), prompt: `1-100${say('moe.accounts.switchAt.unit')}`, value: String(rotation.switchAtPercent),
                validateInput: value => (percentOf(value) === null ? PERCENT_HINT : undefined)
            });
            const percent = input === undefined ? null : percentOf(input);
            const current = parseAccountRotation(this.client.accountRotation)?.switchAtPercent;
            if (percent === null || percent === current || !this.allowed(null).switchAt) { return; }
            this.sent(this.client.setAccountSwitchPercent(percent));
        });
    }

    /** An ACCOUNT_ADDED answering an add made here signs the new account in (JetBrains onAccountAdded); any other is ignored. */
    private signInAdded(id: string): void {
        if (!this.awaitingAdd) { return; }
        this.awaitingAdd = false;
        void this.guard(() => this.runCli(['login', id]));
    }

    /** JetBrains AccountsPanel.runCli: the daemon's own accounts CLI in a terminal; with no terminal, the line goes to the clipboard. */
    private runCli(args: string[]): void {
        const rotation = parseAccountRotation(this.client.accountRotation);
        if (rotation === null || rotation.cli === null) { return; }
        const line = accountsCommandLine(rotation.cli, rotation.registryFile, args, process.platform === 'win32'); // throws on CR, LF or NUL
        let terminal: vscode.Terminal;
        try {
            terminal = vscode.window.createTerminal({ name: say('moe.accounts.terminal.tab') });
        } catch {
            void vscode.env.clipboard.writeText(line);
            void vscode.window.showWarningMessage(say('moe.accounts.terminal.unavailable', line));
            return;
        }
        terminal.sendText(line);
        terminal.show();
    }

    /** False from a sender means the frame never left. */
    private sent(ok: boolean): boolean {
        if (!ok) { void vscode.window.showWarningMessage(NOT_CONNECTED); }
        return ok;
    }

    private async guard(action: () => unknown): Promise<void> {
        try {
            await action();
        } catch (error) {
            void vscode.window.showErrorMessage(`Account action failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
