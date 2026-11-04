package com.moe.services

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.ExecutionReadiness
import com.moe.model.MoeState
import com.moe.model.ReadinessFailure
import com.moe.model.ReadinessReply
import com.moe.util.MoeProjectRegistry
import org.java_websocket.WebSocket
import org.java_websocket.WebSocketImpl
import org.java_websocket.client.WebSocketClient
import org.java_websocket.framing.CloseFrame
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.handshake.ServerHandshake
import org.java_websocket.server.WebSocketServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.Timeout
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock

class MoeProjectConnectionTest {
    // Backstop: any future unbounded wait here fails with a stack trace instead of holding the shared jetbrains-gradle lease.
    @get:Rule
    val timeout: Timeout = Timeout.seconds(30)

    @Test
    fun `closing a never-connected client is bounded, where closeBlocking would wait forever`() {
        val client = object : WebSocketClient(URI("ws://127.0.0.1:9/")) {
            override fun onOpen(handshakedata: ServerHandshake?) {}
            override fun onMessage(message: String?) {}
            override fun onClose(code: Int, reason: String?, remote: Boolean) {}
            override fun onError(ex: Exception?) {}
        }
        val started = System.nanoTime()

        val closed = closeWithin(client, timeoutMs = 300)

        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertTrue("Close took ${elapsedMs} ms", elapsedMs < 300 + FORCE_TIMEOUT_MS + 2_000)
        assertTrue("The forced closeConnection must close even a never-opened client", closed)
        assertTrue(client.isClosed)
    }

    @Test
    fun `late open cannot undo manual disconnect`() = withConnection { fixture ->
        val client = fixture.connect(41001)
        fixture.service.disconnect()
        assertTrue("The retired client did not close", closeWithin(client))

        client.onOpen(null)

        assertFalse("A retired client must not reconnect the service", fixture.service.isConnected())
        assertEquals(null, fixture.service.field("refreshFuture"))
    }

    @Test
    fun `late open cannot resurrect a disposed service`() = withConnection { fixture ->
        val client = fixture.connect(41002)
        fixture.service.dispose()
        assertTrue("The disposed service's client did not close", closeWithin(client))

        client.onOpen(null)

        assertFalse("Disposed service must remain disconnected", fixture.service.isConnected())
        assertEquals(0, MoeProjectRegistry.daemonRefCountForTest(41002))
    }

    @Test
    fun `retired open cannot replace the current daemon registration`() = withConnection { fixture ->
        val oldClient = fixture.connect(41003)
        fixture.service.disconnect()
        assertTrue("The old client did not close", closeWithin(oldClient))
        val currentClient = fixture.connect(41004)

        oldClient.onOpen(null)

        assertTrue(fixture.service.isConnected())
        assertEquals(currentClient, fixture.service.field("wsClient"))
        assertEquals(0, MoeProjectRegistry.daemonRefCountForTest(41003))
        assertEquals(1, MoeProjectRegistry.daemonRefCountForTest(41004))
    }

    @Test
    fun `socket error closes the abandoned transport`() = withConnection { fixture ->
        val client = fixture.connect(41005)

        client.onError(IllegalStateException("simulated transport failure"))

        assertFalse(fixture.service.isConnected())
        assertTrue("The server must observe the failed socket closing", fixture.closed.await(2, TimeUnit.SECONDS))
    }

    @Test
    fun `disconnect wins while open is publishing its status`() {
        val publishingOpen = CountDownLatch(1)
        val resumeOpen = CountDownLatch(1)
        val pauseFirstDispatch = AtomicBoolean(true)
        val statuses = CopyOnWriteArrayList<Pair<Boolean, String>>()
        withConnection(invokeLater = { action ->
            if (pauseFirstDispatch.compareAndSet(true, false)) {
                publishingOpen.countDown()
                assertTrue("Open callback was not released", resumeOpen.await(5, TimeUnit.SECONDS))
            }
            action()
        }) { fixture ->
            fixture.service.addListener(object : MoeStateListener {
                override fun onState(state: MoeState) {}
                override fun onStatus(connected: Boolean, message: String) {
                    statuses.add(connected to message)
                }
            })
            val disconnected = CountDownLatch(1)
            val disconnectThread = Thread {
                fixture.service.disconnect()
                disconnected.countDown()
            }
            try {
                val client = fixture.startConnection(41006)
                assertTrue("Open callback did not publish", publishingOpen.await(5, TimeUnit.SECONDS))
                disconnectThread.start()
                val lock = fixture.service.field("wsLock") as ReentrantLock
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                // Wait until disconnect either finishes or waits on the open callback's
                // lock; no timing guess about which thread reached the critical section.
                while (disconnected.count != 0L && !lock.hasQueuedThread(disconnectThread) && System.nanoTime() < deadline) {
                    Thread.sleep(10)
                }
                assertTrue("Disconnect did not reach the connection transition", disconnected.count == 0L || lock.hasQueuedThread(disconnectThread))
                resumeOpen.countDown()
                assertTrue("Disconnect did not finish", disconnected.await(5, TimeUnit.SECONDS))
                assertTrue("The client did not close", closeWithin(client))

                assertFalse(fixture.service.isConnected())
                assertEquals(false to "Disconnected", statuses.last())
                assertEquals(null, fixture.service.field("refreshFuture"))
            } finally {
                resumeOpen.countDown()
                disconnectThread.join(5000)
            }
        }
    }

