package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import java.io.File
import java.time.Instant
import java.util.UUID

object MoeProjectInitializer {
    private val ROLE_NAMES = listOf("qa", "architect", "worker")

    fun initializeProject(path: String, projectName: String? = null) {
        val root = File(path)
        val moeDir = File(root, ".moe")
        if (!moeDir.exists()) {
            moeDir.mkdirs()
        }

        File(moeDir, "epics").mkdirs()
        File(moeDir, "tasks").mkdirs()
        File(moeDir, "workers").mkdirs()
        File(moeDir, "teams").mkdirs()
        File(moeDir, "proposals").mkdirs()
        File(moeDir, "roles").mkdirs()

        // Always sync role docs and agent context from bundled plugin resources
        syncRoleDocs(moeDir)
        syncAgentContext(moeDir)

        val gitignore = File(moeDir, ".gitignore")
        if (!gitignore.exists()) {
            gitignore.writeText("# Moe runtime files (not shared)\ndaemon.json\ndaemon.lock\nworkers/\nteams/\nproposals/\n")
        }

        val now = Instant.now().toString()
        val projectJson = JsonObject().apply {
            addProperty("id", "proj-${shortId()}")
            addProperty("schemaVersion", 3)
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
                addProperty("agentCommand", "claude")
                addProperty("enableAgentTeams", false)
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

    /**
     * Syncs role docs from bundled plugin resources to .moe/roles/.
     * Always overwrites to ensure agents get the latest production-ready docs.
     * Can be called independently of initializeProject (e.g., on every project open).
     */
    fun syncRoleDocs(moeDir: File) {
        File(moeDir, "roles").mkdirs()
        for (role in ROLE_NAMES) {
            val roleFile = File(moeDir, "roles/$role.md")
            val content = loadBundledRoleDoc(role)
            if (content != null) {
                roleFile.writeText(content)
            } else if (!roleFile.exists()) {
                // Fallback: only write minimal content if bundled doc not found AND file doesn't exist
                roleFile.writeText("# ${role.replaceFirstChar { it.uppercase() }} Role Guide\n\nRole documentation not found. Rebuild the plugin to bundle role docs.\n")
            }
        }
    }

    /**
     * Syncs agent-context.md from bundled plugin resources to .moe/.
     * Always overwrites to ensure agents get the latest shared context.
     */
    fun syncAgentContext(moeDir: File) {
        val content = loadBundledFile("docs/agent-context.md")
        if (content != null) {
            File(moeDir, "agent-context.md").writeText(content)
        }
    }

    /**
     * Loads a file from the bundled plugin directory.
     * Returns null if the bundled file cannot be found.
     */
    private fun loadBundledFile(relativePath: String): String? {
        try {
            val plugin = PluginManagerCore.getPlugin(PluginId.getId("com.moe.jetbrains"))
            val pluginRoot = plugin?.pluginPath?.toFile()
            if (pluginRoot != null) {
                val bundled = File(pluginRoot, relativePath)
                if (bundled.exists()) {
                    return bundled.readText()
                }
            }

            val codeSource = MoeProjectInitializer::class.java.protectionDomain?.codeSource?.location?.toURI()
            val jarFile = codeSource?.let { File(it) }
            val inferredRoot = jarFile?.parentFile?.parentFile
            if (inferredRoot != null) {
                val fromJar = File(inferredRoot, relativePath)
                if (fromJar.exists()) {
                    return fromJar.readText()
                }
            }
        } catch (_: Exception) {
            // Fall through to return null
        }
        return null
    }

    /**
     * Loads a role doc from the bundled plugin directory (docs/roles/<role>.md).
     * Returns null if the bundled file cannot be found.
     */
    private fun loadBundledRoleDoc(role: String): String? {
        return loadBundledFile("docs/roles/$role.md")
    }
}
