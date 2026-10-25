package com.moe.util

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import java.io.File
import java.io.IOError
import java.io.StringReader
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Instant
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

sealed interface RuntimeSelection {
    data class Accepted(val file: File) : RuntimeSelection
    data class Rejected(val reason: String) : RuntimeSelection
}

/** LEGACY keeps the historical runtime selection; PROTECTED runs only the runtime installed with the plugin. */
enum class RuntimeProfile { LEGACY, PROTECTED }

/**
 * The one place JetBrains decides which Moe controller, wrapper, proxy and node it may run.
 *
 * The profile mirrors the daemon's resolveExecutionProfile (delivery/executionProfile.ts) but
 * fails closed: only a confirmed-absent setting, "legacy" or "observe" keeps the legacy
 * selection. Anything the daemon would reject, or this IDE cannot read strictly, is PROTECTED.
 */
object RuntimeSelectionPolicy {
    private val log = Logger.getInstance(RuntimeSelectionPolicy::class.java)
    private const val MAX_PROJECT_JSON_BYTES = 1 shl 20
    private val gson = Gson()
    private val DRIVE_ROOT = Regex("^[A-Za-z]:/$")
    private val DEVICE_PREFIX = Regex("^//[?.]/(unc/)?", RegexOption.IGNORE_CASE)
    private const val PLUGIN_ID = "com.moe.jetbrains"

    // Projects read as verified-local this JVM session. A later repository edit (pull, admitted
    // change) cannot downgrade their selection; a deliberate downgrade applies after an IDE restart.
    private val pinned: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** Never throws: an unreadable or untrusted `.moe/project.json` answers PROTECTED. */
    fun profile(basePath: String): RuntimeProfile {
        if (basePath.isBlank()) return RuntimeProfile.LEGACY
        val key = projectKey(basePath)
        if (key in pinned) return RuntimeProfile.PROTECTED
        val verifiedLocal = try {
            declaresVerifiedLocal(Paths.get(basePath, ".moe", "project.json"))
        } catch (ex: Exception) {
            val failure = if (ex is UntrustedSetting) ex.message else ex.javaClass.simpleName
            log.warn("Moe runtime selection fails closed to the protected profile: $failure")
            return RuntimeProfile.PROTECTED
        }
        if (!verifiedLocal) return RuntimeProfile.LEGACY
        pinned += key
        return RuntimeProfile.PROTECTED
    }

    /** True for exactly "verified-local", false for absent/legacy/observe; throws for anything else. */
    private fun declaresVerifiedLocal(file: Path): Boolean {
        if (Files.notExists(file, LinkOption.NOFOLLOW_LINKS)) return false
        val bytes = Files.newInputStream(file).use { it.readNBytes(MAX_PROJECT_JSON_BYTES + 1) }
        if (bytes.size > MAX_PROJECT_JSON_BYTES) throw UntrustedSetting("project.json is larger than 1 MiB")
        val root = parseStrict(String(bytes, Charsets.UTF_8))
        if (!root.isJsonObject) throw UntrustedSetting("project.json is not a JSON object")
        val settings = root.asJsonObject.get("settings") ?: return false
        if (!settings.isJsonObject) throw UntrustedSetting("settings is not a JSON object")
        val value = settings.asJsonObject.get("executionProfile") ?: return false
        val profile = if (value.isJsonPrimitive && value.asJsonPrimitive.isString) value.asString else null
        return when (profile) {
            "legacy", "observe" -> false
            "verified-local" -> true
            else -> throw UntrustedSetting("executionProfile is not legacy, observe or verified-local")
        }
    }

    // JsonParser.parseString/parseReader relax the reader to lenient, so read through the
    // JsonElement adapter with a STRICT reader. The daemon's JSON.parse rejects a byte order mark,
    // which Gson would skip, so a BOM is untrusted too.
    private fun parseStrict(text: String): JsonElement {
        if (text.startsWith('\uFEFF')) throw UntrustedSetting("project.json starts with a byte order mark")
        val reader = JsonReader(StringReader(text)).apply { strictness = Strictness.STRICT }
        val root = gson.getAdapter(JsonElement::class.java).read(reader)
        if (reader.peek() != JsonToken.END_DOCUMENT) throw UntrustedSetting("project.json has content after the document")
        return root
    }

    /** The real path when it resolves, else the normalized absolute path, in comparable form. */
    private fun projectKey(basePath: String): String {
        val path = realPathOrNull(basePath) ?: try {
            Paths.get(basePath).toAbsolutePath().normalize()
        } catch (_: Exception) {
            null
        } catch (_: IOError) {
            null
        }
        return comparablePath(path?.toString() ?: basePath, defaultFoldCase)
    }

