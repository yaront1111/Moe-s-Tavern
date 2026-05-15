package com.moe.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MoeProjectRegistryTest {
    @Test
    fun `daemon registration tracker registers the same PID only once`() {
        val registered = mutableListOf<Int>()
        val unregistered = mutableListOf<Int>()
        val tracker = MoeDaemonRegistrationTracker(
            register = { registered.add(it) },
            unregister = {
                unregistered.add(it)
                true
            }
        )

        tracker.register(101)
        tracker.register(101)

        assertEquals(listOf(101), registered)
        assertEquals(emptyList<Int>(), unregistered)
        assertEquals(101, tracker.currentPid)
    }

    @Test
    fun `daemon registration tracker unregisters old PID when switching`() {
        val registered = mutableListOf<Int>()
        val unregistered = mutableListOf<Int>()
        val tracker = MoeDaemonRegistrationTracker(
            register = { registered.add(it) },
            unregister = {
                unregistered.add(it)
                true
            }
        )

        tracker.register(101)
        tracker.register(202)

        assertEquals(listOf(101, 202), registered)
        assertEquals(listOf(101), unregistered)
        assertEquals(202, tracker.currentPid)
    }

    @Test
    fun `daemon registration tracker unregisters current PID only once`() {
        val registered = mutableListOf<Int>()
        val unregistered = mutableListOf<Int>()
        val tracker = MoeDaemonRegistrationTracker(
            register = { registered.add(it) },
            unregister = {
                unregistered.add(it)
                true
            }
        )

        tracker.register(101)
        tracker.unregisterCurrent()
        tracker.unregisterCurrent()

        assertEquals(listOf(101), registered)
        assertEquals(listOf(101), unregistered)
        assertNull(tracker.currentPid)
    }
}
