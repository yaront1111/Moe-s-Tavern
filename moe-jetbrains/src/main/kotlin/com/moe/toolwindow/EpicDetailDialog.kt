package com.moe.toolwindow

import com.moe.model.Epic
import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
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
    private val statusField = JComboBox(arrayOf("PLANNED", "ACTIVE", "COMPLETED", "ARCHIVED"))

    init {
        title = MoeBundle.message("moe.dialog.epicDetail", epic.title)
        statusField.selectedItem = epic.status
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(VerticalLayout(8))
        panel.border = JBUI.Borders.empty(4)

        panel.add(JBLabel(MoeBundle.message("moe.label.title")))
        titleField.maximumSize = Dimension(520, titleField.preferredSize.height)
        panel.add(titleField)

        panel.add(JBLabel(MoeBundle.message("moe.label.description")))
        descriptionField.lineWrap = true
        descriptionField.wrapStyleWord = true
        val descriptionScroll = JScrollPane(descriptionField)
        descriptionScroll.preferredSize = Dimension(520, 100)
        panel.add(descriptionScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.architectureNotes")))
        architectureNotesField.lineWrap = true
        architectureNotesField.wrapStyleWord = true
        val notesScroll = JScrollPane(architectureNotesField)
        notesScroll.preferredSize = Dimension(520, 80)
        panel.add(notesScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.epicRails")))
        epicRailsField.lineWrap = true
        epicRailsField.wrapStyleWord = true
        val railsScroll = JScrollPane(epicRailsField)
        railsScroll.preferredSize = Dimension(520, 80)
        panel.add(railsScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.status")))
        panel.add(statusField)

        return panel
    }

    override fun createActions(): Array<Action> {
        val actions = mutableListOf<Action>()
        actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.save")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val edits = EpicEdits(
                    title = titleField.text.trim().ifEmpty { epic.title },
                    description = descriptionField.text.trim(),
                    architectureNotes = architectureNotesField.text.trim(),
                    epicRails = epicRailsField.text
                        .lineSequence()
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                        .toList()
                )
                val chosenStatus = statusField.selectedItem?.toString() ?: epic.status
                // Decide from the newest cached board: epic is the snapshot this dialog opened with.
                val state = service.getState()
                val current = state?.epics?.firstOrNull { it.id == epic.id } ?: epic
                val plan = EpicArchive.plan(current, state?.tasks.orEmpty(), edits, chosenStatus)
                val sent = EpicArchive.save(
                    plan,
                    warnInFlight = { titles ->
                        Messages.showWarningDialog(
                            project,
                            MoeBundle.message(EpicArchive.IN_FLIGHT_MESSAGE_KEY, epic.title, titles.joinToString("\n") { "- $it" }),
                            MoeBundle.message(EpicArchive.TITLE_KEY)
                        )
                    },
                    confirmArchive = { count ->
                        val archiveTitle = MoeBundle.message(EpicArchive.TITLE_KEY)
                        Messages.showOkCancelDialog(
                            project,
                            MoeBundle.message(EpicArchive.CONFIRM_MESSAGE_KEY, epic.title, count),
                            archiveTitle,
                            archiveTitle,
                            MoeBundle.message("moe.button.cancel"),
                            Messages.getWarningIcon()
                        ) == Messages.OK
                    },
                    send = { frame ->
                        when (frame) {
                            is EpicSaveFrame.Details -> service.updateEpicDetails(
                                epic.id, frame.edits.title, frame.edits.description,
                                frame.edits.architectureNotes, frame.edits.epicRails, frame.status
                            )
                            is EpicSaveFrame.Status -> service.updateEpicStatus(epic.id, frame.status, frame.order)
                        }
                    }
                )
                // Not sent (tasks in flight, or Cancel): the dialog stays open with the typed edits.
                if (sent) close(OK_EXIT_CODE)
            }
        })
        actions.add(object : DialogWrapperAction(MoeBundle.message("moe.button.delete")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val result = Messages.showYesNoDialog(
                    project,
                    MoeBundle.message("moe.message.deleteEpic", epic.title),
                    MoeBundle.message("moe.message.deleteEpicTitle"),
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
