package com.moe.listeners

import com.moe.services.MoeProjectService
import com.moe.util.MoeProjectRegistry
import com.intellij.ide.lightEdit.LightEdit
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import java.io.File

class MoeProjectOpenListener : ProjectManagerListener {
    override fun projectOpened(project: Project) {
        // The IDE's LightEdit pseudo-project (basePath = <IDE config>/light-edit) is not a
        // Moe project: no registry entry, no .moe/ scaffold and no daemon for it.
        if (LightEdit.owns(project)) return
        val basePath = project.basePath ?: return
        MoeProjectRegistry.registerProject(basePath, project.name)
        // Auto-connect to daemon when project opens (initializes .moe if missing)
        val service = project.service<MoeProjectService>()
        service.connect()
    }
}
