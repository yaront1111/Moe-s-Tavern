package com.moe.listeners

import com.moe.services.MoeProjectService
import com.moe.util.MoeProjectRegistry
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import java.io.File

class MoeProjectOpenListener : ProjectManagerListener {
    override fun projectOpened(project: Project) {
        project.service<MoeProjectService>().ensureDaemonRunning()
        val basePath = project.basePath ?: return
        val moeDir = File(basePath, ".moe")
        if (moeDir.exists()) {
            MoeProjectRegistry.registerProject(basePath, project.name)
        }
    }
}
