package com.moe.services

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The five account commands the Accounts tab sends (contract: plugin -> daemon). */
class MoeCommandSenderAccountsTest {
    private val sent = mutableListOf<String>()
    private var connected = true
    private var disconnects = 0
    private val sender = MoeCommandSender(
        connectedCheck = { connected },
        onDisconnected = { disconnects++ },
        send = { _, message -> sent.add(message); true }
    )

    private fun packets() = sent.map { JsonParser.parseString(it) }

    @Test
    fun `account commands send the contract envelopes`() {
        sender.addAccount("  Work Max  ")
        sender.addAccount("   ")
        sender.addAccount(null)
        sender.removeAccount("acct-1")
        sender.moveAccount("acct-2", -1)
        sender.moveAccount("acct-2", 1)
        sender.renameAccount("acct-3", " Personal ")
        sender.setAccountSwitchPercent(85)

        assertEquals(
            listOf(
                """{"type":"ADD_ACCOUNT","payload":{"label":"Work Max"}}""",
                """{"type":"ADD_ACCOUNT","payload":{}}""",
                """{"type":"ADD_ACCOUNT","payload":{}}""",
                """{"type":"REMOVE_ACCOUNT","payload":{"accountId":"acct-1"}}""",
                """{"type":"MOVE_ACCOUNT","payload":{"accountId":"acct-2","offset":-1}}""",
                """{"type":"MOVE_ACCOUNT","payload":{"accountId":"acct-2","offset":1}}""",
                """{"type":"RENAME_ACCOUNT","payload":{"accountId":"acct-3","label":"Personal"}}""",
                """{"type":"SET_ACCOUNT_SWITCH_PERCENT","payload":{"switchAtPercent":85}}"""
            ).map { JsonParser.parseString(it) },
            packets()
        )
        assertEquals(0, disconnects)
    }

    @Test
    fun `disconnected account commands send nothing and report the lost connection`() {
        connected = false

        sender.addAccount("Work")
        sender.removeAccount("acct-1")
        sender.moveAccount("acct-1", 1)
        sender.renameAccount("acct-1", "Home")
        sender.setAccountSwitchPercent(90)

        assertTrue(sent.isEmpty())
        assertEquals(5, disconnects)
    }

    @Test
    fun `an invalid offset or switch percent throws before anything is sent`() {
        for (offset in listOf(0, 2, -2)) {
            assertThrows(IllegalArgumentException::class.java) { sender.moveAccount("acct-1", offset) }
        }
        for (percent in listOf(0, 101, -5)) {
            assertThrows(IllegalArgumentException::class.java) { sender.setAccountSwitchPercent(percent) }
        }

        assertTrue(sent.isEmpty())
        assertEquals(0, disconnects)
    }
}
