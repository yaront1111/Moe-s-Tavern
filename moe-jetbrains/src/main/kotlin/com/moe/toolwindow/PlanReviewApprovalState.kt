package com.moe.toolwindow

import com.moe.model.MAX_SAFE_PLAN_REVISION

/**
 * Decides whether the plan a reviewer actually read may still be approved.
 *
 * This is deliberately a plain state machine over plain values: no Swing, no
 * IntelliJ and no service types, so it is drivable by headless JUnit and is not
 * coupled to the command layer. [PlanReviewDialog] owns every side effect; this
 * object owns every decision.
 *
 * Two invariants carry the whole feature:
 *  - a [Decision.Send] always quotes the revision captured at render time, never
 *    a fresher one observed later, because the reviewer only ever read that one;
 *  - [Phase.FINISHED] is reachable only from [Phase.PENDING] observing the task
 *    move to `WORKING`. A transport that accepted the bytes is NOT an approval.
 *
 * Error handling: no method throws for bad input. An unusable snapshot produces
 * a [Decision.Blocked] carrying a message key. These methods run inside Swing
 * callbacks, where a throw would leave the dialog wedged with a live listener.
 *
 * Thread safety: [onStateUpdate] arrives on the daemon message thread while the
 * approve action reads on the event dispatch thread, so every transition and
 * every read is serialized on one lock. Without that, a duplicate send is a real
 * race rather than a theoretical one.
 */
class PlanReviewApprovalState(private val taskId: String) {

    /**
     * How a task's plan revision reached this dialog. The three cases are kept
     * apart on purpose: a daemon payload with no field at all is a legacy task
     * that may still be approved at effective revision 0, while a present but
     * unparseable stamp must never be approved against an assumed 0.
     */
    sealed class RevisionToken {
        data class Present(val value: Long) : RevisionToken()
        object LegacyMissing : RevisionToken()
        object Malformed : RevisionToken()
    }

    /** The parts of a task this machine is allowed to look at. */
    data class TaskSnapshot(
        val present: Boolean,
        val status: String?,
        val revision: RevisionToken
    )

    sealed class Decision {
        data class Send(val taskId: String, val expectedPlanRevision: Long) : Decision()
        data class Blocked(val messageKey: String) : Decision()
    }

    enum class Phase { AWAITING_RENDER, READY, PENDING, INVALIDATED, FINISHED, DISPOSED }

    private val lock = Any()
    private var phase: Phase = Phase.AWAITING_RENDER
    private var capturedRevision: Long? = null
    private var notice: String? = null

    val currentPhase: Phase get() = synchronized(lock) { phase }

    /** The revision the reviewer actually read, or null before a successful render. */
    val capturedPlanRevision: Long? get() = synchronized(lock) { capturedRevision }

    /** Only a rendered, still-valid plan may be approved. */
    val approveEnabled: Boolean get() = synchronized(lock) { phase == Phase.READY }

    /** Message key of the notice the dialog should show, or null for none. */
    val noticeKey: String? get() = synchronized(lock) { notice }

    /**
     * Captures the revision of the plan that just rendered. The dialog calls this
     * ONLY after the Definition of Done and steps panels were built without
     * throwing, so an unrendered plan can never be approved.
     *
     * @return true when the revision was captured and approval is now possible.
     */
    fun onRendered(snapshot: TaskSnapshot): Boolean = synchronized(lock) {
        if (phase != Phase.AWAITING_RENDER) return false
        val blockedBy = unusableReason(snapshot)
        if (blockedBy != null) {
            phase = Phase.INVALIDATED
            notice = blockedBy
            return false
        }
        capturedRevision = snapshot.revision.effectiveOrNull()
        phase = Phase.READY
        notice = null
        true
    }

    /**
     * Folds an observed task state into the machine.
     *
     * @return true when the dialog must repaint: latch the button and show a
     *   notice, or close on an authoritative approval.
     */
    fun onStateUpdate(snapshot: TaskSnapshot): Boolean = synchronized(lock) {
        if (phase != Phase.READY && phase != Phase.PENDING) return false
        // The one authoritative completion: the daemon moved the task on.
        if (phase == Phase.PENDING && snapshot.present && snapshot.status == STATUS_WORKING) {
            phase = Phase.FINISHED
            notice = null
            return true
        }
        val reason = unusableReason(snapshot) ?: staleReason(snapshot) ?: return false
        phase = Phase.INVALIDATED
        notice = reason
        true
    }

    /**
     * Independent action-time recheck. Ignoring the disabled button is not enough
     * to send: the caller's own freshly read state has to agree with what was
     * rendered, and the returned [Decision.Send] still quotes the captured
     * revision rather than anything in [snapshot].
     */
    fun onApproveClicked(connected: Boolean, snapshot: TaskSnapshot): Decision = synchronized(lock) {
        when (phase) {
            Phase.DISPOSED -> return Decision.Blocked(CLOSED_KEY)
            Phase.FINISHED -> return Decision.Blocked(ALREADY_APPROVED_KEY)
            Phase.PENDING -> return Decision.Blocked(IN_FLIGHT_KEY)
            Phase.AWAITING_RENDER -> return Decision.Blocked(NOT_RENDERED_KEY)
            Phase.INVALIDATED -> return Decision.Blocked(notice ?: PLAN_CHANGED_KEY)
            Phase.READY -> Unit
        }
        if (!connected) return Decision.Blocked(NOT_CONNECTED_KEY)
        val reason = unusableReason(snapshot) ?: staleReason(snapshot)
        if (reason != null) {
            // Real staleness found at click time latches, exactly as if the state
            // callback had delivered it first. A dropped connection does not
            // latch: it is transient, and a retry has to stay possible.
            phase = Phase.INVALIDATED
            notice = reason
            return Decision.Blocked(reason)
        }
        val captured = capturedRevision ?: return Decision.Blocked(REVISION_UNUSABLE_KEY)
        phase = Phase.PENDING
        notice = null
        Decision.Send(taskId, captured)
    }

