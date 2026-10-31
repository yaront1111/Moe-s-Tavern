/**
 * The Managed VMs view's contract with CQ-I03a's `scripts/local-runner/vm-control.mjs`, mirroring the JetBrains
 * ManagedVmPresentation (CQ-I03). Pure (no vscode import), so tests run it directly.
 * - Provider readiness is not execution readiness or verification: three lines, and only a literal JSON `true` counts for the last two.
 * - The extension never offers strong-profile (verified-local) activation; the daemon refuses it with
 *   EXECUTION_PROFILE_NOT_READY until isolation, runner evidence and delivery are certified.
 * - Ownership is the producer's R06 ledger and the extension never names an instance. A report naming anything outside
 *   the owned-name shape, or one name twice, is unreadable as a whole. Producer stdout and stderr never reach rendered text.
 */
export type ManagedVmCommand = 'status' | 'reconcile' | 'cleanup';
export type UnreadableReason = 'timed-out' | 'failed' | 'too-large' | 'malformed' | 'not-owned' | 'cancelled' | 'node-missing' | 'script-missing' | 'no-project';
export interface ManagedVmRow { instance: string; phase: string; state: string; launchTries: number; taskId: string }
export type ManagedVmReport =
    | { kind: 'status'; providerReady: boolean; providerCode?: string; executionReady: boolean; verified: boolean; instances: ManagedVmRow[]; invalid: number }
    | { kind: 'outcome'; notes: string[] } | { kind: 'refused'; code: string } | { kind: 'unreadable'; reason: UnreadableReason };
export type ExecFileLike = (file: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean; signal?: AbortSignal },
    callback: (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string | Buffer) => void) => unknown;
