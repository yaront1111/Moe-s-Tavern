package com.moe.services

import com.moe.util.RuntimeProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

/**
 * MOE_DAEMON_COMMAND precedence and rewrite. The environment is injected through the supervisor's
 * `daemonCommandOverride` seam because a JVM cannot change its own environment; the expectations are literal
 * strings, so a change to the production constants or helpers cannot make them pass by accident.
 */
class MoeDaemonCommandOverrideTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    private val p = "/srv/my proj"
    private val q = "\"$p\""

    private fun initializedRoot(name: String): File =
        temporaryFolder.newFolder(name).also { File(it, ".moe").mkdirs() }

    private fun shellPrefix(): List<String> =
        if (MoeDaemonSupervisor.isWindowsHost()) listOf("cmd", "/c") else listOf("bash", "-lc")

    private fun shellSupervisor(wsl: Boolean = false, override: () -> String? = { null }): MoeDaemonSupervisor =
        MoeDaemonSupervisor(
            p, "Test Project",
            wslAgentsEnabled = { wsl }, profile = { RuntimeProfile.LEGACY },
            daemonCommandOverride = override, docSync = { _, _ -> }
        )

    private fun build(raw: String, wsl: Boolean = false): String = shellSupervisor(wsl).buildDaemonCommand(p, raw)

    @Test
    fun `O1 a set override wins over a resolving daemon script and an unset or blank one keeps the direct spawn`() {
        val root = initializedRoot("o1")
        val script = File(root, "packages/moe-daemon/dist/index.js").apply { parentFile.mkdirs() }.also { it.writeText("repo") }
        val r = "\"${root.absolutePath}\""

        fun spawn(wsl: Boolean, seam: () -> String?): List<String> {
            val started = mutableListOf<List<String>>()
            val supervisor = MoeDaemonSupervisor(
                root.absolutePath, "Test Project",
                processStarter = { started += it.command().toList(); StubProcess() },
                wslAgentsEnabled = { wsl }, profile = { RuntimeProfile.LEGACY },
                daemonCommandOverride = seam, docSync = { _, _ -> }
            )
            assertTrue("wsl=$wsl", supervisor.ensureDaemonRunning())
            return started.single()
        }

        assertEquals(shellPrefix() + "npx moe-daemon start --project $r", spawn(false) { "npx moe-daemon" })
        assertEquals(shellPrefix() + "npx moe-daemon start --project $r --host wsl", spawn(true) { "npx moe-daemon" })

        // Unset, blank and unreadable all keep today's direct spawn of the resolved script. The throw is the
        // error-handling case: an environment that cannot be read counts as unset and still starts the daemon.
        val unset: List<() -> String?> = listOf({ null }, { "" }, { "   " }, { throw SecurityException("denied") })
        unset.forEachIndexed { index, seam ->
            val cmd = spawn(false, seam)
            assertEquals("case $index", listOf("start", "--project", root.absolutePath), cmd.drop(2))
            assertEquals("case $index", script.canonicalFile, File(cmd[1]).canonicalFile)
        }
    }

    @Test
    fun `O2 the protected profile never reads the override`() {
        val root = initializedRoot("o2")
        var reads = 0
        val started = mutableListOf<List<String>>()
        val supervisor = MoeDaemonSupervisor(
            root.absolutePath, "Test Project",
            processStarter = { started += it.command().toList(); StubProcess() },
            profile = { RuntimeProfile.PROTECTED }, installedRoot = { null }, nodeExecutable = { null },
            daemonCommandOverride = { reads++; "npx moe-daemon" }, docSync = { _, _ -> }
        )

        // installedArtifact(null, ...) refuses with "installed Moe runtime not found".
        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals("the protected profile must not read MOE_DAEMON_COMMAND", 0, reads)
        assertTrue("nothing may be started", started.isEmpty())
    }

    @Test
    fun `O3 a command naming no daemon subcommand gets start and one naming a subcommand keeps its own`() {
        val installer = "\"C:\\Program Files\\Moe\\moe-daemon\\start-daemon.cmd\""
        // The path holds a standalone `start` word, so a plain whitespace split would see a subcommand in it.
        val quotedScript = "node \"/opt/my start dir/index.js\""
        val cases = listOf(
            "npx moe-daemon" to "npx moe-daemon start --project $q",
            "moe-daemon" to "moe-daemon start --project $q",
            "node /opt/moe/daemon/index.js" to "node /opt/moe/daemon/index.js start --project $q",
            installer to "$installer start --project $q",
            // A quoted word is one word: the `start` inside the path is not a subcommand.
            quotedScript to "$quotedScript start --project $q",
            "npx moe-daemon start" to "npx moe-daemon start --project $q",
            "npx moe-daemon init" to "npx moe-daemon init --project $q",
            "  npx moe-daemon  " to "npx moe-daemon start --project $q"
        )
        cases.forEach { (raw, expected) ->
            val actual = build(raw)
            assertEquals(raw, expected, actual)
            assertFalse("$raw: $actual", actual.contains("--host"))
        }

        // Blank is unset. Compare the two: the unset branch may find a real installed start-daemon.cmd on a Windows host.
        val supervisor = shellSupervisor()
        assertEquals(supervisor.buildDaemonCommand(p, null), supervisor.buildDaemonCommand(p, "   "))
    }

    @Test
    fun `O4 a command carrying --project or projectPath is used as written`() {
        assertEquals(
            "node /opt/moe/index.js start --project $q",
            build("node /opt/moe/index.js start --project \"{projectPath}\"")
        )
        assertEquals("my-wrapper $p", build("my-wrapper {projectPath}"))
        assertEquals("npx moe-daemon start --project /srv/other", build("npx moe-daemon start --project /srv/other"))
        // No `start` is added to a command that carries --project: the daemon reads its subcommand only as its first
        // argument, so an appended start could not fix it, and CONFIGURATION.md tells the operator to name it.
        assertEquals("npx moe-daemon --project /srv/other", build("npx moe-daemon --project /srv/other"))
    }

    @Test
    fun `O5 WSL agent mode appends --host wsl unless the command carries --host`() {
        assertEquals("npx moe-daemon start --project $q --host wsl", build("npx moe-daemon", wsl = true))
        val own = build("npx moe-daemon start --host 127.0.0.1", wsl = true)
        assertEquals("npx moe-daemon start --host 127.0.0.1 --project $q", own)
        assertEquals("exactly one --host", 1, Regex("--host").findAll(own).count())
        assertEquals(
            "node /opt/moe/index.js start --project $q --host wsl",
            build("node /opt/moe/index.js start --project \"{projectPath}\"", wsl = true)
        )
        assertEquals(
            "npx moe-daemon start --project /srv/other --host wsl",
            build("npx moe-daemon start --project /srv/other", wsl = true)
        )
    }

    /** A process that stays alive until destroyed, with empty streams: enough for the spawn's output drain. */
    private class StubProcess : Process() {
        private var alive = true

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
            alive = false
        }
        override fun destroyForcibly(): Process {
            destroy()
            return this
        }
    }
}
