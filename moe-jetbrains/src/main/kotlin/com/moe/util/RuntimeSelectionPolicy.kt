package com.moe.util

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.jna.JnaLoader
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.extensions.PluginId
import com.sun.jna.platform.win32.Kernel32
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
 * On Windows a folder confirmed protected is also recognized under another spelling (subst, mapped, share or device) by file identity.
 */
object RuntimeSelectionPolicy {
    private val log = Logger.getInstance(RuntimeSelectionPolicy::class.java)
    private const val MAX_PROJECT_JSON_BYTES = 1 shl 20
    private val gson = Gson()
    private val DRIVE_ROOT = Regex("^[A-Za-z]:/$")
    private val LOCAL_DRIVE = Regex("^[A-Za-z]:/")
    private val DEVICE_PREFIX = Regex("^//[?.]/(unc/)?", RegexOption.IGNORE_CASE)
    private val DRIVE_QUALIFIED = Regex("""^[A-Za-z]:\\""")
    // A whole local volume, never a folder in one, a shadow copy or any other device family.
    private val LOCAL_DEVICE = Regex("""^\\Device\\(?:HarddiskVolume\d+|CdRom\d+|Floppy\d+|Ramdisk\d*)$""", RegexOption.IGNORE_CASE)
    private val DRIVE_LETTER = Regex("[A-Za-z]:")
    private const val MAX_WINDOWS_PATH = 32767
    private const val PLUGIN_ID = "com.moe.jetbrains"
    // VS Code (CQ-RF06b) refuses with the same words.
    private const val BASE_NOT_PLAIN = "the project directory is not a plain local Windows path"

    // Projects read as verified-local or awaiting a downgrade decision this JVM session. A later
    // repository edit cannot downgrade them; even an explicitly confirmed downgrade waits for restart.
    // The atomic add also ensures only one confirmation request per project per session.
    private val pinned: MutableSet<String> = ConcurrentHashMap.newKeySet()

    @Volatile
    internal var confirmer: DowngradeConfirmer = ProfileDowngradeDialog

    // File identity for the profile lookup under another spelling; tests replace it.
    @Volatile
    internal var sameDirectory: (Path, Path) -> Boolean = Files::isSameFile

    private enum class StoredProfile { ABSENT, LEGACY, PROTECTED, UNTRUSTED }
    private val PROFILE_FIELDS = setOf("version", "project", "profile")

    /** Domain-separated from daemon provenance, while using the same owner-only store and name rule. */
    internal fun profileRecordName(basePath: String): String = recordsFile("profile:" + projectKey(basePath))

    private fun storedProfile(basePath: String, key: String): StoredProfile {
        return try {
            // A pin only restricts, so it is read even for a base that is not a plain local base, or when the store root or
            // the base has no physical folder: a drive mapping cannot place it (as written, or through a junction, link or
            // subst), its real path cannot be found, or it has no drive at all. Unprovable is not absent, and must not turn
            // a pinned project legacy; a missing base reads as absent. Writes still need a store provably outside the project.
            val readable = store()?.takeIf {
                it.usableFor(basePath) ||
                    windowsHost && (physicalFolder(it.root) == null || unplainBase(basePath) || physicalFolder(Paths.get(basePath)) == null)
            }
            val text = readable?.read(recordsFile("profile:$key")) ?: return StoredProfile.ABSENT
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
            val weaker = stored == StoredProfile.ABSENT || stored == StoredProfile.LEGACY
            val aliases = if (weaker) protectedAliases(basePath, key) else emptyList()
            if (weaker && aliases.isEmpty()) {
                // Another reader may have pinned and confirmed a downgrade while this one was reading the store.
                return if (key in pinned) RuntimeProfile.PROTECTED else RuntimeProfile.LEGACY
            }
            if (aliases.isNotEmpty()) log.warn("Moe keeps the protected profile: ${aliases.size} other spelling(s) of this project were confirmed protected")
            if (pinned.add(key)) askDowngrade(basePath, key, aliases)
        }
        return RuntimeProfile.PROTECTED
    }

