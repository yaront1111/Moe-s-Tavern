package com.moe.services

import com.google.gson.Gson
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DaemonIdentityTest {
    private val servers = mutableListOf<HttpServer>()
    private val executors = mutableListOf<ExecutorService>()

    @After
    fun tearDown() {
        servers.forEach { it.stop(0) }
        executors.forEach { it.shutdownNow() }
    }

    @Test
    fun `this project in another spelling is Same`() {
        for (served in listOf("D:/proj", "D:\\proj", "d:/proj", "D:/proj/", "/mnt/d/proj", "D:\\a\\..\\proj")) {
            assertEquals(served, DaemonIdentity.Same, probe(200, health(served)))
        }
    }

    @Test
    fun `a WSL-hosted daemon serving this project is Same`() {
        assertEquals(DaemonIdentity.Same, probe(200, health("/home/u/p"), own = "//wsl$/Ubuntu/home/u/p"))
        assertEquals(DaemonIdentity.Same, probe(200, health("/home/u/p"), own = "\\\\wsl.localhost\\Ubuntu\\home\\u\\p"))
        assertEquals(DaemonIdentity.Same, probe(200, health("/mnt/d/proj"), own = "//WSL$/Ubuntu/mnt/d/proj"))
    }

    @Test
    fun `another absolute project is Foreign with the served path`() {
        assertEquals(DaemonIdentity.Foreign("D:/other"), probe(200, health("D:/other")))
        assertEquals(DaemonIdentity.Foreign("/home/u/proj"), probe(200, health("/home/u/proj")))
        assertEquals(DaemonIdentity.Foreign("/mnt/e/proj"), probe(200, health("/mnt/e/proj")))
        assertEquals(DaemonIdentity.Foreign("\\\\server\\share\\proj"), probe(200, health("\\\\server\\share\\proj")))
    }

    @Test
    fun `an unhealthy reply still names its project`() {
        assertEquals(DaemonIdentity.Foreign("D:/other"), probe(503, health("D:/other", status = "unhealthy")))
        assertEquals(DaemonIdentity.Same, probe(503, health("D:\\proj", status = "unhealthy")))
    }

    @Test
    fun `a relative served path is Unknown`() {
        for (served in listOf(".", "..", "sub/p", "proj", "D:proj", "\\proj")) {
            assertEquals(served, DaemonIdentity.Unknown, probe(200, health(served)))
        }
    }

    @Test
    fun `a relative own path never yields Foreign`() {
        assertEquals(DaemonIdentity.Unknown, probe(200, health("D:/other"), own = "proj"))
    }

    @Test
    fun `a reply without a usable projectPath is Unknown`() {
        val bodies = listOf(
            """{"status":"healthy","pid":1}""",
            """{"projectPath":42}""",
            """{"projectPath":""}""",
            """{"projectPath":"   "}""",
            """{"projectPath":null}""",
            """{"projectPath":{"path":"D:/other"}}""",
            """{"projectPath":["D:/other"]}"""
        )
        for (body in bodies) assertEquals(body, DaemonIdentity.Unknown, probe(200, body))
    }

    @Test
    fun `a body that is not a JSON object is Unknown`() {
        for (body in listOf("not json", "[\"D:/other\"]", "\"D:/other\"", "", "{\"projectPath\":\"D:/other\"")) {
            assertEquals(body, DaemonIdentity.Unknown, probe(200, body))
        }
    }

    @Test
    fun `a body over 64 KiB is Unknown and one at the cap is classified`() {
        val json = health("D:/other")
        val atCap = json + " ".repeat(DaemonIdentityProbe.MAX_HEALTH_BODY_BYTES - json.length)
        assertEquals(DaemonIdentityProbe.MAX_HEALTH_BODY_BYTES, atCap.toByteArray().size)
        assertEquals(DaemonIdentity.Foreign("D:/other"), probe(200, atCap))
        assertEquals(DaemonIdentity.Unknown, probe(200, "$atCap "))
        assertEquals(DaemonIdentity.Unknown, probe(200, json + " ".repeat(1024 * 1024)))
    }

    @Test
    fun `statuses other than 200 and 503 are Unknown`() {
        for (status in listOf(204, 404, 426, 500, 502)) {
            assertEquals("HTTP $status", DaemonIdentity.Unknown, probe(status, health("D:/other")))
            assertEquals("classify $status", DaemonIdentity.Unknown, DaemonIdentityProbe.classify(status, health("D:/other"), OWN))
        }
        assertEquals(DaemonIdentity.Foreign("D:/other"), DaemonIdentityProbe.classify(503, health("D:/other"), OWN))
    }

    @Test
    fun `a redirect is not followed`() {
        val target = serve(200, health("D:/other"))
        val port = serve { exchange ->
            exchange.responseHeaders.add("Location", "http://127.0.0.1:$target/health")
            exchange.sendResponseHeaders(302, -1)
        }
        assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.probe(port, OWN))
    }

    @Test
    fun `an unreachable or invalid port is Unknown`() {
        val stopped = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val port = stopped.address.port
        stopped.stop(0)
        assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.probe(port, OWN))
        assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.probe(0, OWN))
        assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.probe(-1, OWN))
        assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.probe(70000, OWN))
    }

    @Test
    fun `a reply slower than the read timeout is Unknown within the bound`() {
        val port = serve { exchange ->
            Thread.sleep(5_000)
            respond(exchange, 200, health("D:/other"))
        }
        val elapsedMs = timed { assertEquals(DaemonIdentity.Unknown, probeFast(port)) }
        assertTrue("probe took ${elapsedMs}ms", elapsedMs < 2_000)
    }

    @Test
    fun `a trickling reply is cut off by the total deadline`() {
        val port = serve { exchange ->
            exchange.sendResponseHeaders(200, 0)
            val out = exchange.responseBody
            for (byte in health("D:/other").toByteArray()) {
                out.write(byte.toInt())
                out.flush()
                Thread.sleep(100)
            }
        }
        val elapsedMs = timed { assertEquals(DaemonIdentity.Unknown, probeFast(port)) }
        assertTrue("probe took ${elapsedMs}ms", elapsedMs < 2_000)
    }

    @Test
    fun `comparableProjectPath folds Windows, WSL and UNC spellings`() {
        val rows = mapOf(
            "D:\\proj" to "d:/proj",
            "D:/proj/" to "d:/proj",
            "d:\\Proj\\" to "d:/proj",
            " D:/proj " to "d:/proj",
            "D:\\" to "d:",
            "D:/a/./b/../proj" to "d:/a/proj",
            "D:/../proj" to "d:/proj",
            "/mnt/d/proj" to "d:/proj",
            "/mnt/D/Proj/" to "d:/proj",
            "/mnt/d" to "d:",
            "/mnt/d/a/../proj" to "d:/proj",
            "/mnt/d/../c/x" to "c:/x",
            "/mnt/dd/x" to "/mnt/dd/x",
            "/home/u/./x/../p" to "/home/u/p",
            "/home//u///p/" to "/home/u/p",
            "/home/U/P" to "/home/U/P",
            "/" to "/",
            "/../x" to "/x",
            "//wsl$/Ubuntu/home/u/p" to "/home/u/p",
            "\\\\wsl.localhost\\Ubuntu\\home\\U\\p" to "/home/U/p",
            "//WSL$/Ubuntu/mnt/d/proj" to "d:/proj",
            "//wsl$/Ubuntu" to "/",
            "\\\\Server\\Share\\Dir" to "//server/share/dir",
            "//server/share/a/../b" to "//server/share/b",
            "//server/share/../../b" to "//server/share/b",
            "sub/./p/" to "sub/p"
        )
        for ((input, expected) in rows) {
            assertEquals(input, expected, DaemonIdentityProbe.comparableProjectPath(input))
        }
    }

    @Test
    fun `isAbsoluteAnyOs accepts drive, UNC and POSIX roots only`() {
        for (path in listOf("D:\\x", "d:/x", "D:\\", "D:/", "/x", "/", "\\\\server\\share", "//server/share", "//wsl$/Ubuntu/home")) {
            assertTrue(path, DaemonIdentityProbe.isAbsoluteAnyOs(path))
        }
        for (path in listOf("", "  ", ".", "..", "./x", "sub/p", "D:x", "D:", "\\x", "~/p", "1:/x", " /x", "\\\\\\x")) {
            assertFalse(path, DaemonIdentityProbe.isAbsoluteAnyOs(path))
        }
    }

    private fun probe(status: Int, body: String, own: String = OWN): DaemonIdentity =
        DaemonIdentityProbe.probe(serve(status, body), own)

    private fun probeFast(port: Int): DaemonIdentity =
        DaemonIdentityProbe.probe(port, OWN, connectTimeoutMs = 200, readTimeoutMs = 200)

    private fun timed(block: () -> Unit): Long {
        val started = System.nanoTime()
        block()
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
    }

    private fun serve(status: Int, body: String): Int = serve { respond(it, status, body) }

    /** Serves GET /health on an ephemeral loopback port; [handler] writes the reply. */
    private fun serve(handler: (HttpExchange) -> Unit): Int {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val executor = Executors.newCachedThreadPool()
        server.executor = executor
        server.createContext("/health") { exchange ->
            try {
                handler(exchange)
            } catch (_: Exception) {
                // The client may hang up first (cap, timeout); that is the point of those rows.
            } finally {
                exchange.close()
            }
        }
        server.start()
        servers += server
        executors += executor
        return server.address.port
    }

    private fun respond(exchange: HttpExchange, status: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
        if (bytes.isNotEmpty()) exchange.responseBody.write(bytes)
    }

    private fun health(projectPath: String, status: String = "healthy"): String =
        """{"status":"$status","pid":4242,"projectPath":${Gson().toJson(projectPath)}}"""

    companion object {
        private const val OWN = "D:/proj"
    }
}
