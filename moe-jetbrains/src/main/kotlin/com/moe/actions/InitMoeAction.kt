package com.moe.actions

import com.moe.util.MoeProjectInitializer
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.ide.impl.ProjectUtil
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.ui.Messages

class InitMoeAction : AnAction("Initialize Moe") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
        descriptor.title = "Select Project Folder"
        val selected = FileChooser.chooseFile(descriptor, project, null) ?: return

        MoeProjectInitializer.initializeProject(selected.path)

        Messages.showInfoMessage(
            project,
            "Initialized .moe in ${selected.path}",
            "Moe"
        )

        val basePath = project?.basePath
        if (basePath == null || basePath != selected.path) {
            val open = Messages.showYesNoDialog(
                project,
                "Open ${selected.path} as a project?",
                "Moe",
                Messages.getQuestionIcon()
            )
            if (open == Messages.YES) {
                ProjectUtil.openOrImport(selected.path, project, true)
            }
        }
    }
}
