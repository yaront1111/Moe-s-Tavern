package com.moe.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalAgentLauncherTest {
    @Test
    fun `PowerShell worker Claude command stays in print mode`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\Users\\yaron\\AppData\\Roaming\\JetBrains\\PyCharm2025.2\\plugins\\moe-jetbrains\\scripts\\moe-agent.ps1",
            envOverrides = mapOf("MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js"),
            agentCommand = "claude",
            teamName = "Cordum"
        )

        assertTrue(command.contains("-Role worker"))
        assertTrue(command.contains("-Command 'claude'"))
        assertTrue(command.contains("-Team 'Cordum'"))
        // A worker must NOT get the TUI: it never exits on its own, so the
        // wrapper would block inside it forever and never reach the post-flight
        // auto-commit+push that ships a task reaching REVIEW.
        assertFalse(command.contains("-Interactive"))
        assertFalse(command.contains("MOE_NO_PRINT_MODE"))
    }

    @Test
    fun `PowerShell architect Claude command opts into interactive TUI`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "claude"
        )

        assertTrue(command.contains("-Role architect"))
        assertTrue(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell governor Claude command opts into interactive TUI`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "governor",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "claude"
        )

        assertTrue(command.contains("-Role governor"))
        assertTrue(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell qa Claude command stays in print mode`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "qa",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "claude"
        )

        assertTrue(command.contains("-Role qa"))
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell worker non-Claude command stays provider native`() {
        val codexCommand = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "codex"
        )
        val geminiCommand = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "gemini"
        )

        assertFalse(codexCommand.contains("-Interactive"))
        assertFalse(geminiCommand.contains("-Interactive"))
    }

    @Test
    fun `PowerShell exec modes do not force Claude interactive`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "claude",
            codexExec = true
        )

        assertTrue(command.contains("-CodexExec"))
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell codex exec passes -CodexExec`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "codex",
            codexExec = true
        )

        assertTrue(command.contains(" -CodexExec"))
        assertFalse(command.contains("-GeminiExec"))
        assertFalse(command.contains("-GrokExec"))
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell gemini exec passes -GeminiExec and never -CodexExec`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "gemini",
            codexExec = true
        )

        assertTrue(command.contains(" -GeminiExec"))
        assertFalse(command.contains("-CodexExec"))
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell architect Gemini command stays provider native`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "gemini"
        )

        assertTrue(command.contains("-Role architect"))
        assertTrue(command.contains("-Command 'gemini'"))
        // Gemini's TUI/headless polarity is the wrapper's -GeminiExec, not -Interactive.
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell worker Grok command stays provider native`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = mapOf("MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js"),
            agentCommand = "grok",
            teamName = "Cordum"
        )

        assertTrue(command.contains("-Role worker"))
        assertTrue(command.contains("-Command 'grok'"))
        assertTrue(command.contains("-Team 'Cordum'"))
        assertFalse(command.contains("-Interactive"))
        assertFalse(command.contains("-GrokExec"))
        assertFalse(command.contains("-CodexExec"))
    }

    @Test
    fun `PowerShell architect Grok command does not pass -Interactive`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "grok"
        )

        assertTrue(command.contains("-Role architect"))
        assertTrue(command.contains("-Command 'grok'"))
        // Grok's role-based interactive polarity (architect TUI, worker headless)
        // is resolved by the wrapper; JetBrains must not force -Interactive.
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `PowerShell grok exec passes -GrokExec and never -CodexExec`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "grok",
            codexExec = true
        )

        assertTrue(command.contains(" -GrokExec"))
        assertFalse(command.contains("-CodexExec"))
        assertFalse(command.contains("-GeminiExec"))
        assertFalse(command.contains("-Interactive"))
    }

    @Test
    fun `AgentProvider maps grok and keeps CUSTOM last`() {
        assertEquals(TerminalAgentLauncher.AgentProvider.GROK, TerminalAgentLauncher.AgentProvider.fromCommand("grok"))
        assertEquals("grok", TerminalAgentLauncher.AgentProvider.GROK.command)
        assertEquals("Grok", TerminalAgentLauncher.AgentProvider.GROK.displayName)
        // Enum order is menu order: GROK sits after GEMINI and before CUSTOM.
        val entries = TerminalAgentLauncher.AgentProvider.entries
        assertEquals(TerminalAgentLauncher.AgentProvider.CUSTOM, entries.last())
        assertEquals(entries.indexOf(TerminalAgentLauncher.AgentProvider.GEMINI) + 1, entries.indexOf(TerminalAgentLauncher.AgentProvider.GROK))
    }

    @Test
    fun `PowerShell architect command no longer sets MOE_NO_PRINT_MODE env var`() {
        val command = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\Cordum",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "claude"
        )

        assertFalse(command.contains("MOE_NO_PRINT_MODE"))
    }

    @Test
    fun `toWslPath translates drive-letter paths and leaves others alone`() {
        assertEquals("/mnt/d/projexts/px4swarm", TerminalAgentLauncher.toWslPath("D:\\projexts\\px4swarm"))
        assertEquals("/mnt/d/projexts/px4swarm", TerminalAgentLauncher.toWslPath("D:/projexts/px4swarm"))
        assertEquals(
            "/mnt/c/Users/Yaron/AppData/Roaming/JetBrains/plugins/moe-jetbrains/daemon/index.js",
            TerminalAgentLauncher.toWslPath("C:\\Users\\Yaron\\AppData\\Roaming\\JetBrains\\plugins\\moe-jetbrains\\daemon\\index.js")
        )
        assertEquals("/mnt/c", TerminalAgentLauncher.toWslPath("C:\\"))
        assertEquals("/home/user/project", TerminalAgentLauncher.toWslPath("/home/user/project"))
        assertEquals("codex", TerminalAgentLauncher.toWslPath("codex"))
        assertEquals("gemini", TerminalAgentLauncher.toWslPath("gemini"))
        assertEquals("grok", TerminalAgentLauncher.toWslPath("grok"))
    }

    @Test
    fun `WSL bash command uses mnt paths for project, script, and env overrides`() {
        val command = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "worker",
            scriptPath = "C:\\Users\\Yaron\\AppData\\Roaming\\JetBrains\\PyCharm2026.1\\plugins\\moe-jetbrains\\scripts\\moe-agent.sh",
            envOverrides = mapOf(
                "MOE_DAEMON_PATH" to "C:\\Users\\Yaron\\AppData\\Roaming\\JetBrains\\PyCharm2026.1\\plugins\\moe-jetbrains\\daemon\\index.js",
                "MOE_PROXY_PATH" to "C:\\Users\\Yaron\\AppData\\Roaming\\JetBrains\\PyCharm2026.1\\plugins\\moe-jetbrains\\proxy\\index.js"
            ),
            agentCommand = "codex",
            teamName = "px4swarm"
        )

        assertTrue(command.contains("bash '/mnt/c/Users/Yaron/AppData/Roaming/JetBrains/PyCharm2026.1/plugins/moe-jetbrains/scripts/moe-agent.sh'"))
        assertTrue(command.contains("--project '/mnt/d/projexts/px4swarm'"))
        assertTrue(command.contains("MOE_DAEMON_PATH='/mnt/c/Users/Yaron/AppData/Roaming/JetBrains/PyCharm2026.1/plugins/moe-jetbrains/daemon/index.js'"))
        assertTrue(command.contains("MOE_PROXY_PATH='/mnt/c/Users/Yaron/AppData/Roaming/JetBrains/PyCharm2026.1/plugins/moe-jetbrains/proxy/index.js'"))
        assertTrue(command.contains("--team 'px4swarm'"))
        assertTrue(command.contains("--command 'codex'"))
        assertFalse(command.contains("C:\\"))
        assertFalse(command.contains("D:\\"))
    }

    @Test
    fun `WSL bash codex exec passes --codex-exec`() {
        val command = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = emptyMap(),
            agentCommand = "codex",
            codexExec = true
        )

        assertTrue(command.contains(" --codex-exec"))
        assertFalse(command.contains("--gemini-exec"))
        assertFalse(command.contains("--grok-exec"))
        assertFalse(command.contains("--interactive"))
    }

    @Test
    fun `WSL bash gemini exec passes --gemini-exec and never --codex-exec`() {
        val command = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = emptyMap(),
            agentCommand = "gemini",
            codexExec = true
        )

        assertTrue(command.contains("--command 'gemini'"))
        assertTrue(command.contains(" --gemini-exec"))
        assertFalse(command.contains("--codex-exec"))
        assertFalse(command.contains("--interactive"))
    }

    @Test
    fun `WSL bash grok command stays provider native and maps exec to --grok-exec`() {
        val worker = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = mapOf("MOE_PROXY_PATH" to "C:\\moe\\proxy\\index.js"),
            agentCommand = "grok",
            teamName = "px4swarm"
        )
        assertTrue(worker.contains("--project '/mnt/d/projexts/px4swarm'"))
        assertTrue(worker.contains("MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js'"))
        assertTrue(worker.contains("--command 'grok'"))
        assertTrue(worker.contains("--team 'px4swarm'"))
        assertFalse(worker.contains("--interactive"))
        assertFalse(worker.contains("--grok-exec"))
        assertFalse(worker.contains("--codex-exec"))

        val architect = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = emptyMap(),
            agentCommand = "grok"
        )
        // Role-based TUI polarity is the wrapper's job; JetBrains never forces it.
        assertFalse(architect.contains("--interactive"))

        val exec = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "architect",
            scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = emptyMap(),
            agentCommand = "grok",
            codexExec = true
        )
        assertTrue(exec.contains(" --grok-exec"))
        assertFalse(exec.contains("--codex-exec"))
        assertFalse(exec.contains("--gemini-exec"))
        assertFalse(exec.contains("--interactive"))
    }

    @Test
    fun `bashWrapPowerShell produces a bash-safe interop line`() {
        val psLine = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\projexts\\px4swarm",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = mapOf("MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js"),
            agentCommand = "codex"
        )
        val wrapped = TerminalAgentLauncher.bashWrapPowerShell(psLine)

        assertTrue(wrapped.startsWith("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \""))
        // bash double quotes require \$ so PowerShell (not bash) expands $env:
        assertTrue(wrapped.contains("\\\$env:MOE_DAEMON_PATH"))
        // no PowerShell backtick escapes may survive — bash treats ` as command substitution
        assertFalse(wrapped.contains("`\$"))
        assertFalse(wrapped.contains("`\""))
    }
}
