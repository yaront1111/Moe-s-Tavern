package com.moe.toolwindow

import com.moe.model.ImplementationStep
import com.moe.model.Task
import com.moe.services.MoeCommandSender
import com.moe.toolwindow.BoardRelease.Outcome
import com.moe.toolwindow.BoardRelease.StepLease
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Properties

class BoardReleaseTest {
    private fun step(id: String, status: String) =
        ImplementationStep(stepId = id, description = "", status = status, affectedFiles = emptyList())

    private fun task(holder: String?, vararg plan: ImplementationStep) = Task(
        id = "task-1", epicId = "epic-1", title = "Rendered task", description = "",
        status = "WORKING", order = 0.0, definitionOfDone = emptyList(),
        implementationPlan = plan.toList(), prLink = null, reopenReason = null,
        assignedWorkerId = holder
    )

    private val leased = task("w-mid", step("step-1", "COMPLETED"), step("step-2", "IN_PROGRESS"), step("step-3", "PENDING"))
    private val idle = task("w-1", step("step-1", "COMPLETED"), step("step-2", "PENDING"))

    @Test
    fun `an assigned task with an IN_PROGRESS step is leased by its holder on the first such step`() {
        assertEquals(StepLease("w-mid", "step-2"), BoardRelease.stepLease(leased))
        assertEquals(
            StepLease("w-2", "step-1"),
            BoardRelease.stepLease(task("w-2", step("step-1", "IN_PROGRESS"), step("step-2", "IN_PROGRESS")))
        )
    }

    @Test
    fun `no lease without an assignee or an IN_PROGRESS step`() {
        assertNull(BoardRelease.stepLease(null))
        assertNull(BoardRelease.stepLease(task(null, step("step-1", "IN_PROGRESS"))))
        assertNull(BoardRelease.stepLease(task("", step("step-1", "IN_PROGRESS"))))
        assertNull(BoardRelease.stepLease(task("w-1")))
        assertNull(BoardRelease.stepLease(idle))
    }

    // The flow drives a real MoeCommandSender, so every case asserts the exact frames sent.
    private val frames = mutableListOf<String>()
    private val sender = MoeCommandSender(connectedCheck = { true }, onDisconnected = {}, send = { _, m -> frames.add(m); true })
    private val forceAsked = mutableListOf<StepLease>()
    private val staleShown = mutableListOf<StepLease>()
    private var releaseAsked = 0

    private fun gesture(rendered: Task, release: Boolean, force: Boolean, latest: Task? = rendered) =
        BoardRelease.release(
            rendered,
            confirmRelease = { releaseAsked++; release },
            confirmForce = { lease -> forceAsked.add(lease); force },
            latest = { latest },
            send = { f -> sender.releaseTask(rendered.id, "Released from board", f) },
            stale = { lease -> staleShown.add(lease) }
        )

    private val plain = """{"type":"RELEASE_TASK","payload":{"taskId":"task-1","reason":"Released from board"}}"""
    private val forced = """{"type":"RELEASE_TASK","payload":{"taskId":"task-1","reason":"Released from board","force":true}}"""

    @Test
    fun `a release with no step in progress sends the plain frame and never asks about force`() {
        assertEquals(Outcome.RELEASED, gesture(idle, release = true, force = true))
        assertEquals(listOf(plain), frames)
        assertEquals(1, releaseAsked)
        assertTrue(forceAsked.isEmpty())
    }

    @Test
    fun `a mid-step release sends force only after a second confirmation that names holder and step`() {
        assertEquals(Outcome.FORCE_RELEASED, gesture(leased, release = true, force = true))
        // An equal lease in a newer copy (other fields changed) still forces.
        assertEquals(Outcome.FORCE_RELEASED, gesture(leased, release = true, force = true, latest = leased.copy(title = "Renamed")))
        assertEquals(List(2) { StepLease("w-mid", "step-2") }, forceAsked)
        assertEquals(listOf(forced, forced), frames)
        assertTrue(staleShown.isEmpty())
    }

    @Test
    fun `declining either confirmation sends no frame`() {
        assertEquals(Outcome.CANCELLED, gesture(leased, release = true, force = false))
        assertEquals(Outcome.CANCELLED, gesture(leased, release = false, force = true))
        assertEquals(Outcome.CANCELLED, gesture(idle, release = false, force = true))
        assertEquals(listOf(StepLease("w-mid", "step-2")), forceAsked)
        assertTrue(frames.isEmpty())
    }

