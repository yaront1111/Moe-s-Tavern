package com.moe.statusbar

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory

class MoeStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = MoeStatusBarWidget.ID

    override fun getDisplayName(): String = "Moe Status"

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget {
        return MoeStatusBarWidget(project)
    }

    override fun disposeWidget(widget: StatusBarWidget) {
        // Widget disposal is handled by the widget itself
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}
