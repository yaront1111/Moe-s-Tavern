package com.moe.toolwindow

import com.moe.model.MAX_SAFE_PLAN_REVISION
import com.moe.model.Task
import com.moe.toolwindow.PlanReviewApprovalState.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class BoardApprovalTest {
    private fun task(revision: Long? = 0L, status: String = "AWAITING_APPROVAL") = Task(
        id = "task-1", epicId = "epic-1", title = "Rendered task", description = "",
        status = status, order = 0.0, definitionOfDone = emptyList(),
        implementationPlan = emptyList(), prLink = null, reopenReason = null,
        assignedWorkerId = null, planRevision = revision
    )

    @Test
    fun `present revision sends the rendered token`() {
        assertEquals(Decision.Send("task-1", 7L), BoardApproval.decide(task(7L)))
        assertEquals(Decision.Send("task-1", MAX_SAFE_PLAN_REVISION),
            BoardApproval.decide(task(MAX_SAFE_PLAN_REVISION)))
    }

    @Test
    fun `legacy missing revision sends an explicit zero`() {
        assertEquals(Decision.Send("task-1", 0L), BoardApproval.decide(task()))
    }

    @Test
    fun `malformed revision is never sent`() {
        listOf(null, -1L, MAX_SAFE_PLAN_REVISION + 1L).forEach { revision ->
            assertEquals(Decision.Blocked(PlanReviewApprovalState.REVISION_UNUSABLE_KEY),
                BoardApproval.decide(task(revision)))
        }
    }

    @Test
    fun `non awaiting status is never approved`() {
        listOf("WORKING", "PLANNING", "BLOCKED").forEach { status ->
            assertEquals(Decision.Blocked(PlanReviewApprovalState.STATUS_CHANGED_KEY),
                BoardApproval.decide(task(7L, status)))
        }
    }

    @Test
    fun `missing task is never approved`() {
        assertEquals(Decision.Blocked(PlanReviewApprovalState.TASK_MISSING_KEY),
            BoardApproval.decide(null))
    }

    @Test
    fun `each snapshot retains its own revision`() {
        val rendered = task(3L)
        val newer = rendered.copy(planRevision = 4L)
        assertEquals(Decision.Send("task-1", 3L), BoardApproval.decide(rendered))
        assertEquals(Decision.Send("task-1", 4L), BoardApproval.decide(newer))
        assertEquals(Decision.Send("task-1", 3L), BoardApproval.decide(rendered))
    }

    @Test
    fun `dispatch sends only the decided snapshot token`() {
        val sent = mutableListOf<Pair<String, Long>>()
        val notices = mutableListOf<String>()
        BoardApproval.dispatch(BoardApproval.decide(task(7L)),
            { id, revision -> sent.add(id to revision); true }, notices::add)
        assertEquals(listOf("task-1" to 7L), sent)
        assertEquals(emptyList<String>(), notices)
    }

    @Test
    fun `dispatch refuses malformed revisions with the actionable notice`() {
        val sent = mutableListOf<Pair<String, Long>>()
        val notices = mutableListOf<String>()
        BoardApproval.dispatch(BoardApproval.decide(task(null)),
            { id, revision -> sent.add(id to revision); true }, notices::add)
        assertEquals(emptyList<Pair<String, Long>>(), sent)
        assertEquals(listOf(PlanReviewApprovalState.REVISION_UNUSABLE_KEY), notices)
    }

    @Test
    fun `dispatch does not duplicate the disconnected notification`() {
        val notices = mutableListOf<String>()
        var sends = 0
        BoardApproval.dispatch(BoardApproval.decide(task()),
            { _, revision -> sends++; assertEquals(0L, revision); false }, notices::add)
        assertEquals(1, sends)
        assertEquals(emptyList<String>(), notices)
    }

    @Test
    fun `dispatch reports a throwing transport without escaping the UI callback`() {
        val notices = mutableListOf<String>()
        BoardApproval.dispatch(BoardApproval.decide(task(7L)),
            { _, _ -> throw IllegalStateException("transport lost") }, notices::add)
        assertEquals(listOf(PlanReviewApprovalState.SEND_FAILED_KEY), notices)
    }

    // DialogWrapper/notification infrastructure needs a full IDE; pin only the
    // thin UI wiring here, as in PlanReviewApprovalStateTest's dialog guards.
    private fun source(relative: String): String {
        val path = "src/main/kotlin/com/moe/$relative"
        val file = listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.isFile }
            ?: error("Source not found: $path")
        return file.readText().replace("\r\n", "\n").also { check(it.isNotBlank()) }
    }

    @Test
    fun `UI glue requires EDT and dispatches the rendered task without a cache lookup`() {
        val body = source("toolwindow/BoardApproval.kt")
            .substringAfter("fun approveRendered(").substringBefore("internal fun dispatch(")
        assertTrue(body.contains("check(SwingUtilities.isEventDispatchThread())"))
        assertTrue(body.contains("dispatch(decide(task),"))
        assertTrue(body.contains("service.approveTask(id, revision)"))
        assertTrue(body.contains("notifyApprovalBlocked(task, MoeBundle.message(key))"))
        assertTrue(!body.contains("getState()"))
    }

    @Test
    fun `blocked notification offers Plan Review on the EDT for awaiting tasks`() {
        val body = source("services/MoeNotificationService.kt")
            .substringAfter("fun notifyApprovalBlocked(").substringBefore("fun notifyTaskBlocked(")
        assertTrue(body.contains("assertEdt()"))
        assertTrue(body.contains("NotificationType.WARNING"))
        assertTrue(body.contains("task?.status == PlanReviewApprovalState.STATUS_AWAITING_APPROVAL"))
        assertTrue(body.contains("MoeBundle.message(\"moe.dialog.planReview\")"))
        assertTrue(body.contains("PlanReviewDialog(project, task, service).show()"))
        assertTrue(body.contains("notification.expire()"))
    }

    private fun assertRenderedApproval(body: String, snapshot: String) {
        assertTrue(body.contains("BoardApproval.approveRendered(project, service, $snapshot)"))
        assertTrue(!body.contains("service.approveTask("))
        assertTrue(!body.contains("service.getState()"))
    }

    @Test
    fun `Next approves the snapshot supplied by the rendered card or dialog`() {
        val body = source("toolwindow/MoeToolWindowPanel.kt")
            .substringAfter("fun handleNext(task: Task)").substringBefore("fun handleReleaseAgent(")
        assertRenderedApproval(body, "task")
        assertTrue(body.contains("if (task.status == \"AWAITING_APPROVAL\")"))
        assertTrue(body.contains("service.updateTaskStatus(task.id, nextStatus, task.order)"))
    }

    @Test
    fun `task drop approves from the rendered board list`() {
        val body = source("toolwindow/MoeToolWindowPanel.kt")
            .substringAfter("onDrop = { taskId, newStatus, order ->").substringBefore("onEpicDrop =")
        assertRenderedApproval(body, "currentTask")
        assertTrue(body.contains("val currentTask = allTasks.find { it.id == taskId }"))
        assertTrue(body.contains("currentTask?.status == \"AWAITING_APPROVAL\" && newStatus == \"WORKING\""))
        assertTrue(body.contains("service.updateTaskStatus(taskId, newStatus, order)"))
    }

    @Test
    fun `epic drop approves awaiting tasks and preserves other transitions`() {
        val body = source("toolwindow/MoeToolWindowPanel.kt")
            .substringAfter("onEpicDrop = { epicId, newStatus ->").substringBefore("onOpen =")
        assertRenderedApproval(body, "task")
        assertTrue(body.contains("task.status == \"AWAITING_APPROVAL\" && newStatus == \"WORKING\""))
        val skip = body.indexOf("if (task.status == \"BLOCKED\") continue")
        assertTrue(skip >= 0 && skip < body.indexOf("BoardApproval.approveRendered("))
        assertTrue(body.contains("} else {\n                                service.updateTaskStatus(task.id, newStatus, order)"))
        assertTrue(body.contains("service.updateEpicStatus(epicId, epicStatus, epic.order)"))
    }

    @Test
    fun `detail Approve uses the displayed task before closing`() {
        val body = source("toolwindow/TaskDetailDialog.kt")
            .substringAfter("DialogWrapperAction(MoeBundle.message(\"moe.button.approve\"))")
            .substringBefore("DialogWrapperAction(MoeBundle.message(\"moe.button.reject\"))")
        assertRenderedApproval(body, "task")
        assertTrue(body.indexOf("BoardApproval.approveRendered(") < body.indexOf("close(OK_EXIT_CODE)"))
    }

    @Test
    fun `global approval action opens review instead of approving an unseen plan`() {
        val body = source("actions/ApproveTaskAction.kt")
        assertTrue(body.contains("PlanReviewDialog(project, awaitingTask, service).show()"))
        assertTrue(!body.contains("approveTask("))
        assertTrue(body.contains("e.presentation.isEnabled = hasAwaitingTask"))
    }

    @Test
    fun `destination columns invalidate drop callbacks when rendered approvals change`() {
        // The Working column may itself be unchanged when a Planning task
        // becomes AWAITING_APPROVAL. Its cached callback must not keep routing
        // that task through a token-free UPDATE_TASK using the older allTasks.
        val panel = source("toolwindow/MoeToolWindowPanel.kt")
        val key = panel.substringAfter("val approvalFingerprint =").substringBefore("var updatedColumns")
        assertTrue(key.contains("tasks.filter { it.status == PlanReviewApprovalState.STATUS_AWAITING_APPROVAL }"))
        assertTrue(key.contains("\"\${it.id}:\${it.planRevision}\""))
        val column = panel.substringAfter("fun updateColumn(")
        val fingerprint = column.lineSequence().first { it.contains("val fingerprint =") }
        assertTrue(fingerprint.contains("|approvals=\$approvalFingerprint"))
    }
}
