package com.moe.toolwindow

import com.moe.model.Epic
import com.moe.model.MoeState
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import java.awt.Color
import java.awt.Dimension
import java.awt.event.ItemEvent
import java.awt.event.ItemListener
import javax.swing.BorderFactory
import javax.swing.DefaultComboBoxModel
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.Action
import javax.swing.JScrollPane
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

class CreateTaskDialog(
    private val ideaProject: Project,
    private var epics: List<Epic>,
    private val service: MoeProjectService
) : DialogWrapper(ideaProject), Disposable {

    private val epicCombo = ComboBox<EpicOption>()
    private val priorityCombo = ComboBox(arrayOf("CRITICAL", "HIGH", "MEDIUM", "LOW"))
    private val titleField = JBTextField()
    private val descriptionField = JBTextArea()
    private val dodField = JBTextArea()
    private var lastSelectedEpic: Epic? = null
    private var pendingNewEpicSelection = false
    private val stateListener: MoeStateListener
    private var epicComboListener: ItemListener? = null

    // Validation error labels
    private val epicErrorLabel = JBLabel("").apply {
        foreground = JBColor(Color(220, 53, 69), Color(255, 80, 80))
        font = JBUI.Fonts.smallFont()
    }
    private val titleErrorLabel = JBLabel("").apply {
        foreground = JBColor(Color(220, 53, 69), Color(255, 80, 80))
        font = JBUI.Fonts.smallFont()
    }

    private val normalBorder = JBUI.Borders.empty()
    private val errorBorder = BorderFactory.createLineBorder(JBColor(Color(220, 53, 69), Color(255, 80, 80)), 1)
    private var createAction: DialogWrapperAction? = null

    init {
        title = MoeBundle.message("moe.dialog.createTask")

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

        panel.add(JBLabel(MoeBundle.message("moe.label.epic")))
        refreshEpicCombo(null)
        epicCombo.renderer = EpicOptionRenderer()
        epicCombo.maximumSize = Dimension(520, epicCombo.preferredSize.height)

        epicComboListener = ItemListener { e ->
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
        epicCombo.addItemListener(epicComboListener)

        panel.add(epicCombo)
        panel.add(epicErrorLabel)

        panel.add(JBLabel(MoeBundle.message("moe.label.priority")))
        priorityCombo.selectedItem = "MEDIUM"
        priorityCombo.maximumSize = Dimension(520, priorityCombo.preferredSize.height)
        panel.add(priorityCombo)

        panel.add(JBLabel(MoeBundle.message("moe.label.title")))
        titleField.maximumSize = Dimension(520, titleField.preferredSize.height)
        titleField.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent?) { validateFields() }
            override fun removeUpdate(e: DocumentEvent?) { validateFields() }
            override fun changedUpdate(e: DocumentEvent?) { validateFields() }
        })
        panel.add(titleField)
        panel.add(titleErrorLabel)

        panel.add(JBLabel(MoeBundle.message("moe.label.description")))
        descriptionField.lineWrap = true
        descriptionField.wrapStyleWord = true
        descriptionField.minimumSize = Dimension(360, 140)
        val descriptionScroll = JScrollPane(descriptionField)
        descriptionScroll.preferredSize = Dimension(520, 140)
        panel.add(descriptionScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.definitionOfDone")))
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

    private fun validateFields(): Boolean {
        var isValid = true

        // Validate epic selection
        val selectedOption = epicCombo.selectedItem as? EpicOption
        val selectedEpic = selectedOption?.epic
        if (selectedEpic == null) {
            epicErrorLabel.text = MoeBundle.message("moe.validation.epicRequired")
            isValid = false
        } else {
            epicErrorLabel.text = ""
        }

        // Validate title
        val taskTitle = titleField.text.trim()
        if (taskTitle.isEmpty()) {
            titleErrorLabel.text = MoeBundle.message("moe.validation.titleRequired")
            titleField.border = BorderFactory.createCompoundBorder(errorBorder, JBUI.Borders.empty(2))
            isValid = false
        } else if (taskTitle.length > 500) {
            titleErrorLabel.text = MoeBundle.message("moe.validation.titleMaxLength")
            titleField.border = BorderFactory.createCompoundBorder(errorBorder, JBUI.Borders.empty(2))
            isValid = false
        } else {
            titleErrorLabel.text = ""
            titleField.border = JBUI.Borders.empty(2)
        }

        // Enable/disable create button based on validation
        createAction?.isEnabled = isValid

        return isValid
    }

    override fun createActions(): Array<Action> {
        createAction = object : DialogWrapperAction(MoeBundle.message("moe.button.create")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                if (!validateFields()) {
                    return
                }
                val selectedOption = epicCombo.selectedItem as? EpicOption
                val selectedEpic = selectedOption?.epic ?: return
                val taskTitle = titleField.text.trim()
                val description = descriptionField.text.trim()
                val dod = dodField.text
                    .lineSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .toList()

                val priority = priorityCombo.selectedItem as? String ?: "MEDIUM"
                service.createTask(selectedEpic.id, taskTitle, description, dod, priority)
                close(OK_EXIT_CODE)
            }
        }
        // Initial validation
        validateFields()
        return arrayOf(createAction!!, cancelAction)
    }

    override fun dispose() {
        // Remove all listeners to prevent memory leaks
        service.removeListener(stateListener)
        epicComboListener?.let { epicCombo.removeItemListener(it) }
        epicComboListener = null
        super.dispose()
    }

    private class EpicOption(val epic: Epic?, val isCreateNew: Boolean = false) {
        companion object {
            fun createNew() = EpicOption(null, isCreateNew = true)
        }

        constructor(epic: Epic) : this(epic, false)

        val displayText: String
            get() = if (isCreateNew) MoeBundle.message("moe.message.createNewEpic") else (epic?.title ?: "")
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
