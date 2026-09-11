package com.moe.toolwindow

import com.moe.model.MAX_SAFE_PLAN_REVISION
import com.moe.toolwindow.PlanReviewApprovalState.Decision
import com.moe.toolwindow.PlanReviewApprovalState.Phase
import com.moe.toolwindow.PlanReviewApprovalState.RevisionToken
import com.moe.toolwindow.PlanReviewApprovalState.TaskSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Headless cover for the plan-review approval machine: plain JUnit 4, no IntelliJ
 * fixture, no Swing, no daemon — the MetricsPanelTest pattern.
 *
 * Every assertion names an exact value (a Decision subtype, a message key
 * constant, a captured revision), because the defect this guards against is
 * approving the WRONG revision, which a truthiness check cannot see.
 */
class PlanReviewApprovalStateTest {

    private val taskId = "task-abc"

    private fun snapshot(
        revision: Long?,
        status: String = PlanReviewApprovalState.STATUS_AWAITING_APPROVAL,
        present: Boolean = true
    ) = TaskSnapshot(present, status, PlanReviewApprovalState.tokenOf(revision))

    private fun rendered(revision: Long): PlanReviewApprovalState {
        val state = PlanReviewApprovalState(taskId)
        assertTrue("render must capture $revision", state.onRendered(snapshot(revision)))
        assertEquals(revision, state.capturedPlanRevision)
        return state
    }

    // ------------------------------------------------- the rendered token, never the cached one

    @Test
    fun `a click on the rendered revision sends exactly that revision`() {
        val state = rendered(7L)
        val decision = state.onApproveClicked(connected = true, snapshot = snapshot(7L))
        assertEquals(Decision.Send(taskId, 7L), decision)
    }

    @Test
    fun `a click after the plan moved to a newer revision never sends the newer one`() {
        val state = rendered(7L)
        assertTrue("a revision change must repaint", state.onStateUpdate(snapshot(8L)))

        val decision = state.onApproveClicked(connected = true, snapshot = snapshot(8L))

        assertEquals(Decision.Blocked(PlanReviewApprovalState.PLAN_CHANGED_KEY), decision)
        assertEquals(7L, state.capturedPlanRevision)
        assertFalse(state.approveEnabled)
        assertEquals(PlanReviewApprovalState.PLAN_CHANGED_KEY, state.noticeKey)
    }

    @Test
    fun `a click racing ahead of the state callback still refuses the newer revision`() {
        // No onStateUpdate at all: the action-time recheck alone has to catch it,
        // which is what stops the click from substituting the cache's revision.
        val state = rendered(7L)

        val decision = state.onApproveClicked(connected = true, snapshot = snapshot(8L))

        assertEquals(Decision.Blocked(PlanReviewApprovalState.PLAN_CHANGED_KEY), decision)
        assertEquals(7L, state.capturedPlanRevision)
    }

