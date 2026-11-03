package com.moe.toolwindow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardMovesTest {
    // Copy of the daemon's /ws UPDATE_TASK VALID_TRANSITIONS at 946358a8
    // (packages/moe-daemon/src/server/WebSocketServer.ts:498-507).
    private val validTransitions = mapOf(
        "BACKLOG" to listOf("PLANNING", "WORKING", "ARCHIVED"),
        "PLANNING" to listOf("AWAITING_APPROVAL", "BACKLOG", "BLOCKED", "ARCHIVED"),
        "AWAITING_APPROVAL" to listOf("WORKING", "PLANNING"),
        "WORKING" to listOf("REVIEW", "PLANNING", "BACKLOG", "BLOCKED"),
        "REVIEW" to listOf("DONE", "WORKING", "BACKLOG", "PLANNING", "ARCHIVED", "BLOCKED"),
        "BLOCKED" to listOf("WORKING", "PLANNING", "REVIEW", "BACKLOG", "ARCHIVED"),
        "DONE" to listOf("BACKLOG", "WORKING", "ARCHIVED"),
        "ARCHIVED" to listOf("BACKLOG", "WORKING")
    )

    @Test fun backlogHasNoPrevious() = assertNull(BoardMoves.previous("BACKLOG"))

    @Test fun planningGoesToBacklog() =
        assertEquals(PreviousMove.Status("BACKLOG"), BoardMoves.previous("PLANNING"))

    @Test fun awaitingApprovalGoesToPlanning() =
        assertEquals(PreviousMove.Status("PLANNING"), BoardMoves.previous("AWAITING_APPROVAL"))

    @Test fun workingGoesToPlanning() =
        assertEquals(PreviousMove.Status("PLANNING"), BoardMoves.previous("WORKING"))

    @Test fun reviewAndDoneReopen() {
        assertEquals(PreviousMove.Reopen, BoardMoves.previous("REVIEW"))
        assertEquals(PreviousMove.Reopen, BoardMoves.previous("DONE"))
    }

    @Test fun blockedArchivedAndUnknownHaveNoPrevious() {
        for (s in listOf("BLOCKED", "ARCHIVED", "", "NOT_A_STATUS")) {
            assertNull("status '$s'", BoardMoves.previous(s))
            assertFalse(BoardMoves.hasPrevious(s))
        }
        assertTrue(BoardMoves.hasPrevious("WORKING"))
    }

    @Test fun everyPreviousMoveIsLegalForTheDaemon() {
        for ((status, allowed) in validTransitions) {
            when (val move = BoardMoves.previous(status)) {
                null -> Unit
                PreviousMove.Reopen -> assertTrue("$status reopens", status == "REVIEW" || status == "DONE")
                is PreviousMove.Status -> assertTrue(
                    "$status -> ${move.target} is not in $allowed",
                    move.target in allowed
                )
            }
        }
    }

    @Test fun nextFollowsTheWorkflowOrder() {
        assertEquals("PLANNING", BoardMoves.next("BACKLOG"))
        assertEquals("AWAITING_APPROVAL", BoardMoves.next("PLANNING"))
        assertEquals("WORKING", BoardMoves.next("AWAITING_APPROVAL"))
        assertEquals("REVIEW", BoardMoves.next("WORKING"))
        assertEquals("DONE", BoardMoves.next("REVIEW"))
    }

    @Test fun doneBlockedArchivedAndUnknownHaveNoNext() {
        for (s in listOf("DONE", "BLOCKED", "ARCHIVED", "", "NOT_A_STATUS")) {
            assertNull("status '$s'", BoardMoves.next(s))
            assertFalse("status '$s'", BoardMoves.hasNext(s))
        }
        for (s in listOf("BACKLOG", "PLANNING", "AWAITING_APPROVAL", "WORKING", "REVIEW")) {
            assertTrue("status '$s'", BoardMoves.hasNext(s))
        }
    }
}
