package com.moe.toolwindow

import com.moe.model.Epic
import com.moe.model.Task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Properties

class EpicArchiveTest {
    private fun epic(status: String) = Epic(
        id = "epic-1", title = "Epic one", description = "old description",
        architectureNotes = "old notes", epicRails = listOf("old rail"), status = status, order = 7.0
    )

    private fun task(id: String, status: String, epicId: String = "epic-1") = Task(
        id = id, epicId = epicId, title = "Title of $id", description = "",
        status = status, order = 0.0, definitionOfDone = emptyList(),
        implementationPlan = emptyList(), prLink = null, reopenReason = null,
        assignedWorkerId = null
    )

    private val edits = EpicEdits("New title", "new description", "new notes", listOf("rail a", "rail b"))

    // Only archivable statuses in epic-1, plus another epic's WORKING and DONE rows that must never count.
    private val quietBoard = listOf(
        task("t-backlog", "BACKLOG"), task("t-review", "REVIEW"), task("t-done", "DONE"),
        task("t-blocked", "BLOCKED"), task("t-archived", "ARCHIVED"),
        task("o-work", "WORKING", epicId = "epic-2"), task("o-done", "DONE", epicId = "epic-2")
    )

    private val quietArchive = EpicSavePlan(
        frames = listOf(EpicSaveFrame.Details(edits, "ACTIVE"), EpicSaveFrame.Status("ARCHIVED", 7.0)),
        archiveTaskCount = 4
    )

    @Test
    fun `archiving with in-flight tasks sends nothing and names them by title`() {
        val board = quietBoard + listOf(
            task("t-plan", "PLANNING"), task("t-await", "AWAITING_APPROVAL"), task("t-work", "WORKING")
        )
        assertEquals(
            EpicSavePlan(
                frames = emptyList(),
                inFlightTitles = listOf("Title of t-plan", "Title of t-await", "Title of t-work")
            ),
            EpicArchive.plan(epic("ACTIVE"), board, edits, "ARCHIVED")
        )
    }

    @Test
    fun `each in-flight status alone blocks the archive`() {
        for (status in listOf("PLANNING", "AWAITING_APPROVAL", "WORKING")) {
            assertEquals(
                status,
                EpicSavePlan(frames = emptyList(), inFlightTitles = listOf("Title of t-x")),
                EpicArchive.plan(epic("ACTIVE"), quietBoard + task("t-x", status), edits, "ARCHIVED")
            )
        }
    }

    @Test
    fun `a quiet epic sends its edits with the current status before a status-only ARCHIVED frame`() {
        assertEquals(quietArchive, EpicArchive.plan(epic("ACTIVE"), quietBoard, edits, "ARCHIVED"))
    }

    @Test
    fun `an unchanged non-archived status still sends exactly one frame`() {
        val board = quietBoard + task("t-work", "WORKING")
        for (status in listOf("PLANNED", "ACTIVE", "COMPLETED")) {
            assertEquals(
                status,
                EpicSavePlan(listOf(EpicSaveFrame.Details(edits, status))),
                EpicArchive.plan(epic(status), board, edits, status)
            )
        }
    }

    @Test
    fun `a move between non-archived statuses sends one frame with the chosen status`() {
        assertEquals(
            EpicSavePlan(listOf(EpicSaveFrame.Details(edits, "COMPLETED"))),
            EpicArchive.plan(epic("ACTIVE"), quietBoard + task("t-work", "WORKING"), edits, "COMPLETED")
        )
    }

    @Test
    fun `an epic that is already ARCHIVED stays a one-frame save`() {
        assertEquals(
            EpicSavePlan(listOf(EpicSaveFrame.Details(edits, "ARCHIVED"))),
            EpicArchive.plan(epic("ARCHIVED"), quietBoard + task("t-work", "WORKING"), edits, "ARCHIVED")
        )
    }

    @Test
    fun `an epic with no tasks still asks with a zero count`() {
        assertEquals(
            EpicSavePlan(
                frames = listOf(EpicSaveFrame.Details(edits, "PLANNED"), EpicSaveFrame.Status("ARCHIVED", 7.0)),
                archiveTaskCount = 0
            ),
            EpicArchive.plan(epic("PLANNED"), emptyList(), edits, "ARCHIVED")
        )
    }

