package com.moe.toolwindow

import com.moe.model.Task

/**
 * The Done column's render cap. Every DONE task is otherwise a Swing card (a handful of
 * components and listeners) rebuilt on each board change, hundreds of them on a long-lived
 * board. Only the newest [DONE_COLUMN_CAP] render; the rest are counted into the header and a
 * footer line (Clear Done archives them). Pure so the selection is headless-testable.
 */
object BoardDoneCap {
    const val DONE_COLUMN_CAP = 200

    /**
     * The tasks to render and how many were left out. Newest first by the daemon's ISO 8601
     * `updatedAt` (else `completedAt`, else `createdAt`; a missing stamp is oldest; the strings
     * compare as instants), the higher `order` on a tie, the earlier input position on a full tie.
     * The kept tasks come back in [tasks]' own order, so the column lays them out as it would uncapped.
     */
    fun visible(tasks: List<Task>, cap: Int): Pair<List<Task>, Int> {
        if (tasks.size <= cap) return tasks to 0
        val newest = tasks
            .sortedWith(
                compareByDescending<Task> { it.updatedAt ?: it.completedAt ?: it.createdAt ?: "" }
                    .thenByDescending { it.order }
            )
            .take(cap)
            .mapTo(HashSet()) { it.id }
        val shown = tasks.filter { it.id in newest }
        return shown to tasks.size - shown.size
    }
}
