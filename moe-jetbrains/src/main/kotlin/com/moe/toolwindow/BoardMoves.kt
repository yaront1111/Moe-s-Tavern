package com.moe.toolwindow

/** What the board's Previous (left arrow / detail-dialog Previous) asks the daemon to do. */
internal sealed interface PreviousMove {
    /** REOPEN_TASK with the typed reason; the daemon routes the task back to BACKLOG. */
    object Reopen : PreviousMove

    /** A plain UPDATE_TASK status move to [target]. */
    data class Status(val target: String) : PreviousMove
}

internal object BoardMoves {
    /**
     * The daemon-legal "one column left" move for [status], or null when there is none.
     * Targets mirror the /ws UPDATE_TASK VALID_TRANSITIONS in
     * packages/moe-daemon/src/server/WebSocketServer.ts (AWAITING_APPROVAL is display-mapped
     * into the Planning column, so WORKING's left neighbour is PLANNING, never
     * AWAITING_APPROVAL, which /ws refuses). Never throws: unknown statuses are null.
     */
    fun previous(status: String): PreviousMove? = when (status) {
        "WORKING", "AWAITING_APPROVAL" -> PreviousMove.Status("PLANNING")
        "PLANNING" -> PreviousMove.Status("BACKLOG")
        "REVIEW", "DONE" -> PreviousMove.Reopen
        else -> null
    }

    fun hasPrevious(status: String): Boolean = previous(status) != null

    /**
     * The status the board's Next (right arrow / detail-dialog Next) moves [status] to, or null when there is
     * none. Workflow order BACKLOG, PLANNING, AWAITING_APPROVAL, WORKING, REVIEW, DONE; each target is in the
     * daemon's VALID_TRANSITIONS (packages/moe-daemon/src/tools/setTaskStatus.ts), and AWAITING_APPROVAL reaches
     * WORKING through BoardApproval.approveRendered. DONE is the end, BLOCKED leaves only through unblock_worker
     * resolveBlocks or set_task_status, and ARCHIVED or unknown statuses have no forward move. Never throws.
     */
    fun next(status: String): String? = when (status) {
        "BACKLOG" -> "PLANNING"
        "PLANNING" -> "AWAITING_APPROVAL"
        "AWAITING_APPROVAL" -> "WORKING"
        "WORKING" -> "REVIEW"
        "REVIEW" -> "DONE"
        else -> null
    }

    fun hasNext(status: String): Boolean = next(status) != null
}
