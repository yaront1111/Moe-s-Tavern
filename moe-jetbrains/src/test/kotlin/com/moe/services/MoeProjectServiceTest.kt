package com.moe.services

import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.MoeState
import com.moe.util.MoeDaemonRegistrationTracker
import com.moe.util.MoeProjectRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.lang.reflect.Proxy

class MoeProjectServiceTest {
    @Test
    fun `manual disconnect publishes disconnected status immediately`() {
        val service = MoeProjectService(fakeProject()) { runnable -> runnable() }
        val statuses = mutableListOf<Pair<Boolean, String>>()
        val listener = object : MoeStateListener {
            override fun onState(state: MoeState) {}
            override fun onStatus(connected: Boolean, message: String) {
                statuses.add(connected to message)
            }
        }

        service.addListener(listener)

        service.disconnect()

        assertFalse(service.isConnected())
        assertEquals(listOf(false to "Disconnected"), statuses)

        service.removeListener(listener)
        service.dispose()
    }

    @Test
    fun `dispose unregisters connected daemon PID only once`() {
        MoeProjectRegistry.clearDaemonRefCountsForTest()
        val service = MoeProjectService(fakeProject()) { runnable -> runnable() }
        service.daemonRegistrationForTest().register(303)
        assertEquals(1, MoeProjectRegistry.daemonRefCountForTest(303))

        service.dispose()
        service.dispose()

        assertEquals(0, MoeProjectRegistry.daemonRefCountForTest(303))
        MoeProjectRegistry.clearDaemonRefCountsForTest()
    }

    private fun fakeProject(): IdeaProject {
        return Proxy.newProxyInstance(
            IdeaProject::class.java.classLoader,
            arrayOf(IdeaProject::class.java)
        ) { _, method, args ->
            when (method.name) {
                "getName" -> "Test Project"
                "getBasePath" -> null
                "isDisposed" -> false
                "getService" -> null
                "toString" -> "FakeProject"
                "hashCode" -> 1
                "equals" -> args?.firstOrNull() === this
                else -> defaultReturn(method.returnType)
            }
        } as IdeaProject
    }

    private fun defaultReturn(returnType: Class<*>): Any? =
        when (returnType) {
            java.lang.Boolean.TYPE -> false
            java.lang.Byte.TYPE -> 0.toByte()
            java.lang.Short.TYPE -> 0.toShort()
            java.lang.Integer.TYPE -> 0
            java.lang.Long.TYPE -> 0L
            java.lang.Float.TYPE -> 0f
            java.lang.Double.TYPE -> 0.0
            java.lang.Character.TYPE -> 0.toChar()
            java.lang.Void.TYPE -> null
            else -> null
        }

    private fun MoeProjectService.daemonRegistrationForTest(): MoeDaemonRegistrationTracker {
        val field = MoeProjectService::class.java.getDeclaredField("daemonRegistration")
        field.isAccessible = true
        return field.get(this) as MoeDaemonRegistrationTracker
    }
}
