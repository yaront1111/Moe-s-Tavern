package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.util.MoeProjectRegistry
import org.java_websocket.WebSocket
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock

class MoeProjectConnectionTest {
    @Test
    fun `late open cannot undo manual disconnect`() = withConnection { fixture ->
        val client = fixture.connect(41001)
        fixture.service.disconnect()
        client.closeBlocking()

        client.onOpen(null)

        assertFalse("A retired client must not reconnect the service", fixture.service.isConnected())
        assertEquals(null, fixture.service.field("refreshFuture"))
    }

    @Test
    fun `late open cannot resurrect a disposed service`() = withConnection { fixture ->
        val client = fixture.connect(41002)
        fixture.service.dispose()
        client.closeBlocking()

        client.onOpen(null)

        assertFalse("Disposed service must remain disconnected", fixture.service.isConnected())
        assertEquals(0, MoeProjectRegistry.daemonRefCountForTest(41002))
    }

    @Test
    fun `retired open cannot replace the current daemon registration`() = withConnection { fixture ->
        val oldClient = fixture.connect(41003)
        fixture.service.disconnect()
        oldClient.closeBlocking()
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
                client.closeBlocking()

                assertFalse(fixture.service.isConnected())
                assertEquals(false to "Disconnected", statuses.last())
                assertEquals(null, fixture.service.field("refreshFuture"))
            } finally {
                resumeOpen.countDown()
                disconnectThread.join(5000)
            }
        }
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
        private val started = CountDownLatch(1)
        private val clients = mutableListOf<WebSocketClient>()
        private val server = object : WebSocketServer(InetSocketAddress("127.0.0.1", 0), 1) {
            override fun onStart() { started.countDown() }
            override fun onOpen(conn: WebSocket?, handshake: ClientHandshake?) {}
            override fun onMessage(conn: WebSocket?, message: String?) {}
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

        fun close() {
            service.dispose()
            clients.forEach { it.closeBlocking() }
            server.stop(1000)
        }
    }

    companion object {
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
