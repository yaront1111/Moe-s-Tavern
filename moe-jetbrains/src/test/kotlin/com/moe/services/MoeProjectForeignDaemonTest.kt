package com.moe.services

import com.google.gson.Gson
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.util.MoeProjectRegistry
import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class MoeProjectForeignDaemonTest {
    @Test
    fun `a daemon serving another project gets no client and loses its stale daemon json`() = withFixture { f ->
        f.healthReply(200, f.health(OTHER))
        val info = f.writeDaemonJson(startedAt = "S1")

        f.doConnect(info)

        assertTrue("status must name the other project: ${f.statuses}", f.statuses.any { OTHER in it })
        assertNull(f.service.field("wsClient"))
        assertFalse("the stale daemon.json must be removed", f.daemonJson.exists())
        assertNotNull("the reconnect that spawns this project's daemon", f.service.field("reconnectFuture"))
        f.assertNoWebSocketRequest()
    }

    @Test
    fun `a daemon json rewritten since it was read is kept`() = withFixture { f ->
        f.healthReply(200, f.health(OTHER))
        val read = f.writeDaemonJson(startedAt = "S1")
        f.writeDaemonJson(startedAt = "S2")

        f.doConnect(read)

        assertTrue("a newer daemon.json must survive", f.daemonJson.exists())
        assertTrue(f.daemonJson.readText().contains("S2"))
        assertNull(f.service.field("wsClient"))
        f.assertNoWebSocketRequest()
    }

    @Test
    fun `a daemon json changed in one identity field since it was read is kept byte for byte`() {
        val changes: List<(DaemonInfo) -> DaemonInfo> = listOf(
            { it.copy(pid = 5252) }, { it.copy(port = it.port + 1) },
            { it.copy(startedAt = "S2") }, { it.copy(projectPath = OTHER) }
        )
        for (change in changes) withFixture { f ->
            f.healthReply(200, f.health(OTHER))
            val read = f.writeDaemonJson(startedAt = "S1")
            val replacement = Gson().toJson(change(read))
            f.daemonJson.writeText(replacement)

            f.doConnect(read)

            assertEquals("the one-field replacement must survive", replacement, f.daemonJson.takeIf { it.exists() }?.readText())
            assertNull(f.service.field("wsClient"))
            f.assertNoWebSocketRequest()
        }
    }

    @Test
    fun `connect and readiness retry reach health without probing an other-side pid`() {
        for (retry in listOf(false, true)) withFixture { f ->
            val read = f.writeDaemonJson("S1")
            f.daemonJson.writeText(Gson().toJson(read.copy(projectPath = wslSpelling(f.basePath))))
            val probed = mutableListOf<Int>()
            val supervisor = MoeDaemonSupervisor(f.basePath, "Test", portProbe = { _, _ -> true },
                processAliveProbe = { probed += it; false }, processStarter = { error("must not spawn") })
            MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(f.service, supervisor)
            f.healthReply(200, f.health(OTHER))

            if (retry) MoeProjectService::class.java.getDeclaredMethod("connectWithRetry",
                Int::class.javaPrimitiveType, Long::class.javaPrimitiveType, Int::class.javaPrimitiveType
            ).apply { isAccessible = true }.invoke(f.service, 10, 60_000L, 1) else f.service.connect()

            assertTrue("no foreign pid probe on retry=$retry", probed.isEmpty())
            assertTrue("the health probe judged the daemon", f.statuses.any { OTHER in it })
            assertFalse(f.daemonJson.exists())
            assertNull(f.service.field("wsClient"))
            f.assertNoWebSocketRequest()
        }
    }

    // A live daemon bound off 127.0.0.1 is out of reach, not stale (task-fe811130).
    @Test
    fun `BH4 connect keeps a live off-loopback daemon's json, starts nothing and schedules no reconnect`() = withFixture { f ->
        f.daemonJson.writeText(Gson().toJson(f.writeDaemonJson("S1").copy(bindHost = "::1")))
        val before = f.daemonJson.readText()
        val starts = AtomicInteger()
        injectSupervisor(f, MoeDaemonSupervisor(f.basePath, "Test", portProbe = { _, _ -> false },
            processAliveProbe = { it == 4242 }, processStarter = { starts.incrementAndGet(); error("must not spawn") }))

        f.service.connect()

        assertEquals(before, f.daemonJson.takeIf { it.exists() }?.readText())
        assertEquals(0, starts.get())
        assertTrue("status must name the bind: ${f.statuses}", f.statuses.any { "::1" in it && "127.0.0.1" in it })
        assertNull(f.service.field("reconnectFuture"))
        assertNull(f.service.field("wsClient"))
        f.assertNoWebSocketRequest()
    }

    @Test
    fun `BH5 connect's own stale check removes every record but a live off-loopback one`() {
        val rows = listOf<Triple<String?, Boolean, Boolean>>(
            Triple("::1", true, true), Triple(null, true, false), Triple("wsl", true, false), Triple("::1", false, false)
        )
        for (row in rows) withFixture { f ->
            val (host, alive, kept) = row
            f.daemonJson.writeText(Gson().toJson(f.writeDaemonJson("S1").copy(bindHost = host)))
            val before = f.daemonJson.readText()
            val supervisor = MoeDaemonSupervisor(f.basePath, "Test", portProbe = { _, _ -> false },
                processAliveProbe = { alive }, processStarter = { error("must not spawn") })
            // ensureDaemonRunning then returns before it reads daemon.json, so connect()'s own branch decides alone.
            (MoeDaemonSupervisor::class.java.getDeclaredField("windowsRestartInFlight").apply { isAccessible = true }
                .get(supervisor) as java.util.concurrent.atomic.AtomicBoolean).set(true)
            injectSupervisor(f, supervisor)

            f.service.connect()

            if (kept) assertEquals("$row", before, f.daemonJson.takeIf { it.exists() }?.readText())
            else assertFalse("$row", f.daemonJson.exists())
            assertEquals("$row: ${f.statuses}", kept, f.statuses.any { "::1" in it })
            assertEquals("$row", kept, f.service.field("reconnectFuture") == null)
        }
    }

    // A daemon.json from another pid namespace (a container) is judged by its port alone (task-6796a0f9).
    @Test
    fun `PN7 connect keeps a reachable daemon json from another pid namespace and connects as today`() = withFixture { f ->
        f.healthReply(200, f.health(f.basePath))
        f.daemonJson.writeText(Gson().toJson(f.writeDaemonJson("S1").copy(pidNamespace = "pid:[1]")))
        val before = f.daemonJson.readText()
        val probed = CopyOnWriteArrayList<Int>()
        injectSupervisor(f, MoeDaemonSupervisor(f.basePath, "Test", portProbe = { _, _ -> true },
            processAliveProbe = { probed += it; false }, processStarter = { error("must not spawn") },
            ownPidNamespace = { "pid:[7]" }))

        f.service.connect()

        f.awaitWebSocketRequest()
        assertEquals(before, f.daemonJson.takeIf { it.exists() }?.readText())
        assertTrue("$probed", probed.isEmpty())
    }

    @Test
    fun `PN8 connect removes a daemon json from another pid namespace whose port is closed`() = withFixture { f ->
        f.daemonJson.writeText(Gson().toJson(f.writeDaemonJson("S1").copy(pidNamespace = "pid:[1]")))
        val probed = CopyOnWriteArrayList<Int>()
        // A host process that happens to hold the container's pid number answers alive.
        val supervisor = MoeDaemonSupervisor(f.basePath, "Test", portProbe = { _, _ -> false },
            processAliveProbe = { probed += it; true }, processStarter = { error("must not spawn") },
            ownPidNamespace = { "pid:[7]" })
        // ensureDaemonRunning then returns before it reads daemon.json, so connect()'s own branch decides alone.
        (MoeDaemonSupervisor::class.java.getDeclaredField("windowsRestartInFlight").apply { isAccessible = true }
            .get(supervisor) as java.util.concurrent.atomic.AtomicBoolean).set(true)
        injectSupervisor(f, supervisor)

        f.service.connect()

        assertFalse(f.daemonJson.exists())
        assertTrue("$probed", probed.isEmpty())
        assertNotNull(f.service.field("reconnectFuture"))
    }

    private fun injectSupervisor(f: Fixture, supervisor: MoeDaemonSupervisor) =
        MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(f.service, supervisor)

    @Test
    fun `a replacement naming another project is kept byte for byte`() = withFixture { f ->
        assertReplacementKept(f, OTHER)
    }

    @Test
    fun `a replacement naming this project in its WSL spelling is kept byte for byte`() = withFixture { f ->
        val wsl = wslSpelling(f.basePath)
        assertEquals(DaemonIdentityProbe.comparableProjectPath(f.basePath), DaemonIdentityProbe.comparableProjectPath(wsl))
        assertReplacementKept(f, wsl)
    }

    @Test
    fun `an oversize daemon json is neither parsed nor removed`() = withFixture { f ->
        f.healthReply(200, f.health(OTHER))
        val read = f.writeDaemonJson(startedAt = "S1")
        // Still the daemon that was read, but past the cap the supervisor's reader also refuses.
        val padded = f.daemonJson.readText() + " ".repeat(MoeDaemonSupervisor.MAX_DAEMON_JSON_BYTES)
        f.daemonJson.writeText(padded)

        f.doConnect(read)

        assertEquals("an oversize daemon.json must survive untouched", padded, f.daemonJson.takeIf { it.exists() }?.readText())
        assertNull(f.service.field("wsClient"))
        f.assertNoWebSocketRequest()
    }

    @Test
    fun `this project in another spelling connects as today`() = withFixture { f ->
        f.healthReply(200, f.health(f.basePath.replace('\\', '/') + "/"))
        val info = f.writeDaemonJson(startedAt = "S1")
        val before = f.daemonJson.readText()

        f.doConnect(info)

        f.awaitWebSocketRequest()
        assertEquals(before, f.daemonJson.readText())
    }

    @Test
    fun `an unexpected health status connects as today`() = withFixture { f ->
        f.healthReply(500, f.health(OTHER))
        f.doConnect(f.writeDaemonJson(startedAt = "S1"))

        f.awaitWebSocketRequest()
        assertTrue(f.daemonJson.exists())
    }

    @Test
    fun `a health reply without projectPath connects as today`() = withFixture { f ->
        f.healthReply(200, """{"status":"healthy","pid":4242}""")
        f.doConnect(f.writeDaemonJson(startedAt = "S1"))

        f.awaitWebSocketRequest()
        assertTrue(f.daemonJson.exists())
    }

    /** Another daemon rewrote daemon.json (new pid, startedAt and [projectPath]) after connect() read it. */
    private fun assertReplacementKept(f: Fixture, projectPath: String) {
        f.healthReply(200, f.health(OTHER))
        val read = f.writeDaemonJson(startedAt = "S1")
        val replacement = Gson().toJson(read.copy(pid = 5252, startedAt = "S2", projectPath = projectPath))
        f.daemonJson.writeText(replacement)

        f.doConnect(read)

        assertEquals("the replacement must survive byte for byte", replacement, f.daemonJson.takeIf { it.exists() }?.readText())
        assertNull(f.service.field("wsClient"))
        f.assertNoWebSocketRequest()
    }

    private fun withFixture(test: (Fixture) -> Unit) {
        MoeProjectRegistry.clearDaemonRefCountsForTest()
        val fixture = Fixture()
        try {
            test(fixture)
        } finally {
            fixture.close()
            MoeProjectRegistry.clearDaemonRefCountsForTest()
        }
    }

    private class Fixture {
        val dir: File = Files.createTempDirectory("moe-foreign-daemon").toFile()
        val basePath: String = dir.absolutePath
        val daemonJson = File(dir, ".moe/daemon.json")
        val statuses = CopyOnWriteArrayList<String>()
        val wsRequests = AtomicInteger()
        val service = MoeProjectService(fakeProject(basePath)) { it() }
        @Volatile private var healthStatus = 200
        @Volatile private var healthBody = ""
        private val pool = Executors.newCachedThreadPool()
        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            executor = pool
            createContext("/health") { exchange ->
                try {
                    val bytes = healthBody.toByteArray(Charsets.UTF_8)
                    exchange.sendResponseHeaders(healthStatus, bytes.size.toLong())
                    exchange.responseBody.write(bytes)
                } finally {
                    exchange.close()
                }
            }
            // Any WebSocket client the service opens arrives here as its upgrade request.
            createContext("/ws") { exchange ->
                wsRequests.incrementAndGet()
                try {
                    exchange.sendResponseHeaders(404, -1)
                } finally {
                    exchange.close()
                }
            }
            start()
        }

        init {
            File(dir, ".moe").mkdirs()
            service.addListener(object : MoeStateListener {
                override fun onState(state: MoeState) {}
                override fun onStatus(connected: Boolean, message: String) {
                    statuses.add(message)
                }
            })
        }

        fun healthReply(status: Int, body: String) {
            healthStatus = status
            healthBody = body
        }

        fun health(projectPath: String) = """{"status":"healthy","pid":4242,"projectPath":${Gson().toJson(projectPath)}}"""

        fun writeDaemonJson(startedAt: String): DaemonInfo {
            val info = DaemonInfo(server.address.port, 4242, startedAt, basePath)
            daemonJson.writeText(Gson().toJson(info))
            return info
        }

        fun doConnect(info: DaemonInfo) {
            val method = MoeProjectService::class.java.getDeclaredMethod("doConnect", DaemonInfo::class.java)
            method.isAccessible = true
            method.invoke(service, info)
        }

        fun awaitWebSocketRequest() {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (wsRequests.get() == 0 && System.nanoTime() < deadline) Thread.sleep(10)
            assertTrue("the service must open its WebSocket client", wsRequests.get() > 0)
        }

        fun assertNoWebSocketRequest() {
            Thread.sleep(500)
            assertEquals("a foreign daemon must get no /ws request", 0, wsRequests.get())
        }

        fun close() {
            service.dispose()
            server.stop(0)
            pool.shutdownNow()
            dir.deleteRecursively()
        }
    }

    companion object {
        private const val OTHER = "D:/moe-other-project"

        private fun MoeProjectService.field(name: String): Any? =
            MoeProjectService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(this)

        /** [path] as the other side of the Windows/WSL boundary spells it: D:\x is /mnt/d/x, /x is //wsl$/Ubuntu/x. */
        private fun wslSpelling(path: String): String {
            val drive = Regex("^([A-Za-z]):[\\\\/](.*)$").matchEntire(path) ?: return "//wsl$/Ubuntu$path"
            return "/mnt/${drive.groupValues[1].lowercase()}/${drive.groupValues[2].replace('\\', '/')}"
        }

        private fun fakeProject(basePath: String): IdeaProject = Proxy.newProxyInstance(
            IdeaProject::class.java.classLoader,
            arrayOf(IdeaProject::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "getName" -> "Foreign Daemon Test"
                "getBasePath" -> basePath
                "getService" -> null
                "isDisposed" -> false
                "toString" -> "ForeignDaemonTestProject"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.firstOrNull()
                else -> null
            }
        } as IdeaProject
    }
}
