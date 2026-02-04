package com.moe.toolwindow

import com.moe.model.Epic
import com.moe.services.MoeProjectService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.Action
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JScrollPane
import com.intellij.ui.components.panels.VerticalLayout

class EpicDetailDialog(
    private val project: Project,
    private val epic: Epic,
    private val service: MoeProjectService
) : DialogWrapper(project) {

    private val titleField = JBTextField(epic.title)
    private val descriptionField = JBTextArea(epic.description)
    private val architectureNotesField = JBTextArea(epic.architectureNotes)
    private val epicRailsField = JBTextArea(epic.epicRails.joinToString("\n"))
    private val statusField = JComboBox(arrayOf("PLANNED", "ACTIVE", "COMPLETED"))

    init {
        title = "Epic: ${epic.title}"
        statusField.selectedItem = epic.status
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(VerticalLayout(8))
        panel.border = JBUI.Borders.empty(4)

        panel.add(JBLabel("Title"))
        titleField.maximumSize = Dimension(520, titleField.preferredSize.height)
        panel.add(titleField)

        panel.add(JBLabel("Description"))
        descriptionField.lineWrap = true
        descriptionField.wrapStyleWord = true
        val descriptionScroll = JScrollPane(descriptionField)
        descriptionScroll.preferredSize = Dimension(520, 100)
        panel.add(descriptionScroll)

        panel.add(JBLabel("Architecture Notes"))
        architectureNotesField.lineWrap = true
        architectureNotesField.wrapStyleWord = true
        val notesScroll = JScrollPane(architectureNotesField)
        notesScroll.preferredSize = Dimension(520, 80)
        panel.add(notesScroll)

        panel.add(JBLabel("Epic Rails (one per line)"))
        epicRailsField.lineWrap = true
        epicRailsField.wrapStyleWord = true
        val railsScroll = JScrollPane(epicRailsField)
        railsScroll.preferredSize = Dimension(520, 80)
        panel.add(railsScroll)

        panel.add(JBLabel("Status"))
        panel.add(statusField)

        return panel
    }

    override fun createActions(): Array<Action> {
        val actions = mutableListOf<Action>()
        actions.add(object : DialogWrapperAction("Save") {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val newTitle = titleField.text.trim().ifEmpty { epic.title }
                val newDesc = descriptionField.text.trim()
                val newArchNotes = architectureNotesField.text.trim()
                val newRails = epicRailsField.text
                    .lineSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .toList()
                val newStatus = statusField.selectedItem?.toString() ?: epic.status
                service.updateEpicDetails(epic.id, newTitle, newDesc, newArchNotes, newRails, newStatus)
                close(OK_EXIT_CODE)
            }
        })
        actions.add(object : DialogWrapperAction("Delete") {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val result = Messages.showYesNoDialog(
                    project,
                    "Delete epic \"${epic.title}\"? All tasks in this epic will also be deleted. This cannot be undone.",
                    "Delete Epic",
                    Messages.getWarningIcon()
                )
                if (result == Messages.YES) {
                    service.deleteEpic(epic.id)
                    close(OK_EXIT_CODE)
                }
            }
        })
        actions.add(cancelAction)
        return actions.toTypedArray()
    }
}
