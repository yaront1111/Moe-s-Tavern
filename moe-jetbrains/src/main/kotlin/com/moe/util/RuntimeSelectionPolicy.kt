package com.moe.util

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
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
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.HexFormat
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

sealed interface RuntimeSelection {
    data class Accepted(val file: File) : RuntimeSelection
    data class Rejected(val reason: String) : RuntimeSelection
}

/** LEGACY keeps the historical runtime selection; PROTECTED runs only the runtime installed with the plugin. */
enum class RuntimeProfile { LEGACY, PROTECTED }

/** Never blocks the caller; only an explicit human confirmation may answer true. */
fun interface DowngradeConfirmer {
    fun ask(basePath: String, answer: (Boolean) -> Unit)
}

/**
 * The one place JetBrains decides which Moe controller, wrapper, proxy and node it may run.
 *
 * The profile mirrors the daemon's resolveExecutionProfile (delivery/executionProfile.ts) but
 * fails closed: only a confirmed-absent setting, "legacy" or "observe" keeps the legacy
 * selection. Anything the daemon would reject, or this IDE cannot read strictly, is PROTECTED.
 * The confirmed profile persists outside the repository: a weaker repository declaration cannot
 * downgrade a confirmed-protected project without human confirmation, effective after an IDE restart.
 */
object RuntimeSelectionPolicy {
    private val log = Logger.getInstance(RuntimeSelectionPolicy::class.java)
    private const val MAX_PROJECT_JSON_BYTES = 1 shl 20
    private val gson = Gson()
    private val DRIVE_ROOT = Regex("^[A-Za-z]:/$")
    private val DEVICE_PREFIX = Regex("^//[?.]/(unc/)?", RegexOption.IGNORE_CASE)
    private const val PLUGIN_ID = "com.moe.jetbrains"

    // Projects read as verified-local or awaiting a downgrade decision this JVM session. A later
    // repository edit cannot downgrade them; even an explicitly confirmed downgrade waits for restart.
    // The atomic add also ensures only one confirmation request per project per session.
    private val pinned: MutableSet<String> = ConcurrentHashMap.newKeySet()

    @Volatile
    internal var confirmer: DowngradeConfirmer = ProfileDowngradeDialog

    private enum class StoredProfile { ABSENT, LEGACY, PROTECTED, UNTRUSTED }
    private val PROFILE_FIELDS = setOf("version", "project", "profile")

    /** Domain-separated from daemon provenance, while using the same owner-only store and name rule. */
    internal fun profileRecordName(basePath: String): String = recordsFile("profile:" + projectKey(basePath))

    private fun storedProfile(basePath: String, key: String): StoredProfile {
        return try {
            val text = usableStore(basePath)?.read(recordsFile("profile:$key")) ?: return StoredProfile.ABSENT
            val root = parseStrict(text, "the profile record").fields(PROFILE_FIELDS, "the profile record")
            if (root.get("version").exactLong() != 1L) throw UntrustedSetting("the profile record is not version 1")
            if (root.get("project").stringOrNull() != key) throw UntrustedSetting("the profile record is for another project")
            when (root.get("profile").stringOrNull()) {
                "protected" -> StoredProfile.PROTECTED
                "legacy" -> StoredProfile.LEGACY
                else -> throw UntrustedSetting("the profile record is not protected or legacy")
            }
        } catch (ex: Exception) {
            log.warn("Moe runtime selection distrusts the persisted profile: ${describe(ex)}")
            StoredProfile.UNTRUSTED
        }
    }

