package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.MoeState
import org.junit.Assert.assertEquals
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * Daemon ERROR frames (CQ-I06d): the legacy onError(operation, message) delivery
 * is unchanged, and onDaemonError carries the correlation fields parsed
 * strictly, so a non-string never turns into a plausible-looking id or code.
 */
class MoeMessageDispatcherErrorTest {
    private var state: MoeState? = null
    private val events = mutableListOf<Any>()

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
            override fun onState(state: MoeState) {}

            override fun onStatus(connected: Boolean, message: String) {}

            override fun onError(operation: String, message: String) {
                events.add(listOf(operation, message))
            }

            override fun onDaemonError(error: DaemonError) {
                events.add(error)
            }
        })
    }

    @Test
    fun `E1 a refusal frame delivers the legacy error then the correlated one`() {
        dispatcher.handle(
            """{"type":"ERROR","message":"Plan changed","operation":"APPROVE_TASK","code":-32010,""" +
                """"codeName":"PLAN_REVISION_MISMATCH","context":{"taskId":"task-1","epicId":"epic-1",""" +
                """"expectedPlanRevision":4,"currentPlanRevision":5}}"""
        )

        assertEquals(
            listOf(
                listOf("APPROVE_TASK", "Plan changed"),
                DaemonError("APPROVE_TASK", "PLAN_REVISION_MISMATCH", "task-1", "Plan changed")
            ),
            events
        )
    }

    @Test
    fun `E2 a legacy frame without operation, code or context carries nulls`() {
        dispatcher.handle("""{"type":"ERROR","message":"Missing payload"}""")

        assertEquals(
            listOf(listOf("unknown", "Missing payload"), DaemonError(null, null, null, "Missing payload")),
            events
        )
    }

    @Test
    fun `E3 a non-string codeName arrives as null and never throws`() {
        for (codeName in listOf("7", "true", "null", "{}", "[]")) {
            events.clear()
            dispatcher.handle(
                """{"type":"ERROR","message":"m","operation":"APPROVE_TASK","codeName":$codeName,""" +
                    """"context":{"taskId":"task-1"}}"""
            )
            assertEquals(
                "codeName $codeName",
                listOf(listOf("APPROVE_TASK", "m"), DaemonError("APPROVE_TASK", null, "task-1", "m")),
                events
            )
        }
    }

    @Test
    fun `E3 a context that is not an object or a non-string taskId arrives as null`() {
        val contexts = listOf("\"task-1\"", "[]", "null", "{\"taskId\":5}", "{\"taskId\":null}", "{\"taskId\":{}}")
        for (context in contexts) {
            events.clear()
            dispatcher.handle(
                """{"type":"ERROR","message":"m","operation":"APPROVE_TASK",""" +
                    """"codeName":"PLAN_REVISION_MISMATCH","context":$context}"""
            )
            assertEquals(
                "context $context",
                listOf(
                    listOf("APPROVE_TASK", "m"),
                    DaemonError("APPROVE_TASK", "PLAN_REVISION_MISMATCH", null, "m")
                ),
                events
            )
        }
    }

    @Test
    fun `E3 a non-string operation keeps its legacy text but is not correlatable`() {
        dispatcher.handle("""{"type":"ERROR","message":"m","operation":7,"context":{"taskId":"task-1"}}""")

        assertEquals(listOf(listOf("7", "m"), DaemonError(null, null, "task-1", "m")), events)
    }

    private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Error Test"
            "getBasePath", "getService" -> null
            "isDisposed" -> false
            "toString" -> "ErrorTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject
}
