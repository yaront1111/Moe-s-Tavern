package com.moe.toolwindow

import com.moe.model.Task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DoneColumnClearTest {
    private fun task(id: String, epicId: String, status: String) = Task(
        id = id, epicId = epicId, title = "Task $id", description = "",
        status = status, order = 0.0, definitionOfDone = emptyList(),
        implementationPlan = emptyList(), prLink = null, reopenReason = null,
        assignedWorkerId = null
    )

    private val d1 = task("d1", "epic-1", "DONE")
    private val d2 = task("d2", "epic-1", "DONE")
    private val d3 = task("d3", "epic-1", "DONE")
    private val d4 = task("d4", "epic-2", "DONE")
    private val d5 = task("d5", "epic-2", "DONE")

    // Only DONE is archived by ARCHIVE_DONE_TASKS; the other statuses must never count.
    private val board = listOf(
        d1, d2, d3, d4, d5,
        task("w1", "epic-1", "WORKING"),
        task("a1", "epic-1", "AWAITING_APPROVAL"),
        task("b1", "epic-1", "BLOCKED"),
        task("r1", "epic-2", "REVIEW"),
        task("x1", "epic-2", "ARCHIVED")
    )

    @Test
    fun `no search quotes the visible Done column`() {
        val epic1 = board.filter { it.epicId == "epic-1" && it.status == "DONE" }
        val all = board.filter { it.status == "DONE" }
        assertEquals(3, DoneColumnClear.archiveCount(board, "epic-1", epic1))
        assertEquals(5, DoneColumnClear.archiveCount(board, null, all))
    }

    @Test
    fun `a search subset with an epic selected quotes every DONE task in that epic`() {
        assertEquals(3, DoneColumnClear.archiveCount(board, "epic-1", listOf(d2)))
    }

    @Test
    fun `a search subset with All epics quotes every DONE task on the board`() {
        assertEquals(5, DoneColumnClear.archiveCount(board, null, listOf(d1, d4)))
    }

    @Test
    fun `an empty Done column offers no clear`() {
        // The search can hide every DONE card while DONE tasks remain in scope.
        assertNull(DoneColumnClear.archiveCount(board, "epic-1", emptyList()))
        assertNull(DoneColumnClear.archiveCount(board, null, emptyList()))
    }

    // MessageDialog infrastructure needs a full IDE; pin only the thin UI wiring here,
    // as in BoardApprovalTest.
    private fun source(relative: String): String {
        val path = "src/main/kotlin/com/moe/$relative"
        val file = listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.isFile }
            ?: throw IllegalStateException("Source not found: $path")
        return file.readText().replace("\r\n", "\n")
    }

    @Test
    fun `Done column Clear counts through DoneColumnClear and not the filtered column`() {
        val body = source("toolwindow/MoeToolWindowPanel.kt")
            .substringAfter("onClearColumn = if (isDone)").substringBefore("onNext =")
        assertTrue("onClearColumn slice must not be blank", body.isNotBlank())
        assertTrue(body.contains("DoneColumnClear.archiveCount("))
        assertTrue(!body.contains("columnTasks.size"))
        assertTrue(body.contains("moe.message.archiveDone"))
        assertTrue(body.contains("service.archiveDoneTasks("))
    }
}
