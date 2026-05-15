package com.moe.toolwindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

class MoeToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = MoeToolWindowPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        // Ensure panel (and registered child Disposables: ProposalPanel, ActivityLogPanel,
        // ChatPanel) are disposed when the tool window content is removed, preventing
        // listener leaks on tool window close/reopen.
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}
