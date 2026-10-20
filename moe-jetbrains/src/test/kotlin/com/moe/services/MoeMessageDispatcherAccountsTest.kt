package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.MoeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Proxy

/** The two account events: ACCOUNTS_UPDATED (broadcast) and ACCOUNT_ADDED (sender only). */
class MoeMessageDispatcherAccountsTest {
    private var state: MoeState? = null
    private val published = mutableListOf<MoeState>()
    private val added = mutableListOf<String>()

    private val dispatcher = MoeMessageDispatcher(
        project = fakeProject(),
        invokeLater = { it() },
        isDisposed = { false },
        currentState = { state },
        updateState = { state = it },
        onProjectMismatch = {},
        onDaemonShuttingDown = {}
    ).apply {
        addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {
                published.add(state)
            }

            override fun onStatus(connected: Boolean, message: String) {}

            override fun onAccountAdded(accountId: String) {
                added.add(accountId)
            }
        })
    }

    private fun rotation(registryFile: String, switchAtPercent: Int, accountId: String) = """
        {
          "registryFile": "$registryFile", "switchAtPercent": $switchAtPercent, "error": null,
          "cli": { "node": "/usr/bin/node", "script": "/opt/moe/daemon/accounts/cli.js" },
          "accounts": [
            { "id": "$accountId", "label": "Work", "signIn": "subscription", "signInCheckedAt": null,
              "windows": {}, "peakPercent": null, "blockedUntil": null, "active": true, "seats": [] }
          ]
        }
    """.trimIndent()

    private fun snapshot() {
        dispatcher.handle(
            """
            {"type":"STATE_SNAPSHOT","payload":{
              "project":{"id":"proj-1","name":"Moe"},"epics":[],"tasks":[],
              "workers":[{"id":"worker-a","type":"CLAUDE","epicId":"","status":"CODING","accountId":"acct-1"}],
              "accountRotation":${rotation("/home/dev/.moe/claude-accounts.json", 90, "acct-1")}
            }}
            """.trimIndent()
        )
    }

    @Test
    fun `ACCOUNTS_UPDATED replaces the rotation and keeps the rest of the state`() {
        snapshot()
        val before = state!!

        dispatcher.handle(
            """{"type":"ACCOUNTS_UPDATED","payload":${rotation("/home/dev/.moe/claude-accounts.json", 75, "acct-2")}}"""
        )

        val after = state!!
        assertEquals(75, after.accountRotation?.switchAtPercent)
        assertEquals(listOf("acct-2"), after.accountRotation?.accounts?.map { it.id })
        assertEquals(before.copy(accountRotation = after.accountRotation), after)
        assertEquals(listOf(before, after), published)
    }

    @Test
    fun `ACCOUNTS_UPDATED before the first snapshot is ignored`() {
        dispatcher.handle(
            """{"type":"ACCOUNTS_UPDATED","payload":${rotation("/home/dev/.moe/claude-accounts.json", 75, "acct-2")}}"""
        )

        assertNull(state)
        assertTrue(published.isEmpty())
    }

    @Test
    fun `a malformed ACCOUNTS_UPDATED keeps the last good rotation`() {
        snapshot()
        val before = state!!

        for (payload in listOf("{}", "{\"accounts\":[]}", "{\"registryFile\":42}", "[]", "null", "\"x\"")) {
            dispatcher.handle("""{"type":"ACCOUNTS_UPDATED","payload":$payload}""")
        }
        dispatcher.handle("""{"type":"ACCOUNTS_UPDATED"}""")

        assertEquals(before, state)
        assertEquals(listOf(before), published)
    }

    @Test
    fun `ACCOUNT_ADDED tells listeners the new account id`() {
        dispatcher.handle("""{"type":"ACCOUNT_ADDED","payload":{"accountId":"acct-7"}}""")

        assertEquals(listOf("acct-7"), added)
        assertTrue("ACCOUNT_ADDED must not touch the board state", published.isEmpty())
    }

    @Test
    fun `ACCOUNT_ADDED without a string id is ignored`() {
        for (payload in listOf("{}", "{\"accountId\":\"\"}", "{\"accountId\":7}", "{\"accountId\":null}", "{\"accountId\":{}}", "[]")) {
            dispatcher.handle("""{"type":"ACCOUNT_ADDED","payload":$payload}""")
        }
        dispatcher.handle("""{"type":"ACCOUNT_ADDED"}""")

        assertTrue(added.isEmpty())
    }

    private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Accounts Test"
            "getBasePath", "getService" -> null
            "isDisposed" -> false
            "toString" -> "AccountsTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject
}
