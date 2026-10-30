package com.moe.services

import com.google.gson.Gson
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.util.ProtectedStateStore
import com.moe.util.RuntimeProfile
import com.moe.util.RuntimeSelectionPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Proxy
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.time.Duration
import java.time.Instant
import java.util.Optional
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.stream.Stream

class MoeDaemonSupervisorTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `readDaemonInfo returns null when daemon file is absent`() {
        val root = temporaryFolder.newFolder("absent")

        assertNull(supervisor(root).readDaemonInfo())
    }

    @Test
    fun `readDaemonInfo parses a well formed daemon file`() {
        val root = temporaryFolder.newFolder("valid")
        writeDaemonInfo(root, DaemonInfo(9876, 42, "now", root.canonicalPath))

        val info = supervisor(root).readDaemonInfo()

        assertEquals(9876, info?.port)
        assertEquals(42, info?.pid)
        assertEquals(root.canonicalPath, info?.projectPath)
    }

    @Test
    fun `readDaemonInfo ignores but keeps a daemon file for another project`() {
        val root = temporaryFolder.newFolder("stale")
        val daemonFile = writeDaemonInfo(
            root,
            DaemonInfo(9876, 42, "now", temporaryFolder.newFolder("other").canonicalPath)
        )

        val before = daemonFile.readBytes()
        repeat(2) {
            assertNull(supervisor(root).readDaemonInfo())
            assertTrue("reading must not delete another project's metadata", daemonFile.exists())
            assertArrayEquals(before, daemonFile.readBytes())
        }
    }

    @Test
    fun `readDaemonInfo reads this project in every spelling`() {
        val root = temporaryFolder.newFolder("spellings")
        val base = root.canonicalPath
        val forward = base.replace('\\', '/')
        val spellings = if (forward.matches(Regex("^[A-Za-z]:/.*"))) {
            listOf(base, forward, base.lowercase(), "$base\\", otherSideSpelling(base))
        } else listOf(base, "$base/", "$base/./", "//wsl$/Ubuntu$base", otherSideSpelling(base))
        for (path in spellings + "$forward/child/..") {
            assertEquals(path, DaemonIdentityProbe.comparableProjectPath(base), DaemonIdentityProbe.comparableProjectPath(path))
            val expected = DaemonInfo(9876, 42, "now", path)
            val file = writeDaemonInfo(root, expected)
            val before = file.readBytes()
            assertEquals(path, expected, supervisor(root).readDaemonInfo())
            assertArrayEquals(path, before, file.readBytes())
        }
    }

    @Test
    fun `isSameProject compares cross OS literals before canonical paths`() {
        val pairs = listOf("/mnt/d/proj" to "D:\\proj", "D:/proj/" to "D:\\proj",
            "d:\\PROJ" to "D:\\proj", "D:\\proj" to "/mnt/d/proj", "\\\\wsl$\\Ubuntu\\home\\me\\p" to "/home/me/p")
        pairs.forEach { (path, base) -> assertTrue(path, MoeDaemonSupervisor.isSameProject(path, base)) }
        assertTrue("relative paths need canonical fallback", MoeDaemonSupervisor.isSameProject(".", File(".").canonicalPath))
        listOf("D:\\other", "/mnt/d/other").forEach { assertFalse(MoeDaemonSupervisor.isSameProject(it, "D:\\proj")) }
    }

    @Test
    fun `ensureDaemonRunning removes another project's daemon file before spawning`() {
        val root = initializedRoot("other-project")
        val file = writeDaemonInfo(root, DaemonInfo(9876, 42, "now", temporaryFolder.newFolder().canonicalPath))
        var starts = 0
        val service = supervisor(root, portProbe = { _, _ -> true }, processAliveProbe = { true },
            processStarter = { starts++; FakeProcess() })
        assertTrue(service.ensureDaemonRunning())
        assertEquals(1, starts)
        assertFalse(file.exists())
    }

    @Test
    fun `deleteDaemonInfoIfUnchanged keeps every one-field replacement`() {
        val root = initializedRoot("compare-delete")
        val expected = DaemonInfo(9876, 42, "now", root.canonicalPath)
        val replacements = listOf(expected.copy(pid = 43), expected.copy(port = 9877),
            expected.copy(startedAt = "later"), expected.copy(projectPath = "OTHER"))
        for (replacement in replacements) {
            val file = writeDaemonInfo(root, replacement)
            val before = file.readBytes()
            assertFalse(replacement.toString(), supervisor(root).deleteDaemonInfoIfUnchanged(expected))
            assertArrayEquals(before, file.readBytes())
        }
        val file = writeDaemonInfo(root, expected)
        assertTrue(supervisor(root).deleteDaemonInfoIfUnchanged(expected))
        assertFalse(file.exists())
        assertFalse(supervisor(root).deleteDaemonInfoIfUnchanged(expected))
    }

    @Test
    fun `metadata reads and compare-delete keep unparseable files`() {
        val root = initializedRoot("invalid-metadata")
        val expected = DaemonInfo(9876, 42, "now", root.canonicalPath)
        for (json in listOf("", "null", "{broken", "{}", "{\"port\":9876,\"pid\":42}",
            Gson().toJson(expected.copy(projectPath = "\u0000")),
            Gson().toJson(expected).padEnd(MoeDaemonSupervisor.MAX_DAEMON_JSON_BYTES + 1, ' '))) {
            val file = File(root, ".moe/daemon.json").apply { writeText(json) }
            val before = file.readBytes()
            assertNull(supervisor(root).readDaemonInfo())
            assertFalse(supervisor(root).deleteDaemonInfoIfUnchanged(expected))
            assertArrayEquals(before, file.readBytes())
        }
        assertFalse(MoeDaemonSupervisor("", "Test").deleteDaemonInfoIfUnchanged(expected))
        val emptyPath = expected.copy(projectPath = "")
        writeDaemonInfo(root, emptyPath)
        assertEquals(emptyPath, supervisor(root).readDaemonInfo())
    }

    @Test
    fun `readDaemonInfo returns null for malformed json`() {
        val root = temporaryFolder.newFolder("malformed")
        val moeDir = File(root, ".moe").apply { mkdirs() }
        File(moeDir, "daemon.json").writeText("{not-json")

        assertNull(supervisor(root).readDaemonInfo())
    }

    @Test
    fun `ensureDaemonRunning does not spawn when daemon is reachable`() {
        val root = initializedRoot("reachable")
        writeDaemonInfo(root, DaemonInfo(9876, 42, "now", root.canonicalPath))
        var starts = 0
        val supervisor = supervisor(
            root,
            portProbe = { port, timeout -> port == 9876 && timeout > 0 },
            processAliveProbe = { it == 42 },
            processStarter = { starts++; FakeProcess() }
        )

        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals(0, starts)
    }

    @Test
    fun `isProcessAlive returns false when the probe fails`() {
        val root = temporaryFolder.newFolder("probe-failure")
        val supervisor = supervisor(root, processAliveProbe = { throw IllegalStateException("probe") })

        assertFalse(supervisor.isProcessAlive(42))
    }

    @Test
    fun `isOtherSideOfWsl follows the daemon namespace rule on both hosts`() {
        val posix = listOf("/mnt/d/x", "/home/u/x")
        val windows = listOf("//server/share/x", "\\\\server\\share", "D:\\x", "D:/x")
        for (host in listOf(false, true)) {
            for (path in posix + windows + listOf("x", ".", "")) {
                val expected = if (host) path in posix else path in windows
                assertEquals("$host: $path", expected, MoeDaemonSupervisor.isOtherSideOfWsl(path, host))
            }
        }
    }

    @Test
    fun `isReachable uses only the port for other-side pids`() {
        val root = temporaryFolder.newFolder("reachability")
        val local = DaemonInfo(9876, 42, "now", root.canonicalPath)
        val remote = local.copy(pid = 43, projectPath = otherSideSpelling(root.canonicalPath))
        for (alive in listOf(false, true)) for (open in listOf(false, true)) {
            val probed = mutableListOf<Int>()
            val service = supervisor(root, processAliveProbe = { probed += it; alive }, portProbe = { _, _ -> open })
            assertEquals(alive && open, service.isReachable(local))
            assertEquals(open, service.isReachable(remote))
            assertEquals(listOf(42), probed)
        }
        assertFalse(supervisor(root, portProbe = { _, _ -> error("probe failed") }).isReachable(remote))
    }

    @Test
    fun `ensureDaemonRunning leaves an open other-side daemon of this project alone`() {
        for (open in listOf(true, false)) {
            val root = initializedRoot("other-side-$open")
            val file = writeDaemonInfo(root, DaemonInfo(9876, 42, "now", otherSideSpelling(root.canonicalPath)))
            val before = file.readBytes()
            var starts = 0
            val probed = mutableListOf<Int>()
            val service = supervisor(root, processAliveProbe = { probed += it; false }, portProbe = { _, _ -> open },
                processStarter = { starts++; FakeProcess() })
            assertEquals(!open, service.ensureDaemonRunning())
            assertEquals(if (open) 0 else 1, starts)
            assertTrue(probed.isEmpty())
            if (open) assertArrayEquals(before, file.readBytes()) else assertFalse(file.exists())
        }
    }

    @Test
    fun `protected replacement never captures or prompts for an other-side daemon`() = ReplacementFixture().use { f ->
        writeDaemonInfo(f.root, f.info.copy(projectPath = otherSideSpelling(f.root.canonicalPath)))
        f.targetAlive = false
        val before = f.file.readBytes()
        assertFalse(f.service.ensureDaemonRunning())
        assertTrue(f.asked.isEmpty())
        assertTrue(f.commands.isEmpty())
        assertTrue(f.probedPids.isEmpty())
        assertTrue(f.lookedUpPids.isEmpty())
        assertArrayEquals(before, f.file.readBytes())
    }

    @Test
    fun `pending replacement never probes a rewritten other-side pid`() = ReplacementFixture().use { f ->
        val replacement = f.info.copy(pid = 5252, projectPath = otherSideSpelling(f.root.canonicalPath))
        f.stop = { f.targetAlive = false; f.parentAlive = false; writeDaemonInfo(f.root, replacement); 0 }
        assertFalse(f.service.ensureDaemonRunning())
        val before = f.file.readBytes()
        assertFalse(f.service.ensureDaemonRunning())
        assertFalse(f.probedPids.contains(5252))
        assertEquals(1, f.commands.size)
        assertArrayEquals(before, f.file.readBytes())
    }

    @Test
    fun `restart refuses other-side metadata without touching any process under either profile`() {
        val root = temporaryFolder.newFolder("other-side-restart")
        val remote = DaemonInfo(9876, 42, "now", otherSideSpelling(root.canonicalPath))
        for (profile in RuntimeProfile.values()) for (windows in listOf(false, true)) {
            val probes = mutableListOf<Int>()
            val lookups = mutableListOf<Long>()
            var destroys = 0
            val handle = Proxy.newProxyInstance(ProcessHandle::class.java.classLoader, arrayOf(ProcessHandle::class.java)) { _, method, _ ->
                if (method.name == "destroy") { destroys++; true } else error("unexpected ${method.name}")
            } as ProcessHandle
            val service = MoeDaemonSupervisor(root.canonicalPath, "Test", profile = { profile },
                processAliveProbe = { probes += it; true }, processLookup = { lookups += it; handle }, windowsRestart = { windows })
            assertEquals("Restart Daemon did not stop pid 42, which .moe/daemon.json names on the other side of the Windows/WSL boundary: " +
                "this IDE can neither see nor signal processes there. Check what that process is and stop it there yourself if it is a Moe daemon, " +
                "then use Restart Daemon.", service.stopDaemonForRestart(remote))
            assertTrue(probes.isEmpty())
            assertTrue(lookups.isEmpty())
            assertEquals(0, destroys)
            if (profile == RuntimeProfile.LEGACY && !windows) {
                assertNull(service.stopDaemonForRestart(remote.copy(projectPath = root.canonicalPath)))
                assertEquals(listOf(42), probes)
                assertEquals(listOf(42L), lookups)
                assertEquals(1, destroys)
            }
        }
    }

    @Test
    fun `ensureDaemonRunning refuses to spawn after maximum attempts`() {
        val root = initializedRoot("attempts")
        var starts = 0
        val supervisor = supervisor(root, processStarter = { starts++; FakeProcess() })
        setSpawnAttempts(supervisor, 3)

        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals(0, starts)
    }

    @Test
    fun `ensureDaemonRunning enforces spawn cooldown`() {
        val root = initializedRoot("cooldown")
        val process = FakeProcess()
        var starts = 0
        val supervisor = supervisor(root, processStarter = { starts++; process })

        assertTrue(supervisor.ensureDaemonRunning())
        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals(1, starts)
        supervisor.killSpawnedDaemon()
    }

    @Test
    fun `ensureDaemonRunning reports spawn failures without throwing`() {
        val root = initializedRoot("spawn-failure")
        val statuses = mutableListOf<Pair<Boolean, String>>()
        val supervisor = supervisor(
            root,
            onStatus = { connected, message -> statuses += connected to message },
            processStarter = { throw IllegalStateException("boom") }
        )

        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals(listOf(false to "boom"), statuses)
    }

    @Test
    fun `killSpawnedDaemon is idempotent`() {
        val root = initializedRoot("kill")
        val process = FakeProcess()
        val supervisor = supervisor(root, processStarter = { process })
        assertTrue(supervisor.ensureDaemonRunning())

        supervisor.killSpawnedDaemon()
        supervisor.killSpawnedDaemon()

        assertEquals(1, process.destroyCalls)
        assertFalse(process.isAlive)
    }

    @Test
    fun `findInParents respects maximum depth`() {
        val root = temporaryFolder.newFolder("parents")
        val nested = File(root, "a/b/c").apply { mkdirs() }
        val target = File(root, "marker.txt").apply { writeText("found") }
        val supervisor = supervisor(root)

        assertEquals(target.canonicalFile, supervisor.findInParents(nested, "marker.txt", 3)?.canonicalFile)
        assertNull(supervisor.findInParents(nested, "marker.txt", 2))
    }

    private fun initializedRoot(name: String): File =
        temporaryFolder.newFolder(name).also { File(it, ".moe").mkdirs() }

    @Test
    fun `a legacy spawn and activation neither write nor read daemon provenance`() {
        val root = initializedRoot("legacy-store")
        // The direct command, and a process with a real handle: a legacy spawn that recorded would persist.
        File(root, "packages/moe-daemon/dist/index.js").apply { parentFile.mkdirs() }.writeText("repo")
        val store = ProtectedStateStore(temporaryFolder.newFolder("state").toPath().resolve("moe/protected-state"))
        // Resolve an installed daemon outside the project so an activation provenance read reaches the store.
        val installed = temporaryFolder.newFolder("legacy-installed")
        File(installed, "daemon/index.js").apply { parentFile.mkdirs() }.writeText("installed")
        var consulted = 0
        RuntimeSelectionPolicy.store = { consulted++; store }
        try {
            assertEquals(RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile(root.absolutePath))
            assertTrue("the counting store seam is live", consulted > 0)
            consulted = 0
            val self = ProcessHandle.current()
            // Pin only the supervisor profile so legitimate profile-record reads do not count as provenance.
            val supervisor = MoeDaemonSupervisor(
                root.absolutePath, "Test Project", processStarter = { FakeProcess(self) },
                profile = { RuntimeProfile.LEGACY }, installedRoot = { installed }
            )
            assertTrue(supervisor.ensureDaemonRunning())
            assertFalse("a legacy spawn persists nothing", Files.exists(store.root))
            store.write("a".repeat(64) + ".json", "garbage")
            assertNull(supervisor.activationRefusal(DaemonInfo(9876, self.pid().toInt(), "now", root.absolutePath)))
            assertEquals("a legacy spawn and activation never consult the store", 0, consulted)
        } finally {
            RuntimeSelectionPolicy.resetForTest()
        }
    }

    @Test
    fun `W1 legacy direct start passes --host wsl only in WSL agent mode`() {
        listOf(false, true).forEach { wsl ->
            val root = initializedRoot("w1-$wsl")
            val script = File(root, "packages/moe-daemon/dist/index.js").apply { parentFile.mkdirs() }.also { it.writeText("repo") }
            val started = mutableListOf<List<String>>()
            val supervisor = MoeDaemonSupervisor(
                root.absolutePath, "Test Project",
                processStarter = { started += it.command().toList(); FakeProcess() },
                wslAgentsEnabled = { wsl }, profile = { RuntimeProfile.LEGACY }
            )
            assertTrue("wsl=$wsl", supervisor.ensureDaemonRunning())
            val cmd = started.single()
            val expected = listOf("start", "--project", root.absolutePath) + (if (wsl) listOf("--host", "wsl") else emptyList())
            assertEquals("wsl=$wsl", expected, cmd.drop(2))
            assertEquals("wsl=$wsl", script.canonicalFile, File(cmd[1]).canonicalFile)
            assertFalse("wsl=$wsl", cmd.contains("0.0.0.0"))
        }
    }

    @Test
    fun `W2 legacy shell start command appends --host wsl only in WSL agent mode`() {
        // MOE_DAEMON_COMMAND is the operator's verbatim command and never carries --host.
        Assume.assumeTrue(System.getenv("MOE_DAEMON_COMMAND").isNullOrBlank())
        listOf(false, true).forEach { wsl ->
            val root = initializedRoot("w2-$wsl")
            val supervisor = MoeDaemonSupervisor(
                root.absolutePath, "Test Project", wslAgentsEnabled = { wsl }, profile = { RuntimeProfile.LEGACY }
            )
            val cmd = supervisor.buildDaemonCommand(root.absolutePath)
            // Both the installed start-daemon.cmd branch and the `moe-daemon start` fallback end with the suffix.
            if (wsl) {
                assertTrue("wsl=$wsl: $cmd", cmd.endsWith(" --host wsl"))
                assertEquals("wsl=$wsl: $cmd", 1, Regex("--host").findAll(cmd).count())
                assertTrue("wsl=$wsl: $cmd", cmd.contains("--project \"${root.absolutePath}\""))
            } else {
                assertFalse("wsl=$wsl: $cmd", cmd.contains("--host"))
            }
            assertFalse("wsl=$wsl: $cmd", cmd.contains("0.0.0.0"))
        }
    }

    @Test
    fun `GUI without PATH Node discovers the bootstrapped runtime`() {
        val home = temporaryFolder.newFolder("gui-home")
        val node = File(home, ".local/share/moe/node/current/bin/node").apply {
            parentFile.mkdirs()
            writeText("fixture")
            setExecutable(true)
        }

        assertEquals(node.absolutePath, supervisor(home).resolveNodeExecutable(emptyMap(), home.absolutePath, false) { null })
    }

    @Test
    fun `Node override wins and existing PATH is used when no managed runtime exists`() {
        val home = temporaryFolder.newFolder("node-priority")
        val managed = File(home, ".local/share/moe/node/current/bin/node").apply {
            parentFile.mkdirs()
            writeText("fixture")
            setExecutable(true)
        }
        val service = supervisor(home)

        assertEquals("requested-node", service.resolveNodeExecutable(mapOf("MOE_NODE_COMMAND" to "requested-node"), home.absolutePath, false) { "path-node" })
        assertTrue(managed.delete())
        assertEquals("path-node", service.resolveNodeExecutable(emptyMap(), home.absolutePath, false) { "path-node" })
    }

    @Test
    fun `managed Node replaces an old system runtime for GUI launches`() {
        val home = temporaryFolder.newFolder("old-system-node")
        val managed = File(home, ".local/share/moe/node/current/bin/node").apply {
            parentFile.mkdirs()
            writeText("fixture")
            setExecutable(true)
        }
        val service = supervisor(home)
        val chosen = service.resolveNodeExecutable(emptyMap(), home.absolutePath, false) { "/usr/bin/node" }

        assertEquals(managed.absolutePath, chosen)
        assertEquals(managed.parentFile.absolutePath, service.daemonPath("/usr/bin", chosen, home.absolutePath, false).split(File.pathSeparator).first())
    }

    @Test
    fun `daemon children discover bootstrap Node and agent bins without replacing PATH`() {
        val home = temporaryFolder.newFolder("child-path")
        val nodeBin = File(home, ".local/share/moe/node/current/bin").apply { mkdirs() }
        val agentBin = File(home, ".local/share/moe/npm/bin").apply { mkdirs() }
        val current = listOf("existing-first", "existing-second").joinToString(File.pathSeparator)

        val path = supervisor(home).daemonPath(current, null, home.absolutePath, false)

        assertEquals(listOf("existing-first", "existing-second", nodeBin.absolutePath, agentBin.absolutePath), path.split(File.pathSeparator))
    }

    @Test
    fun `readDaemonInfo parses a daemon file of exactly the size cap under both profiles`() {
        for (profile in RuntimeProfile.values()) {
            val root = temporaryFolder.newFolder("cap-${profile.name}")
            writePaddedDaemonInfo(root, MoeDaemonSupervisor.MAX_DAEMON_JSON_BYTES)

            val info = MoeDaemonSupervisor(root.absolutePath, "Test Project", profile = { profile }).readDaemonInfo()

            assertEquals(9876, info?.port)
            assertEquals(42, info?.pid)
            assertEquals(root.canonicalPath, info?.projectPath)
        }
    }

    @Test
    fun `readDaemonInfo ignores but keeps a daemon file one byte over the size cap under both profiles`() {
        for (profile in RuntimeProfile.values()) {
            val root = temporaryFolder.newFolder("over-${profile.name}")
            val file = writePaddedDaemonInfo(root, MoeDaemonSupervisor.MAX_DAEMON_JSON_BYTES + 1)

            assertNull(MoeDaemonSupervisor(root.absolutePath, "Test Project", profile = { profile }).readDaemonInfo())
            assertTrue(file.exists())
        }
    }

    @Test
    fun `readDaemonInfo does not read a daemon file larger than 2 GiB`() {
        for (profile in RuntimeProfile.values()) {
            val root = temporaryFolder.newFolder("huge-${profile.name}")
            val file = File(File(root, ".moe").apply { mkdirs() }, "daemon.json")
            try {
                Files.newByteChannel(
                    file.toPath(),
                    StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE,
                    StandardOpenOption.SPARSE
                ).use {
                    it.position(Int.MAX_VALUE.toLong() + 1)
                    it.write(ByteBuffer.wrap(byteArrayOf(32)))
                }
            } catch (ex: java.io.IOException) {
                // Filesystem cannot hold it sparsely: fall back to a regular file just above the cap.
                file.delete()
                writePaddedDaemonInfo(root, MoeDaemonSupervisor.MAX_DAEMON_JSON_BYTES + 1)
            }

            assertNull(MoeDaemonSupervisor(root.absolutePath, "Test Project", profile = { profile }).readDaemonInfo())
            assertTrue(file.exists())
        }
    }

    @Test
    fun `Windows daemon PATH extends the existing Path instead of adding a Node-only PATH`() {
        val home = temporaryFolder.newFolder("windows-path")
        val node = File(home, "nodejs/node.exe").absolutePath
        val env = mutableMapOf("Path" to "git-cmd", "SystemRoot" to "windows")

        supervisor(home).applyDaemonPath(env, node, windows = true)

        assertEquals(listOf("Path"), env.keys.filter { it.equals("PATH", ignoreCase = true) })
        assertEquals(listOf(File(home, "nodejs").absolutePath, "git-cmd"), env.getValue("Path").split(File.pathSeparator))
    }

    @Test
    fun `Windows daemon PATH keeps one spelling when the IDE already has two`() {
        val home = temporaryFolder.newFolder("windows-two-paths")
        val env = mutableMapOf("Path" to "second", "PATH" to "first")

        supervisor(home).applyDaemonPath(env, null, windows = true)

        assertEquals(mapOf("PATH" to "first"), env)
    }

    @Test
    fun `RP1 confirmed replacement uses only installed stop then start with fresh provenance`() {
        for (keepFile in listOf(false, true)) ReplacementFixture().use { f ->
            f.wsl = keepFile
            f.stop = { f.targetAlive = false; f.parentAlive = false; if (!keepFile) f.file.delete(); 0 }
            setSpawnAttempts(f.service, 3)
            assertTrue(f.service.ensureDaemonRunning())
            assertEquals(listOf("Test Project" to 4242), f.asked)
            assertEquals(listOf("stop", "start"), f.commands.map { it.command()[2] })
            f.commands.forEach { pb ->
                val action = pb.command()[2]
                val host = if (action == "start" && f.wsl) listOf("--host", "wsl") else emptyList()
                assertEquals(listOf(f.node.canonicalPath, f.daemon.canonicalPath, action, "--project", f.root.path) + host, pb.command())
                assertEquals(f.daemon.canonicalFile.parentFile, pb.directory())
                assertFalse(pb.environment().containsKey("NODE_OPTIONS"))
                assertFalse(pb.environment().containsKey("NODE_PATH"))
                val path = pb.environment().entries.firstOrNull { it.key.equals("PATH", true) }?.value.orEmpty()
                assertTrue(path.split(File.pathSeparator).all { RuntimeSelectionPolicy.isOutsideProject(it, f.root.path) })
            }
            assertEquals(ProcessBuilder.Redirect.DISCARD, f.commands.first().redirectOutput())
            assertTrue(f.commands.first().redirectErrorStream())
            assertFalse(f.file.exists())
            assertNull(f.service.activationRefusal(f.info.copy(pid = ProcessHandle.current().pid().toInt())))
            assertTrue(Files.exists(f.store.root))
        }
    }

    @Test
    fun `RP2 no explicit confirmation never stops or changes metadata`() {
        for (mode in listOf("decline", "throw", "edt")) ReplacementFixture().use { f ->
            f.edt = mode == "edt"
            f.confirm = { if (mode == "throw") error("dialog failed") else false }
            val before = f.file.readText()
            assertFalse(mode, f.service.ensureDaemonRunning())
            assertEquals(mode, if (f.edt) 0 else 1, f.asked.size)
            assertEquals(mode, before, f.file.readText())
            f.assertRefused(mode)
            f.edt = false; f.confirm = { true }
            assertTrue("$mode releases the guard for a later explicit consent", f.service.ensureDaemonRunning())
        }
    }

    @Test
    fun `RP3 stop failures and bounded waits retain the exact refusal`() {
        for (mode in listOf("nonzero", "timeout", "throw", "target", "parent", "badjson", "newpid", "deleted")) ReplacementFixture().use { f ->
            f.stop = {
                when (mode) {
                    "nonzero" -> 1
                    "timeout" -> null
                    "throw" -> error("stop failed")
                    else -> {
                        f.targetAlive = mode in listOf("target", "deleted")
                        f.parentAlive = mode == "parent"
                        if (mode == "newpid") writeDaemonInfo(f.root, f.info.copy(pid = 5252))
                        if (mode in listOf("deleted", "parent")) f.file.delete()
                        if (mode == "badjson") f.file.writeText("{broken")
                        0
                    }
                }
            }
            assertFalse(mode, f.service.ensureDaemonRunning())
            assertEquals(mode, 1, f.commands.size)
            assertEquals(mode, if (mode in listOf("nonzero", "timeout", "throw")) 0 else 2, f.polls)
            f.assertRefused(mode, stops = 1)
            assertEquals(mode, f.refusal, f.service.selectionRefusal())
            assertFalse("$mode retry must not bypass process or metadata clearance", f.service.ensureDaemonRunning())
            assertEquals(mode, 1, f.commands.size)
        }
    }

    @Test
    fun `RP4 unchanged paths do not prompt and an in-flight replacement excludes reentry`() {
        for (mode in listOf("legacy", "verified", "missing", "lookup", "reentry")) ReplacementFixture().use { f ->
            if (mode == "legacy") f.profile = RuntimeProfile.LEGACY
            if (mode == "missing") f.installed = null
            if (mode == "lookup") f.target = null
            if (mode == "verified") {
                val self = ProcessHandle.current()
                RuntimeSelectionPolicy.recordProtectedSpawn(f.root.path, self, f.daemon)
                writeDaemonInfo(f.root, f.info.copy(pid = self.pid().toInt()))
            }
            if (mode == "reentry") f.stop = {
                f.file.delete()
                assertFalse("no duplicate spawn while stop has removed metadata", f.service.ensureDaemonRunning())
                f.targetAlive = false; f.parentAlive = false; 0
            }
            assertEquals(mode, mode == "reentry", f.service.ensureDaemonRunning())
            assertEquals(mode, if (mode == "reentry") 1 else 0, f.asked.size)
            assertEquals(mode, if (mode == "reentry") 2 else 0, f.commands.size)
        }
    }

    @Test
    fun `RP5 default confirmer refuses without an IntelliJ application`() {
        ReplacementFixture().use { f ->
            val service = MoeDaemonSupervisor(f.root.path, "Test Project", portProbe = { _, _ -> true },
                processAliveProbe = { true }, processStarter = { error("must not start") },
                profile = { RuntimeProfile.PROTECTED }, installedRoot = { f.installed }, nodeExecutable = { f.node.path },
                processLookup = { f.target }, onDispatchThread = { false }, runStop = { error("must not stop") })
            assertFalse(service.ensureDaemonRunning())
            assertEquals(f.refusal, service.activationRefusal(f.info))
        }
    }

    @Test
    fun `RP-S stop selection never publishes clears or stores a refusal`() {
        ReplacementFixture().use { f ->
            f.profile = RuntimeProfile.LEGACY; f.nodePath = null
            assertNull(f.service.stopCommandOrNull(f.root.path))
            assertTrue(f.statuses.isEmpty())
            assertNull(f.service.selectionRefusal())
            f.profile = RuntimeProfile.PROTECTED
            assertNull(f.service.selectionRefusal())
            f.file.delete()
            assertFalse(f.service.ensureDaemonRunning())
            val refused = f.service.selectionRefusal()
            assertEquals("Protected execution profile: node executable not found. Project and PATH copies of the Moe daemon are not used.", refused)
            val statuses = f.statuses.toList()
            f.nodePath = f.node.path
            assertEquals(listOf(f.node.canonicalPath, f.daemon.canonicalPath, "stop", "--project", f.root.path), f.service.stopCommandOrNull(f.root.path))
            assertEquals(refused, f.service.selectionRefusal())
            assertEquals(statuses, f.statuses)
        }
    }

    @Test
    fun `RP6 production stop runner waits within its bound and destroys only its timed-out CLI`() {
        for (completed in listOf(false, true)) ReplacementFixture().use { f ->
            val cli = FakeProcess().also { if (completed) it.waitFor() }
            val commands = mutableListOf<String>()
            val service = MoeDaemonSupervisor(f.root.path, "Test Project", portProbe = { _, _ -> true },
                processAliveProbe = { f.targetAlive }, profile = { RuntimeProfile.PROTECTED }, installedRoot = { f.installed },
                nodeExecutable = { f.node.path }, processLookup = { f.target }, replaceConfirmer = { _, _ -> true },
                onDispatchThread = { false }, processStarter = {
                    commands += it.command()[2]
                    f.targetAlive = false; f.parentAlive = false; f.file.delete()
                    if (it.command()[2] == "stop") cli else FakeProcess()
                })
            assertEquals(completed, service.ensureDaemonRunning())
            assertEquals(if (completed) listOf("stop", "start") else listOf("stop"), commands)
            assertEquals(if (completed) 0 else 1, cli.destroyCalls)
        }
    }

    @Test
    fun `W1 Windows restart runs the installed stop before any signal`() {
        for (profile in RuntimeProfile.values()) WinRestart(profile).use { f ->
            f.verified()
            val s = f.proc(S)
            val r = f.proc(f.self, s, 1)
            f.own(s)
            f.stop = { r.alive = false; s.alive = false; 0 }
            assertNull(profile.name, f.restart(f.self))
            assertEquals(profile.name, listOf("stop"), f.signals())
            assertEquals(listOf(f.node.canonicalPath, f.daemon.canonicalPath, "stop", "--project", f.root.path), f.stops.single())
        }
    }

    @Test
    fun `W2 Windows restart kills the old supervisor before a _run it respawned after the capture`() = WinRestart().use { f ->
        val s = f.proc(S)
        val r = f.proc(f.self, s, 1)
        f.own(s)
        f.stop = { r.alive = false; f.proc(R2, s, 2); 0 }
        assertNull(f.restart(f.self))
        assertEquals(listOf("stop", "kill:$S", "kill:$R2"), f.signals())
        assertFalse(f.handles.getValue(R2).alive)
    }

    @Test(timeout = 10_000)
    fun `W3 a process alive after the bound refuses the restart`() {
        WinRestart().use { f ->
            val s = f.proc(S)
            val r = f.proc(f.self, s, 1)
            f.proc(D, s, 2, survives = true)
            f.own(s)
            f.stop = { r.alive = false; 0 }
            f.onSleep = { assertTrue("the wait is bounded", f.polls <= 4) }
            assertEquals(survivor(D), f.restart(f.self))
            assertEquals("a 1 s bound polled every 250 ms", 4, f.polls)
            assertEquals(listOf("stop", "kill:$S", "kill:$D"), f.signals().take(3))
        }
        WinRestart().use { f ->
            f.proc(D, f.proc(S).also { f.own(it) }, 1, survives = true)
            f.onSleep = { throw InterruptedException() }
            assertEquals(INCOMPLETE, f.restart(null))
            assertTrue("the interrupt is kept", Thread.interrupted())
        }
    }

    @Test
    fun `W4 a failed legacy stop still kills the old tree top-down and publishes nothing`() {
        for (mode in listOf("nonzero", "timeout", "throw", "unresolved")) WinRestart().use { f ->
            val s = f.proc(S)
            f.proc(f.self, s, 1)
            f.own(s)
            if (mode == "unresolved") f.nodePath = null
            f.stop = { when (mode) { "nonzero" -> 1; "timeout" -> null; else -> error("stop failed") } }
            assertNull(mode, f.restart(f.self))
            val stop = if (mode == "unresolved") emptyList() else listOf("stop")
            assertEquals(mode, stop + listOf("kill:$S", "kill:${f.self}"), f.signals())
            assertTrue(mode, f.statuses.isEmpty())
            assertNull(mode, MoeDaemonSupervisor::class.java.getDeclaredField("selectionRefusal").apply { isAccessible = true }.get(f.service))
        }
    }

    @Test
    fun `W5 a failed protected stop of a verified daemon refuses before any signal`() {
        for (mode in listOf("nonzero", "timeout", "throw", "unresolved")) WinRestart(RuntimeProfile.PROTECTED).use { f ->
            f.verified()
            val s = f.proc(S)
            f.proc(f.self, s, 1)
            f.own(s)
            if (mode == "unresolved") f.nodePath = null
            f.stop = { when (mode) { "nonzero" -> 1; "timeout" -> null; else -> error("stop failed") } }
            assertEquals(mode, restartRefusal(f.self, STOP_FAILED), f.restart(f.self))
            assertTrue(mode, f.signals().none { it.startsWith("kill:") })
        }
    }

    @Test
    fun `W6 an unverified protected daemon or a failed lookup refuses before the stop`() {
        WinRestart(RuntimeProfile.PROTECTED).use { f ->
            f.proc(f.self, f.proc(S).also { f.own(it) }, 1)
            assertEquals(restartRefusal(f.self, NOT_STARTED_HERE), f.restart(f.self))
            assertEquals(emptyList<String>(), f.events)
        }
        for (profile in RuntimeProfile.values()) WinRestart(profile).use { f ->
            f.verified()
            f.proc(f.self, f.proc(S).also { f.own(it) }, 1)
            f.lookup = { throw SecurityException("lookup") }
            if (profile == RuntimeProfile.PROTECTED) {
                assertEquals(restartRefusal(f.self, STOP_FAILED), f.restart(f.self))
                assertEquals(emptyList<String>(), f.events)
            } else {
                assertNull(f.restart(f.self))
                assertEquals(listOf("stop", "kill:$S", "kill:${f.self}"), f.signals())
            }
        }
    }

    @Test
    fun `W7 a legacy foreign parent is never signaled and must exit by itself`() {
        for (exits in listOf(true, false)) WinRestart().use { f ->
            val p = f.proc(P, startSec = -1)
            val r = f.proc(f.self, p, 1)
            f.stop = { if (exits) { r.alive = false; p.alive = false; 0 } else 1 }
            assertEquals("exits=$exits", if (exits) null else survivor(P), f.restart(f.self))
            assertEquals("exits=$exits", 0, p.kills)
            assertEquals("exits=$exits", if (exits) listOf("stop") else listOf("stop", "kill:${f.self}"), f.signals())
        }
    }

    @Test
    fun `W8 a parent that started after the daemon is a reused pid, neither signaled nor awaited`() {
        for (profile in RuntimeProfile.values()) WinRestart(profile).use { f ->
            f.verified()
            val q = f.proc(Q, startSec = 5, survives = true)
            val r = f.proc(f.self, q, 1)
            f.stop = { r.alive = false; 0 }
            assertNull(profile.name, f.restart(f.self))
            assertEquals(profile.name, 0, q.kills)
            assertEquals(profile.name, listOf("stop"), f.signals())
        }
    }

    @Test
    fun `W9 without daemon json Windows still stops this IDE's own supervisor tree`() {
        for (profile in RuntimeProfile.values()) {
            WinRestart(profile).use { f ->
                val s = f.proc(S)
                f.proc(R, s, 1)
                f.own(s)
                assertNull(profile.name, f.restart(null))
                assertEquals(profile.name, listOf("stop", "kill:$S", "kill:$R"), f.signals())
            }
            WinRestart(profile).use { f ->
                assertNull(profile.name, f.restart(null))
                assertEquals(profile.name, emptyList<String>(), f.events)
                assertTrue(profile.name, f.stops.isEmpty())
            }
        }
    }

    @Test
    fun `W10 the IDE and its ancestors are never signaled or awaited as an old supervisor`() {
        val current = ProcessHandle.current()
        val ide = listOfNotNull(current, current.parent().orElse(null))
            .mapNotNull { h -> h.info().startInstant().orElse(null)?.let { h.pid() to it } }
        assertTrue("the test JVM reports its start", ide.isNotEmpty())
        for (profile in RuntimeProfile.values()) for ((pid, start) in ide) WinRestart(profile).use { f ->
            f.verified()
            val impostor = TreeHandle(pid, start, f.events, survives = true)
            val r = TreeHandle(f.self, start.plusSeconds(1), f.events).also { it.parentHandle = impostor; f.handles[f.self] = it }
            f.stop = { r.alive = false; 0 }
            assertNull("$profile parent $pid", f.restart(f.self))
            assertEquals("$profile parent $pid", 0, impostor.kills)
        }
        WinRestart().use { f ->
            val ideAsDaemon = TreeHandle(f.self, ide.first().second, f.events, survives = true).also { f.handles[f.self] = it }
            assertNull(f.restart(f.self))
            assertEquals(0, ideAsDaemon.kills)
            assertTrue(f.stops.isEmpty())
        }
    }

    @Test
    fun `W11 a child started after its parent was seen dead belongs to a pid reuser and is never signaled`() = WinRestart().use { f ->
        val s = f.proc(S)
        val r = f.proc(f.self, s, 1)
        f.own(s)
        f.stop = { r.alive = false; 0 }
        val reuser = TreeHandle(R2, Instant.now().plusSeconds(3_600), f.events, survives = true)
        s.onKill = { s.kids += reuser }
        assertNull(f.restart(f.self))
        assertEquals(0, reuser.kills)
        assertEquals(listOf("stop", "kill:$S"), f.signals())
    }

    @Test
    fun `W12 a protected verified daemon's supervisor from an earlier session dies before its _run`() =
        WinRestart(RuntimeProfile.PROTECTED).use { f ->
            f.verified()
            val p = f.proc(P, startSec = -1)
            f.proc(f.self, p, 1)
            f.stop = { 0 }
            assertNull(f.restart(f.self))
            assertEquals(listOf("stop", "kill:$P", "kill:${f.self}"), f.signals())
        }

    @Test
    fun `W13 a child spawned as a known process dies is found by a later walk and signaled`() = WinRestart().use { f ->
        val s = f.proc(S)
        val x = f.proc(D, s, 1)
        f.own(s)
        f.stop = { 0 }
        x.onKill = { f.proc(R2, x, 2) }
        assertNull(f.restart(null))
        assertEquals(listOf("stop", "kill:$S", "kill:$D", "kill:$R2"), f.signals())
        assertFalse(f.handles.getValue(R2).alive)
    }

    @Test
    fun `W14 a restart in flight refuses a second restart and any daemon start until it returns`() {
        WinRestart().use { f ->
            f.own(f.proc(S))
            var inner: String? = "unset"
            var ensured: Any? = null
            var depth = 0
            f.stop = {
                if (depth++ == 0) {
                    inner = f.service.stopDaemonForRestart(null)
                    ensured = runCatching { f.service.ensureDaemonRunning() }.getOrElse { it }
                }
                0
            }
            assertNull(f.restart(null))
            assertEquals(IN_PROGRESS, inner)
            assertEquals(false, ensured)
            assertEquals("no daemon start while the old tree stops", 0, f.starts)
            assertEquals(listOf("stop", "kill:$S"), f.signals())
            f.own(f.proc(Q))
            f.stop = { 0 }
            assertNull("the guard clears after a restart", f.restart(null))
            assertEquals(2, f.stops.size)
        }
        WinRestart().use { f ->
            f.proc(D, f.proc(S).also { f.own(it) }, 1, survives = true)
            f.onSleep = { throw InterruptedException() }
            assertEquals(INCOMPLETE, f.restart(null))
            Thread.interrupted()
            f.onSleep = {}
            f.own(f.proc(Q))
            f.stop = { 0 }
            assertNull("the guard clears after a failed restart", f.restart(null))
            assertEquals(2, f.stops.size)
        }
    }

    @Test
    fun `N1 off Windows a legacy restart signals the daemon json pid once and reads no tree`() = WinRestart(windows = false).use { f ->
        val s = f.proc(S)
        f.proc(f.self, s, 1)
        f.own(s)
        assertNull(f.restart(f.self))
        assertEquals(listOf("kill:${f.self}"), f.events)
        assertNull(f.restart(null))
        assertEquals(listOf("kill:${f.self}"), f.events)
        assertTrue(f.stops.isEmpty())
    }

    @Test
    fun `N2 off Windows a protected restart destroys the verified daemon exactly once`() =
        WinRestart(RuntimeProfile.PROTECTED, windows = false).use { f ->
            f.verified()
            val s = f.proc(S)
            f.proc(f.self, s, 1)
            f.own(s)
            assertNull(f.restart(f.self))
            assertEquals(listOf("kill:${f.self}"), f.events)
            assertTrue(f.stops.isEmpty())
        }

    @Test
    fun `W15 legacy refuses failed child enumeration`() = incompleteTree(RuntimeProfile.LEGACY, "children")

    @Test
    fun `W16 protected refuses failed child enumeration`() = incompleteTree(RuntimeProfile.PROTECTED, "children")

    @Test
    fun `W17 legacy refuses a child with missing identity`() = incompleteTree(RuntimeProfile.LEGACY, "missing")

    @Test
    fun `W18 protected refuses a child with missing identity`() = incompleteTree(RuntimeProfile.PROTECTED, "missing")

    @Test
    fun `W19 throwing identity reads cannot hide a live child`() {
        for (profile in RuntimeProfile.values()) for (mode in listOf("info", "start")) incompleteTree(profile, mode)
    }

    @Test
    fun `W20 a lazy enumeration failure cannot hide a live child`() {
        for (profile in RuntimeProfile.values()) incompleteTree(profile, "stream")
    }

    @Test
    fun `W21 incomplete discovery after the stop also refuses`() {
        for (profile in RuntimeProfile.values()) for (mode in listOf("children", "stream", "missing", "info", "start")) {
            incompleteTree(profile, mode, afterStop = true)
        }
    }

    private fun incompleteTree(profile: RuntimeProfile, mode: String, afterStop: Boolean = false) = WinRestart(profile).use { f ->
        val child = f.incompleteTree(mode, afterStop)
        assertEquals("$profile $mode afterStop=$afterStop", INCOMPLETE, f.restart(null))
        assertTrue("the undiscovered child is still alive", child.alive)
        assertEquals("no authority to signal an unidentified child", 0, child.kills)
        assertEquals(0, f.starts)
        assertEquals("no uncertainty poll is needed", 0, f.polls)
        assertEquals(if (afterStop) listOf("stop", "kill:$S") else emptyList<String>(), f.signals())
    }

    @Test
    fun `W22 an incomplete tree refusal preserves metadata and prevents service reconnect`() {
        for (profile in RuntimeProfile.values()) for (mode in listOf("children", "missing")) {
            for (metadata in listOf(false, true)) WinRestart(profile).use { f ->
                val child = f.incompleteTree(mode)
                val file = File(f.root, ".moe/daemon.json")
                if (metadata) writeDaemonInfo(f.root, DaemonInfo(1, 4242, "now", f.root.canonicalPath))
                val before = file.takeIf { it.exists() }?.readText()
                val project = Proxy.newProxyInstance(IdeaProject::class.java.classLoader, arrayOf(IdeaProject::class.java)) { _, method, _ ->
                    when (method.name) { "getName" -> "Restart Test"; "getBasePath" -> f.root.path; "isDisposed" -> false; else -> null }
                } as IdeaProject
                val service = MoeProjectService(project) { it() }
                val statuses = mutableListOf<Pair<Boolean, String>>()
                service.addListener(object : MoeStateListener {
                    override fun onState(state: MoeState) {}
                    override fun onStatus(connected: Boolean, message: String) { statuses += connected to message }
                })
                fun field(name: String) = MoeProjectService::class.java.getDeclaredField(name).apply { isAccessible = true }
                val attempts = MoeDaemonSupervisor::class.java.getDeclaredField("daemonSpawnAttempts").apply { isAccessible = true }
                field("daemonSupervisor").set(service, f.service)
                attempts.setInt(f.service, Int.MAX_VALUE)
                try {
                    service.restartDaemon()
                    assertEquals(before, file.takeIf { it.exists() }?.readText())
                    assertEquals(listOf(false to "Disconnected", false to INCOMPLETE), statuses)
                    assertEquals(Int.MAX_VALUE, attempts.getInt(f.service))
                    assertEquals(true, field("isManualDisconnect").get(service))
                    assertNull(field("reconnectFuture").get(service))
                    assertNull(field("wsClient").get(service))
                    assertEquals(0, f.starts)
                    assertEquals(0, child.kills)
                    assertTrue(child.alive)
                } finally {
                    f.service.releaseSpawnedProcessReference()
                    service.dispose()
                }
            }
        }
    }

    /** Restart Daemon over [TreeHandle] fakes: every installed stop, signal and tree read lands in [events]. */
    private inner class WinRestart(val profile: RuntimeProfile = RuntimeProfile.LEGACY, windows: Boolean = true) : AutoCloseable {
        val root = temporaryFolder.newFolder().also { File(it, ".moe").mkdirs() }
        private val installed = temporaryFolder.newFolder()
        val daemon = File(installed, "daemon/index.js").apply { parentFile.mkdirs(); writeText("installed") }
        val node = File(installed, "node").apply { writeText("node") }
        private val store = ProtectedStateStore(temporaryFolder.newFolder().toPath().resolve("moe/state"))
        // daemon.json names this JVM's pid, so a recorded spawn of this JVM verifies it under PROTECTED.
        val self: Long = ProcessHandle.current().pid()
        val events = mutableListOf<String>()
        val handles = mutableMapOf<Long, TreeHandle>()
        val stops = mutableListOf<List<String>>()
        val statuses = mutableListOf<String>()
        var starts = 0
        var nodePath: String? = node.path
        var lookup: (Long) -> ProcessHandle? = { handles[it] }
        var stop: () -> Int? = { 1 }
        var onSleep: () -> Unit = {}
        var polls = 0
        init {
            RuntimeSelectionPolicy.resetForTest()
            RuntimeSelectionPolicy.store = { store }
        }
        val service by lazy {
            MoeDaemonSupervisor(root.path, "Test Project", onStatus = { _, text -> statuses += text }, portProbe = { _, _ -> false },
                processAliveProbe = { handles[it.toLong()]?.alive == true }, processStarter = { starts++; error("must not start") },
                profile = { profile }, installedRoot = { installed }, nodeExecutable = { nodePath },
                processLookup = { lookup(it) }, runStop = { stops += it.command().toList(); events += "stop"; stop() },
                onDispatchThread = { false }, sleep = { polls++; onSleep() }, exitTimeoutMs = 1_000, windowsRestart = { windows })
        }
        fun proc(pid: Long, parent: TreeHandle? = null, startSec: Long = 0, survives: Boolean = false): TreeHandle =
            TreeHandle(pid, T0.plusSeconds(startSec), events, survives).also { h ->
                handles[pid] = h
                parent?.let { h.parentHandle = it; it.kids += h }
            }
        fun own(supervisor: ProcessHandle) = MoeDaemonSupervisor::class.java.getDeclaredField("spawnedDaemonProcess")
            .apply { isAccessible = true }.set(service, FakeProcess(supervisor))
        fun incompleteTree(mode: String, afterStop: Boolean = false): TreeHandle {
            val s = proc(S)
            val child = TreeHandle(R, if (mode == "missing") null else T0.plusSeconds(1), events)
            val unreadable = object : ProcessHandle by child {
                override fun info(): ProcessHandle.Info {
                    if (mode == "info") throw SecurityException("denied info")
                    return object : ProcessHandle.Info by child.info() {
                        override fun startInstant(): Optional<Instant> {
                            if (mode == "start") throw SecurityException("denied startInstant")
                            return child.info().startInstant()
                        }
                    }
                }
            }
            var stopped = false
            own(object : ProcessHandle by s {
                override fun children(): Stream<ProcessHandle> {
                    if (!afterStop || stopped) when (mode) {
                        "children" -> throw SecurityException("denied children")
                        "stream" -> return Stream.generate { throw SecurityException("denied stream traversal") }
                    }
                    return s.children()
                }
            })
            if (!afterStop) s.kids += unreadable
            stop = { stopped = true; if (afterStop) s.kids += unreadable; 0 }
            return child
        }
        fun verified() {
            if (profile == RuntimeProfile.PROTECTED) RuntimeSelectionPolicy.recordProtectedSpawn(root.path, ProcessHandle.current(), daemon)
        }
        fun restart(pid: Long?): String? = service.stopDaemonForRestart(pid?.let { DaemonInfo(9876, it.toInt(), "now", root.canonicalPath) })
        fun signals(): List<String> = events.filterNot { it.startsWith("read:") }
        override fun close() = RuntimeSelectionPolicy.resetForTest()
    }

    /** One process of a fake tree: its parent, children and descendants reads and every signal are logged. */
    private class TreeHandle(
        private val id: Long, private val start: Instant?, private val events: MutableList<String>, private val survives: Boolean = false
    ) : ProcessHandle {
        var alive = true
        var parentHandle: ProcessHandle? = null
        val kids = mutableListOf<ProcessHandle>()
        var kills = 0
            private set
        var onKill: () -> Unit = {}
        override fun pid(): Long = id
        override fun parent(): Optional<ProcessHandle> = Optional.ofNullable(parentHandle).also { events += "read:$id" }
        override fun children(): Stream<ProcessHandle> = kids.toList().stream().also { events += "read:$id" }
        override fun descendants(): Stream<ProcessHandle> =
            kids.toList().stream().flatMap { Stream.concat(Stream.of(it), it.descendants()) }.also { events += "read:$id" }
        override fun info(): ProcessHandle.Info = object : ProcessHandle.Info {
            override fun command(): Optional<String> = Optional.empty()
            override fun commandLine(): Optional<String> = Optional.empty()
            override fun arguments(): Optional<Array<String>> = Optional.empty()
            override fun startInstant(): Optional<Instant> = Optional.ofNullable(start)
            override fun totalCpuDuration(): Optional<Duration> = Optional.empty()
            override fun user(): Optional<String> = Optional.empty()
        }
        override fun onExit(): CompletableFuture<ProcessHandle> = error("unexpected onExit")
        override fun supportsNormalTermination(): Boolean = false
        override fun destroy(): Boolean = kill()
        override fun destroyForcibly(): Boolean = kill()
        override fun isAlive(): Boolean = alive
        override fun compareTo(other: ProcessHandle): Int = id.compareTo(other.pid())
        private fun kill(): Boolean {
            events += "kill:$id"
            kills++
            if (!survives) alive = false
            onKill()
            return true
        }
    }

    private fun restartRefusal(pid: Long, reason: String) =
        "Protected execution profile: Restart Daemon did not stop pid $pid, which .moe/daemon.json names: $reason. " +
            "Check what that process is and stop it yourself if it is a Moe daemon, then use Restart Daemon."

    private fun survivor(pid: Long) = "Restart Daemon did not start a new Moe daemon: pid $pid is still running after the stop, " +
        "and it could restart the old one. Check what that process is and stop it yourself, then use Restart Daemon."

    private inner class ReplacementFixture : AutoCloseable {
        val root = temporaryFolder.newFolder().also { File(it, ".moe").mkdirs() }
        var installed: File? = temporaryFolder.newFolder()
        val daemon = File(installed, "daemon/index.js").apply { parentFile.mkdirs(); writeText("installed") }
        val node = File(installed, "node").apply { writeText("node") }
        val store = ProtectedStateStore(temporaryFolder.newFolder().toPath().resolve("moe/state"))
        val info = DaemonInfo(9876, 4242, "now", root.canonicalPath)
        val file = writeDaemonInfo(root, info)
        val refusal = "Protected execution profile: the running Moe daemon (pid 4242) was not started by this IDE " +
            "from the installed Moe runtime. Stop it, then use Restart Daemon."
        var targetAlive = true
        var parentAlive = true
        var profile = RuntimeProfile.PROTECTED
        var nodePath: String? = node.path
        var wsl = false
        var edt = false
        var polls = 0
        val asked = mutableListOf<Pair<String, Int>>()
        val probedPids = mutableListOf<Int>()
        val lookedUpPids = mutableListOf<Long>()
        val commands = mutableListOf<ProcessBuilder>()
        val statuses = mutableListOf<String>()
        var confirm: () -> Boolean = { true }
        var stop: () -> Int? = { targetAlive = false; parentAlive = false; file.delete(); 0 }
        private val parent = handle({ parentAlive }, null)
        var target: ProcessHandle? = handle({ targetAlive }, parent)
        init {
            RuntimeSelectionPolicy.resetForTest()
            RuntimeSelectionPolicy.store = { store }
            File(root, "packages/moe-daemon/dist/index.js").apply { parentFile.mkdirs(); writeText("repo trap") }
        }
        val service by lazy {
            MoeDaemonSupervisor(root.path, "Test Project", onStatus = { _, text -> statuses += text },
                portProbe = { _, _ -> true }, processAliveProbe = { probedPids += it; it != 4242 || targetAlive },
                processStarter = { commands += it; FakeProcess(ProcessHandle.current()) },
                wslAgentsEnabled = { wsl }, profile = { profile }, installedRoot = { installed }, nodeExecutable = { nodePath },
                processLookup = { lookedUpPids += it; target }, replaceConfirmer = { name, pid -> asked += name to pid; confirm() },
                runStop = { commands += it; stop() }, onDispatchThread = { edt }, sleep = { polls++ }, exitTimeoutMs = 500)
        }
        fun assertRefused(label: String, stops: Int = 0) {
            assertEquals(label, stops, commands.size)
            assertEquals(label, refusal, service.activationRefusal(info))
        }
        private fun handle(alive: () -> Boolean, parent: ProcessHandle?): ProcessHandle =
            Proxy.newProxyInstance(ProcessHandle::class.java.classLoader, arrayOf(ProcessHandle::class.java)) { _, method, _ ->
                when (method.name) {
                    "isAlive" -> alive()
                    "parent" -> Optional.ofNullable(parent)
                    else -> error("unexpected handle operation: ${method.name}")
                }
            } as ProcessHandle
        override fun close() = RuntimeSelectionPolicy.resetForTest()
    }

    private fun supervisor(
        root: File,
        onStatus: (Boolean, String) -> Unit = { _, _ -> },
        portProbe: (Int, Int) -> Boolean = { _, _ -> false },
        processAliveProbe: (Int) -> Boolean = { false },
        processStarter: (ProcessBuilder) -> Process = { FakeProcess() }
    ): MoeDaemonSupervisor = MoeDaemonSupervisor(
        root.canonicalPath,
        "Test Project",
        onStatus,
        portProbe,
        processAliveProbe,
        processStarter
    )

    private fun otherSideSpelling(base: String): String {
        val path = base.replace('\\', '/')
        return if (path.matches(Regex("^[A-Za-z]:/.*"))) "/mnt/${path[0].lowercaseChar()}${path.substring(2)}"
        else "\\\\wsl.localhost\\Ubuntu${path.replace('/', '\\')}"
    }

    private fun writeDaemonInfo(root: File, info: DaemonInfo): File {
        val moeDir = File(root, ".moe").apply { mkdirs() }
        return File(moeDir, "daemon.json").apply { writeText(Gson().toJson(info)) }
    }

    private fun writeDaemonInfo(root: File, json: String, totalBytes: Int): File {
        val moeDir = File(root, ".moe").apply { mkdirs() }
        return File(moeDir, "daemon.json").apply { writeText(json.padEnd(totalBytes, ' ')) }
    }

    private fun writePaddedDaemonInfo(root: File, totalBytes: Int): File {
        val json = Gson().toJson(DaemonInfo(9876, 42, "now", root.canonicalPath))
        return writeDaemonInfo(root, json, totalBytes)
    }

    private fun setSpawnAttempts(supervisor: MoeDaemonSupervisor, attempts: Int) {
        val field = MoeDaemonSupervisor::class.java.getDeclaredField("daemonSpawnAttempts")
        field.isAccessible = true
        field.setInt(supervisor, attempts)
    }

    /** Without [handle] it has none, as before; destroying it never signals that handle. */
    private class FakeProcess(private val handle: ProcessHandle? = null) : Process() {
        private var alive = true
        var destroyCalls = 0
            private set

        override fun toHandle(): ProcessHandle = handle ?: super.toHandle()

        override fun getOutputStream(): OutputStream = ByteArrayOutputStream()
        override fun getInputStream(): InputStream = ByteArrayInputStream(ByteArray(0))
        override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))
        override fun waitFor(): Int {
            alive = false
            return 0
        }
        override fun waitFor(timeout: Long, unit: TimeUnit): Boolean = !alive
        override fun exitValue(): Int = if (alive) throw IllegalThreadStateException() else 0
        override fun destroy() {
            destroyCalls++
            alive = false
        }
        override fun destroyForcibly(): Process {
            destroy()
            return this
        }
        override fun isAlive(): Boolean = alive
    }

    private companion object {
        // Fake pids above Linux's pid_max, so none is this JVM.
        const val S = 7_000_001L
        const val R = 7_000_002L
        const val R2 = 7_000_003L
        const val D = 7_000_004L
        const val P = 7_000_005L
        const val Q = 7_000_006L
        val T0: Instant = Instant.parse("2020-01-01T00:00:00Z")
        const val STOP_FAILED = "the stop request failed"
        const val NOT_STARTED_HERE = "this IDE did not start it from the installed Moe runtime"
        const val INCOMPLETE = "Restart Daemon did not start a new Moe daemon: it could not confirm that the old one stopped. " +
            "Use Restart Daemon again."
        const val IN_PROGRESS = "Restart Daemon is already stopping the old Moe daemon. Wait for it to finish."
    }
}
