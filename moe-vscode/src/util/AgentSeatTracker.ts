/**
 * Worker seats this window launched into its own terminals, mirroring the JetBrains AgentSeatTracker (VSC-20).
 * Pure: no import and no runtime dependency, so a test loads it with a require that throws on every name.
 *
 * A wrapper killed together with its terminal (the terminal closed, the window exited or crashed) never runs the
 * exit trap that deregisters it, so its worker keeps every task it held (WORKING/PLANNING rows are never released
 * for idleness) and a daemon restart even holds a mid-task row for a runner that will never reattach. The window
 * knows those seats are gone, so it deregisters them itself.
 *
 * `known` is persisted and outlives the window: a seat leaves it only when a daemon acks the deregistration, because
 * a send made while the window shuts down may never be processed. `open` lives for this window session only, so at
 * startup every known seat counts as gone and is deregistered at the first connect.
 *
 * Errors from load, save and deregister propagate unchanged: the callbacks the extension injects own their catching.
 */
export interface SeatDisposable { dispose(): void }

/** The editor's Event shape: subscribe with a listener, get back something that unsubscribes. */
export type SeatEvent<T> = (listener: (value: T) => void) => SeatDisposable;

/** Only the non-blank string entries of an array, once each. Stored JSON is untyped: a string must not iterate as characters. */
function storedIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
}

export class AgentSeatTracker {
    private readonly known: Set<string>;
    private readonly open = new Set<string>();

    constructor(
        load: () => readonly string[],
        private readonly save: (workerIds: string[]) => void,
        private readonly deregister: (workerId: string) => void
    ) {
        this.known = new Set(storedIds(load()));
    }

    launched(workerId: string): void {
        this.open.add(workerId);
        if (!this.known.has(workerId)) {
            this.known.add(workerId);
            this.save([...this.known]);
        }
    }

    /** The seat's terminal is gone: deregister now (dropped when disconnected; resendGone retries). */
    closed(workerId: string): void {
        if (this.open.delete(workerId)) this.deregister(workerId);
    }

    /** On every daemon connect: deregister each known seat whose terminal is gone. */
    resendGone(): void {
        const gone = [...this.known].filter(id => !this.open.has(id));
        for (const id of gone) this.deregister(id);
    }

    acked(workerId: string): void {
        if (this.known.delete(workerId)) this.save([...this.known]);
    }
}

export type SeatSink = Pick<AgentSeatTracker, 'closed' | 'resendGone' | 'acked'>;

/**
 * Subscribes a tracker to three injected event sources and returns one disposable that unsubscribes all three.
 * - A closed terminal reaches closed() only when workerIdOf maps it to a non-empty worker id.
 * - onConnected takes the connection-state event as it is. That event also fires 'connecting' and 'disconnected',
 *   so resendGone() runs only for 'connected'.
 * - onAcked carries the acked worker id.
 * If subscribing any source throws, the subscriptions already made are disposed and the error is rethrown.
 * After dispose() (idempotent) no event reaches workerIdOf or the tracker, even from a source that keeps calling.
 */
export function wireAgentSeats<T>(seats: {
    tracker: SeatSink;
    onDidCloseTerminal: SeatEvent<T>;
    workerIdOf: (terminal: T) => string | undefined;
    onConnected: SeatEvent<string>;
    onAcked: SeatEvent<string>;
}): SeatDisposable {
    let disposed = false;
    const subscriptions: SeatDisposable[] = [];
    const dispose = (): void => {
        disposed = true;
        // splice empties the list, so a second dispose() finds nothing left to dispose.
        for (const subscription of subscriptions.splice(0)) subscription.dispose();
    };
    try {
        subscriptions.push(seats.onDidCloseTerminal(terminal => {
            if (disposed) return;
            const workerId = seats.workerIdOf(terminal);
            if (workerId) seats.tracker.closed(workerId);
        }));
        subscriptions.push(seats.onConnected(state => {
            if (!disposed && state === 'connected') seats.tracker.resendGone();
        }));
        subscriptions.push(seats.onAcked(workerId => {
            if (!disposed) seats.tracker.acked(workerId);
        }));
    } catch (error) {
        dispose();
        throw error;
    }
    return { dispose };
}
