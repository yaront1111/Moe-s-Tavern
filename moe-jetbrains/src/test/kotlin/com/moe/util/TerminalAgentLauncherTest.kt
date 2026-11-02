package com.moe.util

import com.google.gson.JsonParser
import com.moe.model.AccountCli
import com.moe.util.RuntimeProfile.LEGACY
import com.moe.util.RuntimeProfile.PROTECTED
import com.moe.util.TerminalAgentLauncher.AccountsShell
import com.moe.util.TerminalAgentLauncher.AgentCommandChoice
import com.moe.util.TerminalAgentLauncher.AgentCommandChoice.Refused
import com.moe.util.TerminalAgentLauncher.AgentCommandChoice.Run
import com.moe.util.TerminalAgentLauncher.ScriptKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class TerminalAgentLauncherTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

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
    fun `protected runtime marker renders as exactly 1 in WSL bash and PowerShell`() {
        val env = linkedMapOf(
            "MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js",
            "MOE_PROXY_PATH" to "C:\\moe\\proxy\\index.js",
            "MOE_RUNTIME_PROTECTED" to "1"
        )
        val bash = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm", role = "worker", scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = env, agentCommand = "claude"
        )
        assertTrue(bash.contains("MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js'"))
        assertTrue(bash.contains("MOE_RUNTIME_PROTECTED='1'"))
        val ps = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\projexts\\px4swarm", role = "worker", scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = env, agentCommand = "claude"
        )
        assertTrue(ps.contains("\$env:MOE_RUNTIME_PROTECTED='1'"))
    }

    @Test
    fun `legacy env overrides never render the protected runtime marker`() {
        val legacy = mapOf("MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js", "MOE_PROXY_PATH" to "C:\\moe\\proxy\\index.js")
        val bash = TerminalAgentLauncher.buildWslBashCommandForTest(
            basePath = "D:\\projexts\\px4swarm", role = "worker", scriptPath = "C:\\moe\\scripts\\moe-agent.sh",
            envOverrides = legacy, agentCommand = "claude"
        )
        val ps = TerminalAgentLauncher.buildPowerShellCommandForTest(
            basePath = "D:\\projexts\\px4swarm", role = "worker", scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = legacy, agentCommand = "claude"
        )
        assertFalse(bash.contains("MOE_RUNTIME_PROTECTED"))
        assertFalse(ps.contains("MOE_RUNTIME_PROTECTED"))
        TerminalAgentLauncher.ScriptSource.values().forEach {
            assertFalse(it.name, TerminalAgentLauncher.resolveAgentEnvOverrides(it).containsKey("MOE_RUNTIME_PROTECTED"))
        }
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

    @Test
    fun `accounts commands run in the shell agents run in`() {
        assertEquals(AccountsShell.WSL_BASH, TerminalAgentLauncher.accountsShellFor(windows = true, wslAgents = true))
        assertEquals(AccountsShell.POWERSHELL, TerminalAgentLauncher.accountsShellFor(windows = true, wslAgents = false))
        assertEquals(AccountsShell.BASH, TerminalAgentLauncher.accountsShellFor(windows = false, wslAgents = false))
        assertEquals(AccountsShell.BASH, TerminalAgentLauncher.accountsShellFor(windows = false, wslAgents = true))
    }

    @Test
    fun `PowerShell accounts command quotes every word for the inner and outer shell`() {
        val command = TerminalAgentLauncher.buildAccountsCommand(
            AccountCli(
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Users\\O'Brien\\AppData\\Roaming\\JetBrains\\PyCharm2026.2\\plugins\\moe-jetbrains\\daemon\\accounts\\cli.js"
            ),
            "D:\\moe\$\\claude-accounts.json",
            listOf("login", "acct-1"),
            AccountsShell.POWERSHELL
        )

        assertEquals(
            "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& 'C:\\Program Files\\nodejs\\node.exe' " +
                "'C:\\Users\\O''Brien\\AppData\\Roaming\\JetBrains\\PyCharm2026.2\\plugins\\moe-jetbrains\\daemon\\accounts\\cli.js' " +
                "'--accounts-file' 'D:\\moe`\$\\claude-accounts.json' 'login' 'acct-1'\"",
            command
        )
    }

    @Test
    fun `WSL accounts command runs WSL node on mnt paths`() {
        val command = TerminalAgentLauncher.buildAccountsCommand(
            AccountCli(
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Users\\Yaron\\AppData\\Roaming\\JetBrains\\PyCharm2026.2\\plugins\\moe-jetbrains\\daemon\\accounts\\cli.js"
            ),
            "C:\\Users\\Yaron\\.moe\\claude-accounts.json",
            listOf("remove", "acct-2", "--sign-out"),
            AccountsShell.WSL_BASH
        )

        // The daemon's Windows node cannot sign claude in where WSL agents run it.
        assertEquals(
            "node '/mnt/c/Users/Yaron/AppData/Roaming/JetBrains/PyCharm2026.2/plugins/moe-jetbrains/daemon/accounts/cli.js' " +
                "'--accounts-file' '/mnt/c/Users/Yaron/.moe/claude-accounts.json' 'remove' 'acct-2' '--sign-out'",
            command
        )
    }

    @Test
    fun `bash accounts command single-quotes every word`() {
        val command = TerminalAgentLauncher.buildAccountsCommand(
            AccountCli("/usr/local/bin/node", "/opt/moe/daemon/accounts/cli.js"),
            "/home/o'neil/.moe/claude-accounts.json",
            listOf("check"),
            AccountsShell.BASH
        )

        assertEquals(
            "'/usr/local/bin/node' '/opt/moe/daemon/accounts/cli.js' '--accounts-file' '/home/o'\"'\"'neil/.moe/claude-accounts.json' 'check'",
            command
        )
    }

    @Test
    fun `legacy agent command passes the explicit value, then the setting, then claude through unchanged`() {
        assertEquals(Run("codex"), commandFor(LEGACY, "codex", "gemini"))
        assertEquals(Run("gemini"), commandFor(LEGACY, null, "gemini"))
        assertEquals(Run("claude"), commandFor(LEGACY, null, null))
        listOf("/opt/x/claude --foo", "C:\\tools\\claude.exe", "/tmp/evil-agent", " claude ", "CLAUDE", "").forEach { value ->
            assertEquals("explicit '$value'", Run(value), commandFor(LEGACY, value, "grok"))
            assertEquals("setting '$value'", Run(value), commandFor(LEGACY, null, value))
        }
    }

    @Test
    fun `protected agent command runs exactly the known agent CLIs by name`() {
        listOf("claude", "codex", "gemini", "grok").forEach { name ->
            assertEquals(Run(name), commandFor(PROTECTED, name, null))
            assertEquals(Run(name), commandFor(PROTECTED, null, name))
            assertEquals(Run(name), commandFor(PROTECTED, " $name\t", null))
            assertEquals(Run(name), commandFor(PROTECTED, null, "  $name\n"))
        }
        assertEquals(Run("claude"), commandFor(PROTECTED, null, null))
        // The menu's explicit choice wins, so the setting is never consulted.
        assertEquals(Run("codex"), commandFor(PROTECTED, "codex", "/tmp/evil-agent"))
    }

    @Test
    fun `protected agent command refuses a non-standard project setting and names it`() {
        listOf("/tmp/evil-agent", "claude --dangerously-skip-permissions", "claude.exe", "../claude", "CLAUDE", "").forEach { value ->
            assertEquals(value, Refused(protectedRefusal(value, "from .moe/project.json settings.agentCommand")), commandFor(PROTECTED, null, value))
        }
    }

    @Test
    fun `protected agent command refuses a custom command even over a known setting`() {
        listOf("/home/me/bin/my-agent --yolo", "C:\\tools\\claude.exe", "claude --flag").forEach { value ->
            assertEquals(value, Refused(protectedRefusal(value, "custom command")), commandFor(PROTECTED, value, "claude"))
        }
    }

    @Test
    fun `protected refusal shows at most 200 characters of the value with control characters replaced`() {
        val message = refusedMessage(commandFor(PROTECTED, null, "evil\u001b[2J\u0007" + "x".repeat(300)))

        assertTrue(message, message.contains("'evil?[2J?" + "x".repeat(191) + "'"))
        assertFalse(message.any { Character.isISOControl(it) })
    }

    @Test
    fun `a verified-local project json naming a non-standard agent command is protected and refused`() {
        val dir = temporaryFolder.newFolder()
        val projectJson = File(dir, ".moe/project.json").also { it.parentFile.mkdirs() }
        projectJson.writeText("""{"settings":{"executionProfile":"verified-local","agentCommand":"/tmp/evil-agent"}}""")
        try {
            RuntimeSelectionPolicy.store = { null } // Persist nothing outside the temp project.
            val profile = RuntimeSelectionPolicy.profile(dir.path)
            assertEquals(PROTECTED, profile)
            val setting = JsonParser.parseString(projectJson.readText()).asJsonObject
                .getAsJsonObject("settings").get("agentCommand").asString

            val message = refusedMessage(commandFor(profile, null, setting))
            assertTrue(message, message.contains("'/tmp/evil-agent'"))
        } finally {
            RuntimeSelectionPolicy.resetForTest()
        }
    }

    @Test
    fun `legacy launch commands stay byte-for-byte as pinned for every role, shell and WSL toggle`() {
        for (row in PINNED_LEGACY) {
            val label = "${row.role} wsl=${row.wsl} ${row.kind}"
            assertFalse(label, VerifiedLocalLaunch.isVmSeat(row.role, DeclaredProfile.LEGACY_LIKE))
            val expected = row.expected.replace("@S@", scriptAsTyped(row.wsl, row.kind))
            assertEquals(label, expected, pinnedCommand(row.role, row.kind, row.wsl))
        }
        assertEquals(16, PINNED_LEGACY.map { Triple(it.role, it.wsl, it.kind) }.toSet().size)
    }

    @Test
    fun `a VM seat with the WSL toggle on types the native PowerShell wrapper into the WSL prompt`() {
        val native = pinnedCommand("worker", ScriptKind.POWERSHELL, wsl = false)
        val underWsl = pinnedCommand("worker", ScriptKind.POWERSHELL, wsl = true)
        assertEquals(TerminalAgentLauncher.bashWrapPowerShell(native), underWsl)
        assertTrue(underWsl, underWsl.startsWith("powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \""))
        assertTrue(underWsl, underWsl.contains("& '${scriptAsTyped(true, ScriptKind.POWERSHELL)}' -Role worker -Project "))
        assertTrue(native, native.contains("& '$PINNED_SCRIPT' -Role worker -Project 'D:\\projexts\\app'"))
        // Architect and governor keep today's commands: the pinned table above covers them under both toggles.
    }

    class FakeTerminalManager {
        val calls = mutableListOf<Pair<String, String>>()

        fun createLocalShellWidget(basePath: String, tabName: String): Any? {
            calls += basePath to tabName
            return "widget"
        }
    }

    @Test
    fun `a refused seat never touches the terminal manager`() {
        val manager = FakeTerminalManager()
        val refusals = mutableListOf<String>()
        val widget = TerminalAgentLauncher.openSeat(VerifiedLocalLaunch.Decision.Refused("x"), manager, "D:\\p", "Moe Coder") { refusals += it }
        assertEquals(null, widget)
        assertEquals(listOf("x"), refusals)
        assertEquals(emptyList<Pair<String, String>>(), manager.calls)
    }

    @Test
    fun `a launched seat opens exactly one terminal through the reflective manager call`() {
        val manager = FakeTerminalManager()
        val refusals = mutableListOf<String>()
        val widget = TerminalAgentLauncher.openSeat(VerifiedLocalLaunch.Decision.Launch, manager, "D:\\p", "Moe Coder") { refusals += it }
        assertEquals("widget", widget)
        assertEquals(listOf("D:\\p" to "Moe Coder"), manager.calls)
        assertEquals(emptyList<String>(), refusals)
    }

    @Test
    fun `a VM seat refuses every agent CLI but claude and codex and names it`() {
        listOf("gemini", "grok", "my-cli").forEach { command ->
            val explicit = refusedMessage(TerminalAgentLauncher.agentCommandFor(PROTECTED, command, null, vmSeat = true))
            assertTrue(explicit, explicit.contains("'$command' cannot run there"))
            val setting = refusedMessage(TerminalAgentLauncher.agentCommandFor(PROTECTED, null, command, vmSeat = true))
            assertTrue(setting, setting.contains("'$command' cannot run there"))
        }
        assertEquals(Run("claude"), TerminalAgentLauncher.agentCommandFor(PROTECTED, "claude", null, vmSeat = true))
        assertEquals(Run("codex"), TerminalAgentLauncher.agentCommandFor(PROTECTED, " codex ", "gemini", vmSeat = true))
        assertEquals(Run("claude"), TerminalAgentLauncher.agentCommandFor(PROTECTED, null, null, vmSeat = true))
        // Host seats keep today's choice.
        assertEquals(Run("gemini"), TerminalAgentLauncher.agentCommandFor(PROTECTED, "gemini", null))
        assertEquals(Run("gemini"), TerminalAgentLauncher.agentCommandFor(LEGACY, "gemini", null))
    }

    private fun pinnedCommand(role: String, kind: ScriptKind, wsl: Boolean): String =
        TerminalAgentLauncher.buildCommandForTest(
            "D:\\projexts\\app", role, PINNED_SCRIPT, kind, PINNED_ENV, "claude", null, wsl, "$role-0000abcd"
        )

    // The script path is the only OS-dependent input (buildCommand types File.absolutePath), so it is substituted
    // in the form each shell receives it; every other byte is literal.
    private fun scriptAsTyped(wsl: Boolean, kind: ScriptKind): String = when {
        !wsl -> PINNED_SCRIPT
        kind == ScriptKind.BASH -> TerminalAgentLauncher.toWslPath(PINNED_SCRIPT)
        else -> PINNED_SCRIPT.replace("\\", "\\\\")
    }

    private class Row(val role: String, val wsl: Boolean, val kind: ScriptKind, val expected: String)

    private companion object {
        val PINNED_SCRIPT: String = File("pinned", "moe-agent").absolutePath
        val PINNED_ENV = linkedMapOf("MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js", "MOE_PROXY_PATH" to "C:\\moe\\proxy\\index.js")
        val POWERSHELL = ScriptKind.POWERSHELL
        val BASH = ScriptKind.BASH

        // Captured from today's buildCommand before this change (agentCommand claude, no team, workerId <role>-0000abcd).
        val PINNED_LEGACY = listOf(
            Row("architect", false, POWERSHELL, "powershell -NoProfile -ExecutionPolicy Bypass -Command \"`\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; `\$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role architect -Project 'D:\\projexts\\app' -WorkerId 'architect-0000abcd' -Command 'claude' -Interactive\""),
            Row("architect", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role architect --project 'D:\\projexts\\app' --worker-id 'architect-0000abcd' --command 'claude' --interactive"),
            Row("architect", true, POWERSHELL, "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"\\\$env:MOE_DAEMON_PATH='C:\\\\moe\\\\daemon\\\\index.js'; \\\$env:MOE_PROXY_PATH='C:\\\\moe\\\\proxy\\\\index.js'; & '@S@' -Role architect -Project 'D:\\\\projexts\\\\app' -WorkerId 'architect-0000abcd' -Command 'claude' -Interactive\""),
            Row("architect", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role architect --project '/mnt/d/projexts/app' --worker-id 'architect-0000abcd' --command 'claude' --interactive"),
            Row("worker", false, POWERSHELL, "powershell -NoProfile -ExecutionPolicy Bypass -Command \"`\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; `\$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role worker -Project 'D:\\projexts\\app' -WorkerId 'worker-0000abcd' -Command 'claude'\""),
            Row("worker", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role worker --project 'D:\\projexts\\app' --worker-id 'worker-0000abcd' --command 'claude'"),
            Row("worker", true, POWERSHELL, "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"\\\$env:MOE_DAEMON_PATH='C:\\\\moe\\\\daemon\\\\index.js'; \\\$env:MOE_PROXY_PATH='C:\\\\moe\\\\proxy\\\\index.js'; & '@S@' -Role worker -Project 'D:\\\\projexts\\\\app' -WorkerId 'worker-0000abcd' -Command 'claude'\""),
            Row("worker", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role worker --project '/mnt/d/projexts/app' --worker-id 'worker-0000abcd' --command 'claude'"),
            Row("qa", false, POWERSHELL, "powershell -NoProfile -ExecutionPolicy Bypass -Command \"`\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; `\$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role qa -Project 'D:\\projexts\\app' -WorkerId 'qa-0000abcd' -Command 'claude'\""),
            Row("qa", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role qa --project 'D:\\projexts\\app' --worker-id 'qa-0000abcd' --command 'claude'"),
            Row("qa", true, POWERSHELL, "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"\\\$env:MOE_DAEMON_PATH='C:\\\\moe\\\\daemon\\\\index.js'; \\\$env:MOE_PROXY_PATH='C:\\\\moe\\\\proxy\\\\index.js'; & '@S@' -Role qa -Project 'D:\\\\projexts\\\\app' -WorkerId 'qa-0000abcd' -Command 'claude'\""),
            Row("qa", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role qa --project '/mnt/d/projexts/app' --worker-id 'qa-0000abcd' --command 'claude'"),
            Row("governor", false, POWERSHELL, "powershell -NoProfile -ExecutionPolicy Bypass -Command \"`\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; `\$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role governor -Project 'D:\\projexts\\app' -WorkerId 'governor-0000abcd' -Command 'claude' -Interactive\""),
            Row("governor", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role governor --project 'D:\\projexts\\app' --worker-id 'governor-0000abcd' --command 'claude' --interactive"),
            Row("governor", true, POWERSHELL, "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"\\\$env:MOE_DAEMON_PATH='C:\\\\moe\\\\daemon\\\\index.js'; \\\$env:MOE_PROXY_PATH='C:\\\\moe\\\\proxy\\\\index.js'; & '@S@' -Role governor -Project 'D:\\\\projexts\\\\app' -WorkerId 'governor-0000abcd' -Command 'claude' -Interactive\""),
            Row("governor", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role governor --project '/mnt/d/projexts/app' --worker-id 'governor-0000abcd' --command 'claude' --interactive")
        )
    }

    private fun commandFor(profile: RuntimeProfile, explicit: String?, setting: String?): AgentCommandChoice =
        TerminalAgentLauncher.agentCommandFor(profile, explicit, setting)

    private fun refusedMessage(choice: AgentCommandChoice): String {
        assertTrue("expected a refusal, got $choice", choice is Refused)
        return (choice as Refused).message
    }

    private fun protectedRefusal(value: String, source: String): String =
        "Protected execution profile: the agent command '$value' ($source) is not one of claude, codex, gemini, grok, " +
            "so no agent was started. Pick an agent from the Agents menu."
}
