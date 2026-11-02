/**
 * The Accounts presentation: a port of JetBrains' AccountPresentation (rows, chips, actions, label rule) and of
 * MoeJson.parseAccountRotation, held to one shared corpus (moe-jetbrains/src/test/resources/client-accounts.json).
 * Pure on purpose: no import at all, and the time and zone are parameters. Text is `{ key, args }`, never resolved
 * text; resolveAccountText gives the English of MoeBundle.properties. JSON keys live in a Map, never on a plain
 * object, so a crafted window name cannot reach a prototype. No function throws, whatever it is given.
 */
export interface AccountText { key: string; args: (string | number)[] }
export interface PresentedWindow { percent: number | null; resetsAt: string | null }
export interface PresentedAccount {
    id: string; label: string; signIn: string; signInCheckedAt: string | null; windows: Map<string, PresentedWindow>;
    peakPercent: number | null; blockedUntil: string | null; active: boolean; seats: string[];
    /** Null when the daemon does not report it (an older daemon): unknown, never set. */
    vmToken: boolean | null;
}
export interface PresentedRotation {
    registryFile: string; switchAtPercent: number; error: string | null; cli: { node: string; script: string } | null; accounts: PresentedAccount[];
}
export interface AccountRow { id: string; position: number; label: string; signIn: AccountText; fiveHour: AccountText; weekly: AccountText; status: AccountText; vmToken: AccountText }
export interface AccountActions {
    add: boolean; rename: boolean; moveUp: boolean; moveDown: boolean; removeOnly: boolean; signIn: boolean;
    signOut: boolean; signOutAndRemove: boolean; check: boolean; switchAt: boolean; setVmToken: boolean; removeVmToken: boolean;
}

/** The daemon's limits (accounts/registry.ts). */
export const MAX_ACCOUNTS = 32;
export const MAX_LABEL_LENGTH = 64;
const MAX_HEADER_CHIPS = 4, CHIP_LABEL_LENGTH = 20, DEFAULT_SWITCH_AT = 90;
const SUBSCRIPTION = 'subscription';
const SIGN_IN_STATES = new Set([SUBSCRIPTION, 'signed_out', 'other']);
const FIVE_HOUR = 'five_hour', WEEKLY_PREFIX = 'seven_day';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** U+0000..U+001F or U+007F, as a code check because the lint rule refuses control characters in a pattern. */
const isControl = (char: string): boolean => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A real JSON string that is not blank; anything else is unset. */
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
/** A real JSON number that is finite; a string such as "42" or "NaN" is unset. */
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function parseAccount(raw: unknown): PresentedAccount | null {
    if (!isObject(raw)) return null;
    const id = text(raw.id);
    if (id === null) return null;
    const windows = new Map<string, PresentedWindow>();
    for (const [name, value] of isObject(raw.windows) ? Object.entries(raw.windows) : []) {
        if (isObject(value)) windows.set(name, { percent: finite(value.percent), resetsAt: text(value.resetsAt) });
    }
    return {
        id,
        label: text(raw.label) ?? id,
        signIn: typeof raw.signIn === 'string' && SIGN_IN_STATES.has(raw.signIn) ? raw.signIn : 'signed_out', // unknown asks for a sign-in
        signInCheckedAt: text(raw.signInCheckedAt),
        windows,
        peakPercent: finite(raw.peakPercent),
        blockedUntil: text(raw.blockedUntil),
        active: raw.active === true,
        seats: Array.isArray(raw.seats) ? raw.seats.filter((seat): seat is string => typeof seat === 'string') : [],
        vmToken: typeof raw.vmToken === 'boolean' ? raw.vmToken : null
    };
}

/** MoeJson.parseAccountRotation: null unless the payload is an object naming its registry file. */
export function parseAccountRotation(payload: unknown): PresentedRotation | null {
    if (!isObject(payload)) return null;
    const registryFile = text(payload.registryFile);
    if (registryFile === null) return null;
    const switchAt = finite(payload.switchAtPercent);
    const cli = isObject(payload.cli) ? { node: text(payload.cli.node), script: text(payload.cli.script) } : null;
    const seen = new Set<string>();
    const accounts: PresentedAccount[] = [];
    for (const raw of Array.isArray(payload.accounts) ? payload.accounts : []) {
        const account = parseAccount(raw);
        if (account !== null && !seen.has(account.id)) { seen.add(account.id); accounts.push(account); } // the first of a duplicate id wins
    }
    return {
        registryFile,
        switchAtPercent: switchAt !== null && Number.isInteger(switchAt) && switchAt >= 1 && switchAt <= 100 ? switchAt : DEFAULT_SWITCH_AT,
        error: text(payload.error),
        cli: cli !== null && cli.node !== null && cli.script !== null ? { node: cli.node, script: cli.script } : null,
        accounts
    };
}

