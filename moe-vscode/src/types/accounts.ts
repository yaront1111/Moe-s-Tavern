/**
 * Claude account rotation wire types (type-only: no runtime code, safe to import
 * from MoeDaemonClient.ts under the closed require maps of the vm test harnesses).
 *
 * Mirrors the daemon's AccountView / AccountRotationView (packages/moe-daemon/src/types/schema.ts)
 * plus the vmToken flag accountStore.ts adds to each view.
 *
 * MoeDaemonClient stores the RAW payload after a top-level check only (an object
 * with a non-blank registryFile, JetBrains' parseAccountRotation gate). Field-level
 * normalization for display is AccountPresentation.parseAccountRotation's job (VSC-13).
 */

export interface AccountUsageWindow {
    percent: number | null;
    resetsAt: string | null;
}

export interface AccountView {
    id: string;
    label: string;
    /** Only "subscription" accounts are leased. */
    signIn: 'subscription' | 'signed_out' | 'other';
    signInCheckedAt: string | null;
    /** Live usage windows by name ("five_hour", "seven_day", ...). */
    windows: Record<string, AccountUsageWindow>;
    /** Highest live percent; null before any report. */
    peakPercent: number | null;
    /** When usage or a refusal stops blocking the account; null when it does not block it now. */
    blockedUntil: string | null;
    /** The account the next lease would pick. */
    active: boolean;
    /** Non-DEAD workers whose current launch runs under this account. */
    seats: string[];
    /** Whether the account has a VM token; absent from an older daemon. */
    vmToken?: boolean;
}

export interface AccountRotationView {
    registryFile: string;
    switchAtPercent: number;
    /** Why the registry cannot be used (rotation is off until it is fixed); null when it is fine. */
    error: string | null;
    /** How to run the `accounts` CLI on this machine (the IDE runs sign-in through it). */
    cli: { node: string; script: string };
    /** Registry (fill) order. */
    accounts: AccountView[];
}
