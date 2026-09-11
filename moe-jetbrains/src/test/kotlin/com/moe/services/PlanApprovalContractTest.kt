package com.moe.services

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.MAX_SAFE_PLAN_REVISION
import com.moe.model.MoeState
import com.moe.model.Project
import com.moe.model.Task
import com.moe.util.MoeJson
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.lang.reflect.Proxy
import java.net.URI

/**
 * Wire contract for the reviewed plan approval: the `planRevision` both MoeJson
 * routes decode, and the optional `expectedPlanRevision` APPROVE_TASK carries.
 *
 * The revision assertions deliberately inspect the serialized parser output
 * instead of naming `Task.planRevision`, so the very same test bytes compile
 * against the pre-change model and fail with an assertion (dropped field)
 * rather than a compile error.
 */
class PlanApprovalContractTest {
    // ---------------------------------------------------------------- parsing

    @Test
    fun `both parser routes preserve every valid revision exactly`() {
        VALID_REVISIONS.forEach { (literal, expected) ->
            assertBothRoutes(literal, JsonPrimitive(expected), "valid $literal")
        }
    }

    @Test
    fun `absent legacy revision is effective zero on both parser routes`() {
        assertBothRoutes(null, JsonPrimitive(0L), "absent legacy field")
    }

    @Test
    fun `malformed revision stays unusable and never becomes an approvable zero`() {
        MALFORMED_REVISIONS.forEach { literal ->
            assertBothRoutes(literal, JsonNull.INSTANCE, "malformed $literal")
        }
    }

    @Test
    fun `successive payloads never reuse a previous revision`() {
        val sequence = listOf<Pair<String?, JsonElement>>(
            "42" to JsonPrimitive(42L),
            "\"42\"" to JsonNull.INSTANCE,
            null to JsonPrimitive(0L),
            "4294967297" to JsonPrimitive(4294967297L),
            "null" to JsonNull.INSTANCE,
            "0" to JsonPrimitive(0L)
        )
        sequence.forEachIndexed { index, (literal, expected) ->
            assertBothRoutes(literal, expected, "sequence[$index] $literal")
        }
    }

    /** Runs one fixture through parseState (snapshot) and parseTask (incremental). */
    private fun assertBothRoutes(revisionLiteral: String?, expected: JsonElement, label: String) {
        val fixture = taskJson("task-fixture", revisionLiteral)
        val control = taskJson("task-control", CONTROL_REVISION_LITERAL)

        val snapshot = MoeJson.parseState(stateJson(fixture, control)).tasks
        assertEquals("$label: snapshot dropped a task", 2, snapshot.size)
        assertEquals("$label: snapshot task order", listOf("task-fixture", "task-control"), snapshot.map { it.id })
        assertRevision("$label via parseState", snapshot[0], expected)
        assertRevision("$label control via parseState", snapshot[1], JsonPrimitive(CONTROL_REVISION))

        val incremental = MoeJson.parseTask(fixture)
        assertEquals("$label: parseTask dropped the id", "task-fixture", incremental.id)
        assertEquals("$label: parseTask corrupted an unrelated field", "WORKING", incremental.status)
        assertRevision("$label via parseTask", incremental, expected)
    }

    private fun assertRevision(label: String, task: Task, expected: JsonElement) {
        val actual = NULL_SAFE_GSON.toJsonTree(task).asJsonObject
        assertTrue("$label: parsed Task dropped planRevision", actual.has(KEY))
        assertEquals("$label: planRevision", expected, actual.get(KEY))
    }