/** Floored, so 89.6% never reads as a 90% switch point. */
const percent = (value: number): number => Math.floor(Math.max(value, 0));
/** The header and chips have room for a short label only; the Accounts tab shows it whole. */
const shorten = (label: string, max: number): string => (label.length > max ? `${label.slice(0, max - 3)}...` : label);

function formatter(zone: string): Intl.DateTimeFormat {
    const options: Intl.DateTimeFormatOptions = { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    try {
        return new Intl.DateTimeFormat('en-US', options);
    } catch {
        return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }); // an unknown zone reads as UTC
    }
}

function fields(format: Intl.DateTimeFormat, ms: number): Map<string, string> {
    return new Map(format.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
}

/** HH:mm today, MM-dd HH:mm on another day; text that is not an ISO instant shows as sent. */
function time(iso: string, nowMs: number, zone: string): string {
    if (!INSTANT.test(iso)) return iso;
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return iso;
    try {
        const format = formatter(zone);
        const [then, now] = [fields(format, at), fields(format, nowMs)];
        const clock = `${then.get('hour')}:${then.get('minute')}`;
        const sameDay = ['year', 'month', 'day'].every(part => then.get(part) === now.get(part));
        return sameDay ? clock : `${then.get('month')}-${then.get('day')} ${clock}`;
    } catch {
        return iso; // an unusable now
    }
}

const t = (key: string, ...args: (string | number)[]): AccountText => ({ key, args });

function usage(window: PresentedWindow | undefined, nowMs: number, zone: string): AccountText {
    if (window === undefined || window.percent === null) return t('moe.accounts.usage.none');
    if (window.resetsAt === null) return t('moe.accounts.usage.percent', percent(window.percent));
    return t('moe.accounts.usage.resets', percent(window.percent), time(window.resetsAt, nowMs, zone));
}

/** The busiest weekly window (seven_day, seven_day_opus, ...): the first of equals, a missing percent below all. */
function busiestWeekly(account: PresentedAccount): PresentedWindow | undefined {
    let busiest: PresentedWindow | undefined;
    for (const [name, window] of account.windows) {
        if (name.startsWith(WEEKLY_PREFIX) && (busiest === undefined || (window.percent ?? -1) > (busiest.percent ?? -1))) busiest = window;
    }
    return busiest;
}

function status(account: PresentedAccount, nowMs: number, zone: string): AccountText {
    const seats = account.seats.length;
    if (account.signIn !== SUBSCRIPTION) return t('moe.accounts.status.signInNeeded');
    if (account.blockedUntil !== null) return t('moe.accounts.status.spentUntil', time(account.blockedUntil, nowMs, zone));
    if (account.active) return seats > 0 ? t('moe.accounts.status.activeSeats', seats) : t('moe.accounts.status.active');
    return seats > 0 ? t('moe.accounts.status.inUse', seats) : t('moe.accounts.status.ready');
}

/** One row of the Accounts tab per account, in the order Moe uses them. */
export function rows(rotation: PresentedRotation | null, nowMs: number, zone: string): AccountRow[] {
    return (rotation?.accounts ?? []).map((account, index) => ({
        id: account.id,
        position: index + 1,
        label: account.label,
        signIn: t(account.signIn === SUBSCRIPTION ? 'moe.accounts.signIn.subscription' : account.signIn === 'other' ? 'moe.accounts.signIn.other' : 'moe.accounts.signIn.signedOut'),
        fiveHour: usage(account.windows.get(FIVE_HOUR), nowMs, zone),
        weekly: usage(busiestWeekly(account), nowMs, zone),
        status: status(account, nowMs, zone),
        vmToken: t(account.vmToken === true ? 'moe.accounts.vmTokenState.present' : account.vmToken === false ? 'moe.accounts.vmTokenState.absent' : 'moe.accounts.vmTokenState.unknown')
    }));
}

function chip(account: PresentedAccount, nowMs: number, zone: string): AccountText {
    const label = shorten(account.label, CHIP_LABEL_LENGTH);
    const peak = account.peakPercent === null ? null : percent(account.peakPercent);
    if (account.blockedUntil !== null) return t('moe.accounts.chip.spent', label, time(account.blockedUntil, nowMs, zone));
    if (account.active) return peak !== null ? t('moe.accounts.chip.active', label, peak) : t('moe.accounts.chip.activeNoData', label);
    return peak !== null ? t('moe.accounts.chip.usage', label, peak) : t('moe.accounts.chip.noData', label);
}

/** The header line: nothing without accounts, else one chip per subscription account. */
export function chips(rotation: PresentedRotation | null, nowMs: number, zone: string): AccountText[] {
    if (rotation === null) return [];
    if (rotation.error !== null) return [t('moe.accounts.chip.error')];
    if (rotation.accounts.length === 0) return [];
    const signedIn = rotation.accounts.filter(account => account.signIn === SUBSCRIPTION);
    if (signedIn.length === 0) return [t('moe.accounts.chip.noneSignedIn')];
    const shown = signedIn.slice(0, MAX_HEADER_CHIPS).map(account => chip(account, nowMs, zone));
    const hidden = signedIn.length - shown.length;
    return hidden > 0 ? [...shown, t('moe.accounts.chip.more', hidden)] : shown;
}

/** Which Accounts tab controls work right now. */
export function actions(rotation: PresentedRotation | null, selectedId: string | null | undefined, connected: boolean): AccountActions {
    const usable = rotation !== null && rotation.error === null;
    const accounts = rotation?.accounts ?? [];
    const index = accounts.findIndex(account => account.id === selectedId);
    const selected = usable && index >= 0;
    // List edits go through the daemon; command-line actions run in a terminal and only need its paths.
    const edit = usable && connected;
    const cli = usable && rotation.cli !== null;
    // A daemon that sends no vmToken flag runs a CLI that refuses the command: unknown disables both actions.
    const vmToken = selected ? accounts[index].vmToken : null;
    return {
        add: edit && accounts.length < MAX_ACCOUNTS,
        rename: edit && selected,
        moveUp: edit && selected && index > 0,
        moveDown: edit && selected && index < accounts.length - 1,
        removeOnly: edit && selected,
        signIn: cli && selected,
        signOut: cli && selected,
        signOutAndRemove: cli && selected,
        check: cli && accounts.length > 0,
        switchAt: edit,
        setVmToken: cli && selected && vmToken !== null,
        removeVmToken: cli && selected && vmToken === true
    };
}

/** The daemon's label rule (accounts/registry.ts): trimmed, at most 64 UTF-16 characters, no U+0000..U+001F or U+007F (C1 controls pass). */
export function isValidLabel(input: string): boolean {
    if (typeof input !== 'string') return false;
    const label = input.trim();
    return label.length <= MAX_LABEL_LENGTH && ![...label].some(isControl);
}

/** The English of MoeBundle.properties (moe.accounts.signIn, usage, status, vmTokenState and chip keys), {n} unsubstituted. */
export const ACCOUNT_TEXT: Readonly<Record<string, string>> = Object.freeze({
    'moe.accounts.signIn.subscription': 'Subscription',
    'moe.accounts.signIn.signedOut': 'Signed out',
    'moe.accounts.signIn.other': 'Not a subscription',
    'moe.accounts.usage.none': '-',
    'moe.accounts.usage.percent': '{0}%',
    'moe.accounts.usage.resets': '{0}% (resets {1})',
    'moe.accounts.status.signInNeeded': 'Needs subscription sign-in',
    'moe.accounts.status.spentUntil': 'Spent until {0}',
    'moe.accounts.status.active': 'Active',
    'moe.accounts.status.activeSeats': 'Active, {0} running',
    'moe.accounts.status.inUse': 'In use, {0} running',
    'moe.accounts.status.ready': 'Ready',
    'moe.accounts.vmTokenState.present': 'Set',
    'moe.accounts.vmTokenState.absent': 'Not set',
    'moe.accounts.vmTokenState.unknown': 'Unknown',
    'moe.accounts.chip.error': 'account file error',
    'moe.accounts.chip.noneSignedIn': 'no account signed in',
    'moe.accounts.chip.spent': '{0} spent until {1}',
    'moe.accounts.chip.active': '{0} {1}% (active)',
    'moe.accounts.chip.activeNoData': '{0} (active)',
    'moe.accounts.chip.usage': '{0} {1}%',
    'moe.accounts.chip.noData': '{0}',
    'moe.accounts.chip.more': '+{0} more',
    'moe.accounts.error': 'Moe cannot use the account file, so agents start without account rotation: {0}',
    'moe.accounts.noCli': 'The daemon did not say how to run its accounts command, so sign-in is not available here.',
    'moe.accounts.empty': 'Add an account, then sign in with your Claude subscription in the terminal tab that opens.',
    'moe.accounts.notConnected': 'Not connected to the Moe daemon.',
    'moe.accounts.unsupported': 'This Moe daemon does not report Claude accounts. Restart it after updating Moe.',
    'moe.accounts.header': 'Claude: {0}',
    'moe.accounts.column.signIn': 'Sign-in',
    'moe.accounts.column.fiveHour': '5-hour',
    'moe.accounts.column.weekly': 'Weekly',
    'moe.accounts.column.status': 'Status',
    'moe.accounts.column.vmToken': 'VM token'
});

/** The English for a text: its template (the key itself when unknown) with each {n} replaced once by its argument. */
export function resolveAccountText(value: AccountText): string {
    const template = Object.prototype.hasOwnProperty.call(ACCOUNT_TEXT, value.key) ? ACCOUNT_TEXT[value.key] : value.key;
    return template.replace(/\{(\d+)\}/g, (placeholder, n: string) => {
        const arg = value.args[Number(n)];
        return arg === undefined ? placeholder : String(arg);
    });
}
