package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.io.File
import java.time.Instant
import java.util.UUID

object MoeProjectInitializer {
    fun initializeProject(path: String, projectName: String? = null) {
        val root = File(path)
        val moeDir = File(root, ".moe")
        if (!moeDir.exists()) {
            moeDir.mkdirs()
        }

        File(moeDir, "epics").mkdirs()
        File(moeDir, "tasks").mkdirs()
        File(moeDir, "workers").mkdirs()
        File(moeDir, "proposals").mkdirs()
        File(moeDir, "roles").mkdirs()

        // Create role documentation files
        createRoleDoc(moeDir, "qa")
        createRoleDoc(moeDir, "architect")
        createRoleDoc(moeDir, "worker")

        val gitignore = File(moeDir, ".gitignore")
        if (!gitignore.exists()) {
            gitignore.writeText("# Worker state is ephemeral\nworkers/\n# Proposals should be reviewed before committing\nproposals/\n")
        }

        val now = Instant.now().toString()
        val projectJson = JsonObject().apply {
            addProperty("id", "proj-${shortId()}")
            addProperty("schemaVersion", 2)
            addProperty("name", projectName ?: root.name)
            addProperty("rootPath", root.absolutePath)

            add("globalRails", JsonObject().apply {
                add("techStack", JsonArray())
                add("forbiddenPatterns", JsonArray())
                add("requiredPatterns", JsonArray())
                addProperty("formatting", "")
                addProperty("testing", "")
                add("customRules", JsonArray())
            })

            add("settings", JsonObject().apply {
                addProperty("approvalMode", "CONTROL")
                addProperty("speedModeDelayMs", 2000)
                addProperty("autoCreateBranch", true)
                addProperty("branchPattern", "moe/{epicId}/{taskId}")
                addProperty("commitPattern", "feat({epicId}): {taskTitle}")
            })

            addProperty("createdAt", now)
            addProperty("updatedAt", now)
        }

        val gson = GsonBuilder().setPrettyPrinting().create()
        File(moeDir, "project.json").writeText(gson.toJson(projectJson))

        val activity = File(moeDir, "activity.log")
        if (!activity.exists()) {
            activity.writeText("")
        }

        MoeProjectRegistry.registerProject(root.absolutePath, projectName ?: root.name)
    }

    private fun shortId(): String {
        return UUID.randomUUID().toString().split("-")[0]
    }

    private fun createRoleDoc(moeDir: File, role: String) {
        val roleFile = File(moeDir, "roles/$role.md")
        if (roleFile.exists()) return

        val content = when (role) {
            "qa" -> """
                |# QA Role Guide
                |
                |You are a QA reviewer. Your job is to verify completed work meets the Definition of Done.
                |
                |## Workflow
                |
                |1. **Claim tasks** in `REVIEW` status using `moe.claim_next_task`
                |2. **Review** the implementation against the Definition of Done
                |3. **Approve or Reject** using the appropriate tool
                |
                |## Tools
                |
                |### Approve (QA PASS)
                |When all DoD items are satisfied:
                |```
                |moe.qa_approve { taskId, summary }
                |```
                |- Moves task to `DONE`
                |
                |### Reject (QA FAIL)
                |When DoD items are NOT satisfied:
                |```
                |moe.qa_reject { taskId, reason }
                |```
                |- Moves task back to `WORKING`
                |- Sets `reopenReason` for the worker to address
                |
                |## Review Checklist
                |
                |1. Read the task's `definitionOfDone` array
                |2. For each DoD item, verify it's implemented
                |3. If ALL items pass -> `moe.qa_approve`
                |4. If ANY item fails -> `moe.qa_reject` with specific feedback
            """.trimMargin()

            "architect" -> """
                |# Architect Role Guide
                |
                |You are an architect. Your job is to create implementation plans for tasks.
                |
                |## Workflow
                |
                |1. **Claim tasks** in `PLANNING` status using `moe.claim_next_task`
                |2. **Read context** to understand requirements and constraints
                |3. **Create plan** with clear steps and affected files
                |4. **Submit plan** for human approval using `moe.submit_plan`
                |
                |## Tools
                |
                |### Submit Plan
                |```
                |moe.submit_plan { taskId, steps: [{ description, affectedFiles }] }
                |```
                |- Moves task to `AWAITING_APPROVAL`
                |
                |### Check Approval
                |```
                |moe.check_approval { taskId }
                |```
                |- Returns `approved: true` when status is `WORKING`
                |- Returns `rejected: true` with reason if plan was rejected
                |
                |## Planning Guidelines
                |
                |1. Read all rails (global, epic, task constraints)
                |2. Make steps atomic and testable
                |3. List affected files explicitly
                |4. Plan must address all Definition of Done items
            """.trimMargin()

            "worker" -> """
                |# Worker Role Guide
                |
                |You are a worker. Your job is to execute approved implementation plans.
                |
                |## Workflow
                |
                |1. **Claim tasks** in `WORKING` status using `moe.claim_next_task`
                |2. **Execute steps** one at a time
                |3. **Mark complete** when all steps are done
                |
                |## Tools
                |
                |### Start Step
                |```
                |moe.start_step { taskId, stepId }
                |```
                |
                |### Complete Step
                |```
                |moe.complete_step { taskId, stepId, modifiedFiles? }
                |```
                |
                |### Complete Task
                |```
                |moe.complete_task { taskId, summary? }
                |```
                |- Moves task to `REVIEW` for QA
                |
                |## If Task is Reopened (QA Rejected)
                |
                |1. Task returns to `WORKING` status
                |2. Read `reopenReason` to understand QA feedback
                |3. Fix the issues identified
                |4. Call `moe.complete_task` again when fixed
            """.trimMargin()

            else -> return
        }

        roleFile.writeText(content)
    }
}
