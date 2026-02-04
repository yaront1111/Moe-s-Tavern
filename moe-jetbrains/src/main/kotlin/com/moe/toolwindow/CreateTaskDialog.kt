package com.moe.toolwindow

import com.moe.model.Epic
import com.moe.model.MoeState
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import java.awt.event.ItemEvent
import javax.swing.DefaultComboBoxModel
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.Action
import javax.swing.JScrollPane

class CreateTaskDialog(
    private val ideaProject: Project,
    private var epics: List<Epic>,
    private val service: MoeProjectService
) : DialogWrapper(ideaProject) {

    private val epicCombo = ComboBox<EpicOption>()
    private val titleField = JBTextField()
    private val descriptionField = JBTextArea()
    private val dodField = JBTextArea()
    private var lastSelectedEpic: Epic? = null
    private var pendingNewEpicSelection = false
    private val stateListener: MoeStateListener

    init {
        title = "Create Task"

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                val newEpics = state.epics
                if (pendingNewEpicSelection && newEpics.size > epics.size) {
                    val newEpic = newEpics.find { epic -> epics.none { it.id == epic.id } }
                    epics = newEpics
                    refreshEpicCombo(newEpic)
                    pendingNewEpicSelection = false
                } else {
                    epics = newEpics
                }
            }

            override fun onStatus(connected: Boolean, message: String) {
                // Not used
            }
        }
        service.addListener(stateListener)

        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(VerticalLayout(8))
        panel.border = JBUI.Borders.empty(4)

        panel.add(JBLabel("Epic"))
        refreshEpicCombo(null)
        epicCombo.renderer = EpicOptionRenderer()
        epicCombo.maximumSize = Dimension(520, epicCombo.preferredSize.height)

        epicCombo.addItemListener { e ->
            if (e.stateChange == ItemEvent.SELECTED) {
                val selected = epicCombo.selectedItem as? EpicOption
                if (selected?.isCreateNew == true) {
                    // Revert to last selected epic to avoid keeping "Create New Epic..." selected
                    val revertTo = lastSelectedEpic?.let { EpicOption(it) }
                        ?: (epicCombo.model as? DefaultComboBoxModel<EpicOption>)?.let { model ->
                            if (model.size > 1) model.getElementAt(0) else null
                        }
                    if (revertTo != null) {
                        epicCombo.selectedItem = revertTo
                    }

                    // Show create epic dialog
                    val dialog = CreateEpicDialog(ideaProject, service)
                    if (dialog.showAndGet()) {
                        pendingNewEpicSelection = true
                    }
                } else if (selected?.epic != null) {
                    lastSelectedEpic = selected.epic
                }
            }
        }

        panel.add(epicCombo)

        panel.add(JBLabel("Title"))
        titleField.maximumSize = Dimension(520, titleField.preferredSize.height)
        panel.add(titleField)

        panel.add(JBLabel("Description"))
        descriptionField.lineWrap = true
        descriptionField.wrapStyleWord = true
        descriptionField.minimumSize = Dimension(360, 140)
        val descriptionScroll = JScrollPane(descriptionField)
        descriptionScroll.preferredSize = Dimension(520, 140)
        panel.add(descriptionScroll)

        panel.add(JBLabel("Definition of Done (one per line)"))
        dodField.lineWrap = true
        dodField.wrapStyleWord = true
        dodField.minimumSize = Dimension(360, 120)
        val dodScroll = JScrollPane(dodField)
        dodScroll.preferredSize = Dimension(520, 120)
        panel.add(dodScroll)

        return panel
    }

    private fun refreshEpicCombo(selectEpic: Epic?) {
        val items = epics.map { EpicOption(it) } + EpicOption.createNew()
        epicCombo.model = DefaultComboBoxModel(items.toTypedArray())
        if (selectEpic != null) {
            val option = items.find { it.epic?.id == selectEpic.id }
            if (option != null) {
                epicCombo.selectedItem = option
                lastSelectedEpic = selectEpic
            }
        } else if (lastSelectedEpic != null) {
            val option = items.find { it.epic?.id == lastSelectedEpic?.id }
            if (option != null) {
                epicCombo.selectedItem = option
            }
        } else if (epics.isNotEmpty()) {
            lastSelectedEpic = epics.first()
        }
    }

    override fun createActions(): Array<Action> {
        val createAction = object : DialogWrapperAction("Create") {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val selectedOption = epicCombo.selectedItem as? EpicOption
                val selectedEpic = selectedOption?.epic
                if (selectedEpic == null) {
                    return
                }
                val taskTitle = titleField.text.trim()
                if (taskTitle.isEmpty()) {
                    return
                }
                val description = descriptionField.text.trim()
                val dod = dodField.text
                    .lineSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .toList()

                service.createTask(selectedEpic.id, taskTitle, description, dod)
                close(OK_EXIT_CODE)
            }
        }
        return arrayOf(createAction, cancelAction)
    }

    override fun dispose() {
        service.removeListener(stateListener)
        super.dispose()
    }

    private class EpicOption(val epic: Epic?, val isCreateNew: Boolean = false) {
        companion object {
            fun createNew() = EpicOption(null, isCreateNew = true)
        }

        constructor(epic: Epic) : this(epic, false)

        val displayText: String
            get() = if (isCreateNew) "Create New Epic..." else (epic?.title ?: "")
    }

    private class EpicOptionRenderer : javax.swing.ListCellRenderer<EpicOption> {
        private val label = JBLabel()

        override fun getListCellRendererComponent(
            list: javax.swing.JList<out EpicOption>?,
            value: EpicOption?,
            index: Int,
            isSelected: Boolean,
            cellHasFocus: Boolean
        ): java.awt.Component {
            label.text = value?.displayText ?: ""
            if (value?.isCreateNew == true) {
                label.font = label.font.deriveFont(java.awt.Font.ITALIC)
            } else {
                label.font = label.font.deriveFont(java.awt.Font.PLAIN)
            }
            if (isSelected) {
                label.background = list?.selectionBackground
                label.foreground = list?.selectionForeground
                label.isOpaque = true
            } else {
                label.background = list?.background
                label.foreground = list?.foreground
                label.isOpaque = false
            }
            return label
        }
    }
}
