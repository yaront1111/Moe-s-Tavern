package com.moe.util

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.services.MoeDaemonSupervisor
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.util.RuntimeSelectionPolicy.ProcessFacts
import com.moe.util.RuntimeSelectionPolicy.SpawnRecord
import com.moe.util.TerminalAgentLauncher.ProtectedAgentRuntime
import com.moe.util.TerminalAgentLauncher.ResolvedScript
import com.moe.util.TerminalAgentLauncher.ScriptKind
import com.moe.util.TerminalAgentLauncher.ScriptSource
import org.junit.After
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.AclEntry
import java.nio.file.attribute.AclEntryPermission
import java.nio.file.attribute.AclEntryType
import java.nio.file.attribute.AclFileAttributeView
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermissions
import java.time.Instant
import java.util.Optional
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RuntimeSelectionPolicyTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Before
    fun resetBefore() = RuntimeSelectionPolicy.resetForTest()

    @After
    fun resetAfter() = RuntimeSelectionPolicy.resetForTest()

    @Test
    fun `D1 a downgrade needs confirmation across restarts and stays pinned until the next restart`() = withProfileStore { store, dir, asks ->
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        assertEquals(valid, store.read(name))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(store.root.toString(), dir.path))
        assertOwnerOnly(store.root.resolve(name), directory = false)
        RuntimeSelectionPolicy.remember(dir.path, SpawnRecord(100, T0, true, daemonKey(installedDaemon())), LIVE::get)
        assertEquals("separate profile and provenance records", 2, storeFiles(store).size)
        assertTrue(asks.paths.isEmpty())
        writeProfile(dir, "legacy")
        RuntimeSelectionPolicy.forgetSessionForTest()
        val calls = (1..8).map { CompletableFuture.supplyAsync { profileOf(dir) } }
        calls.forEach { assertEquals(RuntimeProfile.PROTECTED, it.get(5, TimeUnit.SECONDS)) }
        assertEquals(listOf(dir.path), asks.paths)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        RuntimeSelectionPolicy.forgetSessionForTest() // No answer is a dismissal.
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(2, asks.paths.size)
        asks.answers.last()(false)
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(3, asks.paths.size)
        assertEquals(valid, store.read(name))
        asks.answers.last()(true)
        assertEquals(profileJson(dir, "legacy"), store.read(name))
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.LEGACY, profileOf(dir))
        assertEquals(3, asks.paths.size)
        listOf("""{"settings":{"executionProfile":"observe"}}""", """{"settings":{}}""", null).forEach { weaker ->
            val other = project("""{"settings":{"executionProfile":"verified-local"}}""")
            assertEquals(RuntimeProfile.PROTECTED, profileOf(other))
            if (weaker == null) assertTrue(File(other, ".moe/project.json").delete()) else writeProjectJson(other, weaker)
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.PROTECTED, profileOf(other))
            assertEquals(other.path, asks.paths.last())
        }
        assertEquals(6, asks.paths.size)
    }

    @Test
    fun `D6 a delayed reader honors a concurrent session pin after confirmation`() = withProfileStore { store, dir, asks ->
        store.write(RuntimeSelectionPolicy.profileRecordName(dir.path), profileJson(dir, "protected"))
        writeProfile(dir, "legacy")
        val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        RuntimeSelectionPolicy.store = {
            if (entered.count > 0) { entered.countDown(); assertTrue(resume.await(5, TimeUnit.SECONDS)) }
            store
        }
        val delayed = CompletableFuture.supplyAsync { profileOf(dir) }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            asks.answers.single()(true)
        } finally { resume.countDown() }
        assertEquals(RuntimeProfile.PROTECTED, delayed.get(5, TimeUnit.SECONDS))
    }
    @Test
    fun `D2 upgrades need no confirmation and unavailable stores preserve session-only behavior`() = withProfileStore { store, dir, asks ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        store.write(name, profileJson(dir, "legacy"))
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(profileJson(dir, "protected"), store.read(name))
        val fresh = project("""{"settings":{"executionProfile":"legacy"}}""")
        assertEquals(RuntimeProfile.LEGACY, profileOf(fresh))
        assertNull(store.read(RuntimeSelectionPolicy.profileRecordName(fresh.path)))
        listOf(null, ProtectedStateStore(File(dir, "state").toPath())).forEach { unavailable ->
            RuntimeSelectionPolicy.store = { unavailable }
            RuntimeSelectionPolicy.forgetSessionForTest()
            writeProfile(dir, "verified-local")
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            writeProfile(dir, "legacy")
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.LEGACY, profileOf(dir))
            assertFalse(File(dir, "state").exists())
        }
        assertTrue(asks.paths.isEmpty())
    }

    @Test
    fun `D3 untrusted profile documents fail closed and explicit confirmation repairs them`() = withProfileStore { store, dir, asks ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        writeProfile(dir, "legacy")
        val bad = listOf("not JSON", valid.replace("\"version\":", "version:"), "\uFEFF$valid", "[]",
            valid.replace("\"version\":1", "\"version\":1,\"extra\":true"), valid.replace("\"version\":1,", ""),
            valid.replace("\"version\":1", "\"version\":2"), valid.replace("\"version\":1", "\"version\":\"1\""),
            valid.replace("\"version\":1", "\"version\":1.0"), profileJson(temporaryFolder.newFolder(), "protected"),
            valid.replace("\"protected\"", "\"verified-local\""), valid.replace("\"protected\"", "\"PROTECTED\""),
            valid.replace("\"protected\"", "null"))
        bad.forEachIndexed { index, text ->
            store.write(name, text)
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals("case $index", RuntimeProfile.PROTECTED, profileOf(dir))
            assertEquals(index + 1, asks.paths.size)
            if (index == 0) {
                asks.answers.last()(true)
                assertEquals(profileJson(dir, "legacy"), store.read(name))
                assertOwnerOnly(store.root.resolve(name), directory = false)
                RuntimeSelectionPolicy.forgetSessionForTest()
                assertEquals(RuntimeProfile.LEGACY, profileOf(dir))
            }
        }
    }

    @Test
    fun `D3 a directory or loosened profile record fails closed`() = withProfileStore { store, dir, asks ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        store.write(name, valid)
        writeProfile(dir, "legacy")
        val file = store.root.resolve(name)
        Files.delete(file)
        Files.createDirectory(file)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(listOf(dir.path), asks.paths)
        Files.delete(file)
        store.write(name, valid)
        try {
            assumeTrue("no permission view or Everyone principal", loosen(file, directory = false))
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            assertEquals(2, asks.paths.size)
        } finally {
            store.write(name, valid) // Atomic replacement restores owner-only access, even after an assertion fails.
        }
    }

    @Test
    fun `D4 confirmer failures do not downgrade and only the first answer counts`() = withProfileStore { store, dir, _ ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        writeProfile(dir, "legacy")
        listOf<Boolean?>(null, true, false).forEach { first ->
            store.write(name, valid)
            RuntimeSelectionPolicy.forgetSessionForTest()
            RuntimeSelectionPolicy.confirmer = DowngradeConfirmer { _, answer ->
                if (first == null) throw IllegalStateException("confirmer unavailable")
                answer(first)
                answer(!first)
            }
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            assertEquals(profileJson(dir, if (first == true) "legacy" else "protected"), store.read(name))
        }
    }

    @Test
    fun `D4 store failures and malformed project reads never escape`() = withProfileStore { store, dir, asks ->
        writeProjectJson(dir, "{")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertTrue(storeFiles(store).isEmpty())
        assertTrue(asks.paths.isEmpty())
        writeProfile(dir, "legacy")
        assertEquals("malformed read did not pin", RuntimeProfile.LEGACY, profileOf(dir))
        Files.createDirectories(store.root.parent)
        Files.writeString(store.root, "not a directory")
        writeProfile(dir, "verified-local")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        writeProfile(dir, "legacy")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertTrue(asks.paths.isEmpty())
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(listOf(dir.path), asks.paths)
        asks.answers.single()(true) // Failed persistence never escapes the answer callback either.
        assertEquals("not a directory", Files.readString(store.root))
    }

    @Test
    fun `D5 only Allow Downgrade confirms and a missing application declines without UI`() {
        listOf(-1, 0, 1, 2).forEach { assertEquals(it == 1, ProfileDowngradeDialog.confirmed(it)) }
        val answers = mutableListOf<Boolean>()
        ProfileDowngradeDialog.ask("/project") { answers += it }
        assertEquals(listOf(false), answers)
    }

    private class RecordingConfirmer : DowngradeConfirmer {
        val paths = CopyOnWriteArrayList<String>()
        val answers = CopyOnWriteArrayList<(Boolean) -> Unit>()
        override fun ask(basePath: String, answer: (Boolean) -> Unit) { paths += basePath; answers += answer }
    }

    private fun withProfileStore(test: (ProtectedStateStore, File, RecordingConfirmer) -> Unit) {
        try {
            val store = useStore()
            val asks = RecordingConfirmer().also { RuntimeSelectionPolicy.confirmer = it }
            test(store, project("""{"settings":{"executionProfile":"verified-local"}}"""), asks)
        } finally {
            RuntimeSelectionPolicy.resetForTest()
        }
    }

    private fun writeProfile(dir: File, value: String) = writeProjectJson(dir, """{"settings":{"executionProfile":"$value"}}""")

    private fun profileJson(dir: File, value: String): String = Gson().toJson(linkedMapOf(
        "version" to 1, "project" to comparable(realFile(dir).path, RuntimeSelectionPolicy.defaultFoldCase), "profile" to value))

    @Test
    fun `P1 absent, legacy and observe settings keep the legacy selection`() {
        assertEquals("no .moe", RuntimeProfile.LEGACY, profileOf(temporaryFolder.newFolder()))
        val noFile = temporaryFolder.newFolder().also { File(it, ".moe").mkdirs() }
        assertEquals("no project.json", RuntimeProfile.LEGACY, profileOf(noFile))
        mapOf(
            "empty object" to "{}",
            "empty settings" to """{"settings":{}}""",
            "legacy" to """{"settings":{"executionProfile":"legacy"}}""",
            "observe" to """{"settings":{"executionProfile":"observe"}}""",
            "exactly 1 MiB" to padded("""{"settings":{"executionProfile":"legacy"}}""", MIB)
        ).forEach { (label, json) -> assertEquals(label, RuntimeProfile.LEGACY, profileOf(project(json))) }
        assertEquals("blank basePath", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile(""))
        assertEquals("whitespace basePath", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile("  "))
    }

    @Test
    fun `P2 every other setting and every untrusted file fail closed to protected`() {
        listOf(
            "\"verified-local\"", "null", "\"\"", "\"Verified-Local\"", "\"bogus\"", "\" legacy\"",
            "0", "true", "[\"legacy\"]", "{}"
        ).forEach { value ->
            val json = """{"settings":{"executionProfile":$value}}"""
            assertEquals(value, RuntimeProfile.PROTECTED, profileOf(project(json)))
        }
        mapOf(
            "settings null" to """{"settings":null}""",
            "settings string" to """{"settings":"legacy"}""",
            "settings array" to """{"settings":[]}""",
            "root array" to "[]",
            "root string" to "\"legacy\"",
            "empty file" to "",
            "truncated" to """{"settings":""",
            "lenient" to "{settings:{executionProfile:'legacy'}}",
            "comment" to """{"settings":{}} // legacy""",
            "trailing content" to """{"settings":{}} x""",
            "second document" to """{"settings":{}} {}""",
            "byte order mark" to "﻿{\"settings\":{}}",
            "duplicate key, verified-local last" to
                """{"settings":{"executionProfile":"legacy","executionProfile":"verified-local"}}""",
            "over 1 MiB" to padded("""{"settings":{}}""", MIB + 1)
        ).forEach { (label, json) -> assertEquals(label, RuntimeProfile.PROTECTED, profileOf(project(json))) }
        val directory = temporaryFolder.newFolder().also { File(it, ".moe/project.json").mkdirs() }
        assertEquals("project.json is a directory", RuntimeProfile.PROTECTED, profileOf(directory))
    }

    @Test
    fun `P2 a dangling project json link fails closed`() {
        val dir = temporaryFolder.newFolder()
        val link = File(dir, ".moe").apply { mkdirs() }.toPath().resolve("project.json")
        assumeTrue("links unavailable on this host", symlink(link, dir.toPath().resolve("missing.json")))

        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
    }

    @Test
    fun `P3 an explicit verified-local read pins protected selection for the session`() {
        val dir = project("""{"settings":{"executionProfile":"verified-local"}}""")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))

        writeProjectJson(dir, """{"settings":{"executionProfile":"legacy"}}""")
        assertEquals("rewritten to legacy", RuntimeProfile.PROTECTED, profileOf(dir))
        assertTrue(File(dir, ".moe/project.json").delete())
        assertEquals("file deleted", RuntimeProfile.PROTECTED, profileOf(dir))
        File(dir, "sub").mkdirs()
        val dotDot = listOf(dir.path, "sub", "..").joinToString(File.separator)
        assertEquals("sub/.. alias", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(dotDot))
        assertEquals("trailing separator", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(dir.path + File.separator))
        val other = project("""{"settings":{"executionProfile":"legacy"}}""")
        assertEquals("another project", RuntimeProfile.LEGACY, profileOf(other))
        val alias = File(temporaryFolder.root, "alias").toPath()
        assumeTrue("links unavailable on this host", symlink(alias, dir.toPath()))
        assertEquals("link alias", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(alias.toString()))
    }

    @Test
    fun `P4 a fail-closed read never pins`() {
        val malformed = project("""{"settings":""")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(malformed))
        writeProjectJson(malformed, """{"settings":{"executionProfile":"legacy"}}""")
        assertEquals("malformed then legacy", RuntimeProfile.LEGACY, profileOf(malformed))

        val unknown = project("""{"settings":{"executionProfile":"bogus"}}""")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(unknown))
        writeProjectJson(unknown, """{"settings":{"executionProfile":"observe"}}""")
        assertEquals("unknown then observe", RuntimeProfile.LEGACY, profileOf(unknown))
    }

    @Test
    fun `N1 comparablePath normalizes Windows, UNC and POSIX forms`() {
        assertEquals("c:/users/me/proj", RuntimeSelectionPolicy.comparablePath("C:\\Users\\Me\\Proj\\", true))
        assertEquals("c:/users/me/proj", RuntimeSelectionPolicy.comparablePath("\\\\?\\C:\\Users\\Me\\Proj", true))
        assertEquals("//server/share/p", RuntimeSelectionPolicy.comparablePath("\\\\?\\UNC\\server\\share\\p", false))
        assertEquals("//server/share/p", RuntimeSelectionPolicy.comparablePath("\\\\?\\unc\\server\\share\\p", false))
        assertEquals("c:/users/me", RuntimeSelectionPolicy.comparablePath("\\\\.\\C:\\Users\\Me", true))
        assertEquals("//server/share", RuntimeSelectionPolicy.comparablePath("\\\\.\\UNC\\server\\share", false))
        assertEquals("//server/share", RuntimeSelectionPolicy.comparablePath("\\\\server\\share\\", false))
        assertEquals("c:/", RuntimeSelectionPolicy.comparablePath("C:\\", true))
        assertEquals("C:/Users", RuntimeSelectionPolicy.comparablePath("C:\\Users", false))
        assertEquals("/A/b", RuntimeSelectionPolicy.comparablePath("/A/b/", false))
        assertEquals("/", RuntimeSelectionPolicy.comparablePath("/", false))
        // NTFS equates dotless i (U+0131) with I, so folding upper-cases before lower-casing.
        assertEquals("c:/prij", RuntimeSelectionPolicy.comparablePath("C:\\Pr\u0131j", true))
    }

    @Test
    fun `N2 isWithin compares whole path segments`() {
        assertTrue(RuntimeSelectionPolicy.isWithin("/w/proj", "/w/proj"))
        assertTrue(RuntimeSelectionPolicy.isWithin("/w/proj/a/b", "/w/proj"))
        assertFalse(RuntimeSelectionPolicy.isWithin("/w/proj-evil", "/w/proj"))
        assertFalse(RuntimeSelectionPolicy.isWithin("/w/pro", "/w/proj"))
        assertTrue(RuntimeSelectionPolicy.isWithin("/etc", "/"))
        assertTrue(RuntimeSelectionPolicy.isWithin("c:/users", "c:/"))
        assertTrue(RuntimeSelectionPolicy.isWithin("//server/share/p", "//server/share"))
        assertFalse(RuntimeSelectionPolicy.isWithin("//server/shared", "//server/share"))
        val child = "C:\\Users\\ME\\Proj\\x"
        val parent = "c:\\users\\me\\proj"
        assertTrue(RuntimeSelectionPolicy.isWithin(comparable(child, true), comparable(parent, true)))
        assertFalse(RuntimeSelectionPolicy.isWithin(comparable(child, false), comparable(parent, false)))
    }

    @Test
    fun `N3 installedArtifact accepts only real files inside the root and outside the project`() {
        val project = temporaryFolder.newFolder("project")
        val root = installedLayout(temporaryFolder.newFolder("installed"))

        assertEquals(
            RuntimeSelection.Accepted(realFile(File(root, "daemon/index.js"))),
            RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", project.path)
        )
        File(temporaryFolder.root, "outside.js").writeText("outside")
        val sandbox = installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains"))
        val missingProject = File(temporaryFolder.root, "gone").path
        mapOf(
            "missing file" to listOf(root, "daemon/missing.js", project.path, "installed daemon/missing.js not found"),
            "directory" to listOf(root, "daemon", project.path, "installed daemon is not a regular file"),
            "null root" to listOf(null, "daemon/index.js", project.path, "installed Moe runtime not found"),
            "missing root" to listOf(File(temporaryFolder.root, "nowhere"), "daemon/index.js", project.path, "installed Moe runtime not found"),
            "root inside the project" to listOf(sandbox, "daemon/index.js", project.path, "installed daemon/index.js resolves inside the project"),
            "dot-dot escape" to listOf(root, "../outside.js", project.path, "installed ../outside.js resolves outside the installed Moe runtime"),
            "missing project" to listOf(root, "daemon/index.js", missingProject, "the project directory cannot be resolved")
        ).forEach { (label, row) ->
            val selection = RuntimeSelectionPolicy.installedArtifact(row[0] as File?, row[1] as String, row[2] as String)
            assertEquals(label, row[3], assertRejected(label, selection))
        }
        // Headless, the plugin is not loaded: the root is null or an existing directory, never a throw.
        RuntimeSelectionPolicy.installedRoot()?.let { assertTrue("installed root $it", it.isDirectory) }
    }

    @Test
    fun `N3 links into the project are rejected wherever they sit`() {
        val project = temporaryFolder.newFolder("project")
        val planted = installedLayout(File(project, "planted"))
        val root = temporaryFolder.newFolder("installed")
        assumeTrue("links unavailable on this host", symlink(File(root, "daemon").toPath(), File(planted, "daemon").toPath()))
        assertEquals(
            "installed daemon/index.js resolves outside the installed Moe runtime",
            assertRejected("link under the root", RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", project.path))
        )

        val linkedRoot = File(temporaryFolder.newFolder("plugins"), "moe-jetbrains")
        assumeTrue("links unavailable on this host", symlink(linkedRoot.toPath(), planted.toPath()))
        assertEquals(
            "installed daemon/index.js resolves inside the project",
            assertRejected("root linked into the project", RuntimeSelectionPolicy.installedArtifact(linkedRoot, "daemon/index.js", project.path))
        )
    }

    @Test
    fun `N4 installedExecutable requires an absolute regular file outside the project`() {
        val project = temporaryFolder.newFolder("project")
        val inProject = File(project, "node").apply { writeText("node") }
        val outside = File(temporaryFolder.newFolder("runtime"), "node").apply { writeText("node") }
        listOf(
            null to "node executable not found",
            "" to "node executable not found",
            "  " to "node executable not found",
            "node" to "node executable is not an absolute path",
            "./node" to "node executable is not an absolute path",
            temporaryFolder.root.path to "node executable is not a regular file",
            inProject.path to "node executable resolves inside the project",
            File(project, "absent").path to "node executable not found"
        ).forEach { (path, reason) ->
            assertEquals("node $path", reason, assertRejected("node $path", RuntimeSelectionPolicy.installedExecutable(path, project.path)))
        }

        assertEquals(RuntimeSelection.Accepted(realFile(outside)), RuntimeSelectionPolicy.installedExecutable(outside.path, project.path))
        val linkedDir = File(temporaryFolder.root, "linked-runtime")
        assumeTrue("links unavailable on this host", symlink(linkedDir.toPath(), project.toPath()))
        val linked = RuntimeSelectionPolicy.installedExecutable(File(linkedDir, "node").path, project.path)
        assertEquals("node executable resolves inside the project", assertRejected("node through a link into the project", linked))
    }

    @Test
    fun `N5 on Windows only drive-qualified forms are plainly local`() {
        listOf(
            "\\\\srv\\sh\\x", "//srv/sh/x", "\\\\?\\UNC\\srv\\sh\\x", "\\\\.\\UNC\\srv\\sh\\x", "\\\\localhost\\C$\\proj",
            "\\\\127.0.0.1\\C$\\proj", "\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\proj",
            "\\\\.\\GLOBALROOT\\Device\\Mup\\localhost\\C$\\proj", "C:", "\\proj", "proj"
        ).forEach { assertFalse(it, RuntimeSelectionPolicy.isPlainLocalPath(it, windows = true)) }
        listOf("C:\\proj", "c:/proj", "C:\\", "\\\\?\\C:\\proj", "\\\\.\\C:\\proj")
            .forEach { assertTrue(it, RuntimeSelectionPolicy.isPlainLocalPath(it, windows = true)) }
        listOf("//srv/sh/x", "\\\\srv\\sh\\x", "/w/proj")
            .forEach { assertTrue("POSIX $it", RuntimeSelectionPolicy.isPlainLocalPath(it, windows = false)) }
    }

    @Test
    fun `N6 on Windows a UNC or device path is never provably outside the project and never looked up`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val project = temporaryFolder.newFolder("project")
        val outside = temporaryFolder.newFolder("outside")
        // An Error, so isOutsideProject's error handling cannot swallow it: any lookup fails the test.
        val untouched: (String) -> Path? = { throw AssertionError("looked up $it") }
        // The outside folder through the loopback share is refused too: the accepted cost.
        (nonLocalSpellings(project) + share("localhost", outside)).forEach { spelling ->
            assertFalse("$spelling without a lookup", RuntimeSelectionPolicy.isOutsideProject(spelling, project.path, resolve = untouched))
            assertFalse(spelling, RuntimeSelectionPolicy.isOutsideProject(spelling, project.path))
        }
        // A plain spelling whose real path is UNC; Paths.get of a UNC string does no I/O.
        listOf(share("localhost", outside), "\\\\srv\\sh\\outside").forEach { real ->
            assertFalse("real path $real", RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, resolve = { Paths.get(real) }))
        }
        // Controls: the same folder, plainly spelled and resolved locally, is outside.
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, resolve = { Paths.get(it).toRealPath() }))
    }

    @Test
    fun `V1 a recorded supervisor verifies its daemon, which stays verified after the supervisor exits`() {
        val dir = temporaryFolder.newFolder("a").path
        val live = mutableMapOf(100L to ProcessFacts(100, T0, 1), 200L to ProcessFacts(200, T1, 100))
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true), live::get)
        assertNull("child of the recorded supervisor", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get))
        live.remove(100L)
        assertNull("supervisor gone", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get))
    }

    @Test
    fun `V2 reused pids, missing facts, unrelated processes and other projects are refused`() {
        val dir = temporaryFolder.newFolder("a").path
        val other = temporaryFolder.newFolder("b").path
        listOf(dir to 100L, dir to 300L, dir to 600L, dir to 800L, other to 400L).forEach { (project, pid) ->
            RuntimeSelectionPolicy.remember(project, SpawnRecord(pid, T0, supervisor = true)) { ProcessFacts(it, T0, 1) }
        }
        // 800 is pruned while its pid is gone, so it never verifies again.
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(801, T0, supervisor = true)) { if (it == 800L) null else ProcessFacts(it, T0, 1) }
        val live = mapOf(
            100L to ProcessFacts(100, T0, 1),
            300L to ProcessFacts(300, T1, 1), // pid 300 now belongs to a later process
            301L to ProcessFacts(301, null, 100), // no start instant
            303L to ProcessFacts(303, T1, 999), 999L to ProcessFacts(999, T0, 1), // an unrelated parent
            400L to ProcessFacts(400, T0, 1), // recorded for another project
            500L to ProcessFacts(500, T1, 600), 600L to ProcessFacts(600, T1, 1), // the parent's pid was reused
            800L to ProcessFacts(800, T0, 1),
            200L to ProcessFacts(200, T1, 100), 700L to ProcessFacts(700, T1, 200) // 700 is a child of the daemon 200
        )
        mapOf(
            "reused pid" to 300L, "no start" to 301L, "unknown pid" to 302L, "unrelated process" to 303L,
            "another project" to 400L, "reused parent pid" to 500L, "pruned record" to 800L
        ).forEach { (label, pid) -> assertEquals(label, refusal(pid), RuntimeSelectionPolicy.verifyProvenance(dir, pid, live::get)) }
        assertNull("daemon of a recorded supervisor", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get))
        assertEquals("a daemon's own child", refusal(700), RuntimeSelectionPolicy.verifyProvenance(dir, 700, live::get))
        val self = ProcessHandle.current().pid()
        assertEquals("the IDE's own pid", refusal(self), RuntimeSelectionPolicy.verifyProvenance(dir, self))
    }

    @Test
    fun `V3 a real spawn record verifies only for its own project`() {
        val a = temporaryFolder.newFolder("a").path
        val b = temporaryFolder.newFolder("b").path
        val self = ProcessHandle.current()
        RuntimeSelectionPolicy.recordProtectedSpawn(a, self)
        assertNull(RuntimeSelectionPolicy.verifyProvenance(a, self.pid()))
        assertEquals(refusal(self.pid()), RuntimeSelectionPolicy.verifyProvenance(b, self.pid()))
        // `sort` waits on stdin on every OS: a live child of the recorded process verifies through its parent.
        val child = ProcessBuilder("sort").start()
        try {
            assertNull("child of a recorded process", RuntimeSelectionPolicy.verifyProvenance(a, child.pid()))
            assertEquals(refusal(child.pid()), RuntimeSelectionPolicy.verifyProvenance(b, child.pid()))
        } finally {
            child.destroyForcibly().waitFor()
        }

        // A handle without a start instant is not recorded; one whose info fails never throws.
        val noStart = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ProcessHandle.Info::class.java)) { _, _, _ ->
            Optional.empty<Any>()
        } as ProcessHandle.Info
        RuntimeSelectionPolicy.recordProtectedSpawn(b, fakeHandle(42) { noStart })
        RuntimeSelectionPolicy.recordProtectedSpawn(b, fakeHandle(43) { throw UnsupportedOperationException("info") })
        listOf(T0, Instant.EPOCH).forEach { start ->
            assertEquals("start $start", refusal(42), RuntimeSelectionPolicy.verifyProvenance(b, 42, facts = { ProcessFacts(42, start, null) }))
        }
        RuntimeSelectionPolicy.resetForTest()
        assertEquals("after reset", refusal(self.pid()), RuntimeSelectionPolicy.verifyProvenance(a, self.pid()))
    }

    @Test
    fun `PS1 a state write leaves the root and the file owner-only and reads back`() {
        val store = newStore()
        store.write(NAME_A, """{"version":1}""")
        assertOwnerOnly(store.root, directory = true)
        assertOwnerOnly(store.root.resolve(NAME_A), directory = false)
        assertEquals("""{"version":1}""", store.read(NAME_A))

        store.write(NAME_A, "replaced")
        assertEquals("replaced", store.read(NAME_A))
        assertOwnerOnly(store.root.resolve(NAME_A), directory = false)
        assertEquals("no temporary file is left behind", listOf(NAME_A), store.root.toFile().list()?.toList())
        store.delete(NAME_A)
        assertNull("deleted", store.read(NAME_A))
        store.delete(NAME_A)
    }

    @Test
    fun `PS2 a loosened state file or root reads as untrusted until the next write`() {
        listOf(false, true).forEach { loosenRoot ->
            val store = newStore().apply { write(NAME_A, "text") }
            val target = if (loosenRoot) store.root else store.root.resolve(NAME_A)
            assumeTrue("cannot grant another principal access on this host", loosen(target, directory = loosenRoot))
            assertThrows("root=$loosenRoot", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_A) }
            store.write(NAME_A, "rewritten")
            assertEquals("root=$loosenRoot rewritten", "rewritten", store.read(NAME_A))
            assertOwnerOnly(store.root, directory = true)
        }
    }

    @Test
    fun `PS3 absent, oversize, linked and badly named state files`() {
        val store = newStore()
        assertNull("no root yet", store.read(NAME_A))
        store.write(NAME_B, "other")
        assertNull("absent file", store.read(NAME_A))
        val cap = ProtectedStateStore.MAX_BYTES
        store.write(NAME_A, "x".repeat(cap))
        assertEquals("exactly the cap", cap, store.read(NAME_A)?.length)
        Files.write(store.root.resolve(NAME_A), byteArrayOf(' '.code.toByte()), StandardOpenOption.APPEND)
        assertThrows("one byte over the cap", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_A) }
        assertThrows("a write over the cap", ProtectedStateStore.Untrusted::class.java) { store.write(NAME_B, "x".repeat(cap + 1)) }
        assertEquals("a refused write keeps the old bytes", "other", store.read(NAME_B))

        val hex = "a".repeat(64)
        listOf("", "x.json", "../$NAME_A", "sub/$NAME_A", File.separator + NAME_A, hex, "A".repeat(64) + ".json", "a".repeat(63) + ".json", "$NAME_A.tmp")
            .forEach { bad ->
                assertThrows("read '$bad'", IllegalArgumentException::class.java) { store.read(bad) }
                assertThrows("write '$bad'", IllegalArgumentException::class.java) { store.write(bad, "x") }
                assertThrows("delete '$bad'", IllegalArgumentException::class.java) { store.delete(bad) }
            }
        assertEquals("bad names wrote nothing", listOf(NAME_A, NAME_B), store.root.toFile().list()?.sorted())

        // An owner-only file the IDE wrote elsewhere is still refused through a link, as is a linked root.
        val elsewhere = newStore().apply { write(NAME_C, "elsewhere") }
        assumeTrue("links unavailable on this host", symlink(store.root.resolve(NAME_C), elsewhere.root.resolve(NAME_C)))
        assertThrows("linked file", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_C) }
        val linkedRoot = ProtectedStateStore(temporaryFolder.root.toPath().resolve("linked-root"))
        assumeTrue("links unavailable on this host", symlink(linkedRoot.root, elsewhere.root))
        assertThrows("linked root read", ProtectedStateStore.Untrusted::class.java) { linkedRoot.read(NAME_C) }
        assertThrows("linked root write", ProtectedStateStore.Untrusted::class.java) { linkedRoot.write(NAME_C, "planted") }
        assertEquals("elsewhere", elsewhere.read(NAME_C))
    }

    @Test
    fun `PS4 a state root inside the project is not usable for it`() {
        val project = temporaryFolder.newFolder("project")
        val sandbox = ProtectedStateStore(File(project, "build/idea-sandbox/system/moe/protected-state").toPath())
        assertFalse("sandbox under the project", sandbox.usableFor(project.path))
        assertFalse("the project itself", ProtectedStateStore(project.toPath()).usableFor(project.path))
        val outside = ProtectedStateStore(temporaryFolder.root.toPath().resolve("system/moe/protected-state"))
        assertTrue("outside the project", outside.usableFor(project.path))
    }

    @Test
    fun `PS5 plain JUnit has no IDE state store`() {
        assertNull(ProtectedStateStore.forIde())
    }

    @Test
    fun `PS6 absence requires a directory above the state root`() {
        val store = newStore()
        assertNull("fresh root below a directory", store.read(NAME_A))
        Files.createDirectories(store.root.parent)
        Files.writeString(store.root, "not a directory")
        assertThrows("regular-file root", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_A) }
        assertEquals("read leaves the root unchanged", "not a directory", Files.readString(store.root))

        val blockedParent = newStore()
        Files.writeString(blockedParent.root.parent, "not a directory")
        // Windows throws Untrusted; POSIX throws the lookup's own 'Not a directory' FileSystemException.
        assertThrows("regular-file parent", IOException::class.java) { blockedParent.read(NAME_A) }
    }

    @Test
    fun `PS7 absence requires an owner-only link-free root but permits linked parents`() {
        val loosened = newStore().apply { write(NAME_B, "other") }
        assumeTrue("cannot grant another principal access on this host", loosen(loosened.root, directory = true))
        assertThrows("absent file under a loosened root", ProtectedStateStore.Untrusted::class.java) { loosened.read(NAME_A) }

        val elsewhere = newStore().apply { write(NAME_B, "other") }
        val linkedRoot = ProtectedStateStore(temporaryFolder.root.toPath().resolve("linked-root"))
        assumeTrue("links unavailable on this host", symlink(linkedRoot.root, elsewhere.root))
        assertThrows("absent file under a linked root", ProtectedStateStore.Untrusted::class.java) { linkedRoot.read(NAME_A) }

        val system = temporaryFolder.root.toPath().resolve("linked-system")
        assumeTrue("links unavailable on this host", symlink(system, temporaryFolder.newFolder().toPath()))
        val linkedParent = ProtectedStateStore(system.resolve("moe/protected-state"))
        assertNull("fresh root below a linked directory", linkedParent.read(NAME_A))
        linkedParent.write(NAME_A, "round trip")
        assertEquals("round trip", linkedParent.read(NAME_A))
    }

    @Test
    fun `PP1 a persisted supervisor verifies its daemon after a restart, which then stays verified without it`() {
        val store = useStore()
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        val live = mutableMapOf(100L to ProcessFacts(100, T0, 1), 200L to ProcessFacts(200, T1, 100))
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon)), live::get)
        assertEquals("the supervisor is persisted", listOf(100L), storedPids(store))
        RuntimeSelectionPolicy.forgetSessionForTest()

        assertNull("child after a restart", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get, daemon))
        assertEquals("the child is persisted", listOf(100L, 200L), storedPids(store))
        RuntimeSelectionPolicy.forgetSessionForTest()
        live.remove(100L)
        assertNull("supervisor gone", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get, daemon))
        assertEquals("the dead supervisor is pruned", listOf(200L), storedPids(store))

        // The usual order: the spawning session verifies the child through its supervisor, and that persists the child too.
        val second = temporaryFolder.newFolder("second").path
        val session = mutableMapOf(110L to ProcessFacts(110, T0, 1), 210L to ProcessFacts(210, T1, 110))
        RuntimeSelectionPolicy.remember(second, SpawnRecord(110, T0, supervisor = true, daemon = daemonKey(daemon)), session::get)
        assertNull("child in the spawning session", RuntimeSelectionPolicy.verifyProvenance(second, 210, session::get))
        RuntimeSelectionPolicy.forgetSessionForTest()
        session.remove(110L)
        assertNull("that child after a restart", RuntimeSelectionPolicy.verifyProvenance(second, 210, session::get, daemon))

        // A store that cannot be written never throws, and the session keeps its record in memory.
        val blocked = File(temporaryFolder.root, "not-a-directory").apply { writeText("file") }
        RuntimeSelectionPolicy.store = { ProtectedStateStore(blocked.toPath().resolve("protected-state")) }
        val third = temporaryFolder.newFolder("third").path
        RuntimeSelectionPolicy.remember(third, SpawnRecord(120, T0, supervisor = true, daemon = daemonKey(daemon))) { ProcessFacts(it, T0, 1) }
        assertNull("in memory", RuntimeSelectionPolicy.verifyProvenance(third, 120, { ProcessFacts(it, T0, 1) }, daemon))
    }

    @Test
    fun `PP2a persisted records verify nothing for another daemon, project or pid, the daemon's child, or from inside the project`() {
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        // The stored supervisor verifies itself and its child, so each refusal below comes from the one thing it changes.
        persistedSession(dir, daemon)
        assertVerified("baseline", dir, daemon)
        // That persisted the child too, yet only a supervisor vouches: the daemon's own child stays unverified.
        RuntimeSelectionPolicy.forgetSessionForTest()
        val grandchild = LIVE + (300L to ProcessFacts(300, T1, 200))
        assertEquals("the daemon's child", refusal(300), RuntimeSelectionPolicy.verifyProvenance(dir, 300, grandchild::get, daemon))

        persistedSession(dir, daemon)
        assertRefused("another installed daemon", dir, installedDaemon())
        assertRefused("no installed daemon", dir, null)
        assertRefused("an installed daemon that does not resolve", dir, File(temporaryFolder.root, "missing/daemon/index.js"))
        assertRefused("another project", temporaryFolder.newFolder("b").path, daemon)
        assertRefused("a reused pid", dir, daemon, mapOf(100L to ProcessFacts(100, T1, 1), 200L to ProcessFacts(200, T1, 100)))

        val foreign = persistedSession(temporaryFolder.newFolder("c").path, daemon).let { it.read(storeFiles(it).single())!! }
        persistedSession(dir, daemon).let { it.write(storeFiles(it).single(), foreign) }
        assertRefused("a file under this project's name for another project", dir, daemon)

        val (name, valid) = persistedSession(dir, daemon).let { store -> storeFiles(store).single().let { it to store.read(it)!! } }
        val inProject = ProtectedStateStore(File(dir, "state").toPath())
        RuntimeSelectionPolicy.store = { inProject }
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon))) { ProcessFacts(it, T0, 1) }
        assertFalse("nothing is written inside the project", inProject.root.toFile().exists())
        inProject.write(name, valid)
        assertRefused("a valid file in a store inside the project", dir, daemon)
    }

    @Test
    fun `PP2b a persisted file the IDE would not have written verifies nothing`() {
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        val valid = persistedSession(dir, daemon).let { it.read(storeFiles(it).single())!! }
        fun rewrite(text: String) = persistedSession(dir, daemon).let { it.write(storeFiles(it).single(), text) }
        rewrite(valid)
        assertVerified("the valid file, rewritten", dir, daemon)
        mapOf(
            "truncated JSON" to valid.dropLast(1),
            "a byte order mark" to "\uFEFF" + valid,
            "trailing content" to "$valid {}",
            "lenient JSON" to valid.replace("\"version\":", "version:"),
            "version 2" to valid.replace("\"version\":1", "\"version\":2"),
            "version 1.0" to valid.replace("\"version\":1", "\"version\":1.0"),
            "a missing project" to valid.replace(Regex("\"project\":\"[^\"]*\","), ""),
            "a missing record field" to valid.replace(",\"supervisor\":true", ""),
            "an extra record field" to valid.replace("\"supervisor\":true", "\"supervisor\":true,\"extra\":true"),
            "an extra top-level field" to valid.replace("\"version\":1", "\"version\":1,\"extra\":1"),
            "a string pid" to valid.replace("\"pid\":100", "\"pid\":\"100\""),
            "a string supervisor" to valid.replace("\"supervisor\":true", "\"supervisor\":\"true\""),
            "records as an object" to valid.replace(Regex("\"records\":\\[(.*)]}$"), "\"records\":$1}")
        ).forEach { (label, text) ->
            assertTrue("$label changes the file", text != valid)
            rewrite(text)
            assertRefused(label, dir, daemon)
        }

        rewrite(valid + " ".repeat(ProtectedStateStore.MAX_BYTES - valid.toByteArray(Charsets.UTF_8).size))
        // The supervisor's own record adds no child, so this verify leaves the file exactly 64 KiB.
        assertNull("exactly 64 KiB", RuntimeSelectionPolicy.verifyProvenance(dir, 100, LIVE::get, daemon))
        RuntimeSelectionPolicy.store()!!.let { Files.write(it.root.resolve(storeFiles(it).single()), byteArrayOf(' '.code.toByte()), StandardOpenOption.APPEND) }
        assertRefused("over 64 KiB", dir, daemon)

        persistedSession(dir, daemon).let { store ->
            assumeTrue("cannot grant another principal access on this host", loosen(store.root.resolve(storeFiles(store).single()), directory = false))
        }
        assertRefused("a loosened file", dir, daemon)
    }

    @Test
    fun `PP3 a verify or a new record prunes persisted records whose process is gone or whose pid was reused`() {
        val store = useStore()
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        listOf(100L, 300L, 500L).forEach {
            RuntimeSelectionPolicy.remember(dir, SpawnRecord(it, T0, supervisor = true, daemon = daemonKey(daemon))) { pid -> ProcessFacts(pid, T0, 1) }
        }
        assertEquals(listOf(100L, 300L, 500L), storedPids(store))
        RuntimeSelectionPolicy.forgetSessionForTest()

        // 300 is gone and 500 now names a later process; 100 still runs, and 900 was never recorded.
        val live = mapOf(100L to ProcessFacts(100, T0, 1), 500L to ProcessFacts(500, T1, 1), 900L to ProcessFacts(900, T1, 1))
        assertEquals(refusal(900), RuntimeSelectionPolicy.verifyProvenance(dir, 900, live::get, daemon))
        assertEquals(listOf(100L), storedPids(store))
        assertEquals(refusal(900), RuntimeSelectionPolicy.verifyProvenance(dir, 900, (live - 100L)::get, daemon))
        assertEquals("the file goes with its last record", emptyList<String>(), storeFiles(store))

        listOf(300L, 500L).forEach {
            RuntimeSelectionPolicy.remember(dir, SpawnRecord(it, T0, supervisor = true, daemon = daemonKey(daemon))) { pid -> ProcessFacts(pid, T0, 1) }
        }
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon)), live::get)
        assertEquals("a new record prunes the same way", listOf(100L), storedPids(store))
    }

    @Test
    fun `S1 protected selection runs only the installed node and daemon`() {
        val (project, root, node) = protectedFixture()
        listOf(false to emptyList(), true to listOf("--host", "wsl")).forEach { (wsl, host) ->
            val started = mutableListOf<List<String>>()
            val dirs = mutableListOf<File?>()
            val supervisor = supervisorFor(project, root = { root }, node = { node.path }, wsl = wsl, started = started, dirs = dirs)
            assertTrue("wsl=$wsl", supervisor.ensureDaemonRunning())
            val expected = listOf(realFile(node).path, realFile(File(root, "daemon/index.js")).path, "start", "--project", project.path) + host
            assertEquals("wsl=$wsl", listOf(expected), started)
            // An IDE started inside a repository must not lend the daemon that working directory.
            assertEquals("wsl=$wsl", listOf(realFile(File(root, "daemon"))), dirs)
            assertNull(supervisor.selectionRefusal())
        }
        // The spawn is recorded: a process whose handle is this JVM then passes activation.
        RuntimeSelectionPolicy.resetForTest()
        val self = ProcessHandle.current()
        val recorded = MoeDaemonSupervisor(project.path, "Test Project", processStarter = { IdleProcess(self) },
            profile = { RuntimeProfile.PROTECTED }, installedRoot = { root }, nodeExecutable = { node.path })
        assertTrue(recorded.ensureDaemonRunning())
        assertNull("recorded spawn", recorded.activationRefusal(DaemonInfo(9876, self.pid().toInt(), "now", project.path)))
    }

    @Test
    fun `S2 a protected refusal starts nothing and stays visible`() {
        val (project, root, node) = protectedFixture()
        val inProjectNode = File(project, "node").apply { writeText("node") }
        val sandbox = installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains"))
        mapOf(
            "installed Moe runtime not found" to Pair<File?, String?>(null, node.path),
            "installed daemon/index.js not found" to Pair<File?, String?>(temporaryFolder.newFolder("empty-root"), node.path),
            "installed daemon/index.js resolves inside the project" to Pair<File?, String?>(sandbox, node.path),
            "node executable not found" to Pair<File?, String?>(root, null),
            "node executable resolves inside the project" to Pair<File?, String?>(root, inProjectNode.path)
        ).forEach { (reason, setup) ->
            val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
            val started = mutableListOf<List<String>>()
            val statuses = mutableListOf<Pair<Boolean, String>>()
            var profile = RuntimeProfile.PROTECTED
            val supervisor = supervisorFor(project, { setup.first }, { setup.second }, profile = { profile }, started = started, statuses = statuses)
            assertFalse(reason, supervisor.ensureDaemonRunning())
            assertEquals(reason, emptyList<List<String>>(), started)
            assertEquals(reason, listOf(false to message), statuses)
            assertEquals(reason, message, supervisor.selectionRefusal())
            profile = RuntimeProfile.LEGACY
            assertNull("$reason under legacy", supervisor.selectionRefusal())
        }
        var nodePath: String? = null
        val recovering = supervisorFor(project, { root }, { nodePath })
        assertFalse(recovering.ensureDaemonRunning())
        nodePath = node.path
        recovering.resetSpawnBackoff()
        assertTrue("a later accepted selection", recovering.ensureDaemonRunning())
        assertNull("an accepted selection clears the refusal", recovering.selectionRefusal())
    }

    @Test
    fun `S3 legacy selection still prefers the project daemon`() {
        val (project, root, node) = protectedFixture()
        val started = mutableListOf<List<String>>()
        val dirs = mutableListOf<File?>()
        val supervisor = supervisorFor(project, { root }, { node.path }, profile = { RuntimeProfile.LEGACY }, started = started, dirs = dirs)
        assertTrue(supervisor.ensureDaemonRunning())
        assertEquals(File(project, "packages/moe-daemon/dist/index.js").absolutePath, started.single()[1])
        assertEquals("legacy keeps the IDE's working directory", listOf<File?>(null), dirs)
        assertNull(supervisor.selectionRefusal())
    }

    @Test
    fun `S4 the protected daemon environment cannot reach repository code`() {
        val (project, _, node) = protectedFixture()
        val supervisor = supervisorFor(project, { null }, { null })
        val outsideA = temporaryFolder.newFolder("path-a").path
        val outsideB = node.parentFile.path
        val spaced = temporaryFolder.newFolder("path c").path
        val padded = temporaryFolder.newFolder("path-d").path
        val alias = File(temporaryFolder.root, "path-alias")
        val unbuilt = File(project, "node_modules/.bin").path
        // Edge-quoted spellings: libuv's Windows PATH search strips one leading or trailing ' or ", so they must never be kept.
        val edgeQuoted = listOf("${project.path}'", "'${project.path}", "$outsideA'", "$outsideA\"")
        val entries = mutableListOf(outsideA, "", "bin", ".", unbuilt, project.path, "\"${File(project, "tools").path}\"", "  ",
            "/bad\u0000path", "  $padded  ", *edgeQuoted.toTypedArray(), "\"$spaced\"", outsideB)
        val linked = symlink(alias.toPath(), project.toPath())
        if (linked) entries += alias.path
        // Unbuilt project dirs have no real path, so only the folded comparison catches a case variant.
        if (RuntimeSelectionPolicy.defaultFoldCase) entries += unbuilt.uppercase()
        val env = mutableMapOf("NODE_OPTIONS" to "--require ./evil.js", "NODE_PATH" to project.path, "HOME" to "home",
            "PATH" to entries.joinToString(File.pathSeparator))
        supervisor.protectedDaemonEnvironment(env, project.path)
        // Each kept entry is exactly the spelling that was validated: trimmed and unquoted.
        val kept = listOf(outsideA, padded, spaced, outsideB).joinToString(File.pathSeparator)
        assertEquals(mapOf("HOME" to "home", "PATH" to kept), env)
        if (linked) {
            val throughAlias = mutableMapOf("PATH" to listOf(project.path, outsideA).joinToString(File.pathSeparator))
            supervisor.protectedDaemonEnvironment(throughAlias, alias.path)
            assertEquals("project addressed through a link", mapOf("PATH" to outsideA), throughAlias)
        }

        val windows = System.getProperty("os.name").startsWith("Windows")
        val nodeName = if (windows) "node.exe" else "node"
        File(project, "bin").mkdirs()
        File(project, "bin/$nodeName").writeText("planted")
        File(outsideB, nodeName).writeText("node")
        val path = listOf(File(project, "bin").path, "bin", "\"$outsideB\"").joinToString(File.pathSeparator)
        assertEquals(File(outsideB, nodeName).absolutePath, supervisor.nodeOnProtectedPath(path, project.path, windows))
    }

    @Test
    fun `S7 on Windows the protected daemon PATH keeps only plain local entries outside the project`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, _, node) = protectedFixture()
        val supervisor = supervisorFor(project, { null }, { null })
        val outsideA = temporaryFolder.newFolder("path-a").path
        val outsideB = node.parentFile.path
        val entries = listOf(outsideA) + nonLocalSpellings(project) + share("localhost", File(outsideA)) + outsideB
        val env = mutableMapOf("PATH" to entries.joinToString(File.pathSeparator))
        supervisor.protectedDaemonEnvironment(env, project.path)
        assertEquals(mapOf("PATH" to listOf(outsideA, outsideB).joinToString(File.pathSeparator)), env)
    }

    @Test
    fun `S8 on Windows a node whose real path is not plain local spawns nothing`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        val volumeNode = volumeSpelling(node)
        val volumeRoot = volumeSpelling(root)
        assumeTrue("no volume GUID path on this host", volumeNode != null && volumeRoot != null)
        val reason = "node executable is not a plain local Windows path"
        assertEquals(reason, assertRejected("volume node", RuntimeSelectionPolicy.installedExecutable(volumeNode, project.path)))
        assertEquals(
            "installed daemon/index.js is not a plain local Windows path",
            assertRejected("volume root", RuntimeSelectionPolicy.installedArtifact(File(volumeRoot!!), "daemon/index.js", project.path))
        )

        val started = mutableListOf<List<String>>()
        val statuses = mutableListOf<Pair<Boolean, String>>()
        val supervisor = supervisorFor(project, { root }, { volumeNode }, started = started, statuses = statuses)
        val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals(emptyList<List<String>>(), started)
        assertEquals(listOf(false to message), statuses)
        assertEquals(message, supervisor.selectionRefusal())

        // Through the loopback share the real path is UNC; whether the share is reachable varies, the refusal never does.
        val shared = share("localhost", node)
        val viaShare = assertRejected("node through the loopback share", RuntimeSelectionPolicy.installedExecutable(shared, project.path))
        if (Files.isRegularFile(Paths.get(shared))) assertEquals("node through the loopback share", reason, viaShare)

        assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, project.path))
    }

    @Test
    fun `S5 activation requires provenance only under the protected profile`() {
        val (project, root, node) = protectedFixture()
        var profile = RuntimeProfile.LEGACY
        val supervisor = supervisorFor(project, { root }, { node.path }, profile = { profile })
        val pid = ProcessHandle.current().pid()
        val info = DaemonInfo(9876, pid.toInt(), "now", project.path)
        assertNull("legacy", supervisor.activationRefusal(info))
        profile = RuntimeProfile.PROTECTED
        assertEquals("unrecorded", refusal(pid), supervisor.activationRefusal(info))
        RuntimeSelectionPolicy.recordProtectedSpawn(project.path, ProcessHandle.current())
        assertNull("recorded", supervisor.activationRefusal(info))
    }

    @Test
    fun `S6 after an IDE restart the daemon a protected supervisor started activates only for its project and installed daemon`() {
        val store = useStore()
        val (project, root, node) = protectedFixture()
        val self = ProcessHandle.current()
        val spawning = MoeDaemonSupervisor(project.path, "Test Project", processStarter = { IdleProcess(self) },
            profile = { RuntimeProfile.PROTECTED }, installedRoot = { root }, nodeExecutable = { node.path })
        assertTrue(spawning.ensureDaemonRunning())
        // The IDE restarts: a new supervisor serves the project, and nothing of the earlier session is remembered.
        fun afterRestart(dir: File, installed: File): String? {
            RuntimeSelectionPolicy.forgetSessionForTest()
            return MoeDaemonSupervisor(dir.path, "Test Project", profile = { RuntimeProfile.PROTECTED }, installedRoot = { installed },
                nodeExecutable = { node.path }).activationRefusal(DaemonInfo(9876, self.pid().toInt(), "now", dir.path))
        }
        assertNull("its project and installed daemon", afterRestart(project, root))
        assertEquals("another installed daemon", refusal(self.pid()), afterRestart(project, installedLayout(temporaryFolder.newFolder("other-installed"))))
        assertEquals("another project", refusal(self.pid()), afterRestart(temporaryFolder.newFolder("other-project"), root))
        Files.delete(store.root.resolve(storeFiles(store).single()))
        assertEquals("no persisted record", refusal(self.pid()), afterRestart(project, root))
    }

    @Test
    fun `L1 protected agents use the installed wrapper, daemon and proxy in the legacy order`() {
        val project = temporaryFolder.newFolder("project")
        listOf("scripts/moe-agent.sh", "scripts/moe-agent.ps1").forEach {
            File(project, it).apply { parentFile.mkdirs() }.writeText("repo $it")
        }
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val env = mapOf(
            "MOE_DAEMON_PATH" to realFile(File(root, "daemon/index.js")).path,
            "MOE_PROXY_PATH" to realFile(File(root, "proxy/index.js")).path,
            "MOE_RUNTIME_PROTECTED" to "1"
        )
        val ps1 = ResolvedScript(realFile(File(root, "scripts/moe-agent.ps1")), ScriptSource.BUNDLED, ScriptKind.POWERSHELL)
        val sh = ResolvedScript(realFile(File(root, "scripts/moe-agent.sh")), ScriptSource.BUNDLED, ScriptKind.BASH)
        val inProject = comparable(realFile(project).path, true)
        listOf(Triple(true, false, ps1), Triple(true, true, sh), Triple(false, false, sh), Triple(false, true, sh))
            .forEach { (windows, preferBash, script) ->
                val label = "windows=$windows preferBash=$preferBash"
                val selection = TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, preferBash, root, windows)
                assertEquals(label, ProtectedAgentRuntime.Selected(script, env), selection)
                (listOf(env.getValue("MOE_DAEMON_PATH"), env.getValue("MOE_PROXY_PATH")) + script.file.path).forEach {
                    assertFalse("$label $it", RuntimeSelectionPolicy.isWithin(comparable(it, true), inProject))
                }
            }
        // A missing preferred wrapper falls back to the other installed one, never to the project's copy.
        File(root, "scripts/moe-agent.ps1").delete()
        assertEquals(ProtectedAgentRuntime.Selected(sh, env), TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, root, true))
        installedLayout(root)
        File(root, "scripts/moe-agent.sh").delete()
        assertEquals(ProtectedAgentRuntime.Selected(ps1, env), TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, root, false))

        // A root reached through a link still yields the real installed files.
        installedLayout(root)
        val linkedRoot = File(temporaryFolder.newFolder("plugins"), "moe-jetbrains")
        assumeTrue("links unavailable on this host", symlink(linkedRoot.toPath(), root.toPath()))
        assertEquals(ProtectedAgentRuntime.Selected(ps1, env), TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, linkedRoot, true))
    }

    @Test
    fun `L2 a protected agent launch without the whole installed runtime is refused`() {
        // The repository carries a complete runtime of its own; none of it may stand in for the installed one.
        val project = installedLayout(temporaryFolder.newFolder("project"))
        fun installedWithout(vararg missing: String) =
            installedLayout(temporaryFolder.newFolder()).also { root -> missing.forEach { assertTrue(File(root, it).delete()) } }
        mapOf(
            "null root" to (null to "installed Moe runtime not found"),
            "missing wrapper" to (installedWithout("scripts/moe-agent.ps1", "scripts/moe-agent.sh") to "installed scripts/moe-agent.ps1 not found"),
            "missing daemon" to (installedWithout("daemon/index.js") to "installed daemon/index.js not found"),
            "missing proxy" to (installedWithout("proxy/index.js") to "installed proxy/index.js not found"),
            "root inside the project" to (installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains")) to
                "installed scripts/moe-agent.ps1 resolves inside the project")
        ).forEach { (label, row) ->
            val selection = TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, row.first, true)
            assertEquals(label, ProtectedAgentRuntime.Refused(row.second), selection)
            assertFalse(label, selection is ProtectedAgentRuntime.Selected)
        }
    }

    @Test
    fun `L3 only the protected profile replaces the legacy agent resolution`() {
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val untouched: () -> File? = { throw AssertionError("legacy resolution must not look up the installed root") }
        listOf(temporaryFolder.newFolder("unconfigured"), project("""{"settings":{"executionProfile":"legacy"}}""")).forEach {
            assertNull(it.path, TerminalAgentLauncher.protectedAgentRuntime(it.path, false, untouched))
        }

        val strong = project("""{"settings":{"executionProfile":"verified-local"}}""")
        val selected = TerminalAgentLauncher.protectedAgentRuntime(strong.path, false) { root }
        assertTrue("$selected", selected is ProtectedAgentRuntime.Selected)
        assertEquals(TerminalAgentLauncher.selectProtectedAgentRuntime(strong.path, false, root), selected)
        assertEquals("1", (selected as ProtectedAgentRuntime.Selected).env["MOE_RUNTIME_PROTECTED"])
        assertEquals(setOf("MOE_DAEMON_PATH", "MOE_PROXY_PATH", "MOE_RUNTIME_PROTECTED"), selected.env.keys)
        val refused = TerminalAgentLauncher.protectedAgentRuntime(strong.path, false) { null }
        assertEquals(ProtectedAgentRuntime.Refused("installed Moe runtime not found"), refused)
        assertEquals(
            "Protected execution profile: installed Moe runtime not found. " +
                "Agents only use the wrapper, daemon and proxy installed with the Moe plugin.",
            (refused as ProtectedAgentRuntime.Refused).message
        )
    }

    @Test
    fun `G1 an unverified daemon is refused before activation`() {
        val dir = project("""{"settings":{"executionProfile":"verified-local"}}""")
        val pid = ProcessHandle.current().pid()
        withService(dir) { service, port, statuses ->
            doConnect(service, DaemonInfo(port, pid.toInt(), "now", dir.path))
            assertNull(service.field("wsClient"))
            assertFalse(service.isConnected())
            assertEquals(false, service.field("connecting"))
            assertNull(service.field("reconnectFuture"))
            assertEquals(0, MoeProjectRegistry.daemonRefCountForTest(pid.toInt()))
            assertEquals(false to refusal(pid), statuses.last())
        }
    }

    @Test
    fun `G2 a daemon this IDE started from the installed runtime activates`() {
        val dir = project("""{"settings":{"executionProfile":"verified-local"}}""")
        RuntimeSelectionPolicy.recordProtectedSpawn(dir.path, ProcessHandle.current())
        withService(dir) { service, port, statuses ->
            doConnect(service, DaemonInfo(port, ProcessHandle.current().pid().toInt(), "now", dir.path))
            assertTrue("wsClient", service.field("wsClient") != null)
            assertTrue("connected", awaitConnected(service))
            assertEquals(true to "Connected", statuses.last())
        }
    }

    @Test
    fun `G3 legacy activation never asks for provenance`() {
        val dir = temporaryFolder.newFolder("legacy")
        withService(dir) { service, port, statuses ->
            doConnect(service, DaemonInfo(port, ProcessHandle.current().pid().toInt(), "now", dir.path))
            assertTrue("connected", awaitConnected(service))
            assertEquals(true to "Connected", statuses.last())
        }
    }

    @Test
    fun `G4 a protected selection refusal stays visible and is not retried`() {
        val (project, _, node) = protectedFixture()
        val started = mutableListOf<List<String>>()
        withService(project) { service, _, statuses ->
            val supervisor = supervisorFor(project, { null }, { node.path }, started = started)
            MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(service, supervisor)
            service.connect()
            assertEquals(emptyList<List<String>>(), started)
            val message = "Protected execution profile: installed Moe runtime not found. Project and PATH copies of the Moe daemon are not used."
            assertEquals(listOf(false to message), statuses.toList())
            assertNull(service.field("reconnectFuture"))
            assertEquals(false, service.field("connecting"))
            assertNull(service.field("wsClient"))
        }
    }

    @Test
    fun `R1 a protected restart signals no process this IDE did not start for the project`() {
        val (project, root, node) = protectedFixture()
        val self = ProcessHandle.current()
        val noStart = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ProcessHandle.Info::class.java)) { _, _, _ ->
            Optional.empty<Any>()
        } as ProcessHandle.Info
        val refused = restartRefusal(self.pid(), NOT_STARTED_HERE)
        val spy = SignalSpy()
        mapOf<String, () -> Unit>(
            "unrecorded" to {},
            "pid reused since it was recorded" to {
                RuntimeSelectionPolicy.remember(project.path, SpawnRecord(self.pid(), T0, supervisor = true)) { ProcessFacts(it, T0, null) }
            },
            "recorded for another project" to { RuntimeSelectionPolicy.recordProtectedSpawn(temporaryFolder.newFolder().path, self) },
            "spawned without a start instant" to { RuntimeSelectionPolicy.recordProtectedSpawn(project.path, fakeHandle(self.pid()) { noStart }) }
        ).forEach { (label, setup) ->
            RuntimeSelectionPolicy.resetForTest()
            setup()
            restart(project, root, node, self.pid(), spy::handle).assertRefused(label, refused)
        }
        // Discovery skips its project check for a blank projectPath; provenance still decides.
        restart(project, root, node, self.pid(), spy::handle, projectPath = "").assertRefused("blank projectPath", refused)
        writeProjectJson(project, """{"settings":""")
        restart(project, root, node, self.pid(), spy::handle, profile = { RuntimeSelectionPolicy.profile(project.path) })
            .assertRefused("unreadable project.json", refused)
        assertEquals(emptyList<Long>(), spy.destroyed)
    }

    @Test
    fun `R2 restart stops a recorded protected daemon, or a legacy one, exactly once and starts a fresh one`() {
        val (project, root, node) = protectedFixture()
        val self = ProcessHandle.current()
        val legacy = SignalSpy()
        restart(project, root, node, self.pid(), legacy::handle, profile = { RuntimeProfile.LEGACY }).assertProceeded("legacy, unrecorded")
        assertEquals("legacy still signals the live pid daemon.json names", listOf(self.pid()), legacy.destroyed)

        RuntimeSelectionPolicy.recordProtectedSpawn(project.path, self)
        val supervisor = SignalSpy()
        restart(project, root, node, self.pid(), supervisor::handle).assertProceeded("recorded supervisor")
        // One lookup: the captured handle is the one destroyed, never a second resolution of the pid.
        assertEquals(listOf(self.pid()), supervisor.lookedUp)
        assertEquals(listOf(self.pid()), supervisor.destroyed)
        // `sort` waits on stdin: daemon.json names the `_run` child of the recorded `start` supervisor.
        val child = ProcessBuilder("sort").start()
        try {
            val daemon = SignalSpy()
            restart(project, root, node, child.pid(), daemon::handle).assertProceeded("child of the recorded supervisor")
            assertEquals(listOf(child.pid()), daemon.lookedUp)
            assertEquals(listOf(child.pid()), daemon.destroyed)
        } finally {
            child.destroyForcibly().waitFor()
        }
    }

    @Test
    fun `R3 a dead, vanished or non-positive pid is never signaled and its daemon json is cleaned up`() {
        val (project, root, node) = protectedFixture()
        val pid = ProcessHandle.current().pid()
        val spy = SignalSpy()
        restart(project, root, node, pid, spy::handle, alive = false).assertProceeded("dead")
        val vanished = mutableListOf<Long>()
        restart(project, root, node, pid, { vanished += it; null }).assertProceeded("vanished before its handle was taken")
        assertEquals(listOf(pid), vanished)
        // A daemon.json without a pid reads as 0, and kill(2) takes 0 and -1 as process groups: neither is a daemon.
        listOf(RuntimeProfile.PROTECTED, RuntimeProfile.LEGACY).forEach { profile ->
            listOf(0L, -1L).forEach { restart(project, root, node, it, spy::handle, profile = { profile }).assertProceeded("$profile pid $it") }
        }
        assertEquals(emptyList<Long>(), spy.lookedUp)
        assertEquals(emptyList<Long>(), spy.destroyed)
    }

    @Test
    fun `R4 lookup and signal failures stop a protected restart and are ignored by a legacy one`() {
        val (project, root, node) = protectedFixture()
        val pid = ProcessHandle.current().pid()
        RuntimeSelectionPolicy.recordProtectedSpawn(project.path, ProcessHandle.current())
        listOf(RuntimeProfile.PROTECTED, RuntimeProfile.LEGACY).forEach { profile ->
            val check: Restart.(String) -> Unit = {
                if (profile == RuntimeProfile.PROTECTED) assertRefused(it, restartRefusal(pid, STOP_FAILED)) else assertProceeded(it)
            }
            restart(project, root, node, pid, { throw SecurityException("lookup") }, { profile }).check("$profile lookup throws")
            listOf<Pair<String, () -> Boolean>>(
                "destroy throws" to { throw SecurityException("signal") },
                "destroy returns false" to { false }
            ).forEach { (label, destroy) ->
                val spy = SignalSpy(destroy)
                restart(project, root, node, pid, spy::handle, { profile }).check("$profile $label")
                assertEquals("$profile $label", listOf(pid), spy.destroyed)
            }
        }
    }

    /** What one Restart Daemon left: daemon.json before and after, starts, statuses, spawn attempts and retry timer. */
    private data class Restart(
        val before: String, val after: String?, val started: List<List<String>>,
        val statuses: List<Pair<Boolean, String>>, val spawnAttempts: Int, val reconnect: Any?
    )

    /**
     * The real Restart Daemon on [project] while daemon.json names [pid], through a supervisor that looks
     * processes up with [lookup] and has spent its spawn attempts, so only a backoff reset starts a daemon.
     */
    private fun restart(
        project: File, root: File, node: File, pid: Long, lookup: (Long) -> ProcessHandle?,
        profile: () -> RuntimeProfile = { RuntimeProfile.PROTECTED }, alive: Boolean = true, projectPath: String = project.path
    ): Restart {
        val metadata = File(project, ".moe/daemon.json").apply { writeText(Gson().toJson(DaemonInfo(1, pid.toInt(), "now", projectPath))) }
        val before = metadata.readText()
        val started = mutableListOf<List<String>>()
        val supervisor = supervisorFor(project, { root }, { node.path }, profile = profile, started = started, alive = { alive }, lookup = lookup)
        SPAWN_ATTEMPTS.setInt(supervisor, Int.MAX_VALUE)
        lateinit var outcome: Restart
        withService(project) { service, _, statuses ->
            MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(service, supervisor)
            service.restartDaemon()
            outcome = Restart(before, metadata.takeIf { it.exists() }?.readText(), started.toList(), statuses.toList(),
                SPAWN_ATTEMPTS.getInt(supervisor), service.field("reconnectFuture"))
        }
        return outcome
    }

    /** Nothing after a refusal: daemon.json byte for byte, no start, no backoff reset, no retry. */
    private fun Restart.assertRefused(label: String, message: String) {
        assertEquals(label, before, after)
        assertEquals(label, emptyList<List<String>>(), started)
        assertEquals(label, listOf(false to "Disconnected", false to message), statuses)
        assertEquals(label, Int.MAX_VALUE, spawnAttempts)
        assertNull(label, reconnect)
    }

    /** A restart that went on: daemon.json deleted, the backoff reset and exactly one daemon started. */
    private fun Restart.assertProceeded(label: String) {
        assertNull(label, after)
        assertEquals(label, 1, started.size)
        assertEquals(label, 1, spawnAttempts)
        assertEquals(label, listOf(false to "Disconnected", false to "Starting daemon..."), statuses.take(2))
    }

    /** Inert stand-ins for the processes daemon.json names: lookups and destroys are recorded, and reach no process. */
    private class SignalSpy(private val destroy: () -> Boolean = { true }) {
        val lookedUp = CopyOnWriteArrayList<Long>()
        val destroyed = CopyOnWriteArrayList<Long>()

        fun handle(pid: Long): ProcessHandle {
            lookedUp += pid
            return Proxy.newProxyInstance(SignalSpy::class.java.classLoader, arrayOf(ProcessHandle::class.java)) { proxy, method, args ->
                when (method.name) {
                    "destroy" -> {
                        destroyed += pid
                        destroy()
                    }
                    "pid" -> pid
                    "isAlive" -> true
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.firstOrNull()
                    "toString" -> "SignalSpy($pid)"
                    else -> throw UnsupportedOperationException(method.name)
                }
            } as ProcessHandle
        }
    }

    private fun restartRefusal(pid: Long, reason: String) =
        "Protected execution profile: Restart Daemon did not stop pid $pid, which .moe/daemon.json names: $reason. " +
            "Check what that process is and stop it yourself if it is a Moe daemon, then use Restart Daemon."

    /** A loopback daemon endpoint and a service on a project rooted at [dir], both torn down after [test]. */
    private fun withService(dir: File, test: (MoeProjectService, Int, List<Pair<Boolean, String>>) -> Unit) {
        MoeProjectRegistry.clearDaemonRefCountsForTest()
        val listening = CountDownLatch(1)
        val server = object : WebSocketServer(InetSocketAddress("127.0.0.1", 0), 1) {
            override fun onStart() = listening.countDown()
            override fun onOpen(conn: WebSocket?, handshake: ClientHandshake?) {}
            override fun onMessage(conn: WebSocket?, message: String?) {}
            override fun onClose(conn: WebSocket?, code: Int, reason: String?, remote: Boolean) {}
            override fun onError(conn: WebSocket?, ex: Exception?) {}
        }
        server.start()
        val service = MoeProjectService(ideaProject(dir)) { it() }
        val statuses = CopyOnWriteArrayList<Pair<Boolean, String>>()
        service.addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {}
            override fun onStatus(connected: Boolean, message: String) {
                statuses += connected to message
            }
        })
        try {
            assertTrue("loopback server did not start", listening.await(5, TimeUnit.SECONDS))
            test(service, server.port, statuses)
        } finally {
            service.dispose()
            server.stop(1000)
            MoeProjectRegistry.clearDaemonRefCountsForTest()
        }
    }

    private fun doConnect(service: MoeProjectService, info: DaemonInfo) {
        MoeProjectService::class.java.getDeclaredMethod("doConnect", DaemonInfo::class.java)
            .apply { isAccessible = true }.invoke(service, info)
    }

    /** Waits until the open callback has finished, as MoeProjectConnectionTest does. */
    private fun awaitConnected(service: MoeProjectService): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while ((!service.isConnected() || service.field("refreshFuture") == null) && System.nanoTime() < deadline) {
            Thread.sleep(10)
        }
        return service.isConnected()
    }

    private fun MoeProjectService.field(name: String): Any? =
        MoeProjectService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun ideaProject(dir: File): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Gate Test"
            "getBasePath" -> dir.path
            "isDisposed" -> false
            "toString" -> "GateTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject

    /** A project whose tree and parent both carry a daemon, an installed root and a node outside both. */
    private fun protectedFixture(): Triple<File, File, File> {
        val parent = temporaryFolder.newFolder("work")
        val project = File(parent, "proj").apply { File(this, ".moe").mkdirs() }
        listOf(parent, project).forEach { File(it, "packages/moe-daemon/dist/index.js").apply { parentFile.mkdirs() }.writeText("repo") }
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val node = File(temporaryFolder.newFolder("runtime"), "node").apply { writeText("node") }
        return Triple(project, root, node)
    }

    private fun supervisorFor(
        project: File,
        root: () -> File?,
        node: () -> String?,
        wsl: Boolean = false,
        profile: () -> RuntimeProfile = { RuntimeProfile.PROTECTED },
        started: MutableList<List<String>> = mutableListOf(),
        statuses: MutableList<Pair<Boolean, String>> = mutableListOf(),
        dirs: MutableList<File?> = mutableListOf(),
        alive: (Int) -> Boolean = { false },
        lookup: (Long) -> ProcessHandle? = { null }
    ) = MoeDaemonSupervisor(
        project.path, "Test Project", { connected, message -> statuses += connected to message }, { _, _ -> false }, alive,
        { pb -> started += pb.command().toList(); dirs += pb.directory(); IdleProcess() }, { wsl }, profile, root, node, lookup,
        // R1-R4 pin the cross-platform restart; the Windows tree stop has its own rows in MoeDaemonSupervisorTest.
        windowsRestart = { false }
    )

    /** A started process that never runs; without [handle] it has none, so it is never recorded. */
    private class IdleProcess(private val handle: ProcessHandle? = null) : Process() {
        override fun toHandle(): ProcessHandle = handle ?: super.toHandle()
        override fun getOutputStream(): OutputStream = OutputStream.nullOutputStream()
        override fun getInputStream(): InputStream = InputStream.nullInputStream()
        override fun getErrorStream(): InputStream = InputStream.nullInputStream()
        override fun waitFor(): Int = 0
        override fun exitValue(): Int = 0
        override fun destroy() {}
        override fun isAlive(): Boolean = false
    }

    private fun refusal(pid: Long) = "Protected execution profile: the running Moe daemon (pid $pid) was not started by this IDE " +
        "from the installed Moe runtime. Stop it, then use Restart Daemon."

    private fun fakeHandle(pid: Long, info: () -> ProcessHandle.Info): ProcessHandle =
        Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ProcessHandle::class.java)) { _, method, _ ->
            when (method.name) {
                "pid" -> pid
                "info" -> info()
                else -> throw UnsupportedOperationException(method.name)
            }
        } as ProcessHandle

    private fun project(json: String): File = temporaryFolder.newFolder().also { writeProjectJson(it, json) }

    private fun writeProjectJson(dir: File, json: String) {
        File(dir, ".moe").mkdirs()
        File(dir, ".moe/project.json").writeBytes(json.toByteArray(Charsets.UTF_8))
    }

    private fun comparable(path: String, fold: Boolean) = RuntimeSelectionPolicy.comparablePath(path, fold)

    private fun realFile(file: File): File = file.toPath().toRealPath().toFile()

    /** Every installed artifact a protected selection may use, laid out as the plugin zip ships them. */
    private fun installedLayout(root: File): File {
        listOf("daemon/index.js", "proxy/index.js", "scripts/moe-agent.sh", "scripts/moe-agent.ps1").forEach {
            File(root, it).apply { parentFile.mkdirs() }.writeText("installed $it")
        }
        return root
    }

    /** The reason of a rejection; never an absolute path (those go to the log only). */
    private fun assertRejected(label: String, selection: RuntimeSelection): String {
        assertTrue("$label: $selection", selection is RuntimeSelection.Rejected)
        val reason = (selection as RuntimeSelection.Rejected).reason
        assertTrue("$label reason is blank", reason.isNotBlank())
        assertFalse("$label reason leaks a path: $reason", reason.contains(temporaryFolder.root.path))
        return reason
    }

    private fun profileOf(dir: File): RuntimeProfile = RuntimeSelectionPolicy.profile(dir.path)

    private fun padded(json: String, size: Int): String = json + " ".repeat(size - json.toByteArray(Charsets.UTF_8).size)

    // A symbolic link, else (Windows without the symlink privilege) a directory junction,
    // which needs no privilege and which Java also reads without following under NOFOLLOW_LINKS.
    private fun symlink(link: Path, target: Path): Boolean = try {
        Files.createSymbolicLink(link, target)
        true
    } catch (_: Exception) {
        System.getProperty("os.name").startsWith("Windows") && junction(link, target)
    }

    private fun junction(link: Path, target: Path): Boolean = try {
        val process = ProcessBuilder("cmd", "/c", "mklink", "/J", link.toString(), target.toString())
            .redirectErrorStream(true).start()
        process.inputStream.readBytes()
        process.waitFor() == 0 && Files.exists(link, LinkOption.NOFOLLOW_LINKS)
    } catch (_: Exception) {
        false
    }

    /** [dir] through the [host] admin share of its drive: `\\<host>\<d>$\<rest>`. */
    private fun share(host: String, dir: File): String {
        val real = realFile(dir).path
        assumeTrue("drive-qualified real path $real", DRIVE_PATH.containsMatchIn(real))
        return "\\\\$host\\${real[0]}\$\\${real.substring(3)}"
    }

    /** Every Windows form of [project] or elsewhere that is not drive-qualified, UNC and device alike. */
    private fun nonLocalSpellings(project: File): List<String> = listOf(
        "\\\\srv\\sh\\x", "//srv/sh/x", "\\\\?\\UNC\\srv\\sh\\x", "\\\\.\\UNC\\srv\\sh\\x",
        "\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\x",
        "\\\\.\\GLOBALROOT\\Device\\Mup\\" + share("localhost", project).removePrefix("\\\\"),
        share("localhost", project), share("127.0.0.1", project), share("localhost", project) + "\\bin"
    )

    /** [file] through its volume GUID device path, `\\.\Volume{…}\<rest>`: local, drive-less, no network; null when mountvol cannot say. */
    private fun volumeSpelling(file: File): String? = try {
        val real = realFile(file).path
        val mountvol = File(System.getenv("SystemRoot"), "System32\\mountvol.exe").path
        val process = ProcessBuilder(mountvol, real.substring(0, 2), "/L").redirectErrorStream(true).start()
        val output = process.inputStream.readBytes().toString(Charsets.UTF_8).trim()
        val volume = VOLUME_LINE.matchEntire(output)?.groupValues?.get(1)
        if (process.waitFor() == 0 && volume != null && DRIVE_PATH.containsMatchIn(real)) "\\\\.\\$volume\\${real.substring(3)}" else null
    } catch (_: Exception) {
        null
    }

    /** A store whose root does not exist yet, under a fresh folder outside every test project. */
    private fun newStore(): ProtectedStateStore = ProtectedStateStore(temporaryFolder.newFolder().toPath().resolve("moe/protected-state"))

    /** A fresh store, installed as the one the policy persists to; resetForTest restores the default. */
    private fun useStore(): ProtectedStateStore = newStore().also { store -> RuntimeSelectionPolicy.store = { store } }

    /** A fresh store holding what an earlier session left for [dir]: supervisor (100, T0) started from [daemon]. */
    private fun persistedSession(dir: String, daemon: File): ProtectedStateStore {
        val store = useStore()
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon))) { ProcessFacts(it, T0, 1) }
        RuntimeSelectionPolicy.forgetSessionForTest()
        return store
    }

    private fun installedDaemon(): File = File(installedLayout(temporaryFolder.newFolder()), "daemon/index.js")

    /** Daemons 100 and 200 each verify from the store alone: nothing is remembered in this session. */
    private fun assertVerified(label: String, project: String, installed: File?) = listOf(100L, 200L).forEach { pid ->
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertNull("$label, pid $pid", RuntimeSelectionPolicy.verifyProvenance(project, pid, LIVE::get, installed))
    }

    private fun assertRefused(label: String, project: String, installed: File?, facts: Map<Long, ProcessFacts> = LIVE) =
        listOf(100L, 200L).forEach { pid ->
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals("$label, pid $pid", refusal(pid), RuntimeSelectionPolicy.verifyProvenance(project, pid, facts::get, installed))
        }

    private fun daemonKey(daemon: File): String = RuntimeSelectionPolicy.installedDaemonKey(daemon) ?: throw AssertionError("$daemon")

    private fun storeFiles(store: ProtectedStateStore): List<String> = store.root.toFile().list()?.sorted().orEmpty()

    /** The pids, in file order, of the records in the one provenance file [store] holds. */
    private fun storedPids(store: ProtectedStateStore): List<Long> =
        Gson().fromJson(store.read(storeFiles(store).single()), JsonObject::class.java).getAsJsonArray("records")
            .map { it.asJsonObject.get("pid").asLong }

    /** The owner-only definition, checked independently of the store: exact POSIX modes, else one ACL entry allowing the owner. */
    private fun assertOwnerOnly(path: Path, directory: Boolean) {
        val posix = Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
        if (posix != null) {
            assertEquals("$path", if (directory) "rwx------" else "rw-------", PosixFilePermissions.toString(posix.readAttributes().permissions()))
            return
        }
        val view = Files.getFileAttributeView(path, AclFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
            ?: throw AssertionError("$path has neither a POSIX nor an ACL view")
        assertEquals("$path", listOf(AclEntryType.ALLOW to view.owner), view.acl.map { it.type() to it.principal() })
    }

    /** Grants group and world read (POSIX) or adds an Everyone entry (ACL); false when this host cannot. */
    private fun loosen(path: Path, directory: Boolean): Boolean {
        val posix = Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
        if (posix != null) {
            posix.setPermissions(PosixFilePermissions.fromString(if (directory) "rwxr-xr-x" else "rw-r--r--"))
            return true
        }
        val view = Files.getFileAttributeView(path, AclFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS) ?: return false
        val everyone = try {
            path.fileSystem.userPrincipalLookupService.lookupPrincipalByGroupName("Everyone")
        } catch (_: Exception) {
            return false
        }
        val entry = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(everyone).setPermissions(AclEntryPermission.READ_DATA).build()
        view.acl = view.acl + entry
        return true
    }

    companion object {
        private val NAME_A = "a".repeat(64) + ".json"
        private val NAME_B = "b".repeat(64) + ".json"
        private val NAME_C = "c".repeat(64) + ".json"
        private const val MIB = 1 shl 20
        private val T0: Instant = Instant.parse("2026-01-01T00:00:00Z")
        private val T1: Instant = T0.plusSeconds(60)
        // Supervisor 100 and the daemon 200 it started, both still running.
        private val LIVE = mapOf(100L to ProcessFacts(100, T0, 1), 200L to ProcessFacts(200, T1, 100))
        private const val NOT_STARTED_HERE = "this IDE did not start it from the installed Moe runtime"
        private const val STOP_FAILED = "the stop request failed"
        private val DRIVE_PATH = Regex("""^[A-Za-z]:\\""")
        // mountvol <X:> /L prints exactly one `\\?\Volume{GUID}\` line.
        private val VOLUME_LINE = Regex("""\\\\\?\\(Volume\{[0-9A-Fa-f-]{36}\})\\""")
        private val SPAWN_ATTEMPTS =MoeDaemonSupervisor::class.java.getDeclaredField("daemonSpawnAttempts").apply { isAccessible = true }
    }
}
