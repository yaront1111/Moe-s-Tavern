package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.Decision
import com.moe.model.MoeState
import org.junit.Assert.assertEquals
import org.junit.Test
import java.lang.reflect.Proxy

class MoeMessageDispatcherDecisionsTest {
    private val decisionCalls = mutableListOf<List<Decision>>()
    private val others = mutableListOf<String>()

    private val dispatcher = MoeMessageDispatcher(
        project = fakeProject(),
        invokeLater = { it() },
        isDisposed = { false },
        currentState = { null },
        updateState = {},
        onProjectMismatch = {},
        onDaemonShuttingDown = {}
    ).apply {
        addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {
                others.add("onState")
            }

            override fun onStatus(connected: Boolean, message: String) {
                others.add("onStatus")
            }

            override fun onError(operation: String, message: String) {
                others.add("onError")
            }

            override fun onDaemonError(error: DaemonError) {
                others.add("onDaemonError")
            }

            override fun onDecisions(decisions: List<Decision>) {
                decisionCalls.add(decisions)
            }

            override fun onDecisionProposed(decision: Decision) {
                others.add("onDecisionProposed")
            }

            override fun onDecisionResolved(decision: Decision) {
                others.add("onDecisionResolved")
            }
        })
    }

    private val d1 = """{"id":"dec-1","proposedBy":"worker-a","content":"Use X","status":"proposed","channel":"chan-1","messageId":"msg-1","createdAt":"2026-11-02T20:00:00.000Z"}"""
    private val d2 = """{"id":"dec-2","proposedBy":"architect-b","content":"Ship","status":"approved","approvedBy":"human","channel":"chan-1","messageId":"msg-2","createdAt":"2026-11-02T20:01:00.000Z","resolvedAt":"2026-11-02T20:05:00.000Z"}"""

    private val expected = listOf(
        Decision(
            id = "dec-1", proposedBy = "worker-a", content = "Use X", status = "proposed",
            approvedBy = null, channel = "chan-1", messageId = "msg-1",
            createdAt = "2026-11-02T20:00:00.000Z", resolvedAt = null
        ),
        Decision(
            id = "dec-2", proposedBy = "architect-b", content = "Ship", status = "approved",
            approvedBy = "human", channel = "chan-1", messageId = "msg-2",
            createdAt = "2026-11-02T20:01:00.000Z", resolvedAt = "2026-11-02T20:05:00.000Z"
        )
    )

    private fun frame(type: String, payload: String) = """{"type":"$type","payload":$payload}"""

    @Test
    fun `DECISIONS publishes every decision once in payload order`() {
        dispatcher.handle(frame("DECISIONS", """{"decisions":[$d1,$d2]}"""))

        assertEquals(listOf(expected), decisionCalls)
        assertEquals(emptyList<String>(), others)
    }

    @Test
    fun `malformed DECISIONS entries are skipped and the valid ones still publish`() {
        val payload = """{"decisions":[$d1,42,null,"dec-x",[],{},{"id":""},{"id":"   "},{"id":null},{"id":7},{"id":{}},{"id":["dec-3"]},$d2]}"""

        dispatcher.handle(frame("DECISIONS", payload))

        assertEquals(listOf(expected), decisionCalls)
        assertEquals(emptyList<String>(), others)
    }

    @Test
    fun `a malformed DECISIONS frame publishes nothing and does not throw`() {
        val frames = listOf(
            """{"type":"DECISIONS"}""",
            frame("DECISIONS", "null"),
            frame("DECISIONS", "[]"),
            frame("DECISIONS", "\"x\""),
            frame("DECISIONS", "{}"),
            frame("DECISIONS", """{"decisions":null}"""),
            frame("DECISIONS", """{"decisions":{}}"""),
            frame("DECISIONS", """{"decisions":"dec-1"}""")
        )

        for (f in frames) {
            dispatcher.handle(f)
            assertEquals(f, emptyList<List<Decision>>(), decisionCalls)
            assertEquals(f, emptyList<String>(), others)
        }
    }

    @Test
    fun `an empty DECISIONS list publishes one empty list`() {
        dispatcher.handle(frame("DECISIONS", """{"decisions":[]}"""))

        assertEquals(listOf(emptyList<Decision>()), decisionCalls)
        assertEquals(emptyList<String>(), others)
    }

    private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Decisions Test"
            "getBasePath", "getService" -> null
            "isDisposed" -> false
            "toString" -> "DecisionsTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject
}
