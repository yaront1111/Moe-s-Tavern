/**
 * Which launched worker seats still have a live shell, so a restart of this window never deregisters a seat that is
 * still working (VSC-21a). Pure: no import and no runtime dependency except the process global behind isProcessAlive's
 * default probe, so a test loads it with a module loader that throws on every name.
 *
 * Why it exists: the editor's terminals outlive the extension session that launched them. A window reload keeps
 * persistent terminal sessions running, and "Restart Extensions" after an update restarts only the extension host.
 * AgentSeatTracker counts every saved seat as gone at startup and deregisters it at the first connect, which is right
 * where tabs die with the IDE and wrong here: the daemon would release tasks their agents are still working on.
 * So each seat's shell pid (the editor's Terminal.processId) is remembered, and at activation, before the first
 * connect, every saved seat whose shell is still alive is marked launched() again.
 *
 * Note for the wiring: a recycled pid can make a dead seat look alive. That only delays its deregistration, which is
 * the safe direction.
 *
 * Errors from load and save propagate unchanged: the callbacks the extension injects own their catching. Nothing else
 * here throws.
 */

/** A real pid: a positive safe integer. Anything else is never probed, because kill(0) and kill(-n) address process groups. */
function isPid(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Probes a pid with signal 0 (it delivers nothing, it only checks that the process exists).
 * - Alive when the probe returns, or throws EPERM: the process exists but belongs to another user.
 * - Dead on ESRCH, on any other throw (whatever was thrown), and for any pid that is not a positive safe integer,
 *   which is never probed.
 */
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

/**
 * The shell pid of each launched seat, persisted through the injected load and save. One worker holds a pid and one
 * pid belongs to a worker, after every operation and after load. A Map keeps worker ids plain data: an object keyed
 * by worker id would answer 'constructor' or 'toString' from its prototype.
 */
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

    /**
     * Remembers the shell pid of a launched seat; a terminal's processId resolves to undefined until its shell starts.
     * A blank or non-string worker id and an invalid pid record nothing. A pid another worker held moves to this one, and
     * the worker's own previous pid is replaced. Saves only when the map changed.
     */
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
     * The given worker ids whose recorded pid `isAlive` confirms with true, in the order given and once each.
     * A non-array gives []. A non-string id and an id without a recorded pid are skipped without probing, and a
     * duplicate is probed once. isAlive receives the pid alone, so isProcessAlive can be passed as it is.
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
