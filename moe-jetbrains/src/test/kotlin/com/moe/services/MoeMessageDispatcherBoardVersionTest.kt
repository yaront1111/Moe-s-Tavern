package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.MoeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import java.lang.reflect.Proxy

/**
 * STATE_SNAPSHOT's top-level `boardVersion`: a frame without "tasks"/"epics" (the daemon's
 * answer to a GET_STATE whose ifBoardVersion is current) keeps the held list instances.
 */
class MoeMessageDispatcherBoardVersionTest {
    private var state: MoeState? = null
    private val published = mutableListOf<MoeState>()
    private val versions = mutableListOf<Long?>()

    private val dispatcher = MoeMessageDispatcher(
        project = fakeProject(),
        invokeLater = { it() },
        isDisposed = { false },
        currentState = { state },
        updateState = { state = it },
        onProjectMismatch = {},
        onDaemonShuttingDown = {},
        onBoardVersion = { versions.add(it) }
    ).apply {
        addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {
                published.add(state)
            }

            override fun onStatus(connected: Boolean, message: String) {}
        })
    }

    private val project = """"project":{"id":"proj-1","name":"Moe"}"""
    private val board = """"epics":[{"id":"epic-1","title":"E"}],"tasks":[{"id":"task-1","epicId":"epic-1"}]"""

    private fun full(version: Long, worker: String) =
        """{"type":"STATE_SNAPSHOT","boardVersion":$version,"payload":{$project,$board,"workers":[{"id":"$worker"}]}}"""

    private fun unchanged(version: Long, worker: String) =
        """{"type":"STATE_SNAPSHOT","boardVersion":$version,"payload":{$project,"workers":[{"id":"$worker"}]}}"""

    @Test
    fun `a full snapshot parses tasks and epics and reports its board version`() {
        dispatcher.handle(full(7, "worker-a"))

        assertEquals(listOf("task-1"), state!!.tasks.map { it.id })
        assertEquals(listOf("epic-1"), state!!.epics.map { it.id })
        assertEquals(listOf("worker-a"), state!!.workers.map { it.id })
        assertEquals(listOf<Long?>(7), versions)
        assertEquals(listOf(state), published)
    }

    @Test
    fun `a board-unchanged snapshot keeps the held task and epic list instances`() {
        dispatcher.handle(full(7, "worker-a"))
        val before = state!!

        dispatcher.handle(unchanged(7, "worker-b"))

        val after = state!!
        assertSame(before.tasks, after.tasks)
        assertSame(before.epics, after.epics)
        assertEquals(listOf("worker-b"), after.workers.map { it.id })
        assertEquals(listOf<Long?>(7, 7), versions)
        assertEquals(listOf(before, after), published)
    }

    @Test
    fun `a snapshot without boardVersion reports null`() {
        dispatcher.handle("""{"type":"STATE_SNAPSHOT","payload":{$project,$board,"workers":[]}}""")

        assertEquals(listOf("task-1"), state!!.tasks.map { it.id })
        assertEquals(listOf<Long?>(null), versions)
    }

    @Test
    fun `an applied TASK_UPDATED push reports its board version and an old daemon's leaves it`() {
        dispatcher.handle(full(7, "worker-a"))

        dispatcher.handle(
            """{"type":"TASK_UPDATED","boardVersion":8,"payload":{"id":"task-1","epicId":"epic-1","title":"Renamed"}}"""
        )

        assertEquals(listOf("Renamed"), state!!.tasks.map { it.title })
        assertEquals(listOf<Long?>(7, 8), versions)

        dispatcher.handle("""{"type":"TASK_UPDATED","payload":{"id":"task-1","epicId":"epic-1","title":"Again"}}""")

        assertEquals(listOf("Again"), state!!.tasks.map { it.title })
        assertEquals(listOf<Long?>(7, 8), versions)
    }

    @Test
    fun `a board-unchanged snapshot before any state is ignored and resets the version`() {
        dispatcher.handle(unchanged(7, "worker-a"))

        assertNull(state)
        assertEquals(emptyList<MoeState>(), published)
        assertEquals(listOf<Long?>(null), versions)
    }

    private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Board Version Test"
            "getBasePath", "getService" -> null
            "isDisposed" -> false
            "toString" -> "BoardVersionTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject
}
