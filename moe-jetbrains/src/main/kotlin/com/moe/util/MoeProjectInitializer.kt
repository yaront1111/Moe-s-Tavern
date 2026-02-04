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
}