    @Test
    fun `revision is a typed nullable Long defaulting to the legacy zero`() {
        assertEquals("safe bound", 9007199254740991L, MAX_SAFE_PLAN_REVISION)

        val parsed: Task = MoeJson.parseTask(taskJson("task-typed", "9007199254740991"))
        val revision: Long? = parsed.planRevision
        assertEquals(9007199254740991L, revision)
        assertEquals(0L, parsed.copy(planRevision = 0L).planRevision)
        assertNull("a malformed revision must stay unusable", parsed.copy(planRevision = null).planRevision)

        val defaulted = Task(
            id = "task-defaulted",
            epicId = "epic-1",
            title = "Defaulted",
            description = "",
            status = "WORKING",
            order = 0.0,
            definitionOfDone = emptyList(),
            implementationPlan = emptyList(),
            prLink = null,
            reopenReason = null,
            assignedWorkerId = null
        )
        assertEquals("an unspecified revision is the legacy effective zero", 0L, defaulted.planRevision)
    }

    // --------------------------------------------------------------- approval

    @Test
    fun `legacy one-argument approval sends the exact old payload`() {
        val sent = mutableListOf<String>()
        val sender = connectedSender(sent)

        sender.approveTask("task-1")

        val payload = singlePayload(sent, "APPROVE_TASK")
        assertEquals("legacy approval must not add wire keys", setOf("taskId"), payload.keySet())
        assertEquals("task-1", payload.get("taskId").asString)
    }

    @Test
    fun `an explicitly null revision is omitted rather than sent as a null token`() {
        val sent = mutableListOf<String>()
        val sender = connectedSender(sent)

        assertTrue("a delivered packet must report success", sender.approveTask("task-1", null))

        assertEquals("null means omitted metadata", setOf("taskId"), singlePayload(sent, "APPROVE_TASK").keySet())
    }

    @Test
    fun `a supplied revision travels in the packet unchanged`() {
        listOf(0L, 17L, 2147483648L, 4294967297L, MAX_SAFE_PLAN_REVISION).forEach { revision ->
            val sent = mutableListOf<String>()
            val sender = connectedSender(sent)

            assertTrue("revision $revision must be delivered", sender.approveTask("task-1", revision))

            val payload = singlePayload(sent, "APPROVE_TASK")
            assertEquals("revision $revision: payload keys", setOf("taskId", REVISION_KEY), payload.keySet())
            assertEquals("revision $revision: taskId", "task-1", payload.get("taskId").asString)
            assertEquals("revision $revision: exact token", revision, payload.get(REVISION_KEY).asLong)
            assertTrue("revision $revision must be a JSON number", payload.get(REVISION_KEY).asJsonPrimitive.isNumber)
        }
    }

    @Test
    fun `an invalid revision throws before anything is sent`() {
        val invalid = listOf(-1L, -9007199254740991L, MAX_SAFE_PLAN_REVISION + 1L, Long.MAX_VALUE, Long.MIN_VALUE)
        listOf(true, false).forEach { connected ->
            invalid.forEach { revision ->
                val sent = mutableListOf<String>()
                var disconnections = 0
                val sender = MoeCommandSender(
                    connectedCheck = { connected },
                    onDisconnected = { disconnections++ },
                    send = { _, message -> sent.add(message); true }
                )

                try {
                    sender.approveTask("task-1", revision)
                    fail("revision $revision (connected=$connected) must be rejected")
                } catch (expected: IllegalArgumentException) {
                    // validation runs before the connection check, by design
                }

                assertEquals("revision $revision must emit no packet", emptyList<String>(), sent)
                assertEquals("invalid input is not a disconnection", 0, disconnections)
            }
        }
    }

    @Test
    fun `a transport that refuses after the connection check reports one disconnection`() {
        val sent = mutableListOf<String>()
        var disconnections = 0
        val sender = MoeCommandSender(
            connectedCheck = { true },
            onDisconnected = { disconnections++ },
            send = { _, message -> sent.add(message); false }
        )

        assertFalse("a refused send is not an approval", sender.approveTask("task-1", 7L))

        assertEquals("the packet reached the transport exactly once", 1, sent.size)
        assertEquals("the refusal must notify exactly once", 1, disconnections)
    }