    private fun persist(basePath: String, key: String, value: RuntimeProfile) {
        try {
            val store = usableStore(basePath) ?: return
            val text = gson.toJson(linkedMapOf("version" to 1, "project" to key, "profile" to value.name.lowercase(Locale.ROOT)))
            store.write(recordsFile("profile:$key"), text)
        } catch (ex: Exception) {
            log.warn("Moe runtime selection could not persist the confirmed profile: ${describe(ex)}")
        }
    }

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
        val stored = storedProfile(basePath, key)
        if (verifiedLocal) {
            pinned += key
            if (stored != StoredProfile.PROTECTED) persist(basePath, key, RuntimeProfile.PROTECTED)
        } else {
            if (stored == StoredProfile.ABSENT || stored == StoredProfile.LEGACY) {
                // Another reader may have pinned and confirmed a downgrade while this one was reading the store.
                return if (key in pinned) RuntimeProfile.PROTECTED else RuntimeProfile.LEGACY
            }
            if (pinned.add(key)) askDowngrade(basePath, key)
        }
        return RuntimeProfile.PROTECTED
    }

    private fun askDowngrade(basePath: String, key: String) {
        val answered = AtomicBoolean(false)
        try {
            confirmer.ask(basePath) { allow ->
                if (answered.compareAndSet(false, true) && allow) persist(basePath, key, RuntimeProfile.LEGACY)
            }
        } catch (ex: Exception) {
            log.warn("Moe keeps the protected profile: downgrade confirmation failed (${ex.javaClass.simpleName})")
        }
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
    // which Gson would skip, so a BOM is untrusted too. [label] names the file in the failure.
    private fun parseStrict(text: String, label: String = "project.json"): JsonElement {
        if (text.startsWith('\uFEFF')) throw UntrustedSetting("$label starts with a byte order mark")
        val reader = JsonReader(StringReader(text)).apply { strictness = Strictness.STRICT }
        val root = gson.getAdapter(JsonElement::class.java).read(reader)
        if (reader.peek() != JsonToken.END_DOCUMENT) throw UntrustedSetting("$label has content after the document")
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

    /**
     * A supervisor this IDE started from the installed runtime, or a daemon such a supervisor started.
     * [daemon] names that installed daemon as [installedDaemonKey] does; only records that name it persist.
     */
    internal data class SpawnRecord(val pid: Long, val start: Instant, val supervisor: Boolean, val daemon: String? = null)

    // Per project key, the protected processes this JVM session started or verified.
    private val spawns = ConcurrentHashMap<String, MutableSet<SpawnRecord>>()

    // Records also outlive the session in the IDE's owner-only store, which plain JUnit lacks; tests swap in their own.
    private val ideStore by lazy { ProtectedStateStore.forIde() }

    @Volatile
    internal var store: () -> ProtectedStateStore? = { ideStore }

    // One read-modify-write of the store at a time in this JVM; another JVM only ever sees a whole file.
    private val storeLock = Any()
    private const val RECORDS_VERSION = 1
    private val FILE_FIELDS = setOf("version", "project", "records")
    private val RECORD_FIELDS = setOf("pid", "start", "supervisor", "daemon")

    /** How a spawn record names [installedDaemon]: its comparable real path, or null when it does not resolve. */
    internal fun installedDaemonKey(installedDaemon: File?): String? =
        installedDaemon?.let { realPathOrNull(it.path) }?.let { comparablePath(it.toString(), defaultFoldCase) }

    /** Remembers a supervisor this IDE started from [installedDaemon], the installed daemon. Never throws. */
    fun recordProtectedSpawn(basePath: String, handle: ProcessHandle, installedDaemon: File? = null) {
        try {
            val start = handle.info().startInstant().orElse(null)
            if (start == null) {
                log.debug("Moe daemon pid ${handle.pid()} reports no start instant, so it will not verify")
                return
            }
            remember(basePath, SpawnRecord(handle.pid(), start, supervisor = true, daemon = installedDaemonKey(installedDaemon)), ::liveFacts)
        } catch (ex: Exception) {
            log.debug("Cannot record the protected Moe daemon: ${ex.message}")
        }
    }

    /**
     * Adds [record] after pruning this project's records whose process is gone or whose pid was reused.
     * A record that names its installed daemon is persisted too, so it still verifies after an IDE restart.
     */
    internal fun remember(basePath: String, record: SpawnRecord, facts: (Long) -> ProcessFacts?) {
        val key = projectKey(basePath)
        val records = spawns.computeIfAbsent(key) { ConcurrentHashMap.newKeySet() }
        records.removeIf { facts(it.pid)?.start != it.start }
        records += record
        persist(basePath, key, record, facts)
    }

    /**
     * Null when this IDE started the daemon [pid] for this project: its own (pid, start) is
     * recorded, or its direct parent is a recorded supervisor (daemon.json names the `_run` child
     * of the `start` process the IDE spawned). Records come from this session, else, after an IDE
     * restart, from the store when they name [installedDaemon]. Otherwise the refusal to show. Never throws.
     */
    internal fun verifyProvenance(
        basePath: String, pid: Long, facts: (Long) -> ProcessFacts? = ::liveFacts, installedDaemon: File? = null
    ): String? {
        val refusal = "Protected execution profile: the running Moe daemon (pid $pid) was not started by this IDE " +
            "from the installed Moe runtime. Stop it, then use Restart Daemon."
        return try {
            val daemon = facts(pid)
            val start = daemon?.start ?: return refusal
            val key = projectKey(basePath)
            when {
                verifiedInSession(basePath, key, pid, start, daemon.parentPid, facts) -> null
                verifiedFromStore(basePath, key, Candidate(pid, start, daemon.parentPid), facts, installedDaemon) -> null
                else -> refusal
            }
        } catch (ex: Exception) {
            log.debug("Cannot verify the Moe daemon's provenance: ${ex.message}")
            refusal
        }
    }

    private fun verifiedInSession(
        basePath: String, key: String, pid: Long, start: Instant, parentPid: Long?, facts: (Long) -> ProcessFacts?
    ): Boolean {
        val records = spawns[key] ?: return false
        if (records.any { it.pid == pid && it.start == start }) return true
        val parentStart = parentPid?.let { facts(it)?.start } ?: return false
        // Only a supervisor vouches for a child, so nothing a daemon spawns can name itself.
        val supervisor = records.firstOrNull { it.supervisor && it.pid == parentPid && it.start == parentStart } ?: return false
        // Recorded, and persisted, so the daemon stays verified if its supervisor dies (Process.destroy on Windows orphans it).
        val child = SpawnRecord(pid, start, supervisor = false, daemon = supervisor.daemon)
        records += child
        persist(basePath, key, child, facts)
        return true
    }

    /** The daemon process being verified: what daemon.json names, as the OS reports it. */
    private data class Candidate(val pid: Long, val start: Instant, val parentPid: Long?)

    // After an IDE restart: the session's rules over this project's persisted records for the daemon installed now,
    // once the records whose process is gone or whose pid was reused are pruned.
    private fun verifiedFromStore(
        basePath: String, key: String, daemon: Candidate, facts: (Long) -> ProcessFacts?, installedDaemon: File?
    ): Boolean {
        val installed = installedDaemonKey(installedDaemon) ?: return false
        val store = usableStore(basePath) ?: return false
        synchronized(storeLock) {
            val stored = load(store, key) ?: return false
            val live = stored.filter { facts(it.pid)?.start == it.start }
            val records = live.filter { it.daemon == installed }
            val own = records.firstOrNull { it.pid == daemon.pid && it.start == daemon.start }
            val parentStart = daemon.parentPid?.let { facts(it)?.start }
            val supervisor = records.firstOrNull { it.supervisor && it.pid == daemon.parentPid && it.start == parentStart }
            val child = if (own == null && supervisor != null) SpawnRecord(daemon.pid, daemon.start, supervisor = false, daemon = installed) else null
            val kept = live + listOfNotNull(child)
            if (kept != stored) save(store, key, kept)
            val vouching = own ?: supervisor ?: return false
            spawns.computeIfAbsent(key) { ConcurrentHashMap.newKeySet() } += listOfNotNull(vouching, child)
            return true
        }
    }

    // Adds [record] to this project's persisted records when it names its installed daemon. Never throws: a
    // record the store cannot take stays in memory only.
    private fun persist(basePath: String, key: String, record: SpawnRecord, facts: (Long) -> ProcessFacts?) {
        if (record.daemon == null) return
        try {
            val store = usableStore(basePath) ?: return
            synchronized(storeLock) {
                // A file that cannot be read or trusted is replaced, so none of its records is ever trusted.
                val stored = load(store, key).orEmpty()
                save(store, key, stored.filter { it != record && facts(it.pid)?.start == it.start } + record)
            }
        } catch (ex: Exception) {
            log.warn("Moe daemon provenance stays in memory only: ${describe(ex)}")
        }
    }

    // The store, unless it lies inside the project: a runIde sandbox under the repository it opens keeps nothing.
    private fun usableStore(basePath: String): ProtectedStateStore? {
        val candidate = store() ?: return null
        if (candidate.usableFor(basePath)) return candidate
        log.debug("Moe daemon provenance is not persisted: the IDE state store is inside the project")
        return null
    }

    // This project's persisted records; null when there are none or, logged, when the file cannot be trusted.
    private fun load(store: ProtectedStateStore, key: String): List<SpawnRecord>? = try {
        val text = store.read(recordsFile(key))
        if (text == null) log.debug("No Moe daemon provenance is persisted for this project")
        text?.let { parseRecords(it, key) }
    } catch (ex: Exception) {
        log.warn("Moe protected runtime selection ignores the persisted daemon provenance: ${describe(ex)}")
        null
    }

    // Rewrites this project's persisted records, deleting the file once none is left. Never throws.
    private fun save(store: ProtectedStateStore, key: String, records: List<SpawnRecord>) {
        try {
            val name = recordsFile(key)
            if (records.isEmpty()) store.delete(name) else store.write(name, recordsJson(key, records))
        } catch (ex: Exception) {
            log.warn("Moe daemon provenance stays in memory only: ${describe(ex)}")
        }
    }

    // A sha-256 of the project key: the store never names the project's files, nor takes a path from input.
    private fun recordsFile(key: String): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))) + ".json"

    private fun recordsJson(key: String, records: List<SpawnRecord>): String {
        val array = JsonArray()
        records.forEach { record ->
            array.add(JsonObject().apply {
                addProperty("pid", record.pid)
                addProperty("start", record.start.toString())
                addProperty("supervisor", record.supervisor)
                addProperty("daemon", record.daemon)
            })
        }
        return gson.toJson(JsonObject().apply {
            addProperty("version", RECORDS_VERSION)
            addProperty("project", key)
            add("records", array)
        })
    }

    // Strict, and any broken rule refuses the whole file: exact fields and types, version 1 and this project's key.
    private fun parseRecords(text: String, key: String): List<SpawnRecord> {
        val root = parseStrict(text, "the provenance file").fields(FILE_FIELDS, "the provenance file")
        if (root.get("version").exactLong() != RECORDS_VERSION.toLong()) throw UntrustedSetting("the provenance file is not version 1")
        if (root.get("project").stringOrNull() != key) throw UntrustedSetting("the provenance file is for another project")
        val records = root.get("records").takeIf { it.isJsonArray }?.asJsonArray
            ?: throw UntrustedSetting("the provenance records are not an array")
        return records.map { parseRecord(it.fields(RECORD_FIELDS, "a provenance record")) }
    }

    private fun parseRecord(record: JsonObject): SpawnRecord {
        val pid = record.get("pid").exactLong()?.takeIf { it > 0 } ?: throw UntrustedSetting("a provenance pid is not a positive integer")
        val start = record.get("start").stringOrNull()?.let(::parseInstant) ?: throw UntrustedSetting("a provenance start is not an instant")
        val supervisor = record.get("supervisor").takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isBoolean }?.asBoolean
            ?: throw UntrustedSetting("a provenance supervisor flag is not a boolean")
        val daemon = record.get("daemon").stringOrNull() ?: throw UntrustedSetting("a provenance daemon is not a string")
        return SpawnRecord(pid, start, supervisor, daemon)
    }

    private fun JsonElement.fields(names: Set<String>, label: String): JsonObject =
        takeIf { it.isJsonObject && it.asJsonObject.keySet() == names }?.asJsonObject
            ?: throw UntrustedSetting("$label does not hold exactly ${names.joinToString()}")

    private fun JsonElement.stringOrNull(): String? = takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

    // Gson keeps a number's literal as written, so only a plain canonical integer passes: 1.0, 1e0 and 01 do not.
    private fun JsonElement.exactLong(): Long? = takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asString
        ?.let { literal -> literal.toLongOrNull()?.takeIf { it.toString() == literal } }

    private fun parseInstant(text: String): Instant? = try {
        Instant.parse(text)
    } catch (_: DateTimeParseException) {
        null
    }

    // Only the typed failures carry a message fit for the log; anything else is named by its class.
    private fun describe(ex: Exception): String? =
        if (ex is UntrustedSetting || ex is ProtectedStateStore.Untrusted) ex.message else ex.javaClass.simpleName

    private fun liveFacts(pid: Long): ProcessFacts? = try {
        ProcessHandle.of(pid).map {
            ProcessFacts(it.pid(), it.info().startInstant().orElse(null), it.parent().map(ProcessHandle::pid).orElse(null))
        }.orElse(null)
    } catch (ex: Exception) {
        log.debug("Cannot read the facts of process $pid: ${ex.message}")
        null
    }

    internal fun forgetSessionForTest() {
        pinned.clear()
        spawns.clear()
    }

    internal fun resetForTest() {
        forgetSessionForTest()
        store = { ideStore }
        confirmer = DowngradeConfirmer { _, _ -> }
    }

    /** A failure whose message names the broken rule and never the file's contents. */
    private class UntrustedSetting(message: String) : Exception(message)
}
