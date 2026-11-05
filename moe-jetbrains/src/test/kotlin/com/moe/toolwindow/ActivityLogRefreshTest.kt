package com.moe.toolwindow

import com.google.gson.JsonParser
import com.moe.model.MoeState
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The Activity Log re-reads the log for a changed board only (J9): not once ever, and not on every 3 s republish. */
class ActivityLogRefreshTest {
    private fun state(workerStatus: String, peakPercent: Double?) = MoeJson.parseState(
        JsonParser.parseString(
            """
            {
              "project": {"id": "proj-1", "name": "Moe"}, "epics": [], "tasks": [],
              "workers": [{"id": "worker-a", "type": "CLAUDE", "epicId": "", "status": "$workerStatus"}],
              "accountRotation": {
                "registryFile": "/home/dev/.moe/claude-accounts.json", "switchAtPercent": 90, "error": null,
                "cli": {"node": "/usr/bin/node", "script": "/opt/moe/daemon/accounts/cli.js"},
                "accounts": [{"id": "acct-1", "label": "Work", "signIn": "subscription", "signInCheckedAt": null,
                  "windows": {}, "peakPercent": $peakPercent, "blockedUntil": null, "active": true, "seats": []}]
              }
            }
            """.trimIndent()
        ).asJsonObject
    )

    @Test
    fun `a changed board re-reads the log, and a republished or usage-only one does not`() {
        val refresh = ActivityLogRefresh()
        val first = state("CODING", 10.0)
        val usageOnly = state("CODING", 55.0)
        assertTrue("the fixture's usage sample must differ", first != usageOnly)
        val sequence: List<MoeState> = listOf(first, state("CODING", 10.0), usageOnly, state("IDLE", 55.0), state("IDLE", 55.0))

        assertEquals(listOf(true, false, false, true, false), sequence.map { refresh.changed(it) })
    }

    @Test
    fun `the panel asks ActivityLogRefresh on every published state`() {
        val path = "src/main/kotlin/com/moe/toolwindow/ActivityLogPanel.kt"
        val file = listOf(File(path), File("moe-jetbrains/$path")).first { it.isFile }
        val src = file.readText().replace("\r\n", "\n")
        val start = "override fun onState(state: MoeState)"
        assertTrue("onState delimiter must exist", src.contains(start))
        val onState = src.substringAfter(start).substringBefore("override fun onStatus(")
        assertTrue(onState.contains("if (logRefresh.changed(state))"))
        assertFalse("the log was read only while empty", onState.contains("allEvents.isEmpty()"))
    }
}