    private fun realPathOrNull(path: String): Path? = try {
        Paths.get(path).toRealPath()
    } catch (_: Exception) {
        null
    } catch (_: IOError) {
        null
    }

    internal val defaultFoldCase: Boolean =
        System.getProperty("os.name").orEmpty().lowercase(Locale.ROOT).let { it.startsWith("windows") || it.startsWith("mac") }

    /**
     * Separators become `/`, the `\\?\` and `\\.\` device prefixes go (`\\?\UNC\server` becomes
     * `//server`), and trailing separators go except on a root. Folding upper-cases before
     * lower-casing because NTFS also equates characters plain lower-casing keeps apart (dotless i and I).
     */
    internal fun comparablePath(path: String, foldCase: Boolean): String {
        var value = DEVICE_PREFIX.replace(path.replace('\\', '/')) { if (it.groupValues[1].isEmpty()) "" else "//" }
        while (value.length > 1 && value.endsWith("/") && !DRIVE_ROOT.matches(value)) value = value.dropLast(1)
        return if (foldCase) value.uppercase(Locale.ROOT).lowercase(Locale.ROOT) else value
    }

    /** [child] is [parent] or under it on a segment boundary; both already in comparable form. */
    internal fun isWithin(child: String, parent: String): Boolean =
        child == parent || child.startsWith(if (parent.endsWith("/")) parent else "$parent/")

    /**
     * The directory the IDE loaded this plugin from, else the root inferred from this jar (the
     * sources TerminalAgentLauncher.resolveBundledRoot uses). It is the only place protected
     * selection takes artifacts from: a missing artifact is rejected, never searched for elsewhere.
     */
    fun installedRoot(): File? = try {
        PluginManagerCore.getPlugin(PluginId.getId(PLUGIN_ID))?.pluginPath?.toFile()?.takeIf { it.exists() }
            ?: RuntimeSelectionPolicy::class.java.protectionDomain?.codeSource?.location?.toURI()
                ?.let { File(it).parentFile?.parentFile }
    } catch (ex: Exception) {
        log.debug("Cannot resolve the installed Moe runtime: ${ex.message}")
        null
    } catch (ex: LinkageError) {
        log.debug("Cannot resolve the installed Moe runtime: ${ex.message}")
        null
    }

    /**
     * [relative] under [root], accepted as its real file only inside the real root (exact
     * comparison) and outside the real project (folded where the file system folds case).
     */
    fun installedArtifact(root: File?, relative: String, basePath: String, foldCase: Boolean = defaultFoldCase): RuntimeSelection {
        val realRoot = root?.let { realPathOrNull(it.path) } ?: return RuntimeSelection.Rejected("installed Moe runtime not found")
        return select("installed $relative", basePath, foldCase, realRoot) { File(root, relative).toPath().toRealPath() }
    }

    /** An absolute, real, regular file outside the project; a bare name is never looked up on PATH. */
    fun installedExecutable(path: String?, basePath: String, foldCase: Boolean = defaultFoldCase): RuntimeSelection {
        if (path.isNullOrBlank()) return RuntimeSelection.Rejected("node executable not found")
        val candidate = try {
            Paths.get(path)
        } catch (ex: InvalidPathException) {
            return rejected("node executable is not a valid path", ex)
        }
        if (!candidate.isAbsolute) return RuntimeSelection.Rejected("node executable is not an absolute path")
        return select("node executable", basePath, foldCase, null) { candidate.toRealPath() }
    }

    /**
     * True only for an absolute [path] outside the project, both as written and as the real path
     * it resolves to. A relative or unparseable path, or any failure, answers false.
     */
    fun isOutsideProject(path: String, basePath: String, foldCase: Boolean = defaultFoldCase): Boolean = try {
        val candidate = Paths.get(path)
        val projects = listOfNotNull(Paths.get(basePath).toAbsolutePath().normalize(), realPathOrNull(basePath))
            .map { comparablePath(it.toString(), foldCase) }
        candidate.isAbsolute && listOfNotNull(candidate.normalize(), realPathOrNull(path))
            .map { comparablePath(it.toString(), foldCase) }
            .none { form -> projects.any { isWithin(form, it) } }
    } catch (_: Exception) {
        false
    } catch (_: IOError) {
        false
    }