    /**
     * The command never left this process. Back to [Phase.READY] so the reviewer
     * can retry; never [Phase.FINISHED], because nothing was accepted.
     */
    fun onSendFailed(): Boolean = releasePending(SEND_FAILED_KEY)

    /**
     * A daemon ERROR frame arrived. Any error while an approval is in flight is
     * read as "this approval did not happen": re-arming a reviewer whose approval
     * did land is a visible annoyance, while reporting a success that never
     * happened is a silent lie.
     *
     * [operation] and [message] are the daemon's own and the dialog shows them
     * unchanged; they are not inspected here.
     */
    @Suppress("UNUSED_PARAMETER")
    fun onDaemonError(operation: String, message: String): Boolean = releasePending(DAEMON_ERROR_KEY)

    /** Terminal. Every later callback is a no-op, so nothing can send after teardown. */
    fun onDisposed() = synchronized(lock) {
        phase = Phase.DISPOSED
        notice = null
    }

    private fun releasePending(reasonKey: String): Boolean = synchronized(lock) {
        if (phase != Phase.PENDING) return false
        phase = Phase.READY
        notice = reasonKey
        true
    }

    /** Why this snapshot can never be approved, independent of what was rendered. */
    private fun unusableReason(snapshot: TaskSnapshot): String? = when {
        !snapshot.present -> TASK_MISSING_KEY
        snapshot.status != STATUS_AWAITING_APPROVAL -> STATUS_CHANGED_KEY
        snapshot.revision.effectiveOrNull() == null -> REVISION_UNUSABLE_KEY
        else -> null
    }

    /** Why this snapshot is no longer the plan that was rendered. */
    private fun staleReason(snapshot: TaskSnapshot): String? =
        if (snapshot.revision.effectiveOrNull() != capturedRevision) PLAN_CHANGED_KEY else null

    private fun RevisionToken.effectiveOrNull(): Long? = when (this) {
        is RevisionToken.Present -> if (value in 0L..MAX_SAFE_PLAN_REVISION) value else null
        is RevisionToken.LegacyMissing -> LEGACY_EFFECTIVE_REVISION
        is RevisionToken.Malformed -> null
    }

    companion object {
        const val STATUS_AWAITING_APPROVAL = "AWAITING_APPROVAL"
        const val STATUS_WORKING = "WORKING"

        /** A task whose payload carried no stamp at all is approvable at 0. */
        const val LEGACY_EFFECTIVE_REVISION = 0L

        const val PLAN_CHANGED_KEY = "moe.message.planReview.planChanged"
        const val TASK_MISSING_KEY = "moe.message.planReview.taskMissing"
        const val STATUS_CHANGED_KEY = "moe.message.planReview.statusChanged"
        const val REVISION_UNUSABLE_KEY = "moe.message.planReview.revisionUnusable"
        const val NOT_CONNECTED_KEY = "moe.message.planReview.notConnected"
        const val IN_FLIGHT_KEY = "moe.message.planReview.approvalInFlight"
        const val ALREADY_APPROVED_KEY = "moe.message.planReview.alreadyApproved"
        const val NOT_RENDERED_KEY = "moe.message.planReview.notRendered"
        const val SEND_FAILED_KEY = "moe.message.planReview.sendFailed"
        const val DAEMON_ERROR_KEY = "moe.message.planReview.daemonError"
        const val CLOSED_KEY = "moe.message.planReview.closed"

        /**
         * Maps [com.moe.model.Task.planRevision] onto a token. The parser already
         * folds a payload with no field at all into 0, and a present but
         * unparseable field into null: so null is Malformed and must never be
         * approved, while 0 is the legacy case and may be.
         *
         * An out-of-range value is Malformed too. The command layer throws on one,
         * and this machine must not hand the dialog a decision that explodes.
         */
        @JvmStatic
        fun tokenOf(planRevision: Long?): RevisionToken = when {
            planRevision == null -> RevisionToken.Malformed
            planRevision !in 0L..MAX_SAFE_PLAN_REVISION -> RevisionToken.Malformed
            planRevision == LEGACY_EFFECTIVE_REVISION -> RevisionToken.LegacyMissing
            else -> RevisionToken.Present(planRevision)
        }

        /**
         * Every key this machine can emit. One guard test walks this list against
         * the bundle, so an untranslated key fails the build instead of showing a
         * raw placeholder at the moment a reviewer needs the warning.
         */
        @JvmStatic
        fun allMessageKeys(): List<String> = listOf(
            PLAN_CHANGED_KEY,
            TASK_MISSING_KEY,
            STATUS_CHANGED_KEY,
            REVISION_UNUSABLE_KEY,
            NOT_CONNECTED_KEY,
            IN_FLIGHT_KEY,
            ALREADY_APPROVED_KEY,
            NOT_RENDERED_KEY,
            SEND_FAILED_KEY,
            DAEMON_ERROR_KEY,
            CLOSED_KEY
        )
    }
}
