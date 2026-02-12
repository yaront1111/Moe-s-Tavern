package com.moe.toolwindow

import com.moe.model.ActivityEvent
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.model.MoeState
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.table.JBTable
import com.intellij.openapi.ui.ComboBox
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.table.AbstractTableModel
import java.util.concurrent.CopyOnWriteArrayList

class ActivityLogPanel(private val project: Project) : JBPanel<ActivityLogPanel>(BorderLayout()), Disposable {
    private val service = project.service<MoeProjectService>()
    private val tableModel = ActivityTableModel()
    private val table = JBTable(tableModel)
    private val filterCombo = ComboBox<String>()
    @Volatile private var allEvents: List<ActivityEvent> = emptyList()
    @Volatile private var selectedFilter: String = "All"
    private var stateListener: MoeStateListener? = null

    private val eventTypes = listOf(
        "All",
        "TASK_CREATED", "TASK_UPDATED", "TASK_DELETED",
        "EPIC_CREATED", "EPIC_UPDATED",
        "PLAN_SUBMITTED", "PLAN_APPROVED", "PLAN_REJECTED",
        "STEP_STARTED", "STEP_COMPLETED",
        "TASK_COMPLETED", "TASK_BLOCKED"
    )

    init {
        border = JBUI.Borders.empty(8)

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 8, 4)).apply {
            isOpaque = false
            add(com.intellij.ui.components.JBLabel(MoeBundle.message("moe.filter.label")))
            eventTypes.forEach { filterCombo.addItem(it) }
            filterCombo.selectedItem = "All"
            filterCombo.addActionListener {
                selectedFilter = filterCombo.selectedItem as? String ?: "All"
                applyFilter()
            }
            add(filterCombo)
        }

        table.apply {
            setShowGrid(false)
            rowHeight = 24
            columnModel.getColumn(0).preferredWidth = 150
            columnModel.getColumn(1).preferredWidth = 120
            columnModel.getColumn(2).preferredWidth = 400
        }

        val scrollPane = JBScrollPane(table)

        add(toolbar, BorderLayout.NORTH)
        add(scrollPane, BorderLayout.CENTER)

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                if (allEvents.isEmpty()) {
                    service.requestActivityLog(200)
                }
            }

            override fun onStatus(connected: Boolean, message: String) {
                if (connected) {
                    service.requestActivityLog(200)
                }
            }

            override fun onActivityLog(events: List<ActivityEvent>) {
                // Thread-safe: store immutable snapshot and update UI on EDT
                allEvents = events.toList()
                SwingUtilities.invokeLater { applyFilter() }
            }
        }
        service.addListener(stateListener!!)

        // Request initial data
        service.requestActivityLog(200)
    }

    override fun dispose() {
        stateListener?.let { service.removeListener(it) }
        stateListener = null
    }

    private fun applyFilter() {
        val filtered = if (selectedFilter == "All") {
            allEvents
        } else {
            allEvents.filter { it.event == selectedFilter }
        }
        tableModel.setEvents(filtered)
    }

    private class ActivityTableModel : AbstractTableModel() {
        @Volatile private var events: List<ActivityEvent> = emptyList()
        private val columns = arrayOf(
            MoeBundle.message("moe.activity.columnTimestamp"),
            MoeBundle.message("moe.activity.columnEvent"),
            MoeBundle.message("moe.activity.columnDetails")
        )
        private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.systemDefault())

        fun setEvents(events: List<ActivityEvent>) {
            this.events = events
            fireTableDataChanged()
        }

        override fun getRowCount(): Int = events.size
        override fun getColumnCount(): Int = columns.size
        override fun getColumnName(column: Int): String = columns[column]

        override fun getValueAt(rowIndex: Int, columnIndex: Int): Any {
            // Defensive: capture reference to avoid race between size check and access
            val currentEvents = events
            if (rowIndex < 0 || rowIndex >= currentEvents.size) return ""
            val event = currentEvents[rowIndex]
            return when (columnIndex) {
                0 -> formatTimestamp(event.timestamp)
                1 -> event.event
                2 -> formatDetails(event)
                else -> ""
            }
        }

        private fun formatTimestamp(timestamp: String): String {
            return try {
                val instant = Instant.parse(timestamp)
                formatter.format(instant)
            } catch (e: Exception) {
                timestamp
            }
        }

        private fun formatDetails(event: ActivityEvent): String {
            val parts = mutableListOf<String>()
            event.taskId?.let { parts.add("task: ${it.takeLast(8)}") }
            event.epicId?.let { parts.add("epic: ${it.takeLast(8)}") }
            event.workerId?.let { parts.add("worker: $it") }

            val payloadStr = event.payload.entries
                .filter { it.value != null }
                .joinToString(", ") { "${it.key}: ${it.value}" }
            if (payloadStr.isNotEmpty()) {
                parts.add(payloadStr)
            }

            return parts.joinToString(" | ")
        }
    }
}
