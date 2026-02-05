package com.moe.listeners

import com.moe.services.MoeProjectService
import com.moe.util.MoeProjectRegistry
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import java.io.File

class MoeProjectOpenListener : ProjectManagerListener {
    override fun projectOpened(project: Project) {
        val basePath = project.basePath ?: return
        MoeProjectRegistry.registerProject(basePath, project.name)
        // Auto-connect to daemon when project opens (initializes .moe if missing)
        val service = project.service<MoeProjectService>()
        service.connect()
    }
}