    @Test
    fun `unrelated commands keep their best-effort transport behaviour`() {
        var disconnections = 0
        val throwing = MoeCommandSender(
            connectedCheck = { true },
            onDisconnected = { disconnections++ },
            send = { _, _ -> throw IllegalStateException("sentinel transport failure") }
        )

        throwing.releaseTask("task-1", "reason")
        throwing.sendMessage("GET_STATE", JsonObject())

        val refusing = MoeCommandSender(
            connectedCheck = { true },
            onDisconnected = { disconnections++ },
            send = { _, _ -> false }
        )
        refusing.rejectTask("task-1", "reason")

        assertEquals("background commands must not become disconnection reports", 0, disconnections)
    }

    @Test
    fun `approval surfaces a transport failure instead of claiming success`() {
        val boom = IllegalStateException("sentinel transport failure")
        val sender = MoeCommandSender(
            connectedCheck = { true },
            onDisconnected = { fail("a live connection must not report disconnection") },
            send = { _, _ -> throw boom }
        )

        val thrown = try {
            sender.approveTask("task-1")
            null
        } catch (ex: Throwable) {
            ex
        }

        assertSame("approveTask must not swallow the transport failure", boom, thrown)
    }

    @Test
    fun `disconnected approval notifies once and sends nothing`() {
        val sent = mutableListOf<String>()
        var disconnections = 0
        val sender = MoeCommandSender(
            connectedCheck = { false },
            onDisconnected = { disconnections++ },
            send = { _, message -> sent.add(message); true }
        )

        assertFalse("a disconnected approval is not an approval", sender.approveTask("task-1"))

        assertEquals("a refused approval must emit no packet", emptyList<String>(), sent)
        assertEquals("existing disconnected notification must fire exactly once", 1, disconnections)
    }

    // ----------------------------------------------------- facade integration

    @Test
    fun `the facade forwards the reviewed token, never a fresher cached one`() = withFacade { facade ->
        facade.cacheTask("task-1", cachedRevision = 8L, status = "AWAITING_APPROVAL")

        assertTrue("a delivered approval reports success", facade.service.approveTask("task-1", 7L))

        val payload = singlePayload(facade.sent, "APPROVE_TASK")
        assertEquals(setOf("taskId", REVISION_KEY), payload.keySet())
        assertEquals("the caller token must win over cached state", 7L, payload.get(REVISION_KEY).asLong)
        val cached = facade.service.getState()?.tasks?.single()
        assertEquals("a local send must not mutate the cached task", 8L, cached?.planRevision)
        assertEquals("a local send is not daemon approval", "AWAITING_APPROVAL", cached?.status)
        assertEquals("a local send must publish no status", emptyList<Pair<Boolean, String>>(), facade.statuses)
    }

    @Test
    fun `the facade keeps the legacy payload and an explicit zero`() = withFacade { facade ->
        assertTrue(facade.service.approveTask("task-1"))
        assertEquals(setOf("taskId"), singlePayload(facade.sent, "APPROVE_TASK").keySet())

        facade.sent.clear()
        assertTrue(facade.service.approveTask("task-1", 0L))
        val payload = singlePayload(facade.sent, "APPROVE_TASK")
        assertEquals(setOf("taskId", REVISION_KEY), payload.keySet())
        assertEquals(0L, payload.get(REVISION_KEY).asLong)
    }

    @Test
    fun `every disconnected facade shape refuses without a packet`() {
        // missing client, cleared flag, and a stale flag over a socket that
        // dropped after the flag was last written.
        val shapes = listOf("no client" to 0, "not connected" to 1, "stale flag, closed socket" to 2)
        shapes.forEach { (label, shape) ->
            withFacade(attachClient = shape != 0, connected = shape != 1, open = shape != 2) { facade ->
                assertFalse("$label must not claim approval", facade.service.approveTask("task-1", 7L))
                assertEquals("$label must emit no packet", emptyList<String>(), facade.sent)
                assertEquals(
                    "$label must publish the existing notification exactly once",
                    listOf(false to "Not connected to daemon"),
                    facade.statuses
                )
            }
        }
    }

