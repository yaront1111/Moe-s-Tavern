package com.moe.services

import com.google.gson.Gson
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.ServerSocket
import java.net.SocketAddress
import java.net.URI
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DaemonIdentityTest {
    private val servers = mutableListOf<HttpServer>()
    private val executors = mutableListOf<ExecutorService>()
    private val rawServers = mutableListOf<ServerSocket>()
    private val links = mutableListOf<Path>()
    private val dirs = mutableListOf<Path>()
    private val realDiskCheck = DaemonIdentityProbe.sameDirectoryOnDisk

    @After
    fun tearDown() {
        DaemonIdentityProbe.sameDirectoryOnDisk = realDiskCheck
        servers.forEach { it.stop(0) }
        executors.forEach { it.shutdownNow() }
        rawServers.forEach { it.close() }
        // Links first: deleting a symlink or junction removes the entry, never its target.
        links.forEach { Files.deleteIfExists(it) }
        dirs.forEach { Files.deleteIfExists(it) }
    }

    @Test
    fun `a project opened through a directory link to the served directory is Same`() {
        val real = tempDir("moe-id-real")
        val link = dirLink(real)
        Assume.assumeNotNull(link)
        assertEquals(DaemonIdentity.Same, DaemonIdentityProbe.classify(200, health(real.toString()), link.toString()))
        assertTrue(MoeDaemonSupervisor.isSameProject(real.toString(), link.toString()))
    }

    @Test
    fun `a link to one project is still Foreign to another project`() {
        val other = tempDir("moe-id-other")
        val link = dirLink(tempDir("moe-id-real"))
        Assume.assumeNotNull(link)
        assertEquals(
            DaemonIdentity.Foreign(other.toString()),
            DaemonIdentityProbe.classify(200, health(other.toString()), link.toString()),
        )
        assertFalse(MoeDaemonSupervisor.isSameProject(other.toString(), link.toString()))
    }

    @Test
    fun `a relative served path stays Unknown through a link`() {
        val link = dirLink(tempDir("moe-id-real"))
        Assume.assumeNotNull(link)
        assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.classify(200, health("proj"), link.toString()))
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
        // A released port refuses at once; a never-started HttpServer still listens after stop(0) (JDK 21).
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
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
    fun `trickling headers are cut off by the whole-request deadline and the socket is closed`() {
        // A status line, then a header byte every 100 ms for 10 s: each byte restarts a per-read timeout.
        val (port, responder) = rawServer { out ->
            out.write("HTTP/1.1 200 OK\r\nX-Slow: ".toByteArray())
            repeat(100) {
                out.write('x'.code)
                Thread.sleep(100)
            }
        }
        val elapsedMs = timed { assertEquals(DaemonIdentity.Unknown, probeFast(port)) }
        assertTrue("probe took ${elapsedMs}ms", elapsedMs < 2_000)
        responder.join(3_000)
        assertFalse("the probe must close its socket, not abandon a blocked read", responder.isAlive)
    }

    @Test
    fun `the last read waits only the time left before the deadline`() {
        // A header byte 1.8 s into a 2.2 s budget: a full 2 s read timeout after it would end at 3.8 s.
        val (port, _) = rawServer { out ->
            out.write("HTTP/1.1 200 OK\r\n".toByteArray())
            Thread.sleep(1_800)
            out.write('X'.code)
            Thread.sleep(5_000)
        }
        val elapsedMs = timed {
            assertEquals(DaemonIdentity.Unknown, DaemonIdentityProbe.probe(port, OWN, connectTimeoutMs = 200, readTimeoutMs = 2_000))
        }
        assertTrue("probe took ${elapsedMs}ms", elapsedMs < 3_000)
    }

    @Test
    fun `the probe never consults the IDE proxy selector`() {
        val port = serve(200, health("D:/other"))
        val asked = CopyOnWriteArrayList<URI>()
        val saved = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> {
                asked += uri
                return listOf(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", 9)))
            }

            override fun connectFailed(uri: URI, sa: SocketAddress, ioe: IOException) {}
        })
        try {
            assertEquals(DaemonIdentity.Foreign("D:/other"), DaemonIdentityProbe.probe(port, OWN))
        } finally {
            ProxySelector.setDefault(saved)
        }
        assertEquals(emptyList<URI>(), asked)
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

    @Test
    fun `a UNC or device spelling never reaches the disk check and is Foreign`() {
        val local = tempDir("moe-id-local").toString()
        val asked = CopyOnWriteArrayList<Pair<String, String>>()
        // A disk check that says Same: only the guard can keep these spellings Foreign, and no run opens SMB.
        DaemonIdentityProbe.sameDirectoryOnDisk = { a, b -> asked += a to b; true }
        for (spelling in listOf("""\\host\share\x""", "//host/share/x", """\\?\UNC\host\share\x""", """\\.\C:\x""", """\\?\C:\x""")) {
            assertEquals(spelling, DaemonIdentity.Foreign(spelling), DaemonIdentityProbe.classify(200, health(spelling), local))
            assertFalse(spelling, MoeDaemonSupervisor.isSameProject(spelling, local))
            assertFalse(spelling, DaemonIdentityProbe.isSameProjectPath(local, spelling))
        }
        assertEquals(emptyList<Pair<String, String>>(), asked)
    }

    @Test
    fun `two local spellings that differ still reach the disk check`() {
        val local = tempDir("moe-id-local").toString()
        val other = tempDir("moe-id-other").toString()
        val asked = CopyOnWriteArrayList<Pair<String, String>>()
        DaemonIdentityProbe.sameDirectoryOnDisk = { a, b -> asked += a to b; false }
        assertEquals(DaemonIdentity.Foreign(other), DaemonIdentityProbe.classify(200, health(other), local))
        assertEquals(listOf(other to local), asked)
    }

    @Test
    fun `a relative spelling is answered by its spelling alone`() {
        val local = tempDir("moe-id-local").toString()
        val asked = CopyOnWriteArrayList<Pair<String, String>>()
        DaemonIdentityProbe.sameDirectoryOnDisk = { a, b -> asked += a to b; true }
        for (spelling in listOf(".", "proj", "sub/p", "D:proj", """\proj""")) {
            assertFalse(spelling, MoeDaemonSupervisor.isSameProject(spelling, local))
            assertFalse(spelling, DaemonIdentityProbe.isSameProjectPath(local, spelling))
        }
        assertEquals(emptyList<Pair<String, String>>(), asked)
    }

    @Test
    fun `isLocalHostAbsolute keeps network, device and relative spellings off the disk`() {
        val windowsYes = listOf("""D:\x""", "d:/x", """D:\""", "D:/")
        val windowsNo = listOf(
            """\\host\share\x""", "//host/share/x", """\\?\UNC\host\share\x""", """\\?\D:\x""", """\\.\C:\x""", "//?/D:/x",
            """\/host/x""", "/x", "/mnt/d/x", """\x""", "D:x", "D:", ".", "proj", "", " D:/x",
        )
        val posixYes = listOf("/x", "/", "/mnt/d/x", "/home/u/p")
        val posixNo = listOf(
            "//host/share/x", """\\host\share\x""", "//wsl$/Ubuntu/x", """/\host""", """D:\x""", "d:/x", ".", "proj", "", """\x""", " /x",
        )
        for (path in windowsYes) assertTrue("windows $path", DaemonIdentityProbe.isLocalHostAbsolute(path, windows = true))
        for (path in windowsNo) assertFalse("windows $path", DaemonIdentityProbe.isLocalHostAbsolute(path, windows = true))
        for (path in posixYes) assertTrue("posix $path", DaemonIdentityProbe.isLocalHostAbsolute(path, windows = false))
        for (path in posixNo) assertFalse("posix $path", DaemonIdentityProbe.isLocalHostAbsolute(path, windows = false))
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

    /** A raw loopback server whose one connection runs [script]; a write the probe hung up on ends it. */
    private fun rawServer(script: (OutputStream) -> Unit): Pair<Int, Thread> {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        rawServers += server
        val responder = Thread {
            try {
                server.accept().use { script(it.getOutputStream()) }
            } catch (_: Exception) {
                // The probe hung up first: that is the point of these rows.
            }
        }.apply { isDaemon = true; start() }
        return server.localPort to responder
    }

    private fun respond(exchange: HttpExchange, status: Int, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
        if (bytes.isNotEmpty()) exchange.responseBody.write(bytes)
    }

    private fun tempDir(prefix: String): Path = Files.createTempDirectory(prefix).also { dirs.add(it) }

    /**
     * A sibling '<name>-link' to [target]: a symlink, else (Windows without the symlink privilege) a
     * directory junction, which needs none; null when neither can be made.
     */
    private fun dirLink(target: Path): Path? {
        val link = target.resolveSibling("${target.fileName}-link")
        val made = try {
            Files.createSymbolicLink(link, target)
            true
        } catch (_: Exception) {
            MoeDaemonSupervisor.isWindowsHost() && junction(link, target)
        }
        // Recorded even when a timed-out mklink left an entry behind, so tearDown removes it.
        if (Files.exists(link, LinkOption.NOFOLLOW_LINKS)) links.add(link)
        return link.takeIf { made }
    }

    private fun junction(link: Path, target: Path): Boolean = try {
        val process = ProcessBuilder("cmd", "/c", "mklink", "/J", link.toString(), target.toString())
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start()
        if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly()
        !process.isAlive && process.exitValue() == 0 && Files.exists(link)
    } catch (_: Exception) {
        false
    }

    private fun health(projectPath: String, status: String = "healthy"): String =
        """{"status":"$status","pid":4242,"projectPath":${Gson().toJson(projectPath)}}"""

    companion object {
        private const val OWN = "D:/proj"
    }
}
