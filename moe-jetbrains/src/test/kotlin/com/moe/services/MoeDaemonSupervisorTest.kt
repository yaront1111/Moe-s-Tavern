package com.moe.services

import com.google.gson.Gson
import com.moe.model.DaemonInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
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

    private fun setSpawnAttempts(supervisor: MoeDaemonSupervisor, attempts: Int) {
        val field = MoeDaemonSupervisor::class.java.getDeclaredField("daemonSpawnAttempts")
        field.isAccessible = true
        field.setInt(supervisor, attempts)
    }

    private class FakeProcess : Process() {
        private var alive = true
        var destroyCalls = 0
            private set

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