    // Every check errs toward rejection: the root comparison is exact, the project one folded.
    private fun select(label: String, basePath: String, foldCase: Boolean, realRoot: Path?, resolve: () -> Path): RuntimeSelection {
        val project = realPathOrNull(basePath) ?: return RuntimeSelection.Rejected("the project directory cannot be resolved")
        val real = try {
            resolve()
        } catch (ex: NoSuchFileException) {
            return rejected("$label not found", ex)
        } catch (ex: Exception) {
            return rejected("$label cannot be resolved", ex)
        }
        return when {
            !Files.isRegularFile(real) -> rejected("$label is not a regular file", real)
            realRoot != null && !isWithin(comparablePath(real.toString(), false), comparablePath(realRoot.toString(), false)) ->
                rejected("$label resolves outside the installed Moe runtime", real)
            isWithin(comparablePath(real.toString(), foldCase), comparablePath(project.toString(), foldCase)) ->
                rejected("$label resolves inside the project", real)
            else -> RuntimeSelection.Accepted(real.toFile())
        }
    }

    // The reason reaches the UI; the absolute path only the log.
    private fun rejected(reason: String, detail: Any): RuntimeSelection.Rejected {
        log.warn("Moe protected runtime selection refused: $reason ($detail)")
        return RuntimeSelection.Rejected(reason)
    }

    /** What the OS reports about a live process; argv is never provenance (Node can rewrite it). */
    internal data class ProcessFacts(val pid: Long, val start: Instant?, val parentPid: Long?)

    /** A supervisor this IDE started from the installed runtime, or a daemon such a supervisor started. */
    internal data class SpawnRecord(val pid: Long, val start: Instant, val supervisor: Boolean)

    // Per project key, the protected processes this JVM session started or verified.
    private val spawns = ConcurrentHashMap<String, MutableSet<SpawnRecord>>()

    /** Remembers a supervisor this IDE started from the installed runtime. Never throws. */
    fun recordProtectedSpawn(basePath: String, handle: ProcessHandle) {
        try {
            val start = handle.info().startInstant().orElse(null)
            if (start == null) {
                log.debug("Moe daemon pid ${handle.pid()} reports no start instant, so it will not verify")
                return
            }
            remember(basePath, SpawnRecord(handle.pid(), start, supervisor = true), ::liveFacts)
        } catch (ex: Exception) {
            log.debug("Cannot record the protected Moe daemon: ${ex.message}")
        }
    }

    /** Adds [record] after pruning this project's records whose process is gone or whose pid was reused. */
    internal fun remember(basePath: String, record: SpawnRecord, facts: (Long) -> ProcessFacts?) {
        val records = spawns.computeIfAbsent(projectKey(basePath)) { ConcurrentHashMap.newKeySet() }
        records.removeIf { facts(it.pid)?.start != it.start }
        records += record
    }

    /**
     * Null when this IDE started the daemon [pid] for this project: its own (pid, start) is
     * recorded, or its direct parent is a recorded supervisor (daemon.json names the `_run` child
     * of the `start` process the IDE spawned). Otherwise the refusal to show. Never throws.
     */
    internal fun verifyProvenance(basePath: String, pid: Long, facts: (Long) -> ProcessFacts? = ::liveFacts): String? {
        val refusal = "Protected execution profile: the running Moe daemon (pid $pid) was not started by this IDE " +
            "from the installed Moe runtime. Stop it, then use Restart Daemon."
        return try {
            val daemon = facts(pid)
            val start = daemon?.start ?: return refusal
            val records = spawns[projectKey(basePath)] ?: return refusal
            if (records.any { it.pid == pid && it.start == start }) return null
            val parentPid = daemon.parentPid ?: return refusal
            val parentStart = facts(parentPid)?.start ?: return refusal
            // Only a supervisor vouches for a child, so nothing a daemon spawns can name itself.
            if (records.none { it.supervisor && it.pid == parentPid && it.start == parentStart }) return refusal
            // Recorded so the daemon stays verified if its supervisor dies (Process.destroy on Windows orphans it).
            records += SpawnRecord(pid, start, supervisor = false)
            null
        } catch (ex: Exception) {
            log.debug("Cannot verify the Moe daemon's provenance: ${ex.message}")
            refusal
        }
    }

    private fun liveFacts(pid: Long): ProcessFacts? = try {
        ProcessHandle.of(pid).map {
            ProcessFacts(it.pid(), it.info().startInstant().orElse(null), it.parent().map(ProcessHandle::pid).orElse(null))
        }.orElse(null)
    } catch (ex: Exception) {
        log.debug("Cannot read the facts of process $pid: ${ex.message}")
        null
    }

    internal fun resetForTest() {
        pinned.clear()
        spawns.clear()
    }

    /** A failure whose message names the broken rule and never the file's contents. */
    private class UntrustedSetting(message: String) : Exception(message)
}