    @Test
    fun `every open sends the client hello as the first frame, before GET_STATE`() = withConnection { fixture ->
        fixture.connect(41010)
        fixture.awaitFrame("GET_STATE")

        val types = fixture.frameObjects().map { it.get("type").asString }
        assertEquals("CLIENT_HELLO", types.first())
        assertEquals(JsonParser.parseString(HELLO), fixture.frameObjects().first().get("payload"))
        assertEquals("Exactly one hello per socket", 1, types.count { it == "CLIENT_HELLO" })
        assertTrue(types.indexOf("GET_STATE") > 0)
    }

    @Test
    fun `plan approval after the hello still carries expectedPlanRevision`() = withConnection { fixture ->
        fixture.connect(41011)

        assertTrue(fixture.service.approveTask("task-1", 3L))

        val payload = fixture.awaitFrame("APPROVE_TASK").getAsJsonObject("payload")
        assertEquals(JsonParser.parseString("""{"taskId":"task-1","expectedPlanRevision":3}"""), payload)
        assertEquals("CLIENT_HELLO", fixture.frameObjects().first().get("type").asString)
    }

    @Test
    fun `a readiness reply completes the request as Answered`() = withConnection { fixture ->
        fixture.connect(41012)
        fixture.answerReadiness(readiness(
            """{"profile":"verified-local","ready":false,"missingCapabilities":["isolated-check-vm"],"evaluatedAt":"2026-11-01T00:00:00.000Z"}"""
        ))

        val reply = fixture.service.requestExecutionReadiness().get(5, TimeUnit.SECONDS)

        assertEquals(
            ReadinessReply.Answered(ExecutionReadiness("verified-local", false, listOf("isolated-check-vm"), "2026-11-01T00:00:00.000Z")),
            reply
        )
        assertEquals(JsonParser.parseString("""{"refresh":true}"""), fixture.awaitFrame("GET_EXECUTION_READINESS").get("payload"))

        // A ready answer with a null evaluatedAt; an unknown additive key is ignored.
        fixture.answerReadiness(readiness("""{"profile":"verified-local","ready":true,"missingCapabilities":[],"evaluatedAt":null,"extra":1}"""))
        assertEquals(
            ReadinessReply.Answered(ExecutionReadiness("verified-local", true, emptyList(), null)),
            fixture.service.requestExecutionReadiness().get(5, TimeUnit.SECONDS)
        )
    }

