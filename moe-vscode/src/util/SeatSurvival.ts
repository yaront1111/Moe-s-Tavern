/**
 * Which launched seats still have a live shell (VSC-21a). The editor's terminals outlive the extension session that
 * launched them: a window reload keeps persistent terminal sessions, and "Restart Extensions" restarts only the
 * extension host. AgentSeatTracker deregisters every saved seat at the first connect, so the daemon would release
 * tasks their agents still work on. So each seat's shell pid (the editor's Terminal.processId) is remembered, and
 * at activation, before the first connect, every saved seat whose shell is still alive is marked launched() again.
 * Note for the wiring: a recycled pid can make a dead seat look alive, which only delays its deregistration (safe).
 * Pure, no import. Errors from the injected load, save and isAlive propagate unchanged: their owners catch them.
 */

/** A real pid: a positive safe integer. Anything else is never probed, because kill(0) and kill(-n) address process groups. */
function isPid(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Signal-0 probe (delivers nothing): alive when it returns or throws EPERM (another user's process), else dead. */
export function isProcessAlive(
    pid: unknown,
    kill: (pid: number, signal: number) => unknown = (p, s) => process.kill(p, s)
): boolean {
    if (!isPid(pid)) return false;
    try {
        kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: unknown } | null)?.code === 'EPERM';
    }
}

/** Each launched seat's shell pid, one per worker and one worker per pid; a Map keeps ids like 'constructor' plain. */
export class SeatPids {
    private readonly pids = new Map<string, number>();

    /** `load` returns untyped stored JSON: only a plain object is read, and entries that are not a worker id with a pid are dropped. Never saves. */
    constructor(
        load: () => unknown,
        private readonly save: (pids: Record<string, number>) => void
    ) {
        const stored = load();
        if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return;
        for (const [workerId, pid] of Object.entries(stored)) this.assign(workerId, pid);
    }

    /** Applies the record rule to the map without saving. True when the map changed. */
    private assign(workerId: unknown, pid: unknown): boolean {
        if (typeof workerId !== 'string' || workerId.trim() === '' || !isPid(pid)) return false;
        const changed = this.pids.get(workerId) !== pid;
        for (const [other, held] of this.pids) {
            if (held === pid && other !== workerId) this.pids.delete(other);
        }
        this.pids.set(workerId, pid);
        return changed;
    }

    /** A fresh object every time, so nothing a callback does to it reaches the map. */
    private persist(): void {
        this.save(Object.fromEntries(this.pids));
    }

    /** Remembers a seat's shell pid (processId is undefined until the shell starts). Bad input is ignored; saves on change. */
    record(workerId: string, pid: number | undefined): void {
        if (this.assign(workerId, pid)) this.persist();
    }

    /** Drops every worker that is not in the list (a non-array keeps none). Saves only when something was dropped. */
    keep(workerIds: unknown): void {
        const wanted = new Set<unknown>(Array.isArray(workerIds) ? (workerIds as unknown[]) : []);
        let dropped = false;
        for (const workerId of [...this.pids.keys()]) {
            if (wanted.has(workerId)) continue;
            this.pids.delete(workerId);
            dropped = true;
        }
        if (dropped) this.persist();
    }

    /** The worker whose shell has this pid, or undefined. */
    seatOf(pid: number | undefined): string | undefined {
        for (const [workerId, held] of this.pids) {
            if (held === pid) return workerId;
        }
        return undefined;
    }

    /**
     * The given ids whose recorded pid isAlive confirms with true, in order and once each; a non-array gives [].
     * Unrecorded ids are never probed, and isAlive gets the pid alone, so isProcessAlive can be passed as it is.
     */
    surviving(workerIds: unknown, isAlive: (pid: number) => boolean): string[] {
        if (!Array.isArray(workerIds)) return [];
        const seen = new Set<string>();
        const alive: string[] = [];
        for (const workerId of workerIds as unknown[]) {
            if (typeof workerId !== 'string' || seen.has(workerId)) continue;
            seen.add(workerId);
            const pid = this.pids.get(workerId);
            if (pid !== undefined && isAlive(pid) === true) alive.push(workerId);
        }
        return alive;
    }
}
