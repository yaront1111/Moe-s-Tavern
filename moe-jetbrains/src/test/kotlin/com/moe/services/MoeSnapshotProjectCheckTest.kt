package com.moe.services

import com.google.gson.Gson
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.util.MoeProjectRegistry
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The STATE_SNAPSHOT project check: this project in any Windows/WSL spelling is no mismatch, another project
 * disconnects and reconnects, and only the service removes daemon.json, and only while it still names the
 * daemon the client connected with.
 */
class MoeSnapshotProjectCheckTest {
    @Test
    fun `S1 this project in any spelling is neither a mismatch nor a disconnect`() {
        for ((base, spellings) in SAME_PROJECT) for (rootPath in spellings) {
            val probe = DispatcherProbe(base)

            probe.dispatcher.handle(snapshot(rootPath))

            val row = "base=$base rootPath=$rootPath"
            assertEquals("no mismatch for $row", 0, probe.mismatches.get())
            assertEquals("the snapshot applies for $row", rootPath, probe.state?.project?.rootPath)
        }
    }

    @Test
    fun `S2 another project is one mismatch and the dispatcher never touches daemon json`() {
        val dirs = listOf(tempDir("moe-snapshot-a"), tempDir("moe-snapshot-b"))
        try {
            val (a, b) = dirs
            val daemonJson = File(a, ".moe/daemon.json").apply {
                parentFile.mkdirs()
                writeText("""{"port":1,"pid":2,"startedAt":"S","projectPath":${Gson().toJson(a.absolutePath)}}""")
            }
            val before = daemonJson.readText()
            for (rootPath in listOf(b.absolutePath, wslSpelling(b.absolutePath))) {
                val probe = DispatcherProbe(a.absolutePath)

                probe.dispatcher.handle(snapshot(rootPath))

                assertEquals("exactly one mismatch for $rootPath", 1, probe.mismatches.get())
                assertNull("a foreign state never applies for $rootPath", probe.state)
                assertEquals("the dispatcher leaves daemon.json alone for $rootPath", before, daemonJson.takeIf { it.exists() }?.readText())
            }
        } finally {
            dirs.forEach { it.deleteRecursively() }
        }
    }

    @Test
    fun `C1 a live client that receives this project in its other-side spelling stays connected`() = withFixture { f ->
        val info = f.writeDaemonJson()
        val before = f.daemonJson.readText()
        val spelling = wslSpelling(f.basePath)
        f.rootPath = spelling

        f.openClient(info)

        awaitTrue("the snapshot must apply: ${f.service.getState()}") { f.service.getState() != null }
        assertEquals(spelling, f.service.getState()!!.project.rootPath)
        assertTrue("the client must stay connected", f.service.isConnected())
        assertNotNull(f.service.field("wsClient"))
        assertNull("no reconnect for a same-project spelling", f.service.field("reconnectFuture"))
        assertEquals(before, f.daemonJson.takeIf { it.exists() }?.readText())
    }

    @Test
    fun `C2 a live client that receives another project disconnects and removes the daemon json it connected with`() = withFixture { f ->
        val info = f.writeDaemonJson()
        f.rootPath = f.other.absolutePath

        f.openClient(info)

        awaitTrue("the reconnect must be scheduled") { f.service.field("reconnectFuture") != null }
        assertFalse(f.service.isConnected())
        assertNull(f.service.field("wsClient"))
        assertNull("the foreign state never applies", f.service.getState())
        assertFalse("the daemon.json that still names the client's daemon must go", f.daemonJson.exists())
    }

    @Test
    fun `C3 a daemon json changed since connect survives the mismatch byte for byte`() {
        val changes: List<Pair<String, (DaemonInfo, File) -> DaemonInfo>> = listOf(
            "pid" to { read: DaemonInfo, _: File -> read.copy(pid = 5252) },
            "port" to { read: DaemonInfo, _: File -> read.copy(port = read.port + 1) },
            "startedAt" to { read: DaemonInfo, _: File -> read.copy(startedAt = "S2") },
            "projectPath" to { read: DaemonInfo, other: File -> read.copy(projectPath = other.absolutePath) }
        )
        for ((field, change) in changes) withFixture { f ->
            val read = f.writeDaemonJson()
            val replacement = Gson().toJson(change(read, f.other))
            f.daemonJson.writeText(replacement)
            f.rootPath = f.other.absolutePath

            f.openClient(read)

            awaitTrue("the reconnect must still be scheduled ($field)") { f.service.field("reconnectFuture") != null }
            assertNull("the foreign state never applies ($field)", f.service.getState())
            assertEquals("the $field replacement must survive", replacement, f.daemonJson.takeIf { it.exists() }?.readText())
        }
    }