    @Test
    fun `a malformed readiness reply is Failed MALFORMED, never Answered`() = withConnection { fixture ->
        fixture.connect(41013)
        val cases = mapOf(
            "missing evaluatedAt" to readiness("""{"profile":"verified-local","ready":true,"missingCapabilities":[]}"""),
            "unknown profile" to readiness("""{"profile":"bogus","ready":true,"missingCapabilities":[],"evaluatedAt":null}"""),
            "string ready" to readiness("""{"profile":"legacy","ready":"true","missingCapabilities":[],"evaluatedAt":null}"""),
            "numeric ready" to readiness("""{"profile":"legacy","ready":1,"missingCapabilities":[],"evaluatedAt":null}"""),
            "number in missing" to readiness("""{"profile":"legacy","ready":false,"missingCapabilities":[1],"evaluatedAt":null}"""),
            "numeric evaluatedAt" to readiness("""{"profile":"legacy","ready":false,"missingCapabilities":[],"evaluatedAt":5}"""),
            "ready with missing ids" to readiness("""{"profile":"verified-local","ready":true,"missingCapabilities":["x"],"evaluatedAt":null}"""),
            "array payload" to """{"type":"EXECUTION_READINESS","payload":[true]}""",
            "no payload" to """{"type":"EXECUTION_READINESS"}"""
        )
        for ((label, message) in cases) {
            fixture.answerReadiness(message)
            assertEquals(label, FAILED_MALFORMED, fixture.service.requestExecutionReadiness().get(5, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `a frame queued without a write demand stays unsent until flush re-arms it`() = withConnection { fixture ->
        fixture.connect(41019)
        val pending = fixture.service.requestExecutionReadiness()
        fixture.awaitFrame("GET_EXECUTION_READINESS")
        val conn = fixture.serverConnection()
        fixture.strand(conn, readiness("""{"profile":"verified-local","ready":true,"missingCapabilities":[],"evaluatedAt":null}"""))

        // The control: nothing else writes on this connection, so no write demand comes and the frame stays queued.
        Thread.sleep(300)
        assertFalse("A stranded frame must not leave on its own", pending.isDone)

        assertTrue("flush must drain the stranded frame", fixture.flush(conn))
        assertEquals(
            ReadinessReply.Answered(ExecutionReadiness("verified-local", true, emptyList(), null)),
            pending.get(5, TimeUnit.SECONDS)
        )
    }

    @Test
    fun `a reply the loopback server strands still answers the request`() = withConnection { fixture ->
        fixture.connect(41020)
        // Every answer is queued the way the race leaves it, so only the fixture's flush can deliver it.
        fixture.enqueue = fixture::strand
        fixture.answerReadiness(readiness("""{"profile":"verified-local","ready":true,"missingCapabilities":[],"evaluatedAt":null}"""))

        assertEquals(
            ReadinessReply.Answered(ExecutionReadiness("verified-local", true, emptyList(), null)),
            fixture.service.requestExecutionReadiness().get(5, TimeUnit.SECONDS)
        )
    }

    @Test
    fun `only a readiness error fails the request, without a generic notification`() = withConnection { fixture ->
        val errors = CopyOnWriteArrayList<String>()
        fixture.service.addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {}
            override fun onStatus(connected: Boolean, message: String) {}
            override fun onError(operation: String, message: String) { errors.add("$operation: $message") }
        })
        fixture.connect(41014)
        for (error in listOf(
            """{"type":"ERROR","operation":"GET_EXECUTION_READINESS","message":"GET_EXECUTION_READINESS failed"}""",
            """{"type":"ERROR","message":"Unknown message type: GET_EXECUTION_READINESS"}"""
        )) {
            fixture.answerReadiness(error)
            assertEquals(error, ReadinessReply.Failed(ReadinessFailure.DAEMON_ERROR), fixture.service.requestExecutionReadiness().get(5, TimeUnit.SECONDS))
        }
        assertEquals(emptyList<String>(), errors.toList())

        fixture.answerReadiness("""{"type":"ERROR","operation":"GET_STATE","message":"boom"}""")
        assertEquals(FAILED_TIMEOUT, fixture.service.requestExecutionReadiness(300).get(5, TimeUnit.SECONDS))
        awaitUntil("The unrelated error keeps today's handling") { errors.contains("GET_STATE: boom") }
    }

    @Test
    fun `an unanswered request times out and leaves the pending set`() = withConnection { fixture ->
        fixture.connect(41015)

        assertEquals(FAILED_TIMEOUT, fixture.service.requestExecutionReadiness(300).get(5, TimeUnit.SECONDS))
        awaitUntil("A completed request must leave the pending set") {
            (fixture.service.field("pendingReadiness") as Collection<*>).isEmpty()
        }
    }

    @Test
    fun `a disconnect or socket error fails pending requests as DISCONNECTED`() = withConnection { fixture ->
        val client = fixture.connect(41016)
        val byError = fixture.service.requestExecutionReadiness()
        client.onError(IllegalStateException("simulated transport failure"))
        assertEquals(FAILED_DISCONNECTED, byError.get(5, TimeUnit.SECONDS))

        fixture.connect(41017)
        val byDisconnect = fixture.service.requestExecutionReadiness()
        fixture.service.disconnect()
        assertEquals(FAILED_DISCONNECTED, byDisconnect.get(5, TimeUnit.SECONDS))

        fixture.connect(41018)
        val byServerClose = fixture.service.requestExecutionReadiness()
        fixture.closeConnectionsFromServer()
        assertEquals(FAILED_DISCONNECTED, byServerClose.get(5, TimeUnit.SECONDS))
    }

    @Test
    fun `a never-connected service fails at once as NOT_CONNECTED and sends nothing`() = withConnection { fixture ->
        val future = fixture.service.requestExecutionReadiness()

        assertTrue(future.isDone)
        assertEquals(ReadinessReply.Failed(ReadinessFailure.NOT_CONNECTED), future.get())
        assertEquals(emptyList<String>(), fixture.frames.toList())
    }

    private fun withConnection(
        invokeLater: ((() -> Unit) -> Unit) = { action -> action() },
        test: (ConnectionFixture) -> Unit
    ) {
        MoeProjectRegistry.clearDaemonRefCountsForTest()
        val fixture = ConnectionFixture(invokeLater)
        try {
            test(fixture)
        } finally {
            fixture.close()
            MoeProjectRegistry.clearDaemonRefCountsForTest()
        }
    }

    private class ConnectionFixture(invokeLater: ((() -> Unit) -> Unit)) {
        val service = MoeProjectService(fakeProject(), invokeLater)
        val closed = CountDownLatch(1)
        /** Every frame the loopback server received, in arrival order. */
        val frames = CopyOnWriteArrayList<String>()
        /** Answers a received frame; null sends nothing. */
        @Volatile var reply: (String) -> String? = { null }
        /** Queues an answer on the server connection; a test swaps in [strand] to replay the race deterministically. */
        @Volatile var enqueue: (WebSocket, String) -> Unit = { conn, text -> conn.send(text) }
        private val started = CountDownLatch(1)
        private val clients = mutableListOf<WebSocketClient>()
        private val server = object : WebSocketServer(InetSocketAddress("127.0.0.1", 0), 1) {
            override fun onStart() { started.countDown() }
            override fun onOpen(conn: WebSocket?, handshake: ClientHandshake?) {}
            override fun onMessage(conn: WebSocket?, message: String?) {
                if (message == null) return
                frames.add(message)
                val answer = reply(message) ?: return
                val socket = conn ?: return
                this@ConnectionFixture.enqueue(socket, answer)
                this@ConnectionFixture.flush(socket)
            }
            override fun onClose(conn: WebSocket?, code: Int, reason: String?, remote: Boolean) {
                closed.countDown()
            }
            override fun onError(conn: WebSocket?, ex: Exception?) {}
        }

        init {
            server.start()
            assertTrue("Loopback server did not start", started.await(5, TimeUnit.SECONDS))
        }

        fun connect(pid: Int): WebSocketClient {
            val client = startConnection(pid)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while ((!service.isConnected() || service.field("refreshFuture") == null) && System.nanoTime() < deadline) {
                Thread.sleep(10)
            }
            assertTrue("Service did not connect to loopback server", service.isConnected())
            assertTrue("Connection callback did not finish", service.field("refreshFuture") != null)
            return client
        }

        fun startConnection(pid: Int): WebSocketClient {
            val method = MoeProjectService::class.java.getDeclaredMethod("doConnect", DaemonInfo::class.java)
            method.isAccessible = true
            method.invoke(service, DaemonInfo(server.port, pid, "now", ""))
            return (service.field("wsClient") as WebSocketClient).also { clients.add(it) }
        }

        fun frameObjects(): List<JsonObject> = frames.map { JsonParser.parseString(it).asJsonObject }

        /** Bounded wait for the first received frame of [type]. */
        fun awaitFrame(type: String): JsonObject {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (System.nanoTime() < deadline) {
                frameObjects().firstOrNull { it.get("type").asString == type }?.let { return it }
                Thread.sleep(10)
            }
            throw AssertionError("No $type frame within 5 s; got ${frames.toList()}")
        }

        /** The daemon side hangs up: the client sees onClose. */
        fun closeConnectionsFromServer() = server.connections.forEach { it.close() }

        /** The server side of the fixture's one open connection. */
        fun serverConnection(): WebSocket = server.connections.single()

        /**
         * Re-arms [conn]'s write demand until the server has written everything queued on it, for at most 2 s, and
         * returns whether the queue drained.
         *
         * Root cause of the malformed-readiness flake (task-8784d35d): Java-WebSocket 1.6.0's WebSocketServer can
         * leave a sent frame queued while the connection's selection key is back on OP_READ. send() queues the frame
         * and sets OP_READ|OP_WRITE, the selector's doWrite sets OP_READ alone once it finds the queue empty, and
         * nothing orders the two. The frame then waits for the next write demand on that connection. This server
         * writes nothing but its answers, so a stranded answer never left and the request's get(5, SECONDS) timed out.
         * A standalone harness on the same jar stranded about 1 reply in 6,600, every time with one frame queued and
         * interestOps OP_READ, and one more onWriteDemand delivered it at once. Production is not exposed: the plugin
         * talks to the Node daemon, never to this server.
         */
        fun flush(conn: WebSocket): Boolean {
            val queue = (conn as WebSocketImpl).outQueue
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (queue.isNotEmpty() && System.nanoTime() < deadline) {
                server.onWriteDemand(conn)
                Thread.sleep(1)
            }
            return queue.isEmpty()
        }

        /** Queues [text] on [conn] with no write demand: the stranded state [flush] exists for. */
        fun strand(conn: WebSocket, text: String) {
            val impl = conn as WebSocketImpl
            impl.draft.createFrames(text, false).forEach { impl.outQueue.put(impl.draft.createBinaryFrame(it)) }
        }

        /** Answers only GET_EXECUTION_READINESS, with [message]. */
        fun answerReadiness(message: String) {
            reply = { frame -> message.takeIf { frame.contains("\"GET_EXECUTION_READINESS\"") } }
        }

        fun close() {
            service.dispose()
            // Bounded and non-throwing: a stuck close must not hang the gate or mask the test's own failure.
            clients.forEach { closeWithin(it) }
            server.stop(1000)
        }
    }

    companion object {
        private const val HELLO = """{"protocolVersion":1,"capabilities":{"planRevisions":true,"verifiedLocal":true}}"""
        private val FAILED_MALFORMED = ReadinessReply.Failed(ReadinessFailure.MALFORMED)
        private val FAILED_TIMEOUT = ReadinessReply.Failed(ReadinessFailure.TIMEOUT)
        private val FAILED_DISCONNECTED = ReadinessReply.Failed(ReadinessFailure.DISCONNECTED)

        private fun readiness(payload: String) = """{"type":"EXECUTION_READINESS","payload":$payload}"""

        private const val CLOSE_TIMEOUT_MS = 3_000L
        private const val FORCE_TIMEOUT_MS = 1_000L

        /** Polls [condition] every 10 ms for up to [timeoutMs]; never asserts. Returns the final result. */
        private fun pollUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (!condition() && System.nanoTime() < deadline) Thread.sleep(10)
            return condition()
        }

        /**
         * Bounded replacement for Java-WebSocket's untimed `closeBlocking()`. That call waits on a latch
         * that is counted down only in onWebsocketClose, so it hangs forever for a client that never
         * opened (close() is then a no-op) or whose close handshake the peer never finishes. This polls
         * the engine state instead: close(), wait up to [timeoutMs] for isClosed, then drop the
         * connection with closeConnection(ABNORMAL_CLOSE) and wait [FORCE_TIMEOUT_MS] more. Returns
         * whether the client ended up closed; exceptions from close are logged, never thrown.
         */
        private fun closeWithin(client: WebSocketClient, timeoutMs: Long = CLOSE_TIMEOUT_MS): Boolean {
            try {
                client.close()
            } catch (e: Exception) {
                System.err.println("MoeProjectConnectionTest: close() threw on ${client.uri}: $e")
            }
            if (pollUntil(timeoutMs) { client.isClosed }) return true
            try {
                client.closeConnection(CloseFrame.ABNORMAL_CLOSE, "test teardown: close timed out")
            } catch (e: Exception) {
                System.err.println("MoeProjectConnectionTest: closeConnection() threw on ${client.uri}: $e")
            }
            if (pollUntil(FORCE_TIMEOUT_MS) { client.isClosed }) return true
            System.err.println(
                "MoeProjectConnectionTest: abandoned WebSocket client ${client.uri} in state ${client.readyState} " +
                    "after ${timeoutMs + FORCE_TIMEOUT_MS} ms"
            )
            return false
        }

        private fun awaitUntil(message: String, condition: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!condition() && System.nanoTime() < deadline) Thread.sleep(10)
            assertTrue(message, condition())
        }

        private fun MoeProjectService.field(name: String): Any? =
            MoeProjectService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(this)

        private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
            IdeaProject::class.java.classLoader,
            arrayOf(IdeaProject::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "getName" -> "Connection Test"
                "getBasePath", "getService" -> null
                "isDisposed" -> false
                "toString" -> "ConnectionTestProject"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.firstOrNull()
                else -> null
            }
        } as IdeaProject
    }
}
