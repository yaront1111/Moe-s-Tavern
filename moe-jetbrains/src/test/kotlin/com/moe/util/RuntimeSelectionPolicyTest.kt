package com.moe.util

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
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.time.Instant
import java.util.Optional
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
            assertEquals("start $start", refusal(42), RuntimeSelectionPolicy.verifyProvenance(b, 42) { ProcessFacts(42, start, null) })
        }
        RuntimeSelectionPolicy.resetForTest()
        assertEquals("after reset", refusal(self.pid()), RuntimeSelectionPolicy.verifyProvenance(a, self.pid()))
    }

    @Test
    fun `S1 protected selection runs only the installed node and daemon`() {
        val (project, root, node) = protectedFixture()
        listOf(false to emptyList(), true to listOf("--host", "0.0.0.0")).forEach { (wsl, host) ->
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
        val quotedOutside = "\"${temporaryFolder.newFolder("path c").path}\""
        val alias = File(temporaryFolder.root, "path-alias")
        val unbuilt = File(project, "node_modules/.bin").path
        val entries = mutableListOf(outsideA, "", "bin", ".", unbuilt, project.path, "\"${File(project, "tools").path}\"", "  ",
            "/bad\u0000path", quotedOutside, outsideB)
        val linked = symlink(alias.toPath(), project.toPath())
        if (linked) entries += alias.path
        // Unbuilt project dirs have no real path, so only the folded comparison catches a case variant.
        if (RuntimeSelectionPolicy.defaultFoldCase) entries += unbuilt.uppercase()
        val env = mutableMapOf("NODE_OPTIONS" to "--require ./evil.js", "NODE_PATH" to project.path, "HOME" to "home",
            "PATH" to entries.joinToString(File.pathSeparator))
        supervisor.protectedDaemonEnvironment(env, project.path)
        val kept = listOf(outsideA, quotedOutside, outsideB).joinToString(File.pathSeparator)
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
    fun `L1 protected agents use the installed wrapper, daemon and proxy in the legacy order`() {
        val project = temporaryFolder.newFolder("project")
        listOf("scripts/moe-agent.sh", "scripts/moe-agent.ps1").forEach {
            File(project, it).apply { parentFile.mkdirs() }.writeText("repo $it")
        }
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val env = mapOf(
            "MOE_DAEMON_PATH" to realFile(File(root, "daemon/index.js")).path,
            "MOE_PROXY_PATH" to realFile(File(root, "proxy/index.js")).path
        )
        val ps1 = ResolvedScript(realFile(File(root, "scripts/moe-agent.ps1")), ScriptSource.BUNDLED, ScriptKind.POWERSHELL)
        val sh = ResolvedScript(realFile(File(root, "scripts/moe-agent.sh")), ScriptSource.BUNDLED, ScriptKind.BASH)
        val inProject = comparable(realFile(project).path, true)
        listOf(Triple(true, false, ps1), Triple(true, true, sh), Triple(false, false, sh), Triple(false, true, sh))
            .forEach { (windows, preferBash, script) ->
                val label = "windows=$windows preferBash=$preferBash"
                val selection = TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, preferBash, root, windows)
                assertEquals(label, ProtectedAgentRuntime.Selected(script, env), selection)
                (env.values + script.file.path).forEach {
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
        dirs: MutableList<File?> = mutableListOf()
    ) = MoeDaemonSupervisor(
        project.path, "Test Project", { connected, message -> statuses += connected to message }, { _, _ -> false }, { false },
        { pb -> started += pb.command().toList(); dirs += pb.directory(); IdleProcess() }, { wsl }, profile, root, node
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

    companion object {
        private const val MIB = 1 shl 20
        private val T0: Instant = Instant.parse("2026-01-01T00:00:00Z")
        private val T1: Instant = T0.plusSeconds(60)
    }
}