    private fun withFixture(test: (ServiceFixture) -> Unit) {
        MoeProjectRegistry.clearDaemonRefCountsForTest()
        val fixture = ServiceFixture()
        try {
            test(fixture)
        } finally {
            fixture.close()
            MoeProjectRegistry.clearDaemonRefCountsForTest()
        }
    }

    private fun awaitTrue(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition() && System.nanoTime() < deadline) Thread.sleep(10)
        assertTrue(message, condition())
    }

    private class DispatcherProbe(basePath: String) {
        val mismatches = AtomicInteger()
        var state: MoeState? = null
        val dispatcher = MoeMessageDispatcher(
            project = fakeProject(basePath),
            invokeLater = { it() },
            isDisposed = { false },
            currentState = { state },
            updateState = { state = it },
            onProjectMismatch = { mismatches.incrementAndGet() },
            onDaemonShuttingDown = {}
        )
    }

    /** A service with a loopback daemon that greets every client with a STATE_SNAPSHOT naming [rootPath]. */
    private class ServiceFixture {
        val dir: File = tempDir("moe-snapshot-svc")
        val other: File = tempDir("moe-snapshot-other")
        val basePath: String = dir.absolutePath
        val daemonJson = File(dir, ".moe/daemon.json")
        @Volatile var rootPath: String = basePath
        val service = MoeProjectService(fakeProject(basePath)) { it() }
        private val started = CountDownLatch(1)
        private val server = object : WebSocketServer(InetSocketAddress("127.0.0.1", 0), 1) {
            override fun onStart() { started.countDown() }
            override fun onOpen(conn: WebSocket?, handshake: ClientHandshake?) { conn?.send(snapshot(rootPath)) }
            override fun onMessage(conn: WebSocket?, message: String?) {}
            override fun onClose(conn: WebSocket?, code: Int, reason: String?, remote: Boolean) {}
            override fun onError(conn: WebSocket?, ex: Exception?) {}
        }

        init {
            File(dir, ".moe").mkdirs()
            // A reconnect that fires before dispose must not start a real daemon.
            val supervisor = MoeDaemonSupervisor(basePath, "Test", processStarter = { error("must not spawn") })
            MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(service, supervisor)
            server.start()
            assertTrue("Loopback server did not start", started.await(5, TimeUnit.SECONDS))
        }

        fun writeDaemonJson(): DaemonInfo {
            val info = DaemonInfo(server.port, 4242, "S1", basePath)
            daemonJson.writeText(Gson().toJson(info))
            return info
        }

        /** Straight to the WebSocket client, so no /health probe runs: MoeProjectForeignDaemonTest owns that path. */
        fun openClient(info: DaemonInfo) {
            val method = MoeProjectService::class.java.getDeclaredMethod("openClient", DaemonInfo::class.java)
            method.isAccessible = true
            method.invoke(service, info)
        }

        fun close() {
            try {
                service.dispose()
                server.stop(1000)
            } finally {
                dir.deleteRecursively()
                other.deleteRecursively()
            }
        }
    }

    companion object {
        /** Every spelling in a row equals its base under comparableProjectPath, so none touches a file system or network. */
        private val SAME_PROJECT: List<Pair<String, List<String>>> = listOf(
            "D:/moe-snapshot-proj" to listOf(
                """D:\moe-snapshot-proj""", "D:/moe-snapshot-proj", """d:\MOE-SNAPSHOT-PROJ\""",
                "D:/moe-snapshot-proj/sub/..", "/mnt/d/moe-snapshot-proj", "/mnt/d/moe-snapshot-proj/",
                "//wsl$/Ubuntu/mnt/d/moe-snapshot-proj", """\\wsl.localhost\Ubuntu\mnt\d\moe-snapshot-proj"""
            ),
            "//wsl$/Ubuntu/home/moe-test/proj" to listOf(
                "/home/moe-test/proj", """\\wsl$\Ubuntu\home\moe-test\proj""", "//wsl.localhost/Ubuntu/home/moe-test/proj/"
            ),
            "/home/moe-test/proj" to listOf("//wsl$/Ubuntu/home/moe-test/proj")
        )

        private fun tempDir(prefix: String): File = Files.createTempDirectory(prefix).toFile()

        private fun snapshot(rootPath: String) =
            """{"type":"STATE_SNAPSHOT","payload":{"project":{"id":"proj-1","name":"Moe","rootPath":${Gson().toJson(rootPath)}},"epics":[],"tasks":[],"workers":[]}}"""

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
                "getName" -> "Snapshot Project Check Test"
                "getBasePath" -> basePath
                "getService" -> null
                "isDisposed" -> false
                "toString" -> "SnapshotProjectCheckTestProject"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.firstOrNull()
                else -> null
            }
        } as IdeaProject
    }
}
