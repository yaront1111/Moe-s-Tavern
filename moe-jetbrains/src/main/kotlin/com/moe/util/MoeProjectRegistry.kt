package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

data class MoeProjectInfo(
    val path: String,
    val name: String,
    val lastOpenedAt: String
)

object MoeProjectRegistry {
    private val log = Logger.getInstance(MoeProjectRegistry::class.java)
    private val gson = GsonBuilder().setPrettyPrinting().create()

    private fun registryFile(): File {
        val home = System.getProperty("user.home")
        val dir = File(home, ".moe")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return File(dir, "projects.json")
    }

    fun listProjects(): List<MoeProjectInfo> {
        val file = registryFile()
        if (!file.exists()) return emptyList()
        return try {
            val type = object : TypeToken<List<MoeProjectInfo>>() {}.type
            val list = gson.fromJson<List<MoeProjectInfo>>(file.readText(), type) ?: emptyList()
            list
                .filter { File(it.path).exists() }
                .sortedByDescending { it.lastOpenedAt }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun registerProject(path: String, name: String) {
        val normalized = normalizePath(path)
        val now = Instant.now().toString()
        val existing = listProjects().filterNot { pathsEqual(it.path, normalized) }.toMutableList()
        existing.add(MoeProjectInfo(normalized, name, now))
        val file = registryFile()
        file.writeText(gson.toJson(existing.sortedByDescending { it.lastOpenedAt }))
    }

    private fun normalizePath(path: String): String {
        return File(path).absolutePath
    }

    private fun pathsEqual(a: String, b: String): Boolean {
        val normalizedA = normalizePath(a)
        val normalizedB = normalizePath(b)
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        return if (isWindows) {
            normalizedA.equals(normalizedB, ignoreCase = true)
        } else {
            normalizedA == normalizedB
        }
    }

    // ---- Daemon reference counting ----
    private val daemonRefCount = ConcurrentHashMap<Int, AtomicInteger>()

    /** Register a daemon PID as being used by a project. Increments refcount. */
    fun registerDaemon(pid: Int) {
        daemonRefCount.computeIfAbsent(pid) { AtomicInteger(0) }.incrementAndGet()
        log.debug("Daemon PID $pid registered (refcount=${daemonRefCount[pid]?.get()})")
    }

    /** Unregister a daemon PID. Returns true if this was the last user (refcount hit 0). */
    fun unregisterDaemon(pid: Int): Boolean {
        val counter = daemonRefCount[pid] ?: return true // Unknown PID — safe to kill
        val remaining = counter.decrementAndGet()
        log.debug("Daemon PID $pid unregistered (refcount=$remaining)")
        if (remaining <= 0) {
            daemonRefCount.remove(pid)
            return true
        }
        return false
    }

    /**
     * Reads ~/.moe/config.json and returns the installPath if it exists and
     * the canary file (packages/moe-daemon/dist/index.js) is present.
     */
    fun readGlobalInstallPath(): String? {
        return try {
            val home = System.getProperty("user.home")
            val configFile = File(home, ".moe${File.separator}config.json")
            if (!configFile.exists()) return null
            val json = gson.fromJson(configFile.readText(), JsonObject::class.java)
            val el = json?.get("installPath")
            val installPath = if (el == null || el.isJsonNull) return null else el.asString
            val canary = File(installPath, "packages${File.separator}moe-daemon${File.separator}dist${File.separator}index.js")
            if (!canary.exists()) {
                log.debug("Global config installPath canary missing: ${canary.absolutePath}")
                return null
            }
            log.debug("Resolved global installPath: $installPath")
            installPath
        } catch (ex: Exception) {
            log.debug("Failed to read global config: ${ex.message}")
            null
        }
    }
}
