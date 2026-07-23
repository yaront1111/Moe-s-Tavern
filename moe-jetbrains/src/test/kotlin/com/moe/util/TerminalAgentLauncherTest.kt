package com.moe.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalAgentLauncherTest {
    @Test
    fun `PowerShell worker Claude command opts into interactive TUI`() {
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
        assertTrue(command.contains("-Interactive"))
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
