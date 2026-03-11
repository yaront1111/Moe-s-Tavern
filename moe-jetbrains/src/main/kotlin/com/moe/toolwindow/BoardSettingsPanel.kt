package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.model.ProjectSettings
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.util.MoeBundle
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.table.JBTable
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.DefaultCellEditor
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.JTextField
import javax.swing.SpinnerNumberModel
import javax.swing.SwingUtilities
import javax.swing.table.AbstractTableModel
import javax.swing.table.TableCellEditor
import javax.swing.table.TableCellRenderer
import com.intellij.openapi.ui.ComboBox
import javax.swing.DefaultComboBoxModel
import java.awt.Component
import javax.swing.JTable

class BoardSettingsPanel(private val project: Project) : JBPanel<BoardSettingsPanel>(BorderLayout()), Disposable {
    private val service = project.service<MoeProjectService>()
    private val columns = listOf("BACKLOG", "PLANNING", "WORKING", "REVIEW", "DEPLOYING", "DONE")
    private val agentRoles = arrayOf("(none)", "architect", "worker", "qa")

    private val wipLimits = mutableMapOf<String, Int?>()
    private val columnAgents = mutableMapOf<String, String?>()

    private val tableModel = ColumnSettingsTableModel()
    private val table = JBTable(tableModel)
    private var stateListener: MoeStateListener? = null

    init {
        border = JBUI.Borders.empty(8)

        table.apply {
            setShowGrid(true)
            rowHeight = 28
            columnModel.getColumn(0).preferredWidth = 120
            columnModel.getColumn(1).preferredWidth = 100
            columnModel.getColumn(2).preferredWidth = 140

            // WIP Limit column: editable text field (accepts blank for no limit)
            columnModel.getColumn(1).cellEditor = object : DefaultCellEditor(JTextField()) {
                override fun getCellEditorValue(): Any {
                    val text = (component as JTextField).text.trim()
                    return if (text.isEmpty()) "" else text
                }
            }

            // Agent column: combo box editor
            val agentCombo = ComboBox(agentRoles)
            columnModel.getColumn(2).cellEditor = DefaultCellEditor(agentCombo)
        }

        val scrollPane = JBScrollPane(table)

        val buttonPanel = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 4)).apply {
            isOpaque = false
            val saveButton = JButton(MoeBundle.message("moe.settings.save"))
            saveButton.addActionListener { saveSettings() }
            add(saveButton)
        }

        add(scrollPane, BorderLayout.CENTER)
        add(buttonPanel, BorderLayout.SOUTH)

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                SwingUtilities.invokeLater { loadFromState(state) }
            }
            override fun onStatus(connected: Boolean, message: String) {}
        }
        service.addListener(stateListener!!)

        // Load initial state if available
        service.getState()?.let { loadFromState(it) }
    }

    private fun loadFromState(state: MoeState) {
        val settings = state.project.settings ?: return
        wipLimits.clear()
        columnAgents.clear()
        for (col in columns) {
            wipLimits[col] = settings.columnLimits?.get(col)
            columnAgents[col] = settings.columnAgents?.get(col)
        }
        tableModel.fireTableDataChanged()
    }

    private fun saveSettings() {
        val currentState = service.getState() ?: return
        val currentSettings = currentState.project.settings ?: ProjectSettings()

        val newLimits = mutableMapOf<String, Int>()
        for (col in columns) {
            wipLimits[col]?.let { newLimits[col] = it }
        }

        val newAgents = mutableMapOf<String, String>()
        for (col in columns) {
            columnAgents[col]?.let { newAgents[col] = it }
        }

        val updatedSettings = currentSettings.copy(
            columnLimits = newLimits.ifEmpty { null },
            columnAgents = newAgents.ifEmpty { null }
        )
        service.updateSettings(updatedSettings)

        NotificationGroupManager.getInstance()
            .getNotificationGroup("Moe Notifications")
            .createNotification("Moe", MoeBundle.message("moe.settings.saved"), NotificationType.INFORMATION)
            .notify(project)
    }

    override fun dispose() {
        stateListener?.let { service.removeListener(it) }
        stateListener = null
    }

    private inner class ColumnSettingsTableModel : AbstractTableModel() {
        private val columnNames = arrayOf(
            MoeBundle.message("moe.settings.columnName"),
            MoeBundle.message("moe.settings.wipLimit"),
            MoeBundle.message("moe.settings.assignedAgent")
        )

        override fun getRowCount(): Int = columns.size
        override fun getColumnCount(): Int = columnNames.size
        override fun getColumnName(column: Int): String = columnNames[column]

        override fun isCellEditable(rowIndex: Int, columnIndex: Int): Boolean {
            return columnIndex > 0 // Column name is read-only
        }

        override fun getValueAt(rowIndex: Int, columnIndex: Int): Any {
            val col = columns[rowIndex]
            return when (columnIndex) {
                0 -> col
                1 -> wipLimits[col]?.toString() ?: ""
                2 -> columnAgents[col] ?: MoeBundle.message("moe.settings.none")
                else -> ""
            }
        }

        override fun setValueAt(aValue: Any?, rowIndex: Int, columnIndex: Int) {
            val col = columns[rowIndex]
            when (columnIndex) {
                1 -> {
                    val text = (aValue as? String)?.trim() ?: ""
                    val num = text.toIntOrNull()
                    wipLimits[col] = if (num != null && num > 0) num else null
                }
                2 -> {
                    val value = aValue as? String
                    columnAgents[col] = if (value == MoeBundle.message("moe.settings.none") || value.isNullOrBlank()) null else value
                }
            }
            fireTableCellUpdated(rowIndex, columnIndex)
        }
    }
}
