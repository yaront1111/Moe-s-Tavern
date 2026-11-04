package com.moe.util

import com.google.gson.JsonParser
import com.intellij.openapi.util.SystemInfo
import com.moe.model.AccountCli
import com.moe.util.RuntimeProfile.LEGACY
import com.moe.util.RuntimeProfile.PROTECTED
import com.moe.util.TerminalAgentLauncher.AccountsShell
import com.moe.util.TerminalAgentLauncher.AgentCommandChoice
import com.moe.util.TerminalAgentLauncher.AgentCommandChoice.Refused
import com.moe.util.TerminalAgentLauncher.AgentCommandChoice.Run
import com.moe.util.TerminalAgentLauncher.ScriptKind
import com.moe.util.TerminalAgentLauncher.ProtectedInterpreter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.TimeUnit

class TerminalAgentLauncherTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `protected POSIX interpreter is the real outside bash`() {
        val project = temporaryFolder.newFolder("project")
        val bash = temporaryFolder.newFile("bash")
        assertEquals(
            ProtectedInterpreter.Ready(bash.toPath().toRealPath().toString()),
            TerminalAgentLauncher.protectedInterpreter(ScriptKind.BASH, false, project.path, false, null, bash.path)
        )
    }

    @Test
    fun `protected POSIX interpreter refuses project missing and directory paths`() {
        val project = temporaryFolder.newFolder("project")
        val inside = temporaryFolder.newFile("project/bash")
        val missing = File(temporaryFolder.root, "missing-bash")
        val directory = temporaryFolder.newFolder("bash-directory")
        for (path in listOf(inside, missing, directory)) {
            val result = TerminalAgentLauncher.protectedInterpreter(ScriptKind.BASH, false, project.path, false, null, path.path)
            assertTrue("must refuse $path: $result", result is ProtectedInterpreter.Refused)
            assertTrue((result as ProtectedInterpreter.Refused).reason.contains(path.path))
            assertFalse(result.reason.contains("node executable"))
        }
    }

    @Test
    fun `protected POSIX interpreter refuses a PowerShell wrapper`() {
        assertTrue(TerminalAgentLauncher.protectedInterpreter(
            ScriptKind.POWERSHELL, false, temporaryFolder.root.path, false, null
        ) is ProtectedInterpreter.Refused)
    }

    @Test
    fun `protected Windows interpreter uses forward slashes or the WSL mount`() {
        assumeTrue(SystemInfo.isWindows)
        assumeTrue(Regex("""[A-Za-z0-9:\\._-]+""").matches(temporaryFolder.root.toPath().toRealPath().toString()))
        val project = temporaryFolder.newFolder("project")
        val root = temporaryFolder.newFolder("sysroot")
        val exe = powerShellFixture(root).toPath().toRealPath().toString()
        assertEquals(
            ProtectedInterpreter.Ready(exe.replace('\\', '/')),
            TerminalAgentLauncher.protectedInterpreter(ScriptKind.POWERSHELL, false, project.path, true, root.path)
        )
        assertEquals(
            ProtectedInterpreter.Ready(TerminalAgentLauncher.toWslPath(exe)),
            TerminalAgentLauncher.protectedInterpreter(ScriptKind.POWERSHELL, true, project.path, true, root.path)
        )
    }

    @Test
    fun `protected Windows interpreter refuses absent or unsafe SystemRoot`() {
        assumeTrue(SystemInfo.isWindows)
        val project = temporaryFolder.newFolder("project")
        val inside = temporaryFolder.newFolder("project", "sysroot")
        val untypable = temporaryFolder.newFolder("sys root")
        val missing = temporaryFolder.newFolder("missing")
        powerShellFixture(inside)
        powerShellFixture(untypable)
        for (root in listOf(null, "", " ", inside.path, untypable.path, missing.path, "invalid\u0000root")) {
            val result = TerminalAgentLauncher.protectedInterpreter(ScriptKind.POWERSHELL, false, project.path, true, root)
            assertTrue("must refuse $root: $result", result is ProtectedInterpreter.Refused)
            val reason = (result as ProtectedInterpreter.Refused).reason
            if (root.isNullOrBlank()) assertTrue(reason.contains("SystemRoot")) else assertTrue(reason.contains(root))
            assertFalse(reason.contains("node executable"))
        }
    }

    @Test
    fun `protected Windows bash requires WSL agent mode`() {
        assumeTrue(SystemInfo.isWindows)
        assertTrue(TerminalAgentLauncher.protectedInterpreter(
            ScriptKind.BASH, false, temporaryFolder.root.path, true, null
        ) is ProtectedInterpreter.Refused)
        assertEquals(ProtectedInterpreter.Ready("/bin/bash"), TerminalAgentLauncher.protectedInterpreter(
            ScriptKind.BASH, true, temporaryFolder.root.path, true, null
        ))
    }

    @Test
    fun `protected bash launch lines change only the interpreter word`() {
        for (wsl in listOf(false, true)) {
            val word = if (wsl) "/bin/bash" else "/usr/bin/bash"
            val legacy = protectedInterpreterLine(ScriptKind.BASH, wsl, null)
            val protected = protectedInterpreterLine(ScriptKind.BASH, wsl, word)
            assertEquals(legacy.replaceFirst(" bash '", " '$word' '"), protected)
            assertTrue(protected.contains(" '$word' '"))
            assertFalse(protected.contains(" bash '"))
        }
    }

    @Test
    fun `protected PowerShell launch lines change only the interpreter word`() {
        for (wsl in listOf(false, true)) {
            val word = if (wsl) "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
                else "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
            val legacy = protectedInterpreterLine(ScriptKind.POWERSHELL, wsl, null)
            val protected = protectedInterpreterLine(ScriptKind.POWERSHELL, wsl, word)
            assertEquals(word + legacy.substring(legacy.indexOf(' ')), protected)
            assertEquals(typedScript(legacy, if (wsl) "powershell.exe" else "powershell"), typedScript(protected, word))
            assertFalse(protected.startsWith("powershell"))
        }
    }

    private fun powerShellFixture(root: File): File {
        val directory = File(root, "System32/WindowsPowerShell/v1.0")
        assertTrue(directory.mkdirs())
        return File(directory, "powershell.exe").also { assertTrue(it.createNewFile()) }
    }

    private fun protectedInterpreterLine(kind: ScriptKind, wsl: Boolean, interpreter: String?): String =
        TerminalAgentLauncher.buildCommandForTest(
            "D:/project", "worker", "C:/installed/scripts/moe-agent", kind,
            linkedMapOf("MOE_DAEMON_PATH" to "C:/installed/daemon/index.js",
                "MOE_PROXY_PATH" to "C:/installed/proxy/index.js", "MOE_RUNTIME_PROTECTED" to "1"),
            "claude", null, wsl, "worker-0000abcd", interpreter = interpreter
        )

    @Test
    fun `PowerShell worker Claude command stays in print mode`() {
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val codexCommand = decodedPowerShellCommand(
            basePath = "D:\\Cordum",
            role = "worker",
            scriptPath = "C:\\moe\\scripts\\moe-agent.ps1",
            envOverrides = emptyMap(),
            agentCommand = "codex"
        )
        val geminiCommand = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val command = decodedPowerShellCommand(
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
        val ps = decodedPowerShellCommand(
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
        val ps = decodedPowerShellCommand(
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

        // Base64 holds no $, backtick, quote or ! for bash to expand, so interop needs only the .exe suffix.
        assertEquals("powershell.exe" + psLine.removePrefix("powershell"), wrapped)
        val script = typedBashPsScript(wrapped)
        assertEquals(typedPsScript(psLine), script)
        // bash escapes nothing now, so the backslashes arrive single.
        assertTrue(script, script.startsWith("\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; "))
    }

    @Test
    fun `accounts commands run in the shell agents run in`() {
        assertEquals(AccountsShell.WSL_BASH, TerminalAgentLauncher.accountsShellFor(windows = true, wslAgents = true))
        assertEquals(AccountsShell.POWERSHELL, TerminalAgentLauncher.accountsShellFor(windows = true, wslAgents = false))
        assertEquals(AccountsShell.BASH, TerminalAgentLauncher.accountsShellFor(windows = false, wslAgents = false))
        assertEquals(AccountsShell.BASH, TerminalAgentLauncher.accountsShellFor(windows = false, wslAgents = true))
    }

    @Test
    fun `PowerShell accounts command quotes every word inside its encoded script`() {
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
            "& 'C:\\Program Files\\nodejs\\node.exe' " +
                "'C:\\Users\\O''Brien\\AppData\\Roaming\\JetBrains\\PyCharm2026.2\\plugins\\moe-jetbrains\\daemon\\accounts\\cli.js' " +
                "'--accounts-file' 'D:\\moe\$\\claude-accounts.json' 'login' 'acct-1'",
            typedPsScript(command)
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
    fun `A1 legacy accounts lines stay byte-identical on every shell`() {
        // Legacy never validates, so a node that does not exist still builds today's line.
        val cli = AccountCli("C:\\missing\\node.exe", "C:\\moe\\daemon\\accounts\\cli.js")
        val args = listOf("login", "acct-1")
        for (shell in AccountsShell.values()) {
            assertEquals(
                "$shell",
                TerminalAgentLauncher.buildAccountsCommand(cli, "C:\\moe\\claude-accounts.json", args, shell),
                TerminalAgentLauncher.accountsCommandFor(LEGACY, cli, "C:\\moe\\claude-accounts.json", args, shell, "D:\\projexts\\app")
            )
        }
    }

    @Test
    fun `A2 protected PowerShell accounts line types the System32 PowerShell and the validated node`() {
        assumeTrue(SystemInfo.isWindows)
        assumeTrue(Regex("""[A-Za-z0-9:\\._-]+""").matches(temporaryFolder.root.toPath().toRealPath().toString()))
        val project = temporaryFolder.newFolder("project")
        val sysroot = temporaryFolder.newFolder("sysroot")
        val word = powerShellFixture(sysroot).toPath().toRealPath().toString().replace('\\', '/')
        val node = temporaryFolder.newFile("node.exe")
        val args = listOf("login", "acct-1")
        val line = TerminalAgentLauncher.accountsCommandFor(
            PROTECTED, AccountCli(node.path, ACCOUNTS_SCRIPT), ACCOUNTS_FILE, args, AccountsShell.POWERSHELL, project.path, sysroot.path
        )
        assertTrue(line, line.startsWith("$word -NoProfile -ExecutionPolicy Bypass -EncodedCommand "))
        assertFalse(line, line.startsWith("powershell"))
        val legacy = TerminalAgentLauncher.buildAccountsCommand(
            AccountCli(node.toPath().toRealPath().toString(), ACCOUNTS_SCRIPT), ACCOUNTS_FILE, listOf("--protected-project", project.path) + args,
            AccountsShell.POWERSHELL
        )
        assertEquals(typedPsScript(legacy), typedScript(line, word))
    }

    @Test
    fun `A3 protected PowerShell accounts line refuses an absent or unsafe SystemRoot`() {
        assumeTrue(SystemInfo.isWindows)
        val project = temporaryFolder.newFolder("project")
        val inside = temporaryFolder.newFolder("project", "sysroot")
        val untypable = temporaryFolder.newFolder("sys root")
        val missing = temporaryFolder.newFolder("missing")
        powerShellFixture(inside)
        powerShellFixture(untypable)
        val node = temporaryFolder.newFile("node.exe")
        for (root in listOf(null, "", " ", inside.path, untypable.path, missing.path)) {
            val message = accountsRefusal {
                TerminalAgentLauncher.accountsCommandFor(
                    PROTECTED, AccountCli(node.path, ACCOUNTS_SCRIPT), ACCOUNTS_FILE, listOf("check"), AccountsShell.POWERSHELL, project.path, root
                )
            }
            if (root.isNullOrBlank()) {
                assertTrue(message, message.contains("SystemRoot"))
            } else {
                assertTrue(message, message.contains(root))
                assertTrue(message, message.contains("the Accounts command's PowerShell"))
            }
        }
    }

    @Test
    fun `A3 protected PowerShell accounts line refuses a node inside the project`() {
        assumeTrue(SystemInfo.isWindows)
        assumeTrue(Regex("""[A-Za-z0-9:\\._-]+""").matches(temporaryFolder.root.toPath().toRealPath().toString()))
        val project = temporaryFolder.newFolder("project")
        val sysroot = temporaryFolder.newFolder("sysroot")
        powerShellFixture(sysroot)
        val node = temporaryFolder.newFile("project/node.exe")
        val message = accountsRefusal {
            TerminalAgentLauncher.accountsCommandFor(
                PROTECTED, AccountCli(node.path, ACCOUNTS_SCRIPT), ACCOUNTS_FILE, listOf("check"), AccountsShell.POWERSHELL, project.path, sysroot.path
            )
        }
        assertTrue(message, message.contains(node.path))
    }

    @Test
    fun `A4 protected bash accounts line types the real outside node and refuses any other`() {
        val project = temporaryFolder.newFolder("project")
        val node = temporaryFolder.newFile("node")
        val args = listOf("check")
        assertEquals(
            TerminalAgentLauncher.buildAccountsCommand(
                AccountCli(node.toPath().toRealPath().toString(), ACCOUNTS_SCRIPT), ACCOUNTS_FILE, listOf("--protected-project", project.path) + args,
                AccountsShell.BASH
            ),
            TerminalAgentLauncher.accountsCommandFor(PROTECTED, AccountCli(node.path, ACCOUNTS_SCRIPT), ACCOUNTS_FILE, args, AccountsShell.BASH, project.path)
        )
        val inside = temporaryFolder.newFile("project/node")
        val missing = File(temporaryFolder.root, "missing-node")
        val directory = temporaryFolder.newFolder("node-directory")
        for (candidate in listOf("bin/node", "node", inside.path, missing.path, directory.path)) {
            val message = accountsRefusal {
                TerminalAgentLauncher.accountsCommandFor(
                    PROTECTED, AccountCli(candidate, ACCOUNTS_SCRIPT), ACCOUNTS_FILE, args, AccountsShell.BASH, project.path
                )
            }
            assertTrue(message, message.contains(candidate))
        }
    }

    @Test
    fun `A5 protected WSL accounts line runs the PATH-filtering program under the fixed bash`() {
        val line = wslAccountsLine("D:\\projexts\\app")
        assertEquals(
            "'/bin/bash' -c '" + TerminalAgentLauncher.PROTECTED_WSL_NODE_PROGRAM + "' moe-accounts '/mnt/d/projexts/app' " +
                "'/mnt/c/Users/Yaron/AppData/Roaming/JetBrains/PyCharm2026.2/plugins/moe-jetbrains/daemon/accounts/cli.js' " +
                "'--accounts-file' '/mnt/c/Users/Yaron/.moe/claude-accounts.json' '--protected-project' '/mnt/d/projexts/app' " +
                "'remove' 'acct-2' '--sign-out'",
            line
        )
        // Typed unchanged inside single quotes by bash, zsh and fish.
        val program = TerminalAgentLauncher.PROTECTED_WSL_NODE_PROGRAM
        assertFalse(program, program.any { it == '\'' || it == '\\' || it == '!' || it < ' ' || it == '\u007f' })
        assertTrue(program, program.endsWith("exec node \"\$@\""))
    }

    @Test
    fun `A6 protected WSL accounts line refuses a project with no mnt path`() {
        for (base in listOf("\\\\server\\share\\app", "/home/u/app", "D:app", "")) {
            val message = accountsRefusal { wslAccountsLine(base) }
            if (base.isNotEmpty()) assertTrue(message, message.contains(base))
        }
        val ex = assertThrows(IllegalArgumentException::class.java) { wslAccountsLine("D:/p" + 1.toChar() + "q") }
        assertEquals("Invalid accounts command word: contains control characters", ex.message)
    }

    @Test
    fun `A7 the WSL node program runs only a node outside the project`() {
        assumeTrue(!SystemInfo.isWindows && File("/bin/bash").canExecute())
        val project = temporaryFolder.newFolder("project")
        val bin = temporaryFolder.newFolder("project", "bin")
        val outside = temporaryFolder.newFolder("outside")
        val work = temporaryFolder.newFolder("work")
        fakeNode(project, "cwd")
        fakeNode(bin, "inside")
        fakeNode(outside, "outside")
        fakeNode(temporaryFolder.newFolder("work", "rel"), "rel")
        val link = Files.createSymbolicLink(File(temporaryFolder.root, "link").toPath(), bin.toPath()).toString()
        val unsafe = listOf(".", "", "bin", bin.path, link)
        assertEquals(ProgramRun(0, "outside|a b|c|"), runProgram(project, (unsafe + outside.path).joinToString(":"), project.path).withoutStderr())
        val refused = runProgram(project, unsafe.joinToString(":"), project.path)
        assertEquals(ProgramRun(1, ""), refused.withoutStderr())
        assertTrue(refused.stderr, refused.stderr.contains("MOE_PROTECTED_INTERPRETER_NOT_FOUND"))
        assertEquals(ProgramRun(1, ""), runProgram(work, "rel", project.path).withoutStderr())
        assertEquals(ProgramRun(1, ""), runProgram(project, outside.path, File(temporaryFolder.root, "missing").path).withoutStderr())
    }

    private data class ProgramRun(val exit: Int, val stdout: String, val stderr: String = "") {
        fun withoutStderr() = copy(stderr = "")
    }

    /** A fake `node` in [dir] that prints [tag] and its arguments, each followed by `|`. */
    private fun fakeNode(dir: File, tag: String) {
        val node = File(dir, "node")
        node.writeText("#!/bin/sh\nprintf '%s|' $tag \"\$@\"\n")
        assertTrue(node.setExecutable(true))
    }

    /** Runs PROTECTED_WSL_NODE_PROGRAM as the WSL line does, in [cwd] with [path] as PATH; kills only its own child. */
    private fun runProgram(cwd: File, path: String, projectArg: String): ProgramRun {
        val out = temporaryFolder.newFile()
        val err = temporaryFolder.newFile()
        val builder = ProcessBuilder("/bin/bash", "-c", TerminalAgentLauncher.PROTECTED_WSL_NODE_PROGRAM, "moe-accounts", projectArg, "a b", "c")
            .directory(cwd).redirectOutput(out).redirectError(err)
        builder.environment()["PATH"] = path
        val process = builder.start()
        if (!process.waitFor(10, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            throw AssertionError("the program did not exit within 10 s (PATH=$path)")
        }
        return ProgramRun(process.exitValue(), out.readText(), err.readText())
    }

    private fun wslAccountsLine(basePath: String): String = TerminalAgentLauncher.accountsCommandFor(
        PROTECTED,
        AccountCli(
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\Yaron\\AppData\\Roaming\\JetBrains\\PyCharm2026.2\\plugins\\moe-jetbrains\\daemon\\accounts\\cli.js"
        ),
        "C:\\Users\\Yaron\\.moe\\claude-accounts.json",
        listOf("remove", "acct-2", "--sign-out"),
        AccountsShell.WSL_BASH,
        basePath
    )

    /** The one IllegalArgumentException a protected Accounts refusal throws, in its own words, never the seat launch's. */
    private fun accountsRefusal(build: () -> String): String {
        val message = assertThrows(IllegalArgumentException::class.java) { build() }.message ?: ""
        assertTrue(message, message.startsWith("Protected execution profile: "))
        assertFalse(message, message.contains("node executable"))
        assertFalse(message, message.contains("agent wrapper"))
        return message
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
            val actual = pinnedCommand(row.role, row.kind, row.wsl)
            if (row.kind == POWERSHELL) {
                // The row pins the decoded script. The typed bytes are rebuilt from it, so the framing is pinned too.
                val exe = if (row.wsl) "powershell.exe" else "powershell"
                assertEquals(label, expected, typedScript(actual, exe))
                val encoded = Base64.getEncoder().encodeToString(expected.toByteArray(Charsets.UTF_16LE))
                assertEquals(label, "$exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded", actual)
            } else {
                assertEquals(label, expected, actual)
            }
        }
        assertEquals(16, PINNED_LEGACY.map { Triple(it.role, it.wsl, it.kind) }.toSet().size)
    }

    @Test
    fun `a VM seat with the WSL toggle on types the native PowerShell wrapper into the WSL prompt`() {
        val native = pinnedCommand("worker", ScriptKind.POWERSHELL, wsl = false)
        val underWsl = pinnedCommand("worker", ScriptKind.POWERSHELL, wsl = true)
        assertEquals(TerminalAgentLauncher.bashWrapPowerShell(native), underWsl)
        assertTrue(underWsl, underWsl.startsWith("powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "))
        assertTrue(underWsl, typedBashPsScript(underWsl).contains("& '${scriptAsTyped(true, ScriptKind.POWERSHELL)}' -Role worker -Project "))
        assertTrue(native, typedPsScript(native).contains("& '$PINNED_SCRIPT' -Role worker -Project 'D:\\projexts\\app'"))
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

    @Test
    fun `every agent route refuses a C0 control or DEL in each typed value`() {
        for (code in CONTROL_CODES) {
            // Mid-value: toWslPath's `$` would drop a trailing line terminator before the WSL check.
            val bad = "p${code.toChar()}q"
            for ((kind, wsl) in AGENT_ROUTES) {
                val carriers = mapOf<String, () -> String>(
                    "project path" to { agentLine(kind, wsl, basePath = "D:/$bad") },
                    "script path" to { agentLine(kind, wsl, scriptPath = "D:/$bad/moe-agent") },
                    "command" to { agentLine(kind, wsl, agentCommand = "claude$bad") },
                    "team name" to { agentLine(kind, wsl, teamName = "a$bad") },
                    "worker id" to { agentLine(kind, wsl, workerId = "worker-$bad") },
                    "env MOE_DAEMON_PATH" to { agentLine(kind, wsl, env = mapOf("MOE_DAEMON_PATH" to "C:/$bad")) }
                )
                for ((label, build) in carriers) {
                    val ex = assertThrows("0x%02x $kind wsl=$wsl $label".format(code), IllegalArgumentException::class.java) { build() }
                    assertEquals("Invalid $label: contains control characters", ex.message)
                }
            }
        }
    }

    @Test
    fun `every accounts shell refuses a C0 control or DEL in each typed word`() {
        for (code in CONTROL_CODES) {
            val bad = "p${code.toChar()}q"
            for (shell in AccountsShell.values()) {
                val carriers = listOf<() -> String>(
                    { accountsLine(shell, node = "C:/$bad/node") },
                    { accountsLine(shell, script = "C:/$bad/cli.js") },
                    { accountsLine(shell, registryFile = "C:/$bad/claude-accounts.json") },
                    { accountsLine(shell, args = listOf("login", "acct-$bad")) }
                )
                carriers.forEachIndexed { index, build ->
                    val ex = assertThrows("0x%02x $shell carrier $index".format(code), IllegalArgumentException::class.java) { build() }
                    assertEquals("Invalid accounts command word: contains control characters", ex.message)
                }
            }
        }
    }

    @Test
    fun `space, tilde and non-ASCII still build on every agent route and accounts shell`() {
        val ok = "a ~\u00e9"
        for ((kind, wsl) in AGENT_ROUTES) {
            val line = agentLine(
                kind, wsl, basePath = "D:/$ok", scriptPath = "D:/$ok/moe-agent", agentCommand = "claude $ok",
                teamName = ok, workerId = "worker-$ok", env = mapOf("MOE_DAEMON_PATH" to "C:/$ok")
            )
            val team = if (kind == ScriptKind.POWERSHELL) "-Team '$ok'" else "--team '$ok'"
            val typed = when {
                kind != ScriptKind.POWERSHELL -> line
                wsl -> typedBashPsScript(line)
                else -> typedPsScript(line)
            }
            assertTrue("$kind wsl=$wsl: $line", typed.contains(team))
        }
        for (shell in AccountsShell.values()) {
            val line = accountsLine(shell, node = "C:/$ok/node", script = "C:/$ok/cli.js", registryFile = "C:/$ok/a.json", args = listOf("login", ok))
            val typed = if (shell == AccountsShell.POWERSHELL) typedPsScript(line) else line
            assertTrue("$shell: $line", typed.contains("'login' '$ok'"))
        }
    }

    @Test
    fun `every PowerShell single-quote character is doubled so each value stays one word`() {
        assertPsCarriersKeep("x'\u2018\u2019\u201A\u201By")
    }

    @Test
    fun `a backtick, dollar or double-quote character stays inside its own word on every PowerShell route`() {
        // The last three hold U+201C, U+201D and U+201E, which PowerShell reads as double quotes.
        val probes = listOf(
            "a`b",
            "a`nb`\$c",
            "tail`",
            "x`\"; Write-Output PWNED2; #'",
            "\$(Write-Output PWNED4)\$env:USERNAME",
            "a“; Write-Output PWNED5; #",
            "a”; Write-Output PWNED3; #",
            "a„b"
        )
        probes.forEach { assertPsCarriersKeep(it) }
    }

    @Test
    fun `a project path holding a right single quotation mark reaches the wrapper intact on both PowerShell routes`() {
        val path = "D:\\Bob\u2019s work"
        val native = agentLine(POWERSHELL, false, basePath = path)
        assertTrue(native, typedPsScript(native).contains("-Project 'D:\\Bob\u2019\u2019s work'"))
        val routes = mapOf(false to typedPsScript(native), true to typedBashPsScript(agentLine(POWERSHELL, true, basePath = path)))
        for ((wsl, script) in routes) {
            val words = psWords(script)
            assertEquals("wsl=$wsl: $script", path, words[words.indexOf("-Project") + 1])
        }
    }

    @Test
    fun `an ASCII double quote or an exclamation mark reaches the wrapper byte-identical on every PowerShell route`() {
        // Windows PowerShell 5.1's native argument passing dropped a plain " from the old -Command line, and an
        // interactive bash expanded ! inside the WSL wrap's double quotes ('event not found').
        val probes = listOf(
            "a\"b",
            "x\"; Write-Output PWNED6; #",
            "D:\\work!x",
            "!!",
            "a!\$b",
            "x'\u2018\u2019\u201A\u201B\u201C\u201D\u201E`\$\"!y"
        )
        probes.forEach { assertPsCarriersKeep(it) }
    }

    /**
     * Puts [value] into each typed value of the native and WSL PowerShell agent lines, then into each word of the
     * PowerShell accounts line, and reads the words back as PowerShell does. Comparing whole lists catches a value that
     * spills into a second word.
     */
    private fun assertPsCarriersKeep(value: String) {
        val agents = mapOf(
            "project path" to PsAgent(basePath = "D:/projexts/$value"),
            "script path" to PsAgent(scriptPath = "D:/moe/$value/moe-agent"),
            "command" to PsAgent(agentCommand = value),
            "team name" to PsAgent(teamName = value),
            "env MOE_DAEMON_PATH" to PsAgent(daemonPath = "C:/moe/$value/index.js")
        )
        for (wsl in listOf(false, true)) {
            for ((label, a) in agents) {
                val line = agentLine(POWERSHELL, wsl, a.basePath, a.scriptPath, a.agentCommand, a.teamName, env = mapOf("MOE_DAEMON_PATH" to a.daemonPath))
                val script = if (wsl) typedBashPsScript(line) else typedPsScript(line)
                assertEquals("wsl=$wsl $label: $line", a.words(), psWords(script))
            }
        }
        val accounts = listOf(
            listOf("C:/$value/node.exe", "C:/moe/cli.js", "C:/moe/claude-accounts.json", "check"),
            listOf("C:/node/node.exe", "C:/$value/cli.js", "C:/moe/claude-accounts.json", "check"),
            listOf("C:/node/node.exe", "C:/moe/cli.js", "C:/$value/claude-accounts.json", "check"),
            listOf("C:/node/node.exe", "C:/moe/cli.js", "C:/moe/claude-accounts.json", value)
        )
        for ((node, script, file, arg) in accounts) {
            val line = accountsLine(AccountsShell.POWERSHELL, node, script, file, listOf("login", arg))
            assertEquals("accounts: $line", listOf("&", node, script, "--accounts-file", file, "login", arg), psWords(typedPsScript(line)))
        }
    }

    /**
     * The words PowerShell's tokenizer reads from [script]. Any of PS_SINGLE_QUOTES opens or closes a quoted word, and a
     * doubled pair inside one reads as its second character. A bare word ends at a space or a single-quote character.
     */
    private fun psWords(script: String): List<String> {
        val words = mutableListOf<String>()
        var i = 0
        while (i < script.length) {
            if (script[i] == ' ') { i++; continue }
            val word = StringBuilder()
            if (script[i] in PS_SINGLE_QUOTES) {
                i++
                while (true) {
                    assertTrue("unterminated quote in: $script", i < script.length)
                    val quote = script[i] in PS_SINGLE_QUOTES
                    if (quote && script.getOrNull(i + 1)?.let { it in PS_SINGLE_QUOTES } != true) break
                    word.append(script[if (quote) i + 1 else i])
                    i += if (quote) 2 else 1
                }
                i++
            } else {
                while (i < script.length && script[i] != ' ' && script[i] !in PS_SINGLE_QUOTES) word.append(script[i++])
            }
            words += word.toString()
        }
        return words
    }

    /** The script a PowerShell prompt runs for a native [line]: the decoded `-EncodedCommand` argument. */
    private fun typedPsScript(line: String): String = typedScript(line, "powershell")

    /** The same for the WSL route's bash prompt, where interop needs the `.exe` suffix. */
    private fun typedBashPsScript(line: String): String = typedScript(line, "powershell.exe")

    /**
     * Decodes a `<exe> -NoProfile -ExecutionPolicy Bypass -EncodedCommand <base64>` [line] as PowerShell does: base64 of
     * UTF-16LE. The tail must be only the base64 alphabet, so no shell the line is typed into sees a character of any
     * value. Both checks run before the decode, so a decode exception cannot hide the line.
     */
    private fun typedScript(line: String, exe: String): String {
        val prefix = "$exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "
        assertTrue("not a $exe -EncodedCommand line: $line", line.startsWith(prefix))
        val encoded = line.substring(prefix.length)
        assertTrue("not a $exe -EncodedCommand line, the tail is not only base64: $line", BASE64_TAIL.matches(encoded))
        val bytes = Base64.getDecoder().decode(encoded)
        assertTrue("odd UTF-16LE byte count ${bytes.size}: $line", bytes.size % 2 == 0)
        return String(bytes, Charsets.UTF_16LE)
    }

    private fun agentLine(
        kind: ScriptKind,
        wsl: Boolean,
        basePath: String = "D:/projexts/app",
        scriptPath: String = "D:/moe/moe-agent",
        agentCommand: String = "claude",
        teamName: String? = "team",
        workerId: String = "worker-0000abcd",
        env: Map<String, String> = mapOf("MOE_DAEMON_PATH" to "C:/moe/daemon/index.js")
    ): String = TerminalAgentLauncher.buildCommandForTest(basePath, "worker", scriptPath, kind, env, agentCommand, teamName, wsl, workerId)

    private fun accountsLine(
        shell: AccountsShell,
        node: String = "C:/node/node.exe",
        script: String = "C:/moe/cli.js",
        registryFile: String = "C:/moe/claude-accounts.json",
        args: List<String> = listOf("check")
    ): String = TerminalAgentLauncher.buildAccountsCommand(AccountCli(node, script), registryFile, args, shell)

    private fun pinnedCommand(role: String, kind: ScriptKind, wsl: Boolean): String =
        TerminalAgentLauncher.buildCommandForTest(
            "D:\\projexts\\app", role, PINNED_SCRIPT, kind, PINNED_ENV, "claude", null, wsl, "$role-0000abcd"
        )

    /** [buildPowerShellCommandForTest][TerminalAgentLauncher.buildPowerShellCommandForTest]'s line, decoded to the script PowerShell runs. */
    private fun decodedPowerShellCommand(
        basePath: String,
        role: String,
        scriptPath: String,
        envOverrides: Map<String, String>,
        agentCommand: String,
        teamName: String? = null,
        codexExec: Boolean = false
    ): String = typedPsScript(
        TerminalAgentLauncher.buildPowerShellCommandForTest(basePath, role, scriptPath, envOverrides, agentCommand, teamName, codexExec)
    )

    // The script path is the only OS-dependent input (buildCommand types File.absolutePath), so it is substituted
    // in the form each script receives it; every other byte is literal. A PowerShell row holds the decoded script.
    private fun scriptAsTyped(wsl: Boolean, kind: ScriptKind): String =
        if (wsl && kind == ScriptKind.BASH) TerminalAgentLauncher.toWslPath(PINNED_SCRIPT) else PINNED_SCRIPT

    private class Row(val role: String, val wsl: Boolean, val kind: ScriptKind, val expected: String)

    /** One PowerShell agent launch through agentLine (role worker, worker id worker-0000abcd) and the words it must type. */
    private class PsAgent(
        val basePath: String = "D:/projexts/app",
        val scriptPath: String = "D:/moe/moe-agent",
        val agentCommand: String = "claude",
        val teamName: String = "team",
        val daemonPath: String = "C:/moe/daemon/index.js"
    ) {
        // buildCommand types File.absolutePath for the script, which depends on the OS.
        fun words() = listOf(
            "\$env:MOE_DAEMON_PATH=", daemonPath, ";", "&", File(scriptPath).absolutePath, "-Role", "worker", "-Project", basePath,
            "-WorkerId", "worker-0000abcd", "-Command", agentCommand, "-Team", teamName
        )
    }

    private companion object {
        val PINNED_SCRIPT: String = File("pinned", "moe-agent").absolutePath
        val PINNED_ENV = linkedMapOf("MOE_DAEMON_PATH" to "C:\\moe\\daemon\\index.js", "MOE_PROXY_PATH" to "C:\\moe\\proxy\\index.js")
        val POWERSHELL = ScriptKind.POWERSHELL
        val BASH = ScriptKind.BASH
        val CONTROL_CODES = listOf(0x00, 0x01, 0x09, 0x0A, 0x0D, 0x15, 0x17, 0x1B, 0x1F, 0x7F)
        val AGENT_ROUTES = listOf(POWERSHELL to false, BASH to false, BASH to true, POWERSHELL to true)
        // U+0027, U+2018, U+2019, U+201A and U+201B: PowerShell's tokenizer reads each as a single quote (CharExtensions.IsSingleQuote).
        const val PS_SINGLE_QUOTES = "'‘’‚‛"
        val BASE64_TAIL = Regex("[A-Za-z0-9+/]+={0,2}")
        const val ACCOUNTS_SCRIPT = "C:\\moe\\daemon\\accounts\\cli.js"
        const val ACCOUNTS_FILE = "C:\\moe\\claude-accounts.json"

        // Captured from buildCommand before PowerShell moved to -EncodedCommand (agentCommand claude, no team, workerId <role>-0000abcd).
        // A POWERSHELL row holds the script the typed line runs; the BASH rows hold the typed line itself.
        val PINNED_LEGACY = listOf(
            Row("architect", false, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role architect -Project 'D:\\projexts\\app' -WorkerId 'architect-0000abcd' -Command 'claude' -Interactive"),
            Row("architect", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role architect --project 'D:\\projexts\\app' --worker-id 'architect-0000abcd' --command 'claude' --interactive"),
            Row("architect", true, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role architect -Project 'D:\\projexts\\app' -WorkerId 'architect-0000abcd' -Command 'claude' -Interactive"),
            Row("architect", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role architect --project '/mnt/d/projexts/app' --worker-id 'architect-0000abcd' --command 'claude' --interactive"),
            Row("worker", false, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role worker -Project 'D:\\projexts\\app' -WorkerId 'worker-0000abcd' -Command 'claude'"),
            Row("worker", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role worker --project 'D:\\projexts\\app' --worker-id 'worker-0000abcd' --command 'claude'"),
            Row("worker", true, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role worker -Project 'D:\\projexts\\app' -WorkerId 'worker-0000abcd' -Command 'claude'"),
            Row("worker", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role worker --project '/mnt/d/projexts/app' --worker-id 'worker-0000abcd' --command 'claude'"),
            Row("qa", false, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role qa -Project 'D:\\projexts\\app' -WorkerId 'qa-0000abcd' -Command 'claude'"),
            Row("qa", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role qa --project 'D:\\projexts\\app' --worker-id 'qa-0000abcd' --command 'claude'"),
            Row("qa", true, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role qa -Project 'D:\\projexts\\app' -WorkerId 'qa-0000abcd' -Command 'claude'"),
            Row("qa", true, BASH, "MOE_DAEMON_PATH='/mnt/c/moe/daemon/index.js' MOE_PROXY_PATH='/mnt/c/moe/proxy/index.js' bash '@S@' --role qa --project '/mnt/d/projexts/app' --worker-id 'qa-0000abcd' --command 'claude'"),
            Row("governor", false, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role governor -Project 'D:\\projexts\\app' -WorkerId 'governor-0000abcd' -Command 'claude' -Interactive"),
            Row("governor", false, BASH, "MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js' MOE_PROXY_PATH='C:\\moe\\proxy\\index.js' bash '@S@' --role governor --project 'D:\\projexts\\app' --worker-id 'governor-0000abcd' --command 'claude' --interactive"),
            Row("governor", true, POWERSHELL, "\$env:MOE_DAEMON_PATH='C:\\moe\\daemon\\index.js'; \$env:MOE_PROXY_PATH='C:\\moe\\proxy\\index.js'; & '@S@' -Role governor -Project 'D:\\projexts\\app' -WorkerId 'governor-0000abcd' -Command 'claude' -Interactive"),
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
