package com.moe.util

import com.moe.model.ExecutionReadiness
import com.moe.model.ReadinessFailure
import com.moe.model.ReadinessReply
import com.moe.util.TerminalAgentLauncher.ProtectedAgentRuntime
import com.moe.util.TerminalAgentLauncher.ScriptKind
import com.moe.util.VerifiedLocalLaunch.Decision
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class VerifiedLocalLaunchTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @After
    fun reset() = RuntimeSelectionPolicy.resetForTest()

    @Test
    fun `only worker and qa under a verified-local or untrusted declaration are VM seats`() {
        for (role in listOf("architect", "worker", "qa", "governor")) {
            for (declared in DeclaredProfile.entries) {
                val expected = (role == "worker" || role == "qa") && declared != DeclaredProfile.LEGACY_LIKE
                assertEquals("$role $declared", expected, VerifiedLocalLaunch.isVmSeat(role, declared))
            }
        }
    }

    @Test
    fun `a VM seat never prefers bash while other seats follow the WSL toggle`() {
        assertFalse(VerifiedLocalLaunch.preferBash(vmSeat = true, wslAgents = true))
        assertFalse(VerifiedLocalLaunch.preferBash(vmSeat = true, wslAgents = false))
        assertTrue(VerifiedLocalLaunch.preferBash(vmSeat = false, wslAgents = true))
        assertFalse(VerifiedLocalLaunch.preferBash(vmSeat = false, wslAgents = false))
    }

    @Test
    fun `on Windows a VM seat selects the installed PowerShell wrapper even with WSL on`() {
        val project = temporaryFolder.newFolder("project")
        val root = temporaryFolder.newFolder("installed")
        listOf("daemon/index.js", "proxy/index.js", "scripts/moe-agent.sh", "scripts/moe-agent.ps1").forEach {
            File(root, it).apply { parentFile.mkdirs() }.writeText("installed $it")
        }
        fun kind(preferBash: Boolean): ScriptKind {
            val selection = TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, preferBash, root, windows = true)
            assertTrue("preferBash=$preferBash: $selection", selection is ProtectedAgentRuntime.Selected)
            return (selection as ProtectedAgentRuntime.Selected).script.kind
        }
        assertEquals(ScriptKind.POWERSHELL, kind(VerifiedLocalLaunch.preferBash(vmSeat = true, wslAgents = true)))
        assertEquals(ScriptKind.BASH, kind(VerifiedLocalLaunch.preferBash(vmSeat = false, wslAgents = true)))
    }

    @Test
    fun `only claude and codex can run in a VM and every other CLI is refused by name`() {
        listOf("claude", "codex", " codex ").forEach { assertNull(it, VerifiedLocalLaunch.agentRefusal(it)) }
        listOf("gemini", "grok", "my-cli --x", "CLAUDE", "").forEach { command ->
            val message = VerifiedLocalLaunch.agentRefusal(command)
            assertTrue("$command: $message", message != null && message.contains("'$command' cannot run there"))
        }
        val long = VerifiedLocalLaunch.agentRefusal("evil\u001b[2J" + "x".repeat(300))!!
        assertTrue(long, long.contains("'evil?[2J" + "x".repeat(192) + "'"))
        assertFalse(long.any { Character.isISOControl(it) })
    }

    @Test
    fun `only a ready verified-local answer launches`() {
        assertEquals(Decision.Launch, VerifiedLocalLaunch.decide("worker", answered("verified-local", true)))

        val notReady = refused(decide("QA", answered("verified-local", false, listOf("isolated-agent-and-qa-vms", "isolated-check-vm"))))
        assertTrue(notReady, notReady.startsWith("Moe did not start the QA agent: verified-local is not ready on this machine.\n"))
        assertTrue(notReady, notReady.contains("\n- missing: isolated-agent-and-qa-vms\n- missing: isolated-check-vm\n"))
        assertTrue(notReady, notReady.endsWith(NOTHING_STARTED))
        // A contradictory answer (ready with missing ids) is never read as ready.
        assertTrue(refused(decide("worker", answered("verified-local", true, listOf("isolated-check-vm")))).contains("isolated-check-vm"))

        listOf("unreadable", "legacy", "observe").forEach { profile ->
            val message = refused(decide("worker", answered(profile, true)))
            assertTrue(message, message.contains("the daemon reports the '$profile' execution profile"))
            assertTrue(message, message.endsWith(NOTHING_STARTED))
        }
    }

    @Test
    fun `every readiness failure refuses with its own sentence`() {
        val messages = ReadinessFailure.entries.map { refused(decide("worker and QA", ReadinessReply.Failed(it))) }
        messages.forEach { message ->
            assertTrue(message, message.startsWith("Moe did not start the worker and QA agents: the Moe daemon"))
            assertTrue(message, message.endsWith(NOTHING_STARTED))
        }
        assertEquals(ReadinessFailure.entries.size, messages.toSet().size)
        assertTrue(messages[ReadinessFailure.TIMEOUT.ordinal].contains("did not answer within 20 seconds"))
    }

    @Test
    fun `daemon-supplied ids and profile are sanitized and capped`() {
        val ids = listOf("<b>bold</b>", "a\u0007b\nc", "y".repeat(100)) + (1..40).map { "cap-$it" }
        val message = refused(decide("worker", answered("verified-local", false, ids)))
        assertTrue(message, message.contains("\n- missing: ?b?bold??b?\n"))
        assertTrue(message, message.contains("\n- missing: a?b?c\n"))
        assertTrue(message, message.contains("\n- missing: " + "y".repeat(64) + "\n"))
        assertTrue(message, message.contains("\n- missing: cap-29\n"))
        assertFalse(message, message.contains("cap-30"))
        assertTrue(message, message.contains("\n…and 11 more\n"))
        assertFalse(message, message.contains("<") || message.any { Character.isISOControl(it) && it != '\n' })

        val profile = refused(decide("worker", answered("<i>x\u0000" + "z".repeat(100), true)))
        assertTrue(profile, profile.contains("'?i?x?" + "z".repeat(59) + "'"))
    }

    @Test
    fun `declaredProfile reads the repository declaration without pinning or touching the store`() {
        var storeReads = 0
        RuntimeSelectionPolicy.store = { storeReads++; null }
        RuntimeSelectionPolicy.confirmer = DowngradeConfirmer { _, _ -> throw AssertionError("asked for a downgrade") }
        assertEquals(DeclaredProfile.LEGACY_LIKE, RuntimeSelectionPolicy.declaredProfile(""))
        assertEquals(DeclaredProfile.LEGACY_LIKE, declared(null))
        assertEquals(DeclaredProfile.LEGACY_LIKE, declared("""{"settings":{}}"""))
        assertEquals(DeclaredProfile.LEGACY_LIKE, declared(profileJson("legacy")))
        assertEquals(DeclaredProfile.LEGACY_LIKE, declared(profileJson("observe")))
        assertEquals(DeclaredProfile.UNTRUSTED, declared(profileJson("bogus")))
        assertEquals(DeclaredProfile.UNTRUSTED, declared("""{"settings":{"executionProfile":"""))
        val dir = temporaryFolder.newFolder()
        val projectJson = File(dir, ".moe/project.json").apply { parentFile.mkdirs() }
        projectJson.writeText(profileJson("verified-local"))
        assertEquals(DeclaredProfile.VERIFIED_LOCAL, RuntimeSelectionPolicy.declaredProfile(dir.path))
        assertEquals(0, storeReads)
        // Nothing was pinned: once the declaration says legacy, profile() answers legacy.
        projectJson.writeText(profileJson("legacy"))
        assertEquals(RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile(dir.path))
    }

    private fun declared(json: String?): DeclaredProfile {
        val dir = temporaryFolder.newFolder()
        if (json != null) File(dir, ".moe/project.json").apply { parentFile.mkdirs() }.writeText(json)
        return RuntimeSelectionPolicy.declaredProfile(dir.path)
    }

    private fun profileJson(profile: String) = """{"settings":{"executionProfile":"$profile"}}"""

    private fun decide(seats: String, reply: ReadinessReply) = VerifiedLocalLaunch.decide(seats, reply)

    private fun answered(profile: String, ready: Boolean, missing: List<String> = emptyList()) =
        ReadinessReply.Answered(ExecutionReadiness(profile, ready, missing, null))

    private fun refused(decision: Decision): String {
        assertTrue("expected a refusal, got $decision", decision is Decision.Refused)
        return (decision as Decision.Refused).message
    }

    private companion object {
        const val NOTHING_STARTED = "Nothing was started, and Moe never runs these agents on this machine instead."
    }
}
