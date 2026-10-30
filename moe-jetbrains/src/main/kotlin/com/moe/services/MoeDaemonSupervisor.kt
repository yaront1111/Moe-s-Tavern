package com.moe.services

import com.google.gson.Gson
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.moe.model.DaemonInfo
import com.moe.util.MoeProjectInitializer
import com.moe.util.MoeProjectRegistry
import com.moe.util.RuntimeProfile
import com.moe.util.RuntimeSelection
import com.moe.util.RuntimeSelectionPolicy
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.TimeUnit

/**
 * Owns daemon discovery, spawn backoff, and the lifecycle of the process started by the plugin.
 * MoeDaemonRegistrationTracker deliberately stays on MoeProjectService: it tracks the connected
 * daemon PID shared by projects, rather than ownership of this supervisor's spawned process.
 */
class MoeDaemonSupervisor(
    private val basePath: String,
    private val projectName: String,
    private val onStatus: (Boolean, String) -> Unit = { _, _ -> },
    private val portProbe: (Int, Int) -> Boolean = ::defaultPortProbe,
    private val processAliveProbe: (Int) -> Boolean = ::defaultProcessAliveProbe,
    private val processStarter: (ProcessBuilder) -> Process = { it.start() },
    private val wslAgentsEnabled: () -> Boolean = { false },
    private val profile: () -> RuntimeProfile = { RuntimeSelectionPolicy.profile(basePath) },
    private val installedRoot: () -> File? = { RuntimeSelectionPolicy.installedRoot() },
    private val nodeExecutable: (() -> String?)? = null,
    private val processLookup: (Long) -> ProcessHandle? = { ProcessHandle.of(it).orElse(null) }
) {
    private val log = Logger.getInstance(MoeDaemonSupervisor::class.java)
    private val gson = Gson()
    @Volatile private var spawnedDaemonProcess: Process? = null
    @Volatile private var daemonSpawnAttempts = 0
    private val maxDaemonSpawnAttempts = 3
    @Volatile private var lastDaemonStartAttemptAt = 0L
    private val daemonStartCooldownMs = 10_000L
    @Volatile private var selectionRefusal: String? = null

    fun readDaemonInfo(): DaemonInfo? {
        val base = basePath.ifBlank { return null }
        val file = File(base, ".moe/daemon.json")
        if (!file.exists()) return null
        return try {
            val bytes = file.inputStream().use { it.readNBytes(MAX_DAEMON_JSON_BYTES + 1) }
            if (bytes.size > MAX_DAEMON_JSON_BYTES) {
                log.warn("Ignoring .moe/daemon.json: larger than ${MAX_DAEMON_JSON_BYTES / 1024} KiB")
                return null
            }
            val info = gson.fromJson(String(bytes, Charsets.UTF_8), DaemonInfo::class.java)
            if (info.projectPath.isNotEmpty()) {
                val daemonPath = File(info.projectPath).canonicalPath
                val expectedPath = File(base).canonicalPath
                if (daemonPath != expectedPath) {
                    log.warn("Stale daemon.json: expected project $expectedPath, found $daemonPath")
                    file.delete()
                    return null
                }
            }
            info
        } catch (ex: Exception) {
            log.debug("Failed to read daemon.json: ${ex.message}")
            null
        }
    }

    fun ensureDaemonRunning(): Boolean {
        if (!ensureMoeInitialized()) {
            return false
        }

        val info = readDaemonInfo()
        if (info != null && isProcessAlive(info.pid) && isPortOpen(info.port)) {
            return false
        }

        // Clean up stale daemon.json so connectWithRetry reads fresh data from the new daemon
        if (info != null) {
            try {
                File(basePath, ".moe/daemon.json").delete()
                log.info("Removed stale daemon.json (PID ${info.pid} not running)")
            } catch (ex: Exception) {
                log.debug("Failed to remove stale daemon.json: ${ex.message}")
            }
        }

        if (daemonSpawnAttempts >= maxDaemonSpawnAttempts) {
            log.info("Max daemon spawn attempts ($maxDaemonSpawnAttempts) reached, not retrying")
            return false
        }

        val now = System.currentTimeMillis()
        if (now - lastDaemonStartAttemptAt < daemonStartCooldownMs) {
            return false
        }
        lastDaemonStartAttemptAt = now
        daemonSpawnAttempts++

        val projectBasePath = basePath.ifBlank { return false }
        val isProtected = profile() == RuntimeProfile.PROTECTED
        val direct = if (isProtected) protectedCommandOrRefuse(projectBasePath) ?: return false else buildDirectDaemonCommand(projectBasePath)

        try {
            val pb = if (direct != null) {
                ProcessBuilder(direct)
            } else {
                val command = buildDaemonCommand(projectBasePath)
                if (isWindows()) {
                    ProcessBuilder("cmd", "/c", command)
                } else {
                    ProcessBuilder("bash", "-lc", command)
                }
            }
            pb.redirectErrorStream(true)
            // direct[1] is the installed daemon: an IDE started inside a repository must not lend it that working directory.
            if (isProtected && direct != null) pb.directory(File(direct[1]).parentFile)
            val env = pb.environment()
            applyDaemonPath(env, direct?.firstOrNull())
            if (isProtected) protectedDaemonEnvironment(env, projectBasePath)
            val process = processStarter(pb)
            if (isProtected) recordProtectedSpawn(projectBasePath, process)
            val oldProcess = spawnedDaemonProcess
            if (oldProcess != null) {
                try {
                    if (oldProcess.isAlive) {
                        oldProcess.destroyForcibly()
                        log.info("Destroyed previous daemon process before spawning new one")
                    }
                } catch (ex: Exception) {
                    log.debug("Failed to destroy previous daemon process before respawn: ${ex.message}", ex)
                } finally {
                    spawnedDaemonProcess = null
                }
            }
            spawnedDaemonProcess = process
            // Drain stdout/stderr to prevent Windows pipe deadlock (buffer is ~4KB)
            // Log the first few lines for diagnostics if daemon fails to start
            Thread({
                try {
                    var lineCount = 0
                    process.inputStream.bufferedReader().forEachLine { line ->
                        if (lineCount < 20) {
                            log.info("Daemon output: $line")
                        }
                        lineCount++
                    }
                } catch (_: Exception) { }
            }, "Moe-DaemonDrain").apply { isDaemon = true }.start()
            log.info("Started Moe daemon for $projectBasePath using ${direct?.joinToString(" ") ?: "shell command"} (pid tracking enabled)")
            return true
        } catch (ex: Exception) {
            log.warn("Failed to start Moe daemon", ex)
            onStatus(false, ex.message ?: "Failed to start daemon")
            return false
        }
    }

    /** Why the protected profile refused to start a daemon; null under LEGACY or once a selection succeeds. */
    fun selectionRefusal(): String? = selectionRefusal?.takeIf { profile() == RuntimeProfile.PROTECTED }

    /** Under PROTECTED, why the daemon [info] names must not be activated; null when it may be. */
    fun activationRefusal(info: DaemonInfo): String? =
        if (profile() == RuntimeProfile.PROTECTED) RuntimeSelectionPolicy.verifyProvenance(basePath, info.pid.toLong()) else null

    /**
     * Stops the daemon [info] names so Restart Daemon can start a fresh one: null when the restart may go
     * on, else the refusal to show. daemon.json is repository content, so its pid is no authority to signal
     * a process: under PROTECTED only a process activation would accept is stopped, and any failure refuses.
     * LEGACY keeps the historical best-effort signal.
     */
    fun stopDaemonForRestart(info: DaemonInfo): String? {
        // An absent pid reads as 0, and kill(2) takes 0 and -1 as process groups: neither names a daemon.
        if (info.pid <= 0 || !isProcessAlive(info.pid)) return null
        val isProtected = profile() == RuntimeProfile.PROTECTED
        return try {
            // Captured once and destroyed as captured, never re-resolved from the pid: the JDK checks the
            // handle's start time before signaling, which guards against a process reusing the pid.
            val target = processLookup(info.pid.toLong()) ?: return null
            if (!isProtected) {
                target.destroy()
                return null
            }
            when {
                activationRefusal(info) != null -> restartRefusal(info.pid, "this IDE did not start it from the installed Moe runtime")
                target.destroy() -> null
                else -> restartRefusal(info.pid, "the stop request failed")
            }
        } catch (ex: Exception) {
            log.warn("Restart Daemon could not stop pid ${info.pid}: ${ex.message}")
            if (isProtected) restartRefusal(info.pid, "the stop request failed") else null
        }
    }

    // The pid comes from the repository, so the refusal never calls that process a Moe daemon.
    private fun restartRefusal(pid: Int, reason: String) =
        "Protected execution profile: Restart Daemon did not stop pid $pid, which .moe/daemon.json names: $reason. " +
            "Check what that process is and stop it yourself if it is a Moe daemon, then use Restart Daemon."

    internal sealed interface ProtectedDaemonCommand {
        data class Ready(val command: List<String>) : ProtectedDaemonCommand
        data class Refused(val reason: String) : ProtectedDaemonCommand
    }

    /** The installed node and daemon; project, parent, PATH, env and global-config copies are never consulted. */
    internal fun protectedDaemonCommand(basePath: String, root: File?, node: String?): ProtectedDaemonCommand {
        val daemon = when (val selection = RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", basePath)) {
            is RuntimeSelection.Accepted -> selection.file
            is RuntimeSelection.Rejected -> return ProtectedDaemonCommand.Refused(selection.reason)
        }
        val nodeFile = when (val selection = RuntimeSelectionPolicy.installedExecutable(node, basePath)) {
            is RuntimeSelection.Accepted -> selection.file
            is RuntimeSelection.Rejected -> return ProtectedDaemonCommand.Refused(selection.reason)
        }
        val command = mutableListOf(nodeFile.path, daemon.path, "start", "--project", basePath)
        if (wslAgentsEnabled()) command += listOf("--host", "0.0.0.0")
        return ProtectedDaemonCommand.Ready(command)
    }

    // A refusal starts nothing: it is logged, published and kept for connect() to show.
    private fun protectedCommandOrRefuse(basePath: String): List<String>? {
        val node = if (nodeExecutable != null) {
            nodeExecutable.invoke()
        } else {
            resolveNodeExecutable(nodeOnPath = { nodeOnProtectedPath(System.getenv("PATH").orEmpty(), basePath) })
        }
        return when (val selection = protectedDaemonCommand(basePath, installedRoot(), node)) {
            is ProtectedDaemonCommand.Ready -> selection.command.also { selectionRefusal = null }
            is ProtectedDaemonCommand.Refused -> {
                val message = "Protected execution profile: ${selection.reason}. Project and PATH copies of the Moe daemon are not used."
                selectionRefusal = message
                log.warn(message)
                onStatus(false, message)
                null
            }
        }
    }

    /** Drops what could load repository code into the installed daemon: NODE_OPTIONS, NODE_PATH and unsafe PATH entries. */
    internal fun protectedDaemonEnvironment(env: MutableMap<String, String>, basePath: String) {
        env.remove("NODE_OPTIONS")
        env.remove("NODE_PATH")
        // After applyDaemonPath a Windows map may hold the variable as "Path"; filter whichever one it kept.
        val pathName = if (isWindows()) env.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH" else "PATH"
        env[pathName]?.let { env[pathName] = protectedPathEntries(it, basePath).joinToString(File.pathSeparator) }
    }

    // In-process: running `where`/`which` by bare name could start a copy in the IDE's working directory.
    internal fun nodeOnProtectedPath(path: String, basePath: String, windows: Boolean = isWindows()): String? =
        protectedPathEntries(path, basePath).asSequence()
            .map { File(unquoted(it), if (windows) "node.exe" else "node") }
            .firstOrNull { it.isFile }?.absolutePath

    // Blank, relative and project entries go, so the daemon's own lookups cannot reach repository executables.
    private fun protectedPathEntries(path: String, basePath: String): List<String> =
        path.split(File.pathSeparator).filter { RuntimeSelectionPolicy.isOutsideProject(unquoted(it), basePath) }

    private fun unquoted(entry: String): String = entry.trim().removeSurrounding("\"")

    private fun recordProtectedSpawn(basePath: String, process: Process) {
        try {
            RuntimeSelectionPolicy.recordProtectedSpawn(basePath, process.toHandle())
        } catch (ex: Exception) {
            // Test fakes have no handle; the daemon then fails provenance and is never activated.
            log.debug("Cannot record the protected Moe daemon process: ${ex.message}")
        }
    }

    fun ensureMoeInitialized(): Boolean {
        val projectBasePath = basePath.ifBlank { return false }
        val moeDir = File(projectBasePath, ".moe")
        if (!moeDir.exists()) {
            return try {
                MoeProjectInitializer.initializeProject(projectBasePath, projectName)
                log.info("Initialized .moe folder for project at $projectBasePath")
                true
            } catch (ex: Exception) {
                log.warn("Failed to initialize .moe folder: ${ex.message}")
                false
            }
        }
        // Always sync role docs and skills to ensure agents get latest production-ready versions
        try {
            MoeProjectInitializer.syncRoleDocs(moeDir)
        } catch (ex: Exception) {
            log.debug("Failed to sync role docs: ${ex.message}")
        }
        try {
            MoeProjectInitializer.syncSkills(moeDir)
        } catch (ex: Exception) {
            log.debug("Failed to sync skills: ${ex.message}")
        }
        return true
    }

    private fun buildDaemonCommand(basePath: String): String {
        val raw = System.getenv("MOE_DAEMON_COMMAND")?.trim()
        if (!raw.isNullOrBlank()) {
            val normalized = raw.trim().trim('"')
            if (raw.contains("{projectPath}")) {
                return raw.replace("{projectPath}", basePath)
            }
            val hasProject = raw.contains("--project")
            if (!hasProject) {
                val needsStart = normalized.endsWith(".cmd", true) ||
                    normalized.endsWith(".ps1", true) ||
                    normalized.endsWith(".js", true) ||
                    normalized.equals("moe-daemon", true)
                val withStart = if (needsStart && !raw.contains(" start")) "$raw start" else raw
                return "$withStart --project \"$basePath\""
            }
            return raw
        }

        val installed = resolveInstalledDaemonCommand(basePath)
        val hostSuffix = if (wslAgentsEnabled()) " --host 0.0.0.0" else ""
        if (installed != null) {
            return installed + hostSuffix
        }

        return "moe-daemon start --project \"$basePath\"$hostSuffix"
    }

    private fun buildDirectDaemonCommand(basePath: String): List<String>? {
        val script = resolveLocalDaemonScript(basePath) ?: return null
        val node = resolveNodeExecutable() ?: "node"
        val command = mutableListOf(node, script.absolutePath, "start", "--project", basePath)
        // WSL agent mode: agents inside WSL can't reach a loopback-only listener,
        // so bind all interfaces (moe-agent.sh probes for the reachable address).
        if (wslAgentsEnabled()) {
            command += listOf("--host", "0.0.0.0")
        }
        return command
    }

    private fun resolveLocalDaemonScript(basePath: String): File? {
        val startDir = File(basePath)
        return findInParents(startDir, "packages/moe-daemon/dist/index.js")
            ?: findInParents(startDir, "moe-daemon/dist/index.js")
            ?: resolveBundledDaemonScript()
            ?: resolveGlobalConfigDaemonScript()
    }

    private fun resolveGlobalConfigDaemonScript(): File? {
        val installPath = MoeProjectRegistry.readGlobalInstallPath() ?: return null
        val candidate = File(installPath, "packages${File.separator}moe-daemon${File.separator}dist${File.separator}index.js")
        return if (candidate.exists()) {
            log.debug("Using daemon from global config: ${candidate.absolutePath}")
            candidate
        } else null
    }

    private fun resolveBundledDaemonScript(): File? {
        return try {
            val plugin = PluginManagerCore.getPlugin(PluginId.getId("com.moe.jetbrains"))
            val pluginRoot = plugin?.pluginPath?.toFile()
            val fromPlugin = pluginRoot?.let { File(it, "daemon/index.js") }
            if (fromPlugin != null && fromPlugin.exists()) {
                log.debug("Using bundled daemon from plugin path: ${fromPlugin.absolutePath}")
                return fromPlugin
            }

            val codeSource = MoeProjectService::class.java.protectionDomain?.codeSource?.location?.toURI()
            val jarFile = codeSource?.let { File(it) }
            val inferredRoot = jarFile?.parentFile?.parentFile
            val fromJar = inferredRoot?.let { File(it, "daemon/index.js") }
            if (fromJar != null && fromJar.exists()) {
                log.debug("Using bundled daemon from jar path: ${fromJar.absolutePath}")
                return fromJar
            }

            null
        } catch (ex: Exception) {
            log.debug("Failed to resolve bundled daemon script: ${ex.message}")
            null
        }
    }

    internal fun findInParents(start: File, relative: String, maxDepth: Int = 5): File? {
        var dir: File? = start
        var depth = 0
        while (dir != null && depth <= maxDepth) {
            val candidate = File(dir, relative)
            if (candidate.exists()) {
                return candidate
            }
            dir = dir.parentFile
            depth += 1
        }
        return null
    }

    internal fun daemonPath(
        current: String,
        nodeCommand: String?,
        home: String? = System.getProperty("user.home"),
        windows: Boolean = isWindows()
    ): String {
        val nodeDir = nodeCommand?.let { File(it).parentFile }
        val bootstrapDirs = if (!windows && home != null) listOf(
            File(home, ".local/share/moe/node/current/bin"),
            File(home, ".local/share/moe/npm/bin")
        ).filter { it.isDirectory }.map { it.absolutePath } else emptyList()
        return (listOfNotNull(nodeDir?.absolutePath) + current.split(File.pathSeparator) + bootstrapDirs)
            .filter { it.isNotBlank() }.distinct().joinToString(File.pathSeparator)
    }

    // Windows names the variable "Path", and ProcessBuilder.environment() keys
    // stay case-sensitive there. Writing "PATH" beside "Path" gave the daemon a
    // second PATH holding only Node's directory; Node keeps the lexicographically
    // first spelling, so every git the daemon ran failed with "spawn git ENOENT".
    // Keep one spelling, the one Node would read.
    internal fun applyDaemonPath(env: MutableMap<String, String>, nodeCommand: String?, windows: Boolean = isWindows()) {
        val names = if (windows) env.keys.filter { it.equals("PATH", ignoreCase = true) }.sorted() else listOf("PATH")
        val name = names.firstOrNull() ?: "PATH"
        val current = env[name] ?: ""
        names.drop(1).forEach { env.remove(it) }
        env[name] = daemonPath(current, nodeCommand, windows = windows)
    }

    internal fun resolveNodeExecutable(
        environment: Map<String, String> = System.getenv(),
        home: String? = System.getProperty("user.home"),
        windows: Boolean = isWindows(),
        nodeOnPath: () -> String? = { if (windows) findNodeFromWhere() else findNodeViaWhich() }
    ): String? {
        val env = environment["MOE_NODE_COMMAND"]?.trim()
        if (!env.isNullOrBlank()) {
            return env.trim('"')
        }
        // The installer selects this runtime when the system Node is unsupported.
        // GUI-launched IDEs do not load the shell profile that puts it on PATH.
        if (!windows && home != null) {
            val managed = File(home, ".local/share/moe/node/current/bin/node")
            if (managed.isFile && managed.canExecute()) return managed.absolutePath
        }
        nodeOnPath()?.let { return it }
        if (windows) {
            val programFiles = environment["ProgramFiles"]
            val programFilesX86 = environment["ProgramFiles(x86)"]
            val localAppData = environment["LOCALAPPDATA"]
            val appData = environment["APPDATA"]
            val candidates = listOfNotNull(
                programFiles?.let { File(it, "nodejs\\node.exe") },
                programFilesX86?.let { File(it, "nodejs\\node.exe") },
                localAppData?.let { File(it, "Programs\\nodejs\\node.exe") },
                localAppData?.let { File(it, "nvm\\current\\node.exe") },
                appData?.let { File(it, "nvm\\node.exe") }
            )
            val found = candidates.firstOrNull { it.exists() }?.absolutePath
            if (found != null) return found
            return null
        }
        // macOS / Linux: check common node locations since ProcessBuilder
        // does not inherit the user's shell PATH when launched from the IDE
        val macLinuxCandidates = listOfNotNull(
            File("/opt/homebrew/bin/node"),         // Homebrew ARM (Apple Silicon)
            File("/usr/local/bin/node"),             // Homebrew Intel / system
            home?.let { File(it, ".nvm/current/bin/node") },
            home?.let { File(it, ".nvm/versions/node").listFiles()
                ?.filter { d -> d.isDirectory }
                ?.maxByOrNull { d -> d.name }
                ?.let { d -> File(d, "bin/node") }
            },
            File("/usr/bin/node")
        )
        val found = macLinuxCandidates.firstOrNull { it.exists() }?.absolutePath
        if (found != null) {
            log.debug("Resolved node on macOS/Linux: $found")
            return found
        }
        return null
    }

    private fun findNodeFromWhere(): String? {
        var process: Process? = null
        return try {
            process = ProcessBuilder("where", "node")
                .redirectErrorStream(true)
                .start()
            val completed = process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!completed) {
                process.destroyForcibly()
                return null
            }
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            val line = reader.readLine()?.trim()
            reader.close()
            if (process.exitValue() == 0 && !line.isNullOrBlank() && File(line).isFile) line else null
        } catch (ex: Exception) {
            log.debug("Failed to find node via 'where' command", ex)
            null
        } finally {
            process?.destroyForcibly()
        }
    }

    private fun findNodeViaWhich(): String? {
        var process: Process? = null
        return try {
            process = ProcessBuilder("which", "node")
                .redirectErrorStream(true)
                .start()
            val completed = process.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!completed) {
                process.destroyForcibly()
                return null
            }
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            val line = reader.readLine()?.trim()
            reader.close()
            if (process.exitValue() == 0 && !line.isNullOrBlank() && File(line).isFile) line else null
        } catch (ex: Exception) {
            log.debug("Failed to find node via 'which' command", ex)
            null
        } finally {
            process?.destroyForcibly()
        }
    }

    private fun resolveInstalledDaemonCommand(basePath: String): String? {
        if (!isWindows()) return null
        val roots = listOf("ProgramFiles", "ProgramFiles(x86)")
            .mapNotNull { System.getenv(it) }
        for (root in roots) {
            val cmd = File(root, "Moe\\moe-daemon\\start-daemon.cmd")
            if (cmd.exists()) {
                return "\"${cmd.absolutePath}\" start --project \"$basePath\""
            }
        }
        return null
    }

    private fun isWindows(): Boolean {
        return System.getProperty("os.name").lowercase().contains("win")
    }

    fun isProcessAlive(pid: Int): Boolean = try {
        processAliveProbe(pid)
    } catch (ex: Exception) {
        log.debug("Failed to check process $pid: ${ex.message}")
        false
    }

    fun isPortOpen(port: Int): Boolean = portProbe(port, PORT_CHECK_TIMEOUT_MS)

    /**
     * Kill the daemon process we spawned if it's still running.
     * This is called on dispose or if startup fails.
     */
    fun killSpawnedDaemon() {
        val process = spawnedDaemonProcess ?: return
        // Intentionally clear the shared reference before kill attempts to prevent double-kill races.
        spawnedDaemonProcess = null
        try {
            if (process.isAlive) {
                log.info("Killing spawned daemon process")
                process.destroy()
                // Give it a moment to terminate gracefully
                if (!process.waitFor(2, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                }
            }
        } catch (ex: Exception) {
            log.warn("Error killing spawned daemon: ${ex.message}")
        } finally {
            // Keep stale references cleared; preserve any newer process assigned concurrently.
            if (spawnedDaemonProcess === process) {
                spawnedDaemonProcess = null
            }
        }
    }

    fun spawnedProcess(): Process? = spawnedDaemonProcess

    fun releaseSpawnedProcessReference() {
        spawnedDaemonProcess = null
    }

    fun resetSpawnAttempts() {
        daemonSpawnAttempts = 0
    }

    fun resetSpawnBackoff() {
        lastDaemonStartAttemptAt = 0
        daemonSpawnAttempts = 0
    }

    companion object {
        // The daemon writes a few hundred bytes; 64 KiB still fits a 32K-character project path.
        internal const val MAX_DAEMON_JSON_BYTES = 64 * 1024

        private val PORT_CHECK_TIMEOUT_MS: Int =
            System.getProperty("moe.portCheckTimeoutMs")?.toIntOrNull() ?: 200

        private fun defaultProcessAliveProbe(pid: Int): Boolean {
            val handle = ProcessHandle.of(pid.toLong())
            return handle.isPresent && handle.get().isAlive
        }

        private fun defaultPortProbe(port: Int, timeoutMs: Int): Boolean {
            val socket = Socket()
            return try {
                socket.connect(InetSocketAddress("127.0.0.1", port), timeoutMs)
                true
            } catch (_: Exception) {
                false
            } finally {
                try {
                    socket.close()
                } catch (_: Exception) {
                    // Ignore close errors.
                }
            }
        }
    }
}