    @Test
    fun `a socket lost between the connected check and the send is not an approval`() {
        // The drop happens inside the transport's own isOpen probe, i.e. strictly
        // after ensureConnected() passed — deterministic, no sleeps.
        withFacade(dropOnProbe = true) { facade ->
            assertFalse("a lost socket must not claim approval", facade.service.approveTask("task-1", 7L))

            assertEquals("nothing may reach a closed socket", emptyList<String>(), facade.sent)
            assertEquals(
                listOf(false to "Not connected to daemon"),
                facade.statuses
            )
        }
    }

    @Test
    fun `the facade rejects an invalid token and surfaces a transport failure`() {
        withFacade(connected = false) { facade ->
            try {
                facade.service.approveTask("task-1", -1L)
                fail("an invalid revision must be rejected even while disconnected")
            } catch (expected: IllegalArgumentException) {
                // validated before any connection check
            }
            assertEquals(emptyList<String>(), facade.sent)
            assertEquals("invalid input is not a disconnection", emptyList<Pair<Boolean, String>>(), facade.statuses)
        }

        val boom = IllegalStateException("sentinel transport failure")
        withFacade(sendFailure = boom) { facade ->
            val thrown = try {
                facade.service.approveTask("task-1", 7L)
                null
            } catch (ex: Throwable) {
                ex
            }
            assertSame("the dialog must see the real transport failure", boom, thrown)
            assertEquals("a thrown send must not be reported as a disconnection", emptyList<Pair<Boolean, String>>(), facade.statuses)
        }
    }

    private fun withFacade(
        attachClient: Boolean = true,
        connected: Boolean = true,
        open: Boolean = true,
        sendFailure: RuntimeException? = null,
        dropOnProbe: Boolean = false,
        body: (Facade) -> Unit
    ) {
        val facade = Facade(attachClient, connected, open, sendFailure, dropOnProbe)
        try {
            body(facade)
        } finally {
            facade.close()
        }
    }

    /** Real service + real sender over a no-network socket; only the transport is fake. */
    private class Facade(
        attachClient: Boolean,
        connected: Boolean,
        open: Boolean,
        sendFailure: RuntimeException?,
        dropOnProbe: Boolean
    ) {
        val sent = mutableListOf<String>()
        val statuses = mutableListOf<Pair<Boolean, String>>()
        val service = MoeProjectService(fakeProject()) { runnable -> runnable() }
        private val listener = object : MoeStateListener {
            override fun onState(state: MoeState) {}
            override fun onStatus(connected: Boolean, message: String) {
                statuses.add(connected to message)
            }
        }
        private val client = if (!attachClient) null else FakeSocket(
            open = {
                if (!dropOnProbe) open else {
                    service.setField("connected", false)
                    service.setField("wsClient", null)
                    false
                }
            },
            onSend = { message ->
                if (sendFailure != null) throw sendFailure
                sent.add(message)
            }
        )

        init {
            service.setField("wsClient", client)
            service.setField("connected", connected)
            service.addListener(listener)
        }

        fun cacheTask(taskId: String, cachedRevision: Long?, status: String) {
            val task = Task(
                id = taskId,
                epicId = "epic-1",
                title = "Cached",
                description = "",
                status = status,
                order = 0.0,
                definitionOfDone = emptyList(),
                implementationPlan = emptyList(),
                prLink = null,
                reopenReason = null,
                assignedWorkerId = null,
                planRevision = cachedRevision
            )
            service.setField("state", MoeState(Project("proj", "Proj"), emptyList(), listOf(task)))
        }

        fun close() {
            service.removeListener(listener)
            service.dispose()
        }
    }

