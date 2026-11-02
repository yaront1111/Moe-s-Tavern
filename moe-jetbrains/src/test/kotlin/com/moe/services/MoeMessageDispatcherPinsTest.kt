package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.MoeState
import com.moe.model.PinEntry
import org.junit.Assert.assertEquals
import org.junit.Test
import java.lang.reflect.Proxy

/** PINS (GET_PINS reply) and PINS_UPDATED (daemon broadcast after every pin write) share one branch. */
class MoeMessageDispatcherPinsTest {
    private val pinCalls = mutableListOf<Pair<String, List<PinEntry>>>()
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

            override fun onPins(channel: String, pins: List<PinEntry>) {
                pinCalls.add(channel to pins)
            }

            override fun onPinCreated(channel: String, pin: PinEntry) {
                others.add("onPinCreated")
            }

            override fun onPinRemoved(channel: String, messageId: String) {
                others.add("onPinRemoved")
            }

            override fun onPinToggled(channel: String, pin: PinEntry) {
                others.add("onPinToggled")
            }
        })
    }

    private val pin1 = """{"messageId":"msg-1","pinnedBy":"governor-x","pinnedAt":"2026-11-02T17:00:00.000Z","done":false,"doneAt":null}"""
    private val pin2 = """{"messageId":"msg-2","pinnedBy":"human","pinnedAt":"2026-11-02T17:05:00.000Z","done":true,"doneAt":"2026-11-02T17:06:00.000Z"}"""

    private fun frame(type: String, payload: String) = """{"type":"$type","payload":$payload}"""

    @Test
    fun `PINS_UPDATED with two pins gives one onPins in payload order and matches PINS`() {
        val payload = """{"channel":"chan-1","pins":[$pin1,$pin2]}"""

        dispatcher.handle(frame("PINS_UPDATED", payload))

        val expected = listOf(
            PinEntry("msg-1", "governor-x", "2026-11-02T17:00:00.000Z", false, null),
            PinEntry("msg-2", "human", "2026-11-02T17:05:00.000Z", true, "2026-11-02T17:06:00.000Z")
        )
        assertEquals(listOf("chan-1" to expected), pinCalls)
        assertEquals(emptyList<String>(), others)

        dispatcher.handle(frame("PINS", payload))

        assertEquals(2, pinCalls.size)
        assertEquals(pinCalls[0], pinCalls[1])
    }

    @Test
    fun `PINS_UPDATED with an empty list clears the channel`() {
        dispatcher.handle(frame("PINS_UPDATED", """{"channel":"chan-1","pins":[]}"""))

        assertEquals(listOf("chan-1" to emptyList<PinEntry>()), pinCalls)
        assertEquals(emptyList<String>(), others)
    }

    @Test
    fun `a malformed PINS_UPDATED publishes nothing and does not throw`() {
        val frames = listOf(
            """{"type":"PINS_UPDATED"}""",
            frame("PINS_UPDATED", "null"),
            frame("PINS_UPDATED", "[]"),
            frame("PINS_UPDATED", "\"chan-1\""),
            frame("PINS_UPDATED", """{"pins":[$pin1]}"""),
            frame("PINS_UPDATED", """{"channel":null,"pins":[$pin1]}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1"}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":null}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":{}}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":"msg-1"}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":[$pin1,42]}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":[$pin1,null]}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":[$pin1,"msg-2"]}"""),
            frame("PINS_UPDATED", """{"channel":"chan-1","pins":[[]]}""")
        )

        for (f in frames) dispatcher.handle(f)

        assertEquals(emptyList<Pair<String, List<PinEntry>>>(), pinCalls)
        assertEquals(emptyList<String>(), others)
    }

    private fun fakeProject(): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Pins Test"
            "getBasePath", "getService" -> null
            "isDisposed" -> false
            "toString" -> "PinsTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject
}
