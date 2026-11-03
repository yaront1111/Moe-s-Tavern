package com.moe.services

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** RELEASE_TASK frames (contract: plugin -> daemon /ws, WebSocketServer.ts case 'RELEASE_TASK'). */
class MoeCommandSenderReleaseTest {
    private val sent = mutableListOf<String>()
    private var connected = true
    private var disconnects = 0
    private val sender = MoeCommandSender(
        connectedCheck = { connected },
        onDisconnected = { disconnects++ },
        send = { _, message -> sent.add(message); true }
    )

    @Test
    fun `the default release frame is byte-identical, with no force key`() {
        sender.releaseTask("task-1", "Released from board")
        sender.releaseTask("task-1", "Released from board", force = false)
        val plain = """{"type":"RELEASE_TASK","payload":{"taskId":"task-1","reason":"Released from board"}}"""
        assertEquals(listOf(plain, plain), sent)
    }

    @Test
    fun `a forced release adds force true after the reason`() {
        sender.releaseTask("task-1", "Released from board", force = true)
        assertEquals(
            listOf("""{"type":"RELEASE_TASK","payload":{"taskId":"task-1","reason":"Released from board","force":true}}"""),
            sent
        )
    }

    @Test
    fun `a blank or missing reason is still omitted, with or without force`() {
        sender.releaseTask("task-1")
        sender.releaseTask("task-1", "   ")
        sender.releaseTask("task-1", null, force = true)
        sender.releaseTask("task-1", "", force = true)
        assertEquals(
            listOf(
                """{"type":"RELEASE_TASK","payload":{"taskId":"task-1"}}""",
                """{"type":"RELEASE_TASK","payload":{"taskId":"task-1"}}""",
                """{"type":"RELEASE_TASK","payload":{"taskId":"task-1","force":true}}""",
                """{"type":"RELEASE_TASK","payload":{"taskId":"task-1","force":true}}"""
            ),
            sent
        )
        assertEquals(0, disconnects)
    }

    @Test
    fun `a disconnected release sends nothing and reports the lost connection`() {
        connected = false
        sender.releaseTask("task-1", "Released from board", force = true)
        assertTrue(sent.isEmpty())
        assertEquals(1, disconnects)
    }
}
