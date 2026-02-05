package com.moe.toolwindow

import com.moe.services.MoeProjectService
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JScrollPane

class CreateEpicDialog(
    project: Project,
    private val service: MoeProjectService
) : DialogWrapper(project) {

    private val titleField = JBTextField()
    private val descriptionField = JBTextArea()
    private val architectureNotesField = JBTextArea()
    private val epicRailsField = JBTextArea()

    init {
        title = MoeBundle.message("moe.dialog.createEpic")
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
        descriptionField.minimumSize = Dimension(360, 100)
        val descriptionScroll = JScrollPane(descriptionField)
        descriptionScroll.preferredSize = Dimension(520, 100)
        panel.add(descriptionScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.architectureNotes")))
        architectureNotesField.lineWrap = true
        architectureNotesField.wrapStyleWord = true
        architectureNotesField.minimumSize = Dimension(360, 80)
        val notesScroll = JScrollPane(architectureNotesField)
        notesScroll.preferredSize = Dimension(520, 80)
        panel.add(notesScroll)

        panel.add(JBLabel(MoeBundle.message("moe.label.epicRails")))
        epicRailsField.lineWrap = true
        epicRailsField.wrapStyleWord = true
        epicRailsField.minimumSize = Dimension(360, 80)
        val railsScroll = JScrollPane(epicRailsField)
        railsScroll.preferredSize = Dimension(520, 80)
        panel.add(railsScroll)

        return panel
    }

    override fun createActions(): Array<Action> {
        val createAction = object : DialogWrapperAction(MoeBundle.message("moe.button.create")) {
            override fun doAction(e: java.awt.event.ActionEvent) {
                val epicTitle = titleField.text.trim()
                if (epicTitle.isEmpty()) {
                    return
                }
                val description = descriptionField.text.trim()
                val architectureNotes = architectureNotesField.text.trim()
                val epicRails = epicRailsField.text
                    .lineSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .toList()

                service.createEpic(epicTitle, description, architectureNotes, epicRails)
                close(OK_EXIT_CODE)
            }
        }
        return arrayOf(createAction, cancelAction)
    }
}
