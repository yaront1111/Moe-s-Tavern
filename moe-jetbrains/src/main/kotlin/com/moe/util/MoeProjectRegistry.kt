package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.file.Files
import java.nio.file.StandardCopyOption
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

    private const val LOCK_TIMEOUT_MS = 5000L
    private const val LOCK_RETRY_DELAY_MS = 50L

    private fun registryDir(): File {
        val home = System.getProperty("user.home")
        val dir = File(home, ".moe")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return dir
    }

    private fun registryFile(): File {
        return File(registryDir(), "projects.json")
    }

    private fun lockFile(): File {
        return File(registryDir(), "projects.json.lock")
    }

    /**
     * Acquires an exclusive cross-process file lock on projects.json.lock and runs [block].
     * Falls back to JVM-level synchronized after the timeout so we never deadlock.
     */
    private fun <T> withRegistryLock(block: () -> T): T {
        val lockTarget = lockFile()
        try {
            RandomAccessFile(lockTarget, "rw").use { raf ->
                val channel = raf.channel
                var fileLock: FileLock? = null
                val deadline = System.currentTimeMillis() + LOCK_TIMEOUT_MS
                while (fileLock == null && System.currentTimeMillis() < deadline) {
                    fileLock = try {
                        channel.tryLock()
                    } catch (ex: Exception) {
                        log.debug("tryLock threw, retrying: ${ex.message}")
                        null
                    }
                    if (fileLock == null) {
                        try {
                            Thread.sleep(LOCK_RETRY_DELAY_MS)
                        } catch (ex: InterruptedException) {
                            Thread.currentThread().interrupt()
                            throw ex
                        }
                    }
                }
                if (fileLock == null) {
                    log.warn("Failed to acquire projects.json.lock within ${LOCK_TIMEOUT_MS}ms; proceeding under JVM lock only")
                    return synchronized(MoeProjectRegistry) { block() }
                }
                try {
                    return block()
                } finally {
                    try {
                        fileLock.release()
                    } catch (ex: Exception) {
                        log.debug("Failed to release file lock: ${ex.message}")
                    }
                }
            }
        } catch (ex: InterruptedException) {
            throw ex
        } catch (ex: Exception) {
            log.warn("Failed to open lock file ${lockTarget.absolutePath}, falling back to JVM lock", ex)
            return synchronized(MoeProjectRegistry) { block() }
        }
    }

    /** Atomically write [content] to [target] via temp file + ATOMIC_MOVE. */
    private fun atomicWrite(target: File, content: String) {
        val parent = target.parentFile
        if (parent != null && !parent.exists()) {
            parent.mkdirs()
        }
        val tmp = File.createTempFile("projects-", ".json.tmp", parent)
        try {
            tmp.writeText(content)
            try {
                Files.move(
                    tmp.toPath(),
                    target.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                )
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(
                    tmp.toPath(),
                    target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING
                )
            }
        } finally {
            if (tmp.exists()) {
                try { tmp.delete() } catch (_: Exception) {}
            }
        }
    }

    private fun readProjectsRaw(): List<MoeProjectInfo> {
        val file = registryFile()
        if (!file.exists()) return emptyList()
        return try {
            val type = object : TypeToken<List<MoeProjectInfo>>() {}.type
            gson.fromJson<List<MoeProjectInfo>>(file.readText(), type) ?: emptyList()
        } catch (ex: Exception) {
            log.debug("Failed to parse projects.json: ${ex.message}")
            emptyList()
        }
    }

    /**
     * Lock-free read. Safe because writers use atomic rename, so readers either see
     * the previous committed file or the new committed file — never a partial write.
     */
    fun listProjects(): List<MoeProjectInfo> {
        return readProjectsRaw()
            .filter { File(it.path).exists() }
            .sortedByDescending { it.lastOpenedAt }
    }

    fun registerProject(path: String, name: String) {
        val normalized = normalizePath(path)
        val now = Instant.now().toString()
        withRegistryLock {
            val existing = readProjectsRaw()
                .filterNot { pathsEqual(it.path, normalized) }
                .toMutableList()
            existing.add(MoeProjectInfo(normalized, name, now))
            val sorted = existing.sortedByDescending { it.lastOpenedAt }
            atomicWrite(registryFile(), gson.toJson(sorted))
        }
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

    internal fun daemonRefCountForTest(pid: Int): Int = daemonRefCount[pid]?.get() ?: 0

    internal fun clearDaemonRefCountsForTest() {
        daemonRefCount.clear()
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

internal class MoeDaemonRegistrationTracker(
    private val register: (Int) -> Unit,
    private val unregister: (Int) -> Boolean,
    private val logError: (String, Exception) -> Unit = { _, _ -> }
) {
    @Volatile
    var currentPid: Int? = null
        private set

    @Synchronized
    fun register(pid: Int) {
        val previousPid = currentPid
        if (previousPid == pid) return

        if (previousPid != null) {
            unregisterSafely(previousPid)
            currentPid = null
        }

        try {
            register.invoke(pid)
            currentPid = pid
        } catch (ex: Exception) {
            logError("Failed to register daemon PID $pid", ex)
            currentPid = null
        }
    }

    @Synchronized
    fun unregisterCurrent(): Boolean {
        val pid = currentPid ?: return true
        currentPid = null
        return unregisterSafely(pid)
    }

    private fun unregisterSafely(pid: Int): Boolean {
        return try {
            unregister.invoke(pid)
        } catch (ex: Exception) {
            logError("Failed to unregister daemon PID $pid", ex)
            true
        }
    }
}