    /** No URI is ever opened: nothing here calls `connect()`, and close is inert. */
    private class FakeSocket(private val open: () -> Boolean, private val onSend: (String) -> Unit) :
        WebSocketClient(URI.create("ws://127.0.0.1:1/ws")) {
        override fun isOpen(): Boolean = open()
        override fun send(text: String) = onSend(text)
        override fun close() = Unit
        override fun onOpen(handshakedata: ServerHandshake?) = Unit
        override fun onMessage(message: String?) = Unit
        override fun onClose(code: Int, reason: String?, remote: Boolean) = Unit
        override fun onError(ex: Exception?) = Unit
    }

    // --------------------------------------------------------------- fixtures

    private fun connectedSender(sent: MutableList<String>) = MoeCommandSender(
        connectedCheck = { true },
        onDisconnected = { fail("a live connection must not report disconnection") },
        send = { _, message -> sent.add(message); true }
    )

    private fun singlePayload(sent: List<String>, expectedType: String): JsonObject {
        assertEquals("exactly one packet expected", 1, sent.size)
        val envelope = JsonParser.parseString(sent.single()).asJsonObject
        assertEquals("envelope keys", setOf("type", "payload"), envelope.keySet())
        assertEquals(expectedType, envelope.get("type").asString)
        return envelope.getAsJsonObject("payload")
    }

    private fun taskJson(id: String, revisionLiteral: String?): JsonObject {
        val revision = if (revisionLiteral == null) "" else ",\"planRevision\":$revisionLiteral"
        val text = "{\"id\":\"$id\",\"epicId\":\"epic-1\",\"title\":\"Title $id\"," +
            "\"description\":\"\",\"status\":\"WORKING\",\"priority\":\"HIGH\",\"order\":1.0," +
            "\"definitionOfDone\":[],\"implementationPlan\":[]$revision}"
        return JsonParser.parseString(text).asJsonObject
    }

    private fun stateJson(vararg tasks: JsonObject): JsonObject {
        val payload = JsonObject()
        payload.add("project", JsonParser.parseString("{\"id\":\"proj\",\"name\":\"Proj\"}"))
        payload.add("tasks", JsonArray().apply { tasks.forEach { add(it) } })
        return payload
    }

    companion object {
        private fun MoeProjectService.setField(name: String, value: Any?) {
            MoeProjectService::class.java.getDeclaredField(name).apply { isAccessible = true }.set(this, value)
        }

        private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
            IdeaProject::class.java.classLoader,
            arrayOf(IdeaProject::class.java)
        ) { proxy, method, args ->
            when (method.name) {
                "getName" -> "Plan Approval Test"
                "getBasePath", "getService" -> null
                "isDisposed" -> false
                "toString" -> "PlanApprovalTestProject"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.firstOrNull()
                else -> null
            }
        } as IdeaProject

        private const val KEY = "planRevision"
        private const val REVISION_KEY = "expectedPlanRevision"
        private const val CONTROL_REVISION = 4294967297L
        private const val CONTROL_REVISION_LITERAL = "4294967297"
        private val NULL_SAFE_GSON = GsonBuilder().serializeNulls().create()

        /** Literal to the exact Long a correct decoder must produce. */
        private val VALID_REVISIONS: List<Pair<String, Long>> = listOf(
            "0" to 0L,
            "17" to 17L,
            "2147483648" to 2147483648L,
            "4294967297" to 4294967297L,
            "9007199254740991" to 9007199254740991L,
            "1.0" to 1L,
            "1e3" to 1000L,
            "9007199254740991.0" to 9007199254740991L
        )

        /** Present but unusable: none of these may collapse into 0 or a truncated value. */
        private val MALFORMED_REVISIONS: List<String> = listOf(
            "null",
            "-1",
            "-9007199254740991",
            "0.5",
            "-0.5",
            "9007199254740991.1",
            "1e-400",
            "-1e400",
            "1e400",
            "9007199254740992",
            "9223372036854775808",
            "\"17\"",
            "\"\"",
            "\"abc\"",
            "true",
            "false",
            "[17]",
            "{\"value\":17}"
        )
    }
}
