package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.PluginId
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

object MoeProjectInitializer {
    // Fallback when the bundled docs/roles directory cannot be enumerated.
    private val ROLE_NAMES = listOf("architect", "governor", "qa", "worker")

    private val GENERATED_MARKER = Regex("^<!--\\s*moe-generated:\\s*sha=([a-f0-9]{6,64})\\s*-->")

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

        // Sync role docs, agent context, and skills from bundled plugin resources
        // (sha-marker upgrade semantics — see writeGeneratedDoc).
        syncRoleDocs(moeDir)
        syncAgentContext(moeDir)
        syncSkills(moeDir)

        val gitignore = File(moeDir, ".gitignore")
        if (!gitignore.exists()) {
            gitignore.writeText("# Moe runtime files (not shared)\ndaemon.json\ndaemon.lock\nworkers/\nteams/\nproposals/\n")
        }

        // Never clobber an existing project.json — re-running init on an
        // initialized project must not reset the project id or settings
        // (matches the daemon's initProject semantics).
        val projectFile = File(moeDir, "project.json")
        if (!projectFile.exists()) {
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
            projectFile.writeText(gson.toJson(projectJson))
        }

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
     * Stamps content with the same `<!-- moe-generated: sha=<hex12> -->` marker
     * the daemon's generate-init-files.ts produces: sha-256 of the LF-normalized,
     * end-trimmed content, first 12 hex chars. Byte-identical stamping keeps the
     * plugin and the bundled daemon agreeing on what "up to date" means, so the
     * two writers never fight over the same file.
     */
    internal fun stampMarker(rawContent: String): String {
        val trimmed = rawContent.replace("\r\n", "\n").trimEnd()
        return "<!-- moe-generated: sha=${sha12(trimmed)} -->\n\n$trimmed"
    }

    private fun sha12(s: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.substring(0, 12)
    }

    /**
     * True when both contents carry a moe-generated marker and the shas differ
     * (i.e. the bundled copy is a different vendored version than what's on disk).
     */
    internal fun shouldUpgradeGeneratedDoc(onDisk: String, stamped: String): Boolean {
        val diskSha = GENERATED_MARKER.find(onDisk)?.groupValues?.get(1) ?: return false
        val bundledSha = GENERATED_MARKER.find(stamped)?.groupValues?.get(1) ?: return false
        return diskSha != bundledSha
    }

    /**
     * Writes one generated doc with the daemon's writeInitFiles semantics:
     * create if missing, overwrite if the on-disk marker sha differs, and leave
     * unmarked files alone (user customizations — deleting the marker line opts
     * a file out of auto-upgrades).
     */
    internal fun writeGeneratedDoc(target: File, stamped: String) {
        if (!target.exists()) {
            target.writeText(stamped)
            return
        }
        if (shouldUpgradeGeneratedDoc(target.readText(), stamped)) {
            target.writeText(stamped)
        }
    }

    /**
     * Syncs all bundled role docs (every .md under docs/roles, incl. governor
     * and the .reference.md companions) to .moe/roles/ with sha-marker upgrade
     * semantics. Safe to call on every project open: bundled updates always
     * reach the project, user-customized (unmarked) files are preserved.
     */
    fun syncRoleDocs(moeDir: File) {
        File(moeDir, "roles").mkdirs()
        for ((name, raw) in loadBundledRoleDocs()) {
            writeGeneratedDoc(File(moeDir, "roles/$name"), stampMarker(raw))
        }
    }

    /** All bundled role docs, falling back to the known role list when the directory can't be enumerated. */
    private fun loadBundledRoleDocs(): Map<String, String> {
        val docs = linkedMapOf<String, String>()
        val bundledDir = locateBundledDir("docs/roles")
        if (bundledDir != null) {
            for (f in bundledDir.listFiles().orEmpty()) {
                if (f.isFile && f.name.endsWith(".md")) {
                    docs[f.name] = f.readText()
                }
            }
        }
        if (docs.isEmpty()) {
            for (role in ROLE_NAMES) {
                loadBundledFile("docs/roles/$role.md")?.let { docs["$role.md"] = it }
            }
        }
        return docs
    }

    /**
     * Syncs agent-context.md from bundled plugin resources to .moe/ with the
     * same marker semantics (the daemon no longer manages this file; existing
     * customized copies are preserved).
     */
    fun syncAgentContext(moeDir: File) {
        val content = loadBundledFile("docs/agent-context.md") ?: return
        writeGeneratedDoc(File(moeDir, "agent-context.md"), stampMarker(content))
    }

    /**
     * Syncs the curated skill pack from bundled plugin resources to .moe/skills/.
     * Mirrors the daemon's writeSkillFiles() — copies SKILL.md / SOURCE.md per
     * skill directory, plus manifest.json and LICENSE-VENDORED.md.
     *
     * Skip-if-exists per file so user customizations survive.
     */
    fun syncSkills(moeDir: File) {
        val skillsDir = File(moeDir, "skills")
        if (!skillsDir.exists()) skillsDir.mkdirs()

        val bundled = locateBundledDir("docs/skills")
        if (bundled == null) {
            // The bundled daemon's writeSkillFiles() will still scaffold .moe/skills/
            // from its embedded SKILL_FILES, so this is a soft warning, not a failure.
            System.err.println("[Moe] docs/skills not bundled in plugin jar — skipping syncSkills (daemon will scaffold instead)")
            return
        }

        // Copy nested skill directories + their files (SKILL.md, SOURCE.md).
        for (entry in bundled.listFiles().orEmpty()) {
            if (entry.isDirectory) {
                val targetDir = File(skillsDir, entry.name)
                if (!targetDir.exists()) targetDir.mkdirs()
                for (file in entry.listFiles().orEmpty()) {
                    if (file.isFile) {
                        val target = File(targetDir, file.name)
                        if (!target.exists()) target.writeText(file.readText())
                    }
                }
            } else if (entry.isFile && (entry.name == "manifest.json" || entry.name == "LICENSE-VENDORED.md")) {
                val target = File(skillsDir, entry.name)
                if (!target.exists()) target.writeText(entry.readText())
            }
        }
    }

    /**
     * Locate a bundled directory inside the plugin distribution.
     * Mirrors loadBundledFile()'s lookup chain (pluginPath, then code-source jar).
     */
    private fun locateBundledDir(relativePath: String): File? {
        try {
            val plugin = PluginManagerCore.getPlugin(PluginId.getId("com.moe.jetbrains"))
            val pluginRoot = plugin?.pluginPath?.toFile()
            if (pluginRoot != null) {
                val bundled = File(pluginRoot, relativePath)
                if (bundled.exists() && bundled.isDirectory) return bundled
            }
            val codeSource = MoeProjectInitializer::class.java.protectionDomain?.codeSource?.location?.toURI()
            val jarFile = codeSource?.let { File(it) }
            val inferredRoot = jarFile?.parentFile?.parentFile
            if (inferredRoot != null) {
                val fromJar = File(inferredRoot, relativePath)
                if (fromJar.exists() && fromJar.isDirectory) return fromJar
            }
        } catch (_: Exception) {
            // Fall through
        }
        return null
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
}
