package com.moe.services

import com.google.gson.Gson
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.ui.Messages
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
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

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
    private val processLookup: (Long) -> ProcessHandle? = { ProcessHandle.of(it).orElse(null) },
    private val replaceConfirmer: (String, Int) -> Boolean = ::confirmDaemonReplacement,
    private val runStop: (ProcessBuilder) -> Int? = { runStopProcess(it, processStarter) },
    private val onDispatchThread: () -> Boolean = { ApplicationManager.getApplication()?.isDispatchThread == true },
    private val sleep: (Long) -> Unit = Thread::sleep,
    private val exitTimeoutMs: Long = EXIT_TIMEOUT_MS,
    private val windowsRestart: () -> Boolean = ::isWindowsHost
) {
    private val log = Logger.getInstance(MoeDaemonSupervisor::class.java)
    private val gson = Gson()
    @Volatile private var spawnedDaemonProcess: Process? = null
    @Volatile private var daemonSpawnAttempts = 0
    private val maxDaemonSpawnAttempts = 3
    @Volatile private var lastDaemonStartAttemptAt = 0L
    private val daemonStartCooldownMs = 10_000L
    @Volatile private var selectionRefusal: String? = null
    private val replacementInFlight = AtomicBoolean()
    // Held while a Windows restart stops the old tree: a daemon spawned meanwhile would be orphaned by the next spawn.
    private val windowsRestartInFlight = AtomicBoolean()
    // A refused restart retains its captured authority until a later restart confirms the entire tree gone.
    @Volatile private var unresolvedWindowsTree: OldTree? = null
    private var pendingReplacement: ReplacementTarget? = null

    private data class ReplacementTarget(val target: ProcessHandle, val parent: ProcessHandle?, val refusal: String) {
        fun alive(): Boolean = target.isAlive || parent?.isAlive == true
    }

    private fun parseDaemonInfo(file: File): DaemonInfo? {
        return try {
            if (!file.exists()) return null
            val bytes = file.inputStream().use { it.readNBytes(MAX_DAEMON_JSON_BYTES + 1) }
            if (bytes.size > MAX_DAEMON_JSON_BYTES) {
                log.warn("Ignoring .moe/daemon.json: larger than ${MAX_DAEMON_JSON_BYTES / 1024} KiB")
                return null
            }
            gson.fromJson(String(bytes, Charsets.UTF_8), DaemonInfo::class.java)
        } catch (ex: Exception) {
            log.debug("Failed to read daemon.json: ${ex.message}")
            null
        }
    }

    fun readDaemonInfo(): DaemonInfo? = try {
        val base = basePath.ifBlank { return null }
        val info = parseDaemonInfo(File(base, ".moe/daemon.json"))
        if (info != null && info.projectPath.isNotEmpty() && !isSameProject(info.projectPath, base)) {
            log.warn("Ignoring .moe/daemon.json: it names ${info.projectPath}, not $base")
            null
        } else info
    } catch (ex: Exception) {
        log.debug("Failed to read daemon.json: ${ex.message}")
        null
    }

    fun deleteDaemonInfoIfUnchanged(expected: DaemonInfo): Boolean = try {
        val base = basePath.ifBlank { return false }
        val file = File(base, ".moe/daemon.json")
        if (parseDaemonInfo(file) != expected) false else file.delete().also {
            if (!it) log.warn("Failed to remove unchanged daemon.json")
        }
    } catch (ex: Exception) {
        log.warn("Failed to remove unchanged daemon.json", ex)
        false
    }

    fun ensureDaemonRunning(): Boolean {
        if (windowsRestartInFlight.get() || unresolvedWindowsTree != null) return false
        if (profile() != RuntimeProfile.PROTECTED) return ensureDaemonRunningImpl()
        // Cover the fall-through spawn too: stop may remove metadata before the old processes exit.
        if (!replacementInFlight.compareAndSet(false, true)) return false
        return try {
            pendingReplacement?.let {
                if (it.alive() || !replacementMetadataCleared()) { selectionRefusal = it.refusal; return false }
                pendingReplacement = null
            }
            ensureDaemonRunningImpl()
        } catch (ex: Exception) {
            log.warn("Cannot replace or start the protected daemon", ex)
            if (ex is InterruptedException) Thread.currentThread().interrupt()
            false
        } finally {
            replacementInFlight.set(false)
        }
    }

    private fun ensureDaemonRunningImpl(): Boolean {
        if (!ensureMoeInitialized()) {
            return false
        }

        val info = parseDaemonInfo(File(basePath, ".moe/daemon.json"))
        val sameProject = try {
            info?.let { it.projectPath.isEmpty() || isSameProject(it.projectPath, basePath) }
        } catch (ex: Exception) {
            log.debug("Failed to classify daemon.json: ${ex.message}")
            null
        }
        if (info != null && sameProject == true && isReachable(info)) {
            if (isOtherSideOfWsl(info.projectPath, isWindows())) return false
            if (!replacedUnverified(info)) return false
        }

        // Clean up stale daemon.json so connectWithRetry reads fresh data from the new daemon
        if (info != null && sameProject != null && deleteDaemonInfoIfUnchanged(info)) {
            log.info("Removed stale daemon.json (PID ${info.pid} not reachable or another project)")
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
            if (isProtected && direct != null) recordProtectedSpawn(projectBasePath, process, File(direct[1]))
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

    // Called under the protected ensure guard, held through the new spawn and released in finally.
    private fun replacedUnverified(info: DaemonInfo): Boolean {
        return try {
            if (profile() != RuntimeProfile.PROTECTED) return false
            val refusal = activationRefusal(info) ?: return false
            if (onDispatchThread()) return false
            val command = stopCommandForProfile(basePath, RuntimeProfile.PROTECTED) ?: return false
            val target = processLookup(info.pid.toLong()) ?: return false
            val captured = ReplacementTarget(target, target.parent().orElse(null), refusal)
            if (!replaceConfirmer(projectName, info.pid)) return false
            // Keep captured identities across failed attempts, even when stop deletes daemon.json.
            pendingReplacement = captured
            selectionRefusal = refusal
            when {
                runStop(stopBuilder(command)) != 0 -> {
                    log.warn("Unverified daemon replacement refused: installed stop failed or timed out")
                    false
                }
                !waitForReplacementExit(captured) -> {
                    log.warn("Unverified daemon replacement refused: target, parent or metadata did not clear")
                    false
                }
                else -> {
                    pendingReplacement = null
                    resetSpawnBackoff()
                    log.info("Unverified daemon stopped; starting the installed Moe runtime")
                    true
                }
            }
        } catch (ex: Exception) {
            log.warn("Unverified daemon replacement failed", ex)
            if (ex is InterruptedException) Thread.currentThread().interrupt()
            false
        }
    }

    private fun waitForReplacementExit(captured: ReplacementTarget): Boolean =
        ExitBound().await { !captured.alive() && replacementMetadataCleared() }

    /** One exit budget, [exitTimeoutMs] capped at EXIT_TIMEOUT_MS, polled every POLL_MS; successive waits share it. */
    private inner class ExitBound {
        private var remaining = exitTimeoutMs.coerceIn(0, EXIT_TIMEOUT_MS)
        private val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(remaining)

        fun await(done: () -> Boolean): Boolean {
            while (true) {
                if (done()) return true
                if (remaining <= 0 || System.nanoTime() >= deadline) return false
                val delay = minOf(POLL_MS, remaining)
                sleep(delay)
                remaining -= delay
            }
        }
    }

    // readDaemonInfo's null also means unreadable or another project, not proof of clearance.
    private fun replacementMetadataCleared(): Boolean = try {
        val file = File(basePath, ".moe/daemon.json")
        if (Files.notExists(file.toPath())) true else {
            val info = parseDaemonInfo(file)
            info != null && !isOtherSideOfWsl(info.projectPath, isWindows()) && info.pid > 0 && !isProcessAlive(info.pid)
        }
    } catch (_: Exception) {
        false
    }

    /** Why the protected profile refused to start a daemon; null under LEGACY or once a selection succeeds. */
    fun selectionRefusal(): String? = selectionRefusal?.takeIf { profile() == RuntimeProfile.PROTECTED }

    /**
     * Under PROTECTED, why the daemon [info] names must not be activated; null when it may be. A spawn an
     * earlier IDE session persisted verifies only for the daemon installed now. LEGACY reads no daemon
     * provenance; profile selection reads only its own record.
     */
    fun activationRefusal(info: DaemonInfo): String? {
        if (profile() != RuntimeProfile.PROTECTED) return null
        val installed = RuntimeSelectionPolicy.installedArtifact(installedRoot(), "daemon/index.js", basePath)
        return RuntimeSelectionPolicy.verifyProvenance(
            basePath, info.pid.toLong(), installedDaemon = (installed as? RuntimeSelection.Accepted)?.file
        )
    }

    /**
     * Stops the daemon [info] names so Restart Daemon can start a fresh one: null when the restart may go
     * on, else the refusal to show. daemon.json is repository content, so its pid is no authority to signal
     * a process: under PROTECTED only a process activation would accept is stopped, and any failure refuses.
     * LEGACY keeps the historical best-effort signal.
     *
     * On Windows a signal is TerminateProcess, which the old supervisor takes for a crash of its `_run` and
     * respawns, so [stopWindowsRestart] stops through the installed CLI and then the old supervisor tree, even
     * with no [info]. It blocks up to the CLI's stop bound and then the exit bound: never call it on the EDT.
     */
    fun stopDaemonForRestart(info: DaemonInfo?): String? {
        if (info != null && isOtherSideOfWsl(info.projectPath, isWindows())) {
            return "Restart Daemon did not stop pid ${info.pid}, which .moe/daemon.json names on the other side of the Windows/WSL boundary: " +
                "this IDE can neither see nor signal processes there. Check what that process is and stop it there yourself if it is a Moe daemon, " +
                "then use Restart Daemon."
        }
        if (windowsRestart()) return stopWindowsRestart(info)
        if (info == null) return null
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
                activationRefusal(info) != null -> restartRefusal(info.pid, NOT_STARTED_HERE)
                target.destroy() -> null
                else -> restartRefusal(info.pid, STOP_FAILED)
            }
        } catch (ex: Exception) {
            log.warn("Restart Daemon could not stop pid ${info.pid}: ${ex.message}")
            if (isProtected) restartRefusal(info.pid, STOP_FAILED) else null
        }
    }

    // Today's guards pick the daemon.json process; signals then reach only this IDE's spawn tree or a PROTECTED-verified one.
    private fun stopWindowsRestart(info: DaemonInfo?): String? {
        if (!windowsRestartInFlight.compareAndSet(false, true)) return RESTART_IN_PROGRESS
        val isProtected = profile() == RuntimeProfile.PROTECTED
        return try {
            // An absent pid reads as 0; a dead pid may be reused: neither is ever signaled.
            val pid = info?.pid?.takeIf { it > 0 && isProcessAlive(it) }
            val run = try {
                pid?.let { processLookup(it.toLong()) }
            } catch (ex: Exception) {
                log.warn("Restart Daemon could not look up pid $pid: ${ex.message}")
                if (isProtected && pid != null) return restartRefusal(pid, STOP_FAILED)
                null
            }
            if (isProtected && info != null && run != null && activationRefusal(info) != null) {
                return restartRefusal(info.pid, NOT_STARTED_HERE)
            }
            stopOldTree(info, run?.takeUnless(::isIdeOrAncestor), isProtected)
        } catch (ex: Exception) {
            log.warn("Restart Daemon could not confirm the old Moe daemon stopped: ${ex.message}")
            if (ex is InterruptedException) Thread.currentThread().interrupt()
            INCOMPLETE_RESTART
        } finally {
            windowsRestartInFlight.set(false)
        }
    }

    private fun stopOldTree(info: DaemonInfo?, run: ProcessHandle?, isProtected: Boolean): String? {
        val own = ownSupervisor()
        val parent = run?.let(::genuineParent)?.takeUnless(::isIdeOrAncestor)
        // A foreign parent is only watched: daemon.json is repository content, and LEGACY never verified it.
        val roots = listOfNotNull(own, parent?.takeIf { isProtected || sameProcess(it, own) }).distinctBy { it.pid() }
        if (run == null && roots.isEmpty() && unresolvedWindowsTree == null) return null
        val old = OldTree(run, roots, parent?.takeIf { p -> roots.none { it.pid() == p.pid() } }, unresolvedWindowsTree)
        unresolvedWindowsTree = old
        old.walk()
        if (!installedStop()) {
            if (isProtected && info != null && run != null) return restartRefusal(info.pid, STOP_FAILED)
            log.warn("Restart Daemon: the installed stop failed; terminating the old supervisor tree")
        }
        val bound = ExitBound()
        // Roots first and dead before their children are signaled, so none can respawn a `_run`.
        old.roots.forEach(::terminate)
        bound.await { old.roots.none(::running) }
        // Done only when a walk made after every known process died finds no new one: a dead process spawns nothing.
        bound.await {
            old.terminateDescendants()
            val settled = old.survivor() == null
            !old.walk() && settled
        }
        val survivor = old.survivor()
        if (survivor == null) {
            unresolvedWindowsTree = null
            return null
        }
        log.warn("Restart Daemon: pid ${survivor.pid()} is still running after the stop")
        return survivorRefusal(survivor.pid())
    }

    /** Captured signal/watch authority, including unresolved prior attempts; never re-resolved from a pid. */
    private inner class OldTree(run: ProcessHandle?, roots: List<ProcessHandle>, watched: ProcessHandle?, retained: OldTree?) {
        val roots: List<ProcessHandle> = (retained?.roots.orEmpty() + roots).distinct()
        private val runs: List<ProcessHandle> = (retained?.runs.orEmpty() + listOfNotNull(run)).distinct()
        private val watched: List<ProcessHandle> = (retained?.watched.orEmpty() + listOfNotNull(watched)).distinct()
        private val tree: MutableSet<ProcessHandle> = LinkedHashSet<ProcessHandle>().apply { retained?.tree?.let(::addAll) }
        // ProcessHandle identity keeps a newly captured own process separate from a dead same-pid root.
        private val deadSince: MutableMap<ProcessHandle, Instant> = HashMap<ProcessHandle, Instant>().apply { retained?.deadSince?.let(::putAll) }

        // Breadth-first, each process before its children; true when it found a new one. A dead process keeps listing
        // its orphans (a `_run` respawned after the capture), but a child started after it was seen dead is a pid reuser's.
        fun walk(): Boolean {
            val known = tree.size
            val queue = ArrayDeque((roots + tree).distinct())
            val seen = queue.toHashSet()
            while (queue.isNotEmpty()) {
                val next = queue.removeFirst()
                val limit = if (running(next)) null else deadSince.getOrPut(next) { Instant.now() }
                children(next)
                    .filter { seen.add(it) }
                    .filter {
                        // Unknown identity grants neither signal authority nor proof that the tree stopped.
                        val start = checkNotNull(startOf(it)) { "Cannot read the start of pid ${it.pid()}" }
                        limit == null || !start.isAfter(limit)
                    }
                    .forEach { tree.add(it); queue += it }
            }
            return tree.size > known
        }

        fun terminateDescendants() = (tree + runs).forEach(::terminate)

        fun survivor(): ProcessHandle? = (runs + roots + tree + watched).firstOrNull(::running)
    }

    // The supervisor this IDE spawned, while it lives; a Process without a handle has none.
    private fun ownSupervisor(): ProcessHandle? = try {
        spawnedDaemonProcess?.toHandle()?.takeIf { it.isAlive }
    } catch (ex: Exception) {
        log.debug("No handle for the spawned Moe daemon: ${ex.message}")
        null
    }

    // A pid is reused once its process exits, so only a process started no later than [run] can be its parent.
    private fun genuineParent(run: ProcessHandle): ProcessHandle? = try {
        val parent = run.parent().orElse(null)
        val parentStart = parent?.let(::startOf)
        val runStart = startOf(run)
        parent?.takeIf { parentStart != null && runStart != null && !parentStart.isAfter(runStart) }
    } catch (ex: Exception) {
        log.debug("Cannot read the parent of pid ${run.pid()}: ${ex.message}")
        null
    }

    private fun sameProcess(a: ProcessHandle, b: ProcessHandle?): Boolean =
        b != null && a.pid() == b.pid() && startOf(a)?.let { it == startOf(b) } == true

    // The IDE and whatever launched it are no old supervisor, whatever .moe/daemon.json names.
    private fun isIdeOrAncestor(handle: ProcessHandle): Boolean = try {
        val start = startOf(handle)
        generateSequence(ProcessHandle.current()) { it.parent().orElse(null) }.take(MAX_ANCESTORS)
            .any { it.pid() == handle.pid() && startOf(it) == start }
    } catch (ex: Exception) {
        log.debug("Cannot compare pid ${handle.pid()} with this IDE: ${ex.message}")
        true
    }

    private fun startOf(handle: ProcessHandle): Instant? = try {
        handle.info().startInstant().orElse(null)
    } catch (_: Exception) {
        null
    }

    // Discovery errors are not an empty tree: let stopWindowsRestart return its fixed refusal.
    private fun children(handle: ProcessHandle): List<ProcessHandle> = handle.children().use { it.toList() }

    // An isAlive that throws counts as alive: the restart then refuses rather than start a second daemon.
    private fun running(handle: ProcessHandle): Boolean = try {
        handle.isAlive
    } catch (_: Exception) {
        true
    }

    // Never a dead process, whose pid may already be reused; whether it died is the confirm's to decide.
    private fun terminate(handle: ProcessHandle) {
        try {
            if (handle.isAlive) handle.destroyForcibly()
        } catch (ex: Exception) {
            log.debug("Cannot terminate pid ${handle.pid()}: ${ex.message}")
        }
    }

    // RF03's installed stop: its sentinel makes a supervisor exit instead of respawning `_run`. Only exit 0 succeeds.
    private fun installedStop(): Boolean = try {
        val runtimeProfile = profile()
        stopCommandForProfile(basePath, runtimeProfile)?.let { runStop(stopBuilder(it, runtimeProfile)) } == 0
    } catch (ex: Exception) {
        log.warn("Restart Daemon: the installed stop failed: ${ex.message}")
        if (ex is InterruptedException) Thread.currentThread().interrupt()
        false
    }

    // The pid comes from the repository, so neither refusal calls that process a Moe daemon.
    private fun survivorRefusal(pid: Long) = "Restart Daemon did not start a new Moe daemon: pid $pid is still running after the stop, " +
        "and it could restart the old one. Check what that process is and stop it yourself, then use Restart Daemon."

    private fun restartRefusal(pid: Int, reason: String) =
        "Protected execution profile: Restart Daemon did not stop pid $pid, which .moe/daemon.json names: $reason. " +
            "Check what that process is and stop it yourself if it is a Moe daemon, then use Restart Daemon."

    internal sealed interface ProtectedDaemonCommand {
        data class Ready(val command: List<String>) : ProtectedDaemonCommand
        data class Refused(val reason: String) : ProtectedDaemonCommand
    }

    /** The installed node and daemon; project, parent, PATH, env and global-config copies are never consulted. */
    internal fun protectedDaemonCommand(basePath: String, root: File?, node: String?, subcommand: String = "start"): ProtectedDaemonCommand =
        installedDaemonCommand(basePath, root, node, subcommand, RuntimeProfile.PROTECTED)

    private fun installedDaemonCommand(
        basePath: String, root: File?, node: String?, subcommand: String, runtimeProfile: RuntimeProfile
    ): ProtectedDaemonCommand {
        val daemon = when (val selection = RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", basePath, runtimeProfile)) {
            is RuntimeSelection.Accepted -> selection.file
            is RuntimeSelection.Rejected -> return ProtectedDaemonCommand.Refused(selection.reason)
        }
        val nodeFile = when (val selection = RuntimeSelectionPolicy.installedExecutable(node, basePath, runtimeProfile)) {
            is RuntimeSelection.Accepted -> selection.file
            is RuntimeSelection.Rejected -> return ProtectedDaemonCommand.Refused(selection.reason)
        }
        val command = mutableListOf(nodeFile.path, daemon.path, subcommand, "--project", basePath)
        if (subcommand == "start" && wslAgentsEnabled()) command += listOf("--host", WSL_BIND_HOST)
        return ProtectedDaemonCommand.Ready(command)
    }

    // A refusal starts nothing: it is logged, published and kept for connect() to show.
    private fun protectedCommandOrRefuse(basePath: String): List<String>? {
        return when (val selection = protectedDaemonCommand(basePath, installedRoot(), protectedNode(basePath))) {
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

    private fun protectedNode(basePath: String, runtimeProfile: RuntimeProfile = RuntimeProfile.PROTECTED): String? =
        if (nodeExecutable != null) nodeExecutable.invoke() else resolveNodeExecutable(nodeOnPath = {
            nodeOnProtectedPath(System.getenv("PATH").orEmpty(), basePath, runtimeProfile = runtimeProfile)
        })

    /** No status/refusal mutation: Restart Daemon also uses this selector under LEGACY. */
    internal fun stopCommandOrNull(basePath: String): List<String>? = try {
        stopCommandForProfile(basePath, profile())
    } catch (ex: Exception) {
        log.warn("Cannot build installed daemon stop command", ex)
        null
    }

    private fun stopCommandForProfile(basePath: String, runtimeProfile: RuntimeProfile): List<String>? =
        when (val selection = installedDaemonCommand(basePath, installedRoot(), protectedNode(basePath, runtimeProfile), "stop", runtimeProfile)) {
            is ProtectedDaemonCommand.Ready -> selection.command
            is ProtectedDaemonCommand.Refused -> null.also { log.warn("Installed daemon stop refused: ${selection.reason}") }
        }

    private fun stopBuilder(command: List<String>, runtimeProfile: RuntimeProfile = RuntimeProfile.PROTECTED): ProcessBuilder = ProcessBuilder(command).apply {
        directory(File(command[1]).parentFile)
        redirectErrorStream(true)
        redirectOutput(ProcessBuilder.Redirect.DISCARD)
        applyDaemonPath(environment(), command[0])
        protectedDaemonEnvironment(environment(), basePath, runtimeProfile)
    }

    /** Drops what could load repository code into the installed daemon: NODE_OPTIONS, NODE_PATH and unsafe PATH entries. */
    internal fun protectedDaemonEnvironment(
        env: MutableMap<String, String>, basePath: String, runtimeProfile: RuntimeProfile = RuntimeProfile.PROTECTED
    ) {
        env.remove("NODE_OPTIONS")
        env.remove("NODE_PATH")
        // After applyDaemonPath a Windows map may hold the variable as "Path"; filter whichever one it kept.
        val pathName = if (isWindows()) env.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH" else "PATH"
        env[pathName]?.let { env[pathName] = protectedPathEntries(it, basePath, runtimeProfile).joinToString(File.pathSeparator) }
    }

    // In-process: running `where`/`which` by bare name could start a copy in the IDE's working directory.
    internal fun nodeOnProtectedPath(
        path: String, basePath: String, windows: Boolean = isWindows(), runtimeProfile: RuntimeProfile = RuntimeProfile.PROTECTED
    ): String? =
        protectedPathEntries(path, basePath, runtimeProfile).asSequence()
            .map { File(it, if (windows) "node.exe" else "node") }
            .firstOrNull { it.isFile }?.absolutePath

    // Blank, relative and project entries go, so the daemon's own lookups cannot reach repository executables.
    // Entries come back as the spelling that was validated: libuv's Windows PATH search strips one leading or trailing
    // ' or " (so `<project>'` searches the project) and execvp reads a space-padded entry as relative; both are dropped or trimmed.
    private fun protectedPathEntries(path: String, basePath: String, runtimeProfile: RuntimeProfile): List<String> =
        path.split(File.pathSeparator).map { unquoted(it) }.filter { entry ->
            "'\"".none { entry.startsWith(it) || entry.endsWith(it) } && RuntimeSelectionPolicy.isOutsideProject(entry, basePath, runtimeProfile)
        }

    private fun unquoted(entry: String): String = entry.trim().removeSurrounding("\"")

    // [installedDaemon] is the installed daemon the command runs, so a later IDE session can match it.
    private fun recordProtectedSpawn(basePath: String, process: Process, installedDaemon: File) {
        try {
            RuntimeSelectionPolicy.recordProtectedSpawn(basePath, process.toHandle(), installedDaemon)
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

    internal fun buildDaemonCommand(basePath: String): String {
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
        val hostSuffix = if (wslAgentsEnabled()) " --host $WSL_BIND_HOST" else ""
        if (installed != null) {
            return installed + hostSuffix
        }

        return "moe-daemon start --project \"$basePath\"$hostSuffix"
    }

    private fun buildDirectDaemonCommand(basePath: String): List<String>? {
        val script = resolveLocalDaemonScript(basePath) ?: return null
        val node = resolveNodeExecutable() ?: "node"
        val command = mutableListOf(node, script.absolutePath, "start", "--project", basePath)
        // WSL agent mode: agents inside WSL can't reach a loopback-only listener, so the daemon
        // binds loopback plus the WSL adapter; moe-agent.sh probes loopback, then the WSL gateway.
        if (wslAgentsEnabled()) {
            command += listOf("--host", WSL_BIND_HOST)
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

    private fun isWindows(): Boolean = isWindowsHost()

    fun isProcessAlive(pid: Int): Boolean = try {
        processAliveProbe(pid)
    } catch (ex: Exception) {
        log.debug("Failed to check process $pid: ${ex.message}")
        false
    }

    fun isPortOpen(port: Int): Boolean = portProbe(port, PORT_CHECK_TIMEOUT_MS)

    fun isReachable(info: DaemonInfo): Boolean = try {
        (isOtherSideOfWsl(info.projectPath, isWindows()) || isProcessAlive(info.pid)) && isPortOpen(info.port)
    } catch (ex: Exception) {
        log.debug("Failed to check daemon reachability: ${ex.message}")
        false
    }

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
        internal fun isWindowsHost(): Boolean = System.getProperty("os.name").lowercase().contains("win")

        internal fun isOtherSideOfWsl(projectPath: String, windows: Boolean): Boolean =
            (if (windows) Regex("""^/(?![\\/])""") else Regex("""^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])"""))
                .containsMatchIn(projectPath)

        internal fun isSameProject(path: String, base: String): Boolean =
            DaemonIdentityProbe.comparableProjectPath(path) == DaemonIdentityProbe.comparableProjectPath(base) ||
                File(path).canonicalPath == File(base).canonicalPath
        private const val STOP_TIMEOUT_MS = 20_000L
        private const val NOT_STARTED_HERE = "this IDE did not start it from the installed Moe runtime"
        private const val STOP_FAILED = "the stop request failed"
        private const val INCOMPLETE_RESTART = "Restart Daemon did not start a new Moe daemon: it could not confirm that the old one stopped. " +
            "Use Restart Daemon again."
        private const val RESTART_IN_PROGRESS = "Restart Daemon is already stopping the old Moe daemon. Wait for it to finish."
        private const val MAX_ANCESTORS = 64
        private const val EXIT_TIMEOUT_MS = 15_000L
        private const val POLL_MS = 250L

        private fun runStopProcess(builder: ProcessBuilder, starter: (ProcessBuilder) -> Process): Int? {
            val process = starter(builder)
            return try {
                if (process.waitFor(STOP_TIMEOUT_MS, TimeUnit.MILLISECONDS)) process.exitValue() else null
            } finally {
                if (process.isAlive) process.destroyForcibly()
            }
        }

        private fun confirmDaemonReplacement(projectName: String, pid: Int): Boolean {
            return try {
                val app = ApplicationManager.getApplication()
                if (app == null || app.isUnitTestMode || app.isHeadlessEnvironment || app.isDispatchThread) return false
                var choice = -1
                app.invokeAndWait {
                    val message = "The daemon that .moe/daemon.json names for $projectName (pid $pid) was not started " +
                        "by this IDE from the installed Moe runtime. Another client, such as VS Code or a terminal " +
                        "agent, may be using it, and stopping it disconnects them. Stop it with the installed Moe " +
                        "CLI and start the installed daemon?"
                    choice = Messages.showDialog(message, "Moe: Unverified Daemon",
                        arrayOf("Keep It", "Stop and Replace"), 0, Messages.getWarningIcon())
                }
                choice == 1
            } catch (ex: Exception) {
                Logger.getInstance(MoeDaemonSupervisor::class.java).warn("Unverified daemon confirmation failed", ex)
                if (ex is InterruptedException) Thread.currentThread().interrupt()
                false
            }
        }

        // The daemon's symbolic bind host: loopback plus the WSL virtual adapter, never every interface.
        private const val WSL_BIND_HOST = "wsl"

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
