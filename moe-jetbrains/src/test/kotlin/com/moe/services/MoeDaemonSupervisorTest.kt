package com.moe.services

import com.google.gson.Gson
import com.moe.model.DaemonInfo
import com.moe.util.ProtectedStateStore
import com.moe.util.RuntimeProfile
import com.moe.util.RuntimeSelectionPolicy
import org.junit.Assert.assertEquals
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
import java.util.Optional
import java.util.concurrent.TimeUnit

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
    fun `readDaemonInfo deletes a daemon file for another project`() {
        val root = temporaryFolder.newFolder("stale")
        val daemonFile = writeDaemonInfo(
            root,
            DaemonInfo(9876, 42, "now", temporaryFolder.newFolder("other").canonicalPath)
        )

        assertNull(supervisor(root).readDaemonInfo())
        assertFalse(daemonFile.exists())
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
                portProbe = { _, _ -> true }, processAliveProbe = { it != 4242 || targetAlive },
                processStarter = { commands += it; FakeProcess(ProcessHandle.current()) },
                wslAgentsEnabled = { wsl }, profile = { profile }, installedRoot = { installed }, nodeExecutable = { nodePath },
                processLookup = { target }, replaceConfirmer = { name, pid -> asked += name to pid; confirm() },
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
        root.absolutePath,
        "Test Project",
        onStatus,
        portProbe,
        processAliveProbe,
        processStarter
    )

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
}
