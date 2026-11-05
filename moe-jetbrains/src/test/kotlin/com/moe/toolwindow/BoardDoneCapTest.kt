package com.moe.toolwindow

import com.moe.model.Task
import org.junit.Assert.assertEquals
import org.junit.Test

class BoardDoneCapTest {
    private fun task(
        id: String,
        order: Double,
        updatedAt: String? = null,
        completedAt: String? = null,
        createdAt: String? = null
    ) = Task(
        id = id, epicId = "epic-1", title = "Task $id", description = "", status = "DONE", order = order,
        definitionOfDone = emptyList(), implementationPlan = emptyList(), prLink = null, reopenReason = null,
        assignedWorkerId = null, updatedAt = updatedAt, completedAt = completedAt, createdAt = createdAt
    )

    @Test
    fun `under the cap everything shows and nothing is hidden`() {
        val tasks = listOf(task("a", 1.0, "2026-11-01T00:00:00.000Z"), task("b", 2.0, "2026-11-02T00:00:00.000Z"))
        assertEquals(tasks to 0, BoardDoneCap.visible(tasks, 2))
        assertEquals(tasks to 0, BoardDoneCap.visible(tasks, BoardDoneCap.DONE_COLUMN_CAP))
        assertEquals(emptyList<Task>() to 0, BoardDoneCap.visible(emptyList(), BoardDoneCap.DONE_COLUMN_CAP))
    }

    @Test
    fun `over the cap keeps the newest by updatedAt in input order and counts the rest`() {
        // Input is the board's order-ascending list; the stamps deliberately disagree with it.
        val tasks = listOf(
            task("old", 1.0, "2026-10-01T00:00:00.000Z"),
            task("newest", 2.0, "2026-11-04T12:00:00.000Z"),
            task("older", 3.0, "2026-09-01T00:00:00.000Z"),
            task("new", 4.0, "2026-11-03T00:00:00.000Z"),
            task("legacy", 5.0) // no stamp at all: the oldest
        )
        val (shown, hidden) = BoardDoneCap.visible(tasks, 2)
        assertEquals(listOf("newest", "new"), shown.map { it.id })
        assertEquals(3, hidden)
    }

    @Test
    fun `completedAt then createdAt stand in for a missing updatedAt`() {
        val tasks = listOf(
            task("by-created", 1.0, createdAt = "2026-11-02T00:00:00.000Z"),
            task("by-completed", 2.0, completedAt = "2026-11-03T00:00:00.000Z", createdAt = "2026-01-01T00:00:00.000Z"),
            task("by-updated", 3.0, updatedAt = "2026-11-01T00:00:00.000Z", completedAt = "2026-12-01T00:00:00.000Z")
        )
        val (shown, hidden) = BoardDoneCap.visible(tasks, 2)
        assertEquals(listOf("by-created", "by-completed"), shown.map { it.id })
        assertEquals(1, hidden)
    }

    @Test
    fun `equal stamps prefer the higher order and are otherwise stable`() {
        val same = "2026-11-04T00:00:00.000Z"
        val tasks = listOf(task("a", 1.0, same), task("b", 2.0, same), task("c", 3.0, same), task("d", 3.0, same))
        val (shown, hidden) = BoardDoneCap.visible(tasks, 2)
        assertEquals(listOf("c", "d"), shown.map { it.id })
        assertEquals(2, hidden)
        assertEquals(BoardDoneCap.visible(tasks, 2), BoardDoneCap.visible(tasks, 2))

        // A full tie keeps the first `cap` tasks in input order, run after run.
        val flat = (1..5).map { task("t$it", 0.0, same) }
        assertEquals(listOf("t1", "t2", "t3"), BoardDoneCap.visible(flat, 3).first.map { it.id })
        assertEquals(BoardDoneCap.visible(flat, 3), BoardDoneCap.visible(flat, 3))
    }
}
