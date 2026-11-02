package com.moe.toolwindow

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Swing/IDE infrastructure is unavailable headless; guard the thin connection wiring. */
class ChatPanelConnectTest {
    private fun source(relative: String): String {
        val path = "src/main/kotlin/com/moe/$relative"
        val file = listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.isFile }
            ?: throw IllegalStateException("Source not found: $path")
        return file.readText().replace("\r\n", "\n")
    }

    @Test
    fun `onStatus connected re-requests channels and decisions`() {
        val src = source("toolwindow/ChatPanel.kt")
        val start = "override fun onStatus(connected: Boolean, message: String)"
        val end = "override fun onChatMessage("
        assertTrue("onStatus delimiter must exist", src.contains(start))
        val afterStatus = src.substringAfter(start)
        assertTrue("onChatMessage delimiter must follow onStatus", afterStatus.contains(end))
        val slice = afterStatus.substringBefore(end)
        assertTrue("onStatus slice must not be blank", slice.isNotBlank())
        assertTrue("onStatus must guard the connected branch", slice.contains("if (connected)"))
        val branch = slice.substringAfter("if (connected)")
        assertTrue("connected must request channels", branch.contains("service.requestChannels()"))
        assertTrue("connected must request decisions", branch.contains("service.requestDecisions()"))
    }

    @Test
    fun `constructor still requests channels and decisions after adding its listener`() {
        val src = source("toolwindow/ChatPanel.kt")
        val start = "service.addListener(stateListener!!)"
        val end = "private fun updateChannels("
        assertTrue("listener registration delimiter must exist", src.contains(start))
        val afterListener = src.substringAfter(start)
        assertTrue("constructor end delimiter must exist", afterListener.contains(end))
        val constructor = afterListener.substringBefore(end)
        assertTrue("constructor must request channels", constructor.contains("service.requestChannels()"))
        assertTrue("constructor must request decisions", constructor.contains("service.requestDecisions()"))
    }
}