    @Test
    fun `a lease that changed while confirming sends nothing`() {
        val changed = listOf(
            task("w-new", step("step-2", "IN_PROGRESS")),
            task("w-mid", step("step-2", "COMPLETED"), step("step-3", "IN_PROGRESS")),
            idle.copy(assignedWorkerId = "w-mid"),
            leased.copy(assignedWorkerId = null),
            null
        )
        for (latest in changed) {
            assertEquals(Outcome.STALE, gesture(leased, release = true, force = true, latest = latest))
        }
        assertTrue(frames.isEmpty())
        assertEquals(List(changed.size) { StepLease("w-mid", "step-2") }, staleShown)
    }

    @Test
    fun `an unassigned task asks nothing and sends nothing`() {
        assertEquals(Outcome.CANCELLED, gesture(task(null, step("step-1", "IN_PROGRESS")), release = true, force = true))
        assertEquals(Outcome.CANCELLED, gesture(task("  "), release = true, force = true))
        assertEquals(0, releaseAsked)
        assertTrue(frames.isEmpty())
    }

    // DialogWrapper and Messages need a full IDE: pin the thin UI wiring by source, as BoardApprovalTest does.
    private fun file(relative: String): File {
        val path = "src/main/$relative"
        return listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.exists() }
            ?: error("Not found: $path")
    }

    private fun source(relative: String) =
        file("kotlin/com/moe/$relative").readText().replace("\r\n", "\n").also { check(it.isNotBlank()) }

    @Test
    fun `card menu and Task Detail both release through the shared handler`() {
        val panel = source("toolwindow/MoeToolWindowPanel.kt")
        assertTrue(panel.contains("onReleaseAgent = { task -> handleReleaseAgent(task) }"))
        val card = panel.substringAfter("fun handleReleaseAgent(task: Task)").substringBefore("fun handlePrevious(")
        assertTrue(card.contains("BoardRelease.releaseRendered(project, service, task)"))
        assertFalse(card.contains("showYesNoDialog"))
        val detail = source("toolwindow/TaskDetailDialog.kt")
            .substringAfter("DialogWrapperAction(MoeBundle.message(\"moe.button.releaseAgent\"))")
            .substringBefore("MoeBundle.message(\"moe.button.reopen\")")
        assertTrue(detail.contains("BoardRelease.releaseRendered(project, service, task) != BoardRelease.Outcome.CANCELLED"))
        assertTrue(detail.indexOf("BoardRelease.releaseRendered(") < detail.indexOf("close(OK_EXIT_CODE)"))
        assertFalse(detail.contains("showYesNoDialog"))
        val senders = file("kotlin").walk()
            .filter { it.isFile && it.extension == "kt" && it.readText().contains("service.releaseTask(") }
            .map { it.name }.toList()
        assertEquals(listOf("BoardRelease.kt"), senders)
    }

    @Test
    fun `the UI adapter asks on the EDT, names holder and step, and rechecks the cache before force`() {
        val body = source("toolwindow/BoardRelease.kt").substringAfter("fun releaseRendered(")
        assertTrue(body.contains("check(SwingUtilities.isEventDispatchThread())"))
        assertTrue(body.contains("MoeBundle.message(FORCE_MESSAGE_KEY, lease.holder, lease.stepId, task.title)"))
        assertTrue(body.contains("latest = { service.getState()?.tasks?.firstOrNull { it.id == task.id } }"))
        assertTrue(body.contains("service.releaseTask(task.id, MoeBundle.message(\"moe.message.releasedInUI\"), force)"))
    }

    @Test
    fun `the new confirmations exist as MessageFormat-safe ASCII naming holder and step`() {
        val bundle = Properties()
        javaClass.getResourceAsStream("/messages/MoeBundle.properties")!!.use { bundle.load(it) }
        for (key in listOf(BoardRelease.FORCE_MESSAGE_KEY, BoardRelease.FORCE_TITLE_KEY, BoardRelease.STALE_MESSAGE_KEY)) {
            val value = bundle.getProperty(key)
            assertNotNull(key, value)
            assertTrue(key, value.all { it.code < 128 } && !value.contains('\''))
        }
        for (key in listOf(BoardRelease.FORCE_MESSAGE_KEY, BoardRelease.STALE_MESSAGE_KEY)) {
            val value = bundle.getProperty(key)
            assertTrue(key, value.contains("{0}") && value.contains("{1}"))
        }
    }
}
