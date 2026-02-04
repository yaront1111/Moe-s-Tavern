package com.moe.services

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.moe.model.Task
import com.moe.toolwindow.TaskDetailDialog

@Service(Service.Level.PROJECT)
class MoeNotificationService(private val project: Project) {

    companion object {
        fun getInstance(project: Project): MoeNotificationService = project.service()
        private const val GROUP_ID = "Moe Notifications"
    }

    fun notifyAwaitingApproval(task: Task) {
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
    ) : com.intellij.notification.NotificationAction("View Task") {
        override fun actionPerformed(e: com.intellij.notification.AnActionEvent, notification: com.intellij.notification.Notification) {
            val service = MoeProjectService.getInstance(project)
            TaskDetailDialog(project, task, service).show()
            notification.expire()
        }
    }
}
