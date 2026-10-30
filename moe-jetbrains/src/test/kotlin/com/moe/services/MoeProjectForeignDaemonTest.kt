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
