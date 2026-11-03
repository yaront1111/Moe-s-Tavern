package com.moe.toolwindow

import com.moe.model.Epic
import com.moe.model.Task

/**
 * The Epic detail dialog's typed fields, normalized exactly as Save always did: trimmed, blank rail lines
 * dropped, and a blank title keeping the epic's current one.
 */
internal data class EpicEdits(
    val title: String,
    val description: String,
    val architectureNotes: String,
    val epicRails: List<String>
)

/** One /ws UPDATE_EPIC frame of an Epic detail Save. A save sends its frames in list order. */
internal sealed interface EpicSaveFrame {
    /** MoeCommandSender.updateEpicDetails: every typed field, plus [status]. */
    data class Details(val edits: EpicEdits, val status: String) : EpicSaveFrame

    /** MoeCommandSender.updateEpicStatus: the status change on its own, with the epic's unchanged [order]. */
    data class Status(val status: String, val order: Double) : EpicSaveFrame
}

/**
 * What an Epic detail Save does. A non-empty [inFlightTitles] means: send nothing ([frames] is empty) and show
 * those titles. A non-null [archiveTaskCount] means: confirm the archive, quoting that count, before sending.
 */
internal data class EpicSavePlan(
    val frames: List<EpicSaveFrame>,
    val inFlightTitles: List<String> = emptyList(),
    val archiveTaskCount: Int? = null
)

/**
 * The Epic detail Save, decided from the cached board before anything is sent. Since task-625c7cfe the daemon
 * runs moe.archive_epic for a move to ARCHIVED: it refuses the whole UPDATE_EPIC frame, typed fields included,
 * while a task of the epic is in flight, and otherwise archives every task that is not ARCHIVED yet. Pure, so
 * the rules are headless-testable; EpicDetailDialog supplies the state and the UI.
 */
internal object EpicArchive {
    const val ARCHIVED = "ARCHIVED"
    const val TITLE_KEY = "moe.message.archiveEpicTitle"
    const val CONFIRM_MESSAGE_KEY = "moe.message.archiveEpic"
    const val IN_FLIGHT_MESSAGE_KEY = "moe.message.archiveEpicInFlight"

    /** moe.archive_epic's IN_FLIGHT (packages/moe-daemon/src/tools/archiveEpic.ts): any of these refuses the archive. */
    val IN_FLIGHT = setOf("PLANNING", "AWAITING_APPROVAL", "WORKING")

    /**
     * [epic] is the newest cached copy and [allTasks] the whole cached board; only tasks of [epic] count. Never throws.
     * - Not a move to ARCHIVED ([chosenStatus] is not ARCHIVED, or [epic] already is): one Details frame with
     *   [chosenStatus], as before. The daemon treats an already-ARCHIVED epic as a plain update.
     * - A move to ARCHIVED while a task of [epic] is PLANNING, AWAITING_APPROVAL or WORKING: no frames, and those
     *   tasks' titles in board order.
     * - Any other move to ARCHIVED: a Details frame that keeps [epic]'s current status, then a Status ARCHIVED
     *   frame, so a refusal from a stale cache never drops the typed edits. The archive count is the tasks of
     *   [epic] that are not ARCHIVED yet, which archive_epic archives (BACKLOG, REVIEW, BLOCKED and DONE).
     */
    fun plan(epic: Epic, allTasks: List<Task>, edits: EpicEdits, chosenStatus: String): EpicSavePlan {
        if (chosenStatus != ARCHIVED || epic.status == ARCHIVED) {
            return EpicSavePlan(listOf(EpicSaveFrame.Details(edits, chosenStatus)))
        }
        val epicTasks = allTasks.filter { it.epicId == epic.id }
        val inFlight = epicTasks.filter { it.status in IN_FLIGHT }
        if (inFlight.isNotEmpty()) {
            return EpicSavePlan(emptyList(), inFlightTitles = inFlight.map { it.title })
        }
        return EpicSavePlan(
            listOf(EpicSaveFrame.Details(edits, epic.status), EpicSaveFrame.Status(ARCHIVED, epic.order)),
            archiveTaskCount = epicTasks.count { it.status != ARCHIVED }
        )
    }

    /**
     * Runs [plan] through the dialog's callbacks. In-flight titles: [warnInFlight], and nothing is sent. An archive
     * count: [confirmArchive] first, and a declined confirmation sends nothing. Otherwise [send] each frame in order.
     * Returns true only when the frames were sent, which is when the dialog may close; false keeps the typed edits.
     */
    fun save(
        plan: EpicSavePlan,
        warnInFlight: (List<String>) -> Unit,
        confirmArchive: (Int) -> Boolean,
        send: (EpicSaveFrame) -> Unit
    ): Boolean {
        if (plan.inFlightTitles.isNotEmpty()) {
            warnInFlight(plan.inFlightTitles)
            return false
        }
        val count = plan.archiveTaskCount
        if (count != null && !confirmArchive(count)) return false
        plan.frames.forEach(send)
        return true
    }
}