    @Test
    fun `several updates never move the captured revision`() {
        val state = rendered(7L)
        state.onStateUpdate(snapshot(8L))
        state.onStateUpdate(snapshot(9L))
        state.onStateUpdate(snapshot(10L))

        assertEquals(7L, state.capturedPlanRevision)
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.PLAN_CHANGED_KEY),
            state.onApproveClicked(connected = true, snapshot = snapshot(10L))
        )
    }

    @Test
    fun `reopening renders and sends the new revision`() {
        // Close-and-reopen is the supported recovery: a FRESH machine captures 8.
        val reopened = rendered(8L)
        assertEquals(Decision.Send(taskId, 8L), reopened.onApproveClicked(true, snapshot(8L)))
    }

    // ------------------------------------------------- invalidation ordering and comment updates

    @Test
    fun `a new revision with byte-identical comments still invalidates`() {
        // The dialog's old early return swallowed exactly this case: the machine
        // has no idea comments exist, so it invalidates on the revision alone.
        val state = rendered(4L)

        assertTrue(state.onStateUpdate(snapshot(5L)))

        assertEquals(Phase.INVALIDATED, state.currentPhase)
        assertEquals(PlanReviewApprovalState.PLAN_CHANGED_KEY, state.noticeKey)
        assertFalse(state.approveEnabled)
    }

    @Test
    fun `a same-revision update leaves the plan approvable and asks for no repaint`() {
        val state = rendered(4L)

        assertFalse("a comment-only update must not repaint the notice", state.onStateUpdate(snapshot(4L)))

        assertEquals(Phase.READY, state.currentPhase)
        assertTrue(state.approveEnabled)
        assertNull(state.noticeKey)
        assertEquals(Decision.Send(taskId, 4L), state.onApproveClicked(true, snapshot(4L)))
    }

    @Test
    fun `a forced action while invalidated cannot send`() {
        val state = rendered(4L)
        state.onStateUpdate(snapshot(5L))

        // A caller that ignores the disabled button still gets nothing out.
        val decision = state.onApproveClicked(connected = true, snapshot = snapshot(4L))

        assertEquals(Decision.Blocked(PlanReviewApprovalState.PLAN_CHANGED_KEY), decision)
        assertEquals(Phase.INVALIDATED, state.currentPhase)
    }

    @Test
    fun `an invalidated machine stays latched on every later update`() {
        val state = rendered(4L)
        state.onStateUpdate(snapshot(5L))

        // Even the original revision coming back must not silently re-arm it.
        assertFalse(state.onStateUpdate(snapshot(4L)))
        assertEquals(Phase.INVALIDATED, state.currentPhase)
        assertFalse(state.approveEnabled)
    }

    // ------------------------------------------------- causes that can never approve

    @Test
    fun `a deleted task blocks with its own key`() {
        val state = rendered(4L)
        assertTrue(state.onStateUpdate(snapshot(4L, present = false)))
        assertEquals(PlanReviewApprovalState.TASK_MISSING_KEY, state.noticeKey)
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.TASK_MISSING_KEY),
            state.onApproveClicked(true, snapshot(4L, present = false))
        )
    }

    @Test
    fun `a status that moved off awaiting approval blocks with its own key`() {
        val state = rendered(4L)
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.STATUS_CHANGED_KEY),
            state.onApproveClicked(true, snapshot(4L, status = "PLANNING"))
        )
        assertEquals(PlanReviewApprovalState.STATUS_CHANGED_KEY, state.noticeKey)
    }

    @Test
    fun `a malformed revision blocks with its own key and never renders`() {
        val state = PlanReviewApprovalState(taskId)

        assertFalse("a malformed stamp must never capture", state.onRendered(snapshot(null)))

        assertNull(state.capturedPlanRevision)
        assertEquals(Phase.INVALIDATED, state.currentPhase)
        assertEquals(PlanReviewApprovalState.REVISION_UNUSABLE_KEY, state.noticeKey)
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.REVISION_UNUSABLE_KEY),
            state.onApproveClicked(true, snapshot(null))
        )
    }

    @Test
    fun `a revision that turns malformed after render blocks with its own key`() {
        val state = rendered(4L)
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.REVISION_UNUSABLE_KEY),
            state.onApproveClicked(true, snapshot(null))
        )
    }

    @Test
    fun `a disconnected service cannot approve and does not latch`() {
        val state = rendered(4L)

        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.NOT_CONNECTED_KEY),
            state.onApproveClicked(connected = false, snapshot = snapshot(4L))
        )

        // Disconnection is transient: reconnecting must let the same review proceed.
        assertEquals(Phase.READY, state.currentPhase)
        assertEquals(Decision.Send(taskId, 4L), state.onApproveClicked(true, snapshot(4L)))
    }

    @Test
    fun `a click before anything rendered blocks with its own key`() {
        val state = PlanReviewApprovalState(taskId)
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.NOT_RENDERED_KEY),
            state.onApproveClicked(true, snapshot(4L))
        )
    }

    @Test
    fun `a task that is not awaiting approval never renders`() {
        val state = PlanReviewApprovalState(taskId)
        assertFalse(state.onRendered(snapshot(4L, status = "WORKING")))
        assertEquals(PlanReviewApprovalState.STATUS_CHANGED_KEY, state.noticeKey)
        assertNull(state.capturedPlanRevision)
    }

    // ------------------------------------------------- the legacy stamp

    @Test
    fun `a legacy task with no stamp renders and sends effective revision zero`() {
        assertEquals(RevisionToken.LegacyMissing, PlanReviewApprovalState.tokenOf(0L))

        val state = rendered(0L)

        assertEquals(0L, state.capturedPlanRevision)
        assertEquals(Decision.Send(taskId, 0L), state.onApproveClicked(true, snapshot(0L)))
    }

    @Test
    fun `an out of range stamp is malformed rather than an argument the command layer rejects`() {
        assertEquals(RevisionToken.Malformed, PlanReviewApprovalState.tokenOf(-1L))
        assertEquals(RevisionToken.Malformed, PlanReviewApprovalState.tokenOf(MAX_SAFE_PLAN_REVISION + 1))
        assertEquals(
            RevisionToken.Present(MAX_SAFE_PLAN_REVISION),
            PlanReviewApprovalState.tokenOf(MAX_SAFE_PLAN_REVISION)
        )
    }

    // ------------------------------------------------- at most one outgoing command

    @Test
    fun `two clicks produce exactly one send`() {
        val state = rendered(4L)
        val decisions = listOf(
            state.onApproveClicked(true, snapshot(4L)),
            state.onApproveClicked(true, snapshot(4L))
        )

        assertEquals(listOf(Decision.Send(taskId, 4L)), decisions.filterIsInstance<Decision.Send>())
        assertEquals(Decision.Blocked(PlanReviewApprovalState.IN_FLIGHT_KEY), decisions[1])
        assertFalse("a pending approval disarms the button", state.approveEnabled)
    }

    @Test
    fun `a click after an authoritative approval is blocked`() {
        val state = rendered(4L)
        state.onApproveClicked(true, snapshot(4L))
        assertTrue(state.onStateUpdate(snapshot(4L, status = PlanReviewApprovalState.STATUS_WORKING)))

        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.ALREADY_APPROVED_KEY),
            state.onApproveClicked(true, snapshot(4L))
        )
    }

    // ------------------------------------------------- transport is not acceptance

    @Test
    fun `a failed send re-arms the button and never finishes the approval`() {
        val state = rendered(4L)
        assertEquals(Decision.Send(taskId, 4L), state.onApproveClicked(true, snapshot(4L)))

        assertTrue(state.onSendFailed())

        assertEquals(Phase.READY, state.currentPhase)
        assertEquals(PlanReviewApprovalState.SEND_FAILED_KEY, state.noticeKey)
        assertTrue(state.approveEnabled)
        assertEquals(Decision.Send(taskId, 4L), state.onApproveClicked(true, snapshot(4L)))
    }

    @Test
    fun `a send that the socket accepted does not finish the approval`() {
        val state = rendered(4L)
        state.onApproveClicked(true, snapshot(4L))

        // Nothing else happens: the daemon has not spoken yet.
        assertEquals(Phase.PENDING, state.currentPhase)
        assertFalse(state.currentPhase == Phase.FINISHED)
    }

    @Test
    fun `a daemon error re-arms the button with usable feedback and no approval`() {
        val state = rendered(4L)
        state.onApproveClicked(true, snapshot(4L))

        assertTrue(state.onDaemonError("APPROVE_TASK", "plan revision is stale"))

        assertEquals(Phase.READY, state.currentPhase)
        assertEquals(PlanReviewApprovalState.DAEMON_ERROR_KEY, state.noticeKey)
        assertTrue(state.approveEnabled)
    }

    @Test
    fun `a transport result outside a pending approval changes nothing`() {
        val state = rendered(4L)

        assertFalse(state.onSendFailed())
        assertFalse(state.onDaemonError("APPROVE_TASK", "unrelated"))

        assertEquals(Phase.READY, state.currentPhase)
        assertNull(state.noticeKey)
    }

    @Test
    fun `only a pending approval observing working reaches finished`() {
        val ready = rendered(4L)
        assertFalse(
            "a status move without a pending approval is invalidation, not success",
            ready.currentPhase == Phase.FINISHED
        )
        ready.onStateUpdate(snapshot(4L, status = PlanReviewApprovalState.STATUS_WORKING))
        assertEquals(Phase.INVALIDATED, ready.currentPhase)

        val pending = rendered(4L)
        pending.onApproveClicked(true, snapshot(4L))
        pending.onStateUpdate(snapshot(4L, status = PlanReviewApprovalState.STATUS_WORKING))
        assertEquals(Phase.FINISHED, pending.currentPhase)
        assertNull(pending.noticeKey)
    }

    // ------------------------------------------------- disposal

    @Test
    fun `after disposal every callback is inert and nothing can send`() {
        val state = rendered(4L)
        state.onDisposed()

        assertEquals(Phase.DISPOSED, state.currentPhase)
        assertFalse(state.approveEnabled)
        assertNull(state.noticeKey)
        assertFalse(state.onStateUpdate(snapshot(5L)))
        assertFalse(state.onSendFailed())
        assertFalse(state.onDaemonError("APPROVE_TASK", "late"))
        assertFalse(state.onRendered(snapshot(4L)))
        assertEquals(
            Decision.Blocked(PlanReviewApprovalState.CLOSED_KEY),
            state.onApproveClicked(true, snapshot(4L))
        )
        assertEquals(Phase.DISPOSED, state.currentPhase)
    }

    @Test
    fun `disposal during a pending approval cannot be finished by a later state`() {
        val state = rendered(4L)
        state.onApproveClicked(true, snapshot(4L))
        state.onDisposed()

        assertFalse(state.onStateUpdate(snapshot(4L, status = PlanReviewApprovalState.STATUS_WORKING)))
        assertEquals(Phase.DISPOSED, state.currentPhase)
    }

    // ------------------------------------------------- concurrency

    @Test
    fun `concurrent updates and clicks still send at most once`() {
        repeat(50) {
            val state = rendered(4L)
            val start = CountDownLatch(1)
            val decisions = java.util.Collections.synchronizedList(mutableListOf<Decision>())

            val clicker = { _: Int ->
                Thread {
                    start.await()
                    decisions.add(state.onApproveClicked(true, snapshot(4L)))
                }
            }
            val threads = listOf(
                clicker(0),
                clicker(1),
                Thread {
                    start.await()
                    state.onStateUpdate(snapshot(5L))
                }
            )
            threads.forEach { it.start() }
            start.countDown()
            threads.forEach { it.join(TimeUnit.SECONDS.toMillis(5)) }

            val sends = decisions.filterIsInstance<Decision.Send>()
            assertTrue("at most one send, got ${sends.size}", sends.size <= 1)
            sends.forEach { assertEquals(4L, it.expectedPlanRevision) }
        }
    }

    // ------------------------------------------------- dialog wiring guard

    /**
     * The machine cannot see the dialog's statement order, and a DialogWrapper
     * needs a platform fixture this module's test task deliberately strips — so
     * the one thing behavioural tests cannot reach is pinned by reading the
     * source. Same shape as the daemon's doc-contract guards: resolve the path
     * relatively, and fail loudly rather than silently pass when it is missing.
     */
    private fun dialogSource(): String {
        val relative = "src/main/kotlin/com/moe/toolwindow/PlanReviewDialog.kt"
        val candidates = listOf(java.io.File(relative), java.io.File("moe-jetbrains/$relative"))
        val file = candidates.firstOrNull { it.isFile }
            ?: throw IllegalStateException("PlanReviewDialog.kt not found from ${java.io.File("").absolutePath}")
        val text = file.readText()
        check(text.isNotBlank()) { "PlanReviewDialog.kt is empty" }
        return text
    }

    @Test
    fun `the dialog folds state into the machine before the comment early return and the debounce`() {
        val source = dialogSource()
        val machineCall = source.indexOf("approval.onStateUpdate(")
        val commentsEarlyReturn = source.indexOf("if (oldComments == newComments)")
        val debounce = source.indexOf("debounceTimer = Timer(DEBOUNCE_MS)")

        assertTrue("the dialog must fold state into the approval machine", machineCall > 0)
        // Positive half: the comment debounce this ordering has to precede is
        // still there, so the guard cannot be satisfied by deleting it.
        assertTrue("the comments-equality early return must still exist", commentsEarlyReturn > 0)
        assertTrue("the comment debounce must still exist", debounce > 0)

        assertTrue(
            "onStateUpdate must run BEFORE the comments-equality early return, " +
                "or a revision change carrying identical comments never reaches the screen",
            machineCall < commentsEarlyReturn
        )
        assertTrue("onStateUpdate must run outside the comment debounce", machineCall < debounce)
    }

    @Test
    fun `the dialog disposes the machine before it tears down its timer and listener`() {
        // Scoped to dispose(): onState stops the debounce timer too, so a
        // file-wide indexOf would measure the wrong statement.
        val disposeBody = dialogSource()
            .substringAfter("override fun dispose()")
            .substringBefore("private fun createDodPanel")
        val disposed = disposeBody.indexOf("approval.onDisposed()")
        val timerStop = disposeBody.indexOf("debounceTimer?.stop()")
        val removeListener = disposeBody.indexOf("service.removeListener(this)")

        assertTrue("dispose must notify the approval machine", disposed >= 0)
        assertTrue("dispose must still stop the debounce timer", timerStop > 0)
        assertTrue("dispose must still remove the listener", removeListener > 0)
        assertTrue(disposed < timerStop)
        assertTrue(disposed < removeListener)
    }

    @Test
    fun `the approve action sends without closing the dialog`() {
        val source = dialogSource()
        val approveBody = source.substringAfter("MoeBundle.message(\"moe.button.approve\")")
            .substringBefore("val rejectAction")

        assertTrue("the approve action must consult the machine", approveBody.contains("onApproveClicked("))
        assertFalse(
            "a send is not an approval: the approve action must not close the dialog",
            approveBody.contains("close(")
        )
        assertEquals(
            "the dialog may hand the command layer exactly one approval call",
            1,
            Regex("service\\.approveTask\\(").findAll(source).count()
        )
        assertTrue(
            "the approval must quote the captured revision",
            source.contains("service.approveTask(send.taskId, send.expectedPlanRevision)")
        )
    }

    // ------------------------------------------------- bundle key guard

    @Test
    fun `every message key the machine can emit is defined in the bundle`() {
        val bundle = Properties()
        val stream = checkNotNull(javaClass.getResourceAsStream("/messages/MoeBundle.properties")) {
            "MoeBundle.properties is not on the test classpath"
        }
        stream.use { bundle.load(it) }

        val keys = PlanReviewApprovalState.allMessageKeys()
        assertEquals("allMessageKeys must not repeat a key", keys.size, keys.toSet().size)
        assertEquals(11, keys.size)
        for (key in keys) {
            val value = bundle.getProperty(key)
            assertNotNull("$key is missing from MoeBundle.properties", value)
            assertTrue("$key has a blank value in MoeBundle.properties", value!!.isNotBlank())
        }
        // The invalidation notice must actually tell the reviewer what to do, and
        // the daemon-error notice must keep its {0} slot for the daemon's own text.
        assertEquals(
            "Plan changed - close and reopen to review the current plan.",
            bundle.getProperty(PlanReviewApprovalState.PLAN_CHANGED_KEY)
        )
        assertTrue(
            "the daemon error notice must carry the message parameter",
            bundle.getProperty(PlanReviewApprovalState.DAEMON_ERROR_KEY).contains("{0}")
        )
    }
}