const MAX_REPORT_BYTES = 64 * 1024; // the producer's cap; maxBuffer adds one byte for its newline
const SCHEMA: Record<ManagedVmCommand, string> = { status: 'moe-vm-status-v1', reconcile: 'moe-vm-reconcile-v1', cleanup: 'moe-vm-cleanup-v1' };
export const TIMEOUT_MS: Record<ManagedVmCommand, number> = { status: 120_000, reconcile: 120_000, cleanup: 20 * 60_000 }; // a delete may take 120 s
// lifecycle.mjs isOwnedInstanceName, PHASES, STATES (plus vm-control's Absent) and validOwner.
const OWNED = /^moe-vm-[0-9a-f]{20}$/;
const PHASES = new Set(['reserved', 'launching', 'owned', 'absent', 'failed', 'collision', 'deleted']);
const STATES = new Set(['Running', 'Stopped', 'Deleted', 'Starting', 'Restarting', 'Delayed Shutdown', 'Suspending', 'Suspended', 'Unavailable', 'Unknown', 'Absent']);
const TASK_ID = /^task-[A-Za-z0-9]{1,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const REASON = /^[a-z][a-z-]{0,31}$/;
const HIDDEN = new Set(['collision', 'deleted']); // a foreign VM that held the reserved name, or gone: never shown as owned
const LAUNCHED = new Set(['launching', 'owned', 'absent', 'failed']); // the phases cleanup acts on (lifecycle.mjs LAUNCHED)

const UNREADABLE: Record<UnreadableReason, string> = {
    'timed-out': 'The VM control script did not finish in time and was stopped. Refresh to see the current state.',
    failed: 'The VM control script could not run or exited with an error.',
    'too-large': 'The VM report was larger than 64 KiB and was not read.',
    malformed: 'The VM report could not be read, so nothing from it is shown.',
    'not-owned': 'The VM report named a VM outside the Moe-owned name shape, or one VM twice, so none of it is shown.',
    cancelled: 'The VM control run was cancelled. Refresh to see the current state.',
    'node-missing': 'Managed VM control unavailable: Node.js was not found. Install Node.js 22 or later, or set MOE_NODE_COMMAND, then refresh.',
    'script-missing': 'Managed VM control unavailable: the bundled scripts/local-runner/vm-control.mjs is missing; reinstall the extension.',
    'no-project': 'Managed VM control unavailable: open the Moe project folder first.'
};
/** Producer codes and preserve reasons; a Map, so a token such as `constructor` never reads a prototype member. */
const CODE_TEXT = new Map(Object.entries({
    PLATFORM_UNSUPPORTED: 'This host platform is not supported for Moe-managed VMs.',
    PREREQUISITES_UNAVAILABLE: 'Host prerequisites could not be checked; run the local-runner doctor.',
    PROVIDER_PREREQUISITES_READY: 'Multipass is ready, but another host prerequisite is not (on Windows, Hyper-V).',
    PROVIDER_NOT_FOUND: 'Multipass was not found. Install Multipass and make sure it is on PATH.',
    PROVIDER_ACCESS_DENIED: 'Multipass denied access to this user; check its authentication or group membership.',
    PROVIDER_TIMEOUT: 'Multipass did not answer in time; check that its service is running.',
    HOST_UNSUPPORTED: 'This host platform or architecture is not in the supported prerequisite matrix.',
    VERSION_UNSUPPORTED: 'This Multipass version is not an approved release; install an approved version.',
    DRIVER_UNSUPPORTED: 'The Multipass driver is unsupported; Moe did not change any driver setting.',
    VM_CONTROL_FAILED: 'The VM control script failed. Refresh to see the current state.',
    VM_CONTROL_REPORT_TOO_LARGE: 'The VM report was too large to send. Reconcile, then refresh.',
    LEDGER_UNREADABLE: 'The owned VM ledger could not be read, so nothing was listed or changed.',
    LIFECYCLE_STATE_UNKNOWN: 'The VM state is unknown; reconcile, then try again.',
    'attempt-active': 'Its agent attempt is still running.',
    'attempt-unknown': 'The daemon could not confirm that its attempt is closed (it must be reachable on loopback).',
    'job-lease-held': 'Its job lease is still held.',
    'lease-unknown': 'The daemon could not confirm that its job lease is free.'
}));
const codeText = (code: string) => CODE_TEXT.get(code) ?? `Unknown code ${code}: this version of Moe has no description for it.`;
export const unreadable = (reason: UnreadableReason): ManagedVmReport => ({ kind: 'unreadable', reason });

/** Never throws: anything but one well-formed report line for `command` is unreadable. */
export function decode(command: ManagedVmCommand, stdout: string, exitCode: number, timedOut: boolean): ManagedVmReport {
    if (timedOut) { return unreadable('timed-out'); }
    if (exitCode !== 0) { return unreadable('failed'); }
    if (Buffer.byteLength(stdout, 'utf8') > MAX_REPORT_BYTES) { return unreadable('too-large'); }
    try { return parse(command, stdout); } catch (error) { return unreadable(error instanceof Refusal ? error.reason : 'malformed'); }
}

export function readiness(report: ManagedVmReport | undefined): string[] {
    const status = report?.kind === 'status' ? report : undefined;
    const reason = status?.providerCode ? codeText(status.providerCode) : 'No reason was given; run the local-runner doctor.';
    return [
        !status ? 'VM provider: not checked yet.' : status.providerReady ? 'VM provider: ready.' : `VM provider: not ready. ${reason}`,
        status?.executionReady === true ? 'Execution: the runner reports it ready.' : 'Execution: not ready. A ready provider does not make isolated execution ready.',
        status?.verified === true ? 'Verification: the runner reports it verified.' : 'Verification: not verified. No isolation or runner evidence is certified.'
    ];
}
/** Blocked whatever a report claims: activation needs certification this extension cannot check. */
export const strongProfile: (report: ManagedVmReport | undefined) => string = () => 'Strong profile (verified-local) is unavailable: protected isolation, '
    + 'trusted runner evidence and revision-bound delivery are not certified. Moe keeps the current execution profile.';
export const rows = (report: ManagedVmReport | undefined): ManagedVmRow[] => (report?.kind === 'status' ? report.instances.filter(row => !HIDDEN.has(row.phase)) : []);
export function actions(lastStatus: ManagedVmReport | undefined, running: boolean): { refresh: boolean; reconcile: boolean; cleanup: boolean } {
    const ready = !running && lastStatus?.kind === 'status' && lastStatus.providerReady;
    return { refresh: !running, reconcile: ready, cleanup: ready && rows(lastStatus).some(row => LAUNCHED.has(row.phase)) };
}
export const notes = (report: ManagedVmReport | undefined): string[] => (!report ? [] : report.kind === 'status' ? invalidNote(report.invalid)
    : report.kind === 'outcome' ? report.notes : report.kind === 'refused' ? [codeText(report.code)] : [UNREADABLE[report.reason]]);
export const commandArgs = (script: string, command: ManagedVmCommand, root: string): string[] => [script, command, '--project', root];

/** Runs `node <script> <command> --project <root>` with no shell; always resolves, never with producer text. */
export function runVmControl(execFileImpl: ExecFileLike, node: string, script: string, command: ManagedVmCommand, root: string, signal?: AbortSignal): Promise<ManagedVmReport> {
    const options = { timeout: TIMEOUT_MS[command], maxBuffer: MAX_REPORT_BYTES + 1, windowsHide: true, ...(signal ? { signal } : {}) };
    return new Promise(resolve => {
        try {
            execFileImpl(node, commandArgs(script, command, root), options, (error, stdout) => resolve(error?.name === 'AbortError' ? unreadable('cancelled')
                : error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? unreadable('too-large') : error?.code === 'ENOENT' ? unreadable('node-missing')
                    : decode(command, String(stdout ?? ''), error ? -1 : 0, error?.killed === true)));
        } catch { resolve(unreadable('failed')); }
    });
}

class Refusal { constructor(readonly reason: UnreadableReason) {} }
const fail = (reason: UnreadableReason = 'malformed'): never => { throw new Refusal(reason); };
const obj = (value: unknown) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail());
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : fail());
const text = (value: unknown): string => (typeof value === 'string' ? value : fail());
const matching = (value: unknown, pattern: RegExp): string => (pattern.test(text(value)) ? value as string : fail());
const oneOf = (value: unknown, allowed: Set<string>): string => (allowed.has(text(value)) ? value as string : fail());
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff ? value : fail());
const invalidNote = (invalid: number) => (invalid > 0 ? [`${invalid} ledger record(s) could not be read and were left untouched.`] : []);
const outcome = (lines: string[]): ManagedVmReport => ({ kind: 'outcome', notes: lines.length ? lines : ['Nothing changed.'] });