    // A confirmed downgrade also covers each matched spelling, under its own key, so no spelling of the folder asks again.
    private fun askDowngrade(basePath: String, key: String, aliases: List<String>) {
        val answered = AtomicBoolean(false)
        try {
            confirmer.ask(basePath) { allow ->
                if (answered.compareAndSet(false, true) && allow) {
                    persist(basePath, key, RuntimeProfile.LEGACY)
                    aliases.forEach { persist(it, it, RuntimeProfile.LEGACY) }
                }
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
    private fun projectKey(basePath: String): String = comparablePath(projectPath(basePath)?.toString() ?: basePath, defaultFoldCase)

    private fun projectPath(basePath: String): Path? = realPathOrNull(basePath) ?: try {
        Paths.get(basePath).toAbsolutePath().normalize()
    } catch (_: Exception) {
        null
    } catch (_: IOError) {
        null
    }

    /**
     * On a Windows host, the projects of PROTECTED records stored under another spelling of this folder: toRealPath keeps
     * a subst, mapped, share or device spelling, so each spelling keys its own record. It reads the store even where it is
     * not usable for [basePath] (a share or device base), since a match only makes the answer stricter and nothing is
     * written. Never throws: any failure matches nothing.
     */
    private fun protectedAliases(basePath: String, key: String): List<String> {
        if (!windowsHost) return emptyList()
        return try {
            val store = store() ?: return emptyList()
            val base = projectPath(basePath) ?: return emptyList()
            // A root (Z:\, \\srv\share\) has no name, so every named record is compared.
            val name = base.fileName?.let { comparablePath(it.toString(), defaultFoldCase) }
            store.names().mapNotNull { aliasOrNull(store, it, key, name, base) }
        } catch (ex: Exception) {
            log.warn("Moe runtime selection looked up no other spelling of the project: ${describe(ex)}")
            emptyList()
        } catch (_: IOError) {
            log.warn("Moe runtime selection looked up no other spelling of the project: IOError")
            emptyList()
        }
    }

    // [file]'s project when it is a strict protected record, under its own name, of another plain local spelling with
    // [base]'s folder name. Every check runs before anything is opened, so a share or device key from the store is never contacted.
    private fun aliasOrNull(store: ProtectedStateStore, file: String, key: String, name: String?, base: Path): String? = try {
        val record = store.read(file)?.let { parseStrict(it, "the profile record").fields(PROFILE_FIELDS, "the profile record") }
        val project = record?.takeIf { it.get("version").exactLong() == 1L && it.get("profile").stringOrNull() == "protected" }
            ?.get("project")?.stringOrNull()
        val stored = project?.takeIf { it != key && isPlainLocalPath(it) && recordsFile("profile:$it") == file }?.let { Paths.get(it) }
        val storedName = stored?.fileName?.let { comparablePath(it.toString(), defaultFoldCase) }
        if (storedName != null && (name == null || storedName == name) && sameDirectory(stored, base)) project else null
    } catch (_: Exception) {
        null
    } catch (_: IOError) {
        null
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

    internal val windowsHost: Boolean = System.getProperty("os.name").orEmpty().lowercase(Locale.ROOT).startsWith("windows")

    /**
     * On a Windows host only a drive-qualified form is plainly local. A UNC form (`\\srv\sh`,
     * `//srv/sh`, `\\?\UNC\…`, `\\.\UNC\…`) can reach any local folder through a share, and a
     * loopback admin share (`\\localhost\C$\<project>`) names the project itself. A device form
     * (`\\.\Volume{…}\…`, `\\.\GLOBALROOT\…`) names a folder without its drive. toRealPath keeps
     * both forms and nothing maps them back to the project, so neither is provably outside it.
     * comparablePath turns `\\?\C:\` and `\\.\C:\` into `C:/`, so those stay plain. No segment may
     * end in '.' or ' ', '.' and '..' included: Win32 resolves those segments and drops a trailing
     * '.' or ' ' when it reads a path, so `<tmp>\project.` names `<tmp>\project`, while toRealPath
     * returns a junction's target as written. POSIX has none of these forms: there the answer is always true.
     */
    internal fun isPlainLocalPath(path: String, windows: Boolean = windowsHost): Boolean =
        !windows || comparablePath(path, false).let { plain ->
            LOCAL_DRIVE.containsMatchIn(plain) && plain.split('/').none { it.endsWith('.') || it.endsWith(' ') }
        }

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

    /** Each drive letter's current DOS-device mapping, read by [queryWindowsDriveTarget]; tests replace it. */
    @Volatile
    internal var windowsDriveTarget: (String) -> String? = ::queryWindowsDriveTarget

    /**
     * Drive-qualified [path] with each subst letter replaced by its target (`\??\<folder>`), until its letter maps to a
     * whole local volume: the folder the OS opens, found without opening anything. Null for any other spelling, for a
     * remote (`\Device\LanmanRedirector\…`, `\??\UNC\…`), unknown, malformed or unreadable mapping, a cycle, or a path
     * longer than Windows allows. Each letter is queried at most once, so at most 26 queries.
     */
    internal fun resolveWindowsDrivePath(path: String, query: (String) -> String? = windowsDriveTarget): String? {
        var current = path.replace('/', '\\')
        val seen = HashSet<Char>()
        while (DRIVE_QUALIFIED.containsMatchIn(current) && current.length <= MAX_WINDOWS_PATH && seen.add(current[0].uppercaseChar())) {
            val mapping = try {
                query("${current[0].uppercaseChar()}:")
            } catch (_: Exception) {
                null
            } catch (_: IOError) {
                null
            } catch (_: LinkageError) {
                null
            } ?: return null
            if (LOCAL_DEVICE.matches(mapping)) return current
            current = (dosTarget(mapping) ?: return null) + current.substring(2)
        }
        return null
    }

    // A subst target: `\??\` and a drive-qualified folder whose segments are not empty and do not end in '.' or ' ' (Win32
    // renames those). Checked segment by segment, not by one regex: Java's regex recurses once per repeated group, so a deep
    // folder overflowed the stack.
    private fun dosTarget(mapping: String): String? {
        val target = mapping.takeIf { it.startsWith("\\??\\") }?.substring(4)?.removeSuffix("\\") ?: return null
        val segments = target.split('\\')
        return target.takeIf { DRIVE_LETTER.matches(segments[0]) && segments.drop(1).all(::plainSegment) }
    }

    private fun plainSegment(s: String) = s.isNotEmpty() && s.last() !in ". " && s.none { it < ' ' || it in "/:*?\"<>|" }

    // The IDE's own JNA, never a helper process; plain JUnit points it at the SDK's native library (build.gradle.kts).
    // Any failure, a JNA that cannot load included, is resolveWindowsDrivePath's to refuse.
    private fun queryWindowsDriveTarget(drive: String): String? {
        if (!JnaLoader.isLoaded()) return null
        val buffer = CharArray(MAX_WINDOWS_PATH + 1)
        return currentDosMapping(buffer, Kernel32.INSTANCE.QueryDosDevice(drive, buffer, buffer.size))
    }

    /** QueryDosDevice's current mapping: its first string, NUL-terminated within [count]. The strings after it are history. */
    internal fun currentDosMapping(buffer: CharArray, count: Int): String? =
        if (count !in 1..buffer.size) null else buffer.indexOf('\u0000').takeIf { it in 1 until count }?.let { String(buffer, 0, it) }

    // Asked before NIO opens [path]: QueryDosDevice opens nothing, so a letter that maps to a share is never contacted.
    private fun unprovableDrive(path: String): Boolean =
        DRIVE_QUALIFIED.containsMatchIn(path.replace('/', '\\')) && resolveWindowsDrivePath(path) == null

    /**
     * For a Windows host only: [path] is plainly local ([isPlainLocalPath]) on a drive whose mapping is proved a
     * local volume ([resolveWindowsDrivePath], once comparablePath drops a `\\?\` or `\\.\` prefix). The spelling is
     * judged first, so only an `X:` designator is ever looked up, and nothing is opened.
     */
    private fun isPlainLocalBase(path: String): Boolean =
        isPlainLocalPath(path) && resolveWindowsDrivePath(comparablePath(path, false)) != null

    // What isOutsideProject refuses a base for under protected on a Windows host: as written, or as its real path.
    private fun unplainBase(basePath: String): Boolean =
        !isPlainLocalBase(basePath) || realPathOrNull(basePath)?.let { !isPlainLocalBase(it.toString()) } == true

    /**
     * [real] once no drive letter on it stands for another folder: each expansion is resolved by the OS again, since
     * a subst target can hold a junction, until expanding changes nothing. Null when a mapping cannot be proved local,
     * a resolution fails, or the rounds repeat or pass 26.
     */
    private fun physicalPath(real: Path): Path? {
        var current = real
        val seen = HashSet<String>()
        while (seen.add(current.toString()) && seen.size <= 26) {
            val expanded = resolveWindowsDrivePath(current.toString()) ?: return null
            if (expanded == current.toString()) return current
            current = realPathOrNull(expanded) ?: return null
        }
        return null
    }

    // The real project as identity compares it: on a drive its physical folder; any other form as it resolved.
    private fun physicalProject(project: Path): Path? =
        if (DRIVE_QUALIFIED.containsMatchIn(project.toString())) physicalPath(project) else project

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
    fun installedArtifact(root: File?, relative: String, basePath: String, foldCase: Boolean = defaultFoldCase): RuntimeSelection =
        installedArtifact(root, relative, basePath, RuntimeProfile.PROTECTED, foldCase)

    // LEGACY Windows restart shares the installed-file checks, but not protected-only path restrictions.
    internal fun installedArtifact(
        root: File?, relative: String, basePath: String, profile: RuntimeProfile, foldCase: Boolean = defaultFoldCase
    ): RuntimeSelection {
        if (root != null && strict(profile) && unprovableDrive(root.path)) {
            return rejected("installed $relative is not a plain local Windows path", root)
        }
        val realRoot = root?.let { realPathOrNull(it.path) } ?: return RuntimeSelection.Rejected("installed Moe runtime not found")
        return select("installed $relative", basePath, foldCase, realRoot, profile) { File(root, relative).toPath().toRealPath() }
    }

    /** An absolute, real, regular file outside the project; a bare name is never looked up on PATH. */
    fun installedExecutable(path: String?, basePath: String, foldCase: Boolean = defaultFoldCase): RuntimeSelection =
        installedExecutable(path, basePath, RuntimeProfile.PROTECTED, foldCase)

    internal fun installedExecutable(
        path: String?, basePath: String, profile: RuntimeProfile, foldCase: Boolean = defaultFoldCase
    ): RuntimeSelection {
        if (path.isNullOrBlank()) return RuntimeSelection.Rejected("node executable not found")
        val candidate = try {
            Paths.get(path)
        } catch (ex: InvalidPathException) {
            return rejected("node executable is not a valid path", ex)
        }
        if (!candidate.isAbsolute) return RuntimeSelection.Rejected("node executable is not an absolute path")
        if (strict(profile) && unprovableDrive(candidate.toString())) {
            return rejected("node executable is not a plain local Windows path", candidate)
        }
        return select("node executable", basePath, foldCase, null, profile) { candidate.toRealPath() }
    }

    /**
     * True only for an absolute [path] outside the project, both as written and as the real path
     * it resolves to; on a Windows host both must also be plainly local ([isPlainLocalPath]), and
     * a spelling that is not is never looked up, so no share is contacted. On a Windows host
     * protected also needs file identity ([outsideByIdentity]) and opens nothing on a drive letter
     * it cannot prove local ([unprovableDrive]). There the base must also be a plain local base
     * ([isPlainLocalBase]), as written (judged before anything parses or opens it) and as its real
     * path; nothing is provably outside any other base. A relative or unparseable path, or any
     * failure, answers false. [resolve] is the real-path lookup, which tests substitute.
     */
    fun isOutsideProject(
        path: String,
        basePath: String,
        foldCase: Boolean = defaultFoldCase,
        resolve: (String) -> Path? = ::realPathOrNull
    ): Boolean = isOutsideProject(path, basePath, RuntimeProfile.PROTECTED, foldCase, resolve)

    internal fun isOutsideProject(
        path: String,
        basePath: String,
        profile: RuntimeProfile,
        foldCase: Boolean = defaultFoldCase,
        resolve: (String) -> Path? = ::realPathOrNull
    ): Boolean = try {
        val candidate = Paths.get(path)
        val provable = !strict(profile) || isPlainLocalBase(basePath) && !unprovableDrive(candidate.normalize().toString())
        val project = if (provable) realPathOrNull(basePath) else null
        // Lazy: Paths.get must not see a base the spelling check refused (JDK 17 throws on a trailing space).
        val projects by lazy {
            listOfNotNull(Paths.get(basePath).toAbsolutePath().normalize(), project).map { comparablePath(it.toString(), foldCase) }
        }
        // Looked up once, and only after the spelling passed.
        val real by lazy { resolve(path) }
        provable && (!strict(profile) || project != null && isPlainLocalBase(project.toString())) &&
            candidate.isAbsolute && (profile == RuntimeProfile.LEGACY || isPlainLocalPath(candidate.normalize().toString())) &&
            listOfNotNull(candidate.normalize(), real).map { it.toString() }.all { form ->
                (profile == RuntimeProfile.LEGACY || isPlainLocalPath(form)) &&
                    comparablePath(form, foldCase).let { c -> projects.none { isWithin(c, it) } }
            } &&
            (!strict(profile) || outsideByIdentity(real ?: candidate.normalize(), project?.let(::physicalProject))) &&
            (!strict(profile) || real != null || ancestorOutside(candidate.normalize(), basePath, foldCase, resolve))
    } catch (_: Exception) {
        false
    } catch (_: IOError) {
        false
    }

    /**
     * For a [path] that did not resolve: a folder created there later lands where its nearest existing ancestor really is
     * (behind a link, an 8.3 name, a subst or a mapped drive), so that ancestor answers for it, through every check above.
     * A [path] that exists without resolving (a dangling link, a failed lookup), or one with no existing ancestor (a removed
     * drive), proves nothing. Each call is on a strictly shorter path, so the recursion ends.
     */
    private fun ancestorOutside(path: Path, basePath: String, foldCase: Boolean, resolve: (String) -> Path?): Boolean {
        if (!Files.notExists(path, LinkOption.NOFOLLOW_LINKS)) return false
        var ancestor = path.parent
        while (ancestor != null && Files.notExists(ancestor, LinkOption.NOFOLLOW_LINKS)) ancestor = ancestor.parent
        return ancestor != null && isOutsideProject(ancestor.toString(), basePath, RuntimeProfile.PROTECTED, foldCase, resolve)
    }

    // Every check errs toward rejection: the root comparison is exact, the project one folded.
    private fun select(
        label: String, basePath: String, foldCase: Boolean, realRoot: Path?, profile: RuntimeProfile, resolve: () -> Path
    ): RuntimeSelection {
        val unresolved = RuntimeSelection.Rejected("the project directory cannot be resolved")
        // Refused, never canonicalized: toRealPath keeps a share or device base, and nothing maps a share back to a local
        // folder (localhost, 127/8, ::1, the host name, DFS, \\wsl$). Identity could match a loopback share only by
        // opening it, and a foreign redirector need not report NTFS file ids.
        if (strict(profile) && !isPlainLocalBase(basePath)) return rejected(BASE_NOT_PLAIN, basePath)
        val project = realPathOrNull(basePath) ?: return unresolved
        if (strict(profile) && !isPlainLocalBase(project.toString())) return rejected(BASE_NOT_PLAIN, project)
        val physical = if (strict(profile)) (physicalProject(project) ?: return unresolved) else null
        val real = try {
            resolve()
        } catch (ex: NoSuchFileException) {
            return rejected("$label not found", ex)
        } catch (ex: Exception) {
            return rejected("$label cannot be resolved", ex)
        }
        return when {
            // Before any further read, so a share is not contacted again.
            profile == RuntimeProfile.PROTECTED &&
                (!isPlainLocalPath(real.toString()) || strict(profile) && unprovableDrive(real.toString())) ->
                rejected("$label is not a plain local Windows path", real)
            !Files.isRegularFile(real) -> rejected("$label is not a regular file", real)
            realRoot != null && !isWithin(comparablePath(real.toString(), false), comparablePath(realRoot.toString(), false)) ->
                rejected("$label resolves outside the installed Moe runtime", real)
            isWithin(comparablePath(real.toString(), foldCase), comparablePath(project.toString(), foldCase)) ->
                rejected("$label resolves inside the project", real)
            // A lookup failure on a path toRealPath just resolved is practically unreachable; it refuses too.
            physical != null && !outsideByIdentity(real, physical) -> rejected("$label resolves inside the project", real)
            else -> RuntimeSelection.Accepted(real.toFile())
        }
    }

    private fun strict(profile: RuntimeProfile): Boolean = profile == RuntimeProfile.PROTECTED && windowsHost

    /**
     * On Windows toRealPath calls GetFinalPathNameByHandle only at a reparse point, so a subst letter is never
     * resolved: `Q:\bin` can be `<project>\bin` with no shared prefix, and as a drive root `Z:\` for `<project>\bin`
     * has no parent, hiding every folder above it. So [path] is expanded ([resolveWindowsDrivePath]), its nearest existing
     * folder resolved to its [physicalPath] ([physicalFolder]), and from there each folder up to the root compared with
     * the physical [project] by file identity (volume serial + file index). True only when one comparison ran and none
     * matched; a missing folder defers to its parent, and any other failure, unprovable mapping or missing project
     * answers false. Node's realpath.native resolves these letters, so VS Code needs no twin.
     */
    private fun outsideByIdentity(path: Path, project: Path?): Boolean {
        if (project == null) return false
        try {
            var folder = physicalFolder(path)
            var proved = false
            while (folder != null) {
                if (Files.isSameFile(folder, project)) return false
                proved = true
                folder = folder.parent
            }
            return proved
        } catch (_: Exception) {
            return false
        } catch (_: IOError) {
            return false
        }
    }

    /**
     * [path]'s nearest existing folder as file identity compares it ([physicalPath]). Null when a drive on the way cannot be
     * proved local, a resolution fails, or nothing on the way exists. The drive lookup is asked before NIO opens anything,
     * so nothing is opened through a drive its spelling cannot place. Never throws.
     */
    private fun physicalFolder(path: Path): Path? {
        try {
            var current: Path? = Paths.get(resolveWindowsDrivePath(path.toString()) ?: return null)
            var real: Path? = null
            while (real == null && current != null) {
                try {
                    real = current.toRealPath()
                } catch (_: NoSuchFileException) {
                    current = current.parent
                }
            }
            return real?.let(::physicalPath)
        } catch (_: Exception) {
            return null
        } catch (_: IOError) {
            return null
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

    // The store, only where it is provably outside the project: a runIde sandbox under the repository it opens keeps nothing.
    private fun usableStore(basePath: String): ProtectedStateStore? {
        val candidate = store() ?: return null
        if (candidate.usableFor(basePath)) return candidate
        log.debug("Moe protected state is not persisted: the IDE state store is not provably outside the project")
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
        sameDirectory = Files::isSameFile
        windowsDriveTarget = ::queryWindowsDriveTarget
    }

    /** A failure whose message names the broken rule and never the file's contents. */
    private class UntrustedSetting(message: String) : Exception(message)
}
