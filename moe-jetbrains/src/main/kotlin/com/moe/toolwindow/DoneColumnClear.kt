package com.moe.toolwindow

import com.moe.model.Task

object DoneColumnClear {
    /**
     * Count the Done column's Clear (✕) confirmation quotes, or null when no ✕ is offered.
     *
     * ARCHIVE_DONE_TASKS (packages/moe-daemon/src/server/WebSocketServer.ts:
     * `t.status === 'DONE' && (!epicFilter || t.epicId === epicFilter)`) archives every DONE
     * task in the epic, or on the whole board, and never sees the board search. So the count
     * comes from the full task list, not from the search-filtered column. An empty visible
     * column offers no ✕ (TaskColumn hides it too). Pure so the rule is headless-testable;
     * MoeToolWindowPanel supplies the state.
     */
    fun archiveCount(allTasks: List<Task>, selectedEpicId: String?, visibleDone: List<Task>): Int? {
        if (visibleDone.isEmpty()) return null
        return allTasks.count {
            it.status == "DONE" && (selectedEpicId.isNullOrEmpty() || it.epicId == selectedEpicId)
        }
    }
}