/** Checks run in the JetBrains order, so a report with several defects gets the same verdict on both clients. */
function parse(command: ManagedVmCommand, stdout: string): ManagedVmReport {
    const line = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    if (line === '' || /[\n\r]/.test(line)) { fail(); }
    const root = obj(JSON.parse(line)); // strict: no trailing data, comments, single quotes or NaN
    const schema = root.schema === undefined ? undefined : text(root.schema);
    if (schema !== undefined && schema !== SCHEMA[command]) { fail(); }
    if (root.code !== undefined) { return { kind: 'refused', code: matching(root.code, CODE) }; }
    if (schema === undefined) { fail(); }
    const seen = new Set<string>();
    const owned = (value: unknown) => (OWNED.test(text(value)) && !seen.has(value as string) ? (seen.add(value as string), value as string) : fail('not-owned'));
    const invalid = count(root.invalid);
    if (command === 'status') {
        const provider = obj(root.provider);
        return {
            kind: 'status', providerReady: provider.ready === true, providerCode: provider.code === undefined ? undefined : matching(provider.code, CODE),
            executionReady: root.executionReady === true, verified: root.verified === true, invalid,
            instances: items(root.instances).map(obj).map(r => ({ instance: owned(r.instance), phase: oneOf(r.phase, PHASES), state: oneOf(r.state, STATES),
                launchTries: count(r.launchTries), taskId: matching(r.taskId, TASK_ID) }))
        };
    }
    if (command === 'reconcile') {
        return outcome([...items(root.reconciled).map(obj).map(r => `${owned(r.instance)}: recorded phase ${oneOf(r.from, PHASES)} corrected to ${oneOf(r.to, PHASES)}.`),
            ...items(root.unknown).map(name => `${owned(name)}: state unknown, record left as is.`), ...invalidNote(invalid)]);
    }
    return outcome([...items(root.deleted).map(name => `${owned(name)}: deleted.`),
        ...items(root.preserved).map(obj).map(r => `${owned(r.instance)}: kept. ${codeText(matching(r.reason, REASON))}`),
        ...items(root.errors).map(obj).map(r => `${owned(r.instance)}: not deleted. ${codeText(matching(r.code, CODE))}`), ...invalidNote(invalid)]);
}