    @Test
    fun `in-flight titles are shown and nothing is asked or sent`() {
        val warned = mutableListOf<List<String>>()
        val sent = mutableListOf<EpicSaveFrame>()
        val result = EpicArchive.save(
            EpicSavePlan(frames = emptyList(), inFlightTitles = listOf("A", "B")),
            warnInFlight = { warned.add(it) },
            confirmArchive = { throw AssertionError("must not ask") },
            send = { sent.add(it) }
        )
        assertFalse(result)
        assertEquals(listOf(listOf("A", "B")), warned)
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `Cancel on the archive confirmation sends nothing`() {
        val asked = mutableListOf<Int>()
        val sent = mutableListOf<EpicSaveFrame>()
        val result = EpicArchive.save(
            quietArchive,
            warnInFlight = { throw AssertionError("must not warn") },
            confirmArchive = { asked.add(it); false },
            send = { sent.add(it) }
        )
        assertFalse(result)
        assertEquals(listOf(4), asked)
        assertTrue(sent.isEmpty())
    }

    @Test
    fun `confirming sends the edits then the archive in order`() {
        val sent = mutableListOf<EpicSaveFrame>()
        val result = EpicArchive.save(
            quietArchive,
            warnInFlight = { throw AssertionError("must not warn") },
            confirmArchive = { it == 4 },
            send = { sent.add(it) }
        )
        assertTrue(result)
        assertEquals(listOf(EpicSaveFrame.Details(edits, "ACTIVE"), EpicSaveFrame.Status("ARCHIVED", 7.0)), sent)
    }

    @Test
    fun `a plain save sends its one frame without asking`() {
        val sent = mutableListOf<EpicSaveFrame>()
        val result = EpicArchive.save(
            EpicArchive.plan(epic("ACTIVE"), quietBoard, edits, "COMPLETED"),
            warnInFlight = { throw AssertionError("must not warn") },
            confirmArchive = { throw AssertionError("must not ask") },
            send = { sent.add(it) }
        )
        assertTrue(result)
        assertEquals(listOf(EpicSaveFrame.Details(edits, "COMPLETED")), sent)
    }

    @Test
    fun `the archive messages exist as MessageFormat-safe ASCII`() {
        val bundle = Properties()
        javaClass.getResourceAsStream("/messages/MoeBundle.properties")!!.use { bundle.load(it) }
        for (key in listOf(EpicArchive.TITLE_KEY, EpicArchive.CONFIRM_MESSAGE_KEY, EpicArchive.IN_FLIGHT_MESSAGE_KEY)) {
            val value = bundle.getProperty(key)
            assertNotNull(key, value)
            assertTrue(key, value.all { it.code < 128 } && !value.contains('\''))
            // Literal text first, so an agent-written title never starts the message.
            assertTrue(key, value.first().isLetter())
        }
        for (key in listOf(EpicArchive.CONFIRM_MESSAGE_KEY, EpicArchive.IN_FLIGHT_MESSAGE_KEY)) {
            val value = bundle.getProperty(key)
            assertTrue(key, value.contains("{0}") && value.contains("{1}"))
        }
    }

    // A DialogWrapper cannot be built in this headless suite (build.gradle.kts strips the platform from :test),
    // so pin the Save wiring in source, as DoneColumnClearTest does for the board.
    private fun source(relative: String): String {
        val path = "src/main/kotlin/com/moe/$relative"
        val file = listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.isFile }
            ?: throw IllegalStateException("Source not found: $path")
        return file.readText().replace("\r\n", "\n")
    }

    @Test
    fun `the dialog Save plans with the helper and sends only through it`() {
        val text = source("toolwindow/EpicDetailDialog.kt")
        val saveAnchor = "DialogWrapperAction(MoeBundle.message(\"moe.button.save\"))"
        val deleteAnchor = "DialogWrapperAction(MoeBundle.message(\"moe.button.delete\"))"
        assertTrue(text.contains(saveAnchor) && text.contains(deleteAnchor))
        val save = text.substringAfter(saveAnchor).substringBefore(deleteAnchor)
        assertTrue(save.contains("val state = service.getState()"))
        assertTrue(save.contains("val current = state?.epics?.firstOrNull { it.id == epic.id } ?: epic"))
        assertTrue(save.contains("EpicArchive.plan(current, state?.tasks.orEmpty(), edits, chosenStatus)"))
        assertTrue(save.contains("EpicArchive.save("))
        assertTrue(save.contains("MoeBundle.message(EpicArchive.CONFIRM_MESSAGE_KEY, epic.title, count)"))
        assertTrue(save.contains(") == Messages.OK"))
        // Every UPDATE_EPIC leaves through the helper's send callback, and only a sent save closes the dialog.
        val sendAt = save.indexOf("send = { frame ->")
        assertTrue(sendAt >= 0)
        assertTrue(save.indexOf("service.updateEpic") > sendAt)
        assertEquals(1, save.split("close(OK_EXIT_CODE)").size - 1)
        assertTrue(save.contains("if (sent) close(OK_EXIT_CODE)"))
    }
}
