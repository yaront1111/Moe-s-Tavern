package com.moe.services

import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.moe.model.Task
import com.moe.toolwindow.TaskDetailDialog

@Service(Service.Level.PROJECT)
class MoeNotificationService(private val project: Project) {

    companion object {
        private val log = Logger.getInstance(MoeNotificationService::class.java)
        fun getInstance(project: Project): MoeNotificationService = project.service()
        private const val GROUP_ID = "Moe Notifications"
    }

    private fun assertEdt() {
        if (!ApplicationManager.getApplication().isDispatchThread) {
            log.error("MoeNotificationService called from non-EDT thread: ${Thread.currentThread().name}")
        }
    }

    fun notifyAwaitingApproval(task: Task) {
        assertEdt()
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(
                "Plan Awaiting Approval",
                "Task \"${task.title}\" has a plan ready for review",
                NotificationType.INFORMATION
            )
            .addAction(ViewTaskAction(project, task))

        notification.notify(project)
    }

    fun notifyTaskBlocked(task: Task) {
        assertEdt()
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(
                "Task Blocked",
                "Task \"${task.title}\" is blocked and needs attention",
                NotificationType.WARNING
            )
            .addAction(ViewTaskAction(project, task))

        notification.notify(project)
    }

    fun notifyTaskInReview(task: Task) {
        assertEdt()
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(
                "Task Ready for Review",
                "Task \"${task.title}\" is ready for code review",
                NotificationType.INFORMATION
            )
            .addAction(ViewTaskAction(project, task))

        notification.notify(project)
    }

    fun notifyTaskCompleted(task: Task) {
        assertEdt()
        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(
                "Task Completed",
                "Task \"${task.title}\" has been marked as done",
                NotificationType.INFORMATION
            )

        notification.notify(project)
    }

    fun notifyConnectionLost() {
        assertEdt()
        NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(
                "Moe Disconnected",
                "Lost connection to Moe daemon. Reconnecting...",
                NotificationType.WARNING
            )
            .notify(project)
    }

    fun notifyConnectionRestored() {
        assertEdt()
        NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP_ID)
            .createNotification(
                "Moe Connected",
                "Connection to Moe daemon restored",
                NotificationType.INFORMATION
            )
            .notify(project)
    }

    private class ViewTaskAction(
        private val project: Project,
        private val task: Task
    ) : NotificationAction("View Task") {
        override fun actionPerformed(e: AnActionEvent, notification: Notification) {
            val service = MoeProjectService.getInstance(project)
            TaskDetailDialog(project, task, service).show()
            notification.expire()
        }
    }
}
