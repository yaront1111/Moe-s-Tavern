package com.moe.toolwindow

import com.moe.toolwindow.ManagedVmCommand.CLEANUP
import com.moe.toolwindow.ManagedVmCommand.RECONCILE
import com.moe.toolwindow.ManagedVmCommand.STATUS
import com.moe.toolwindow.ManagedVmReport.Refused
import com.moe.toolwindow.ManagedVmReport.Unreadable
import java.lang.reflect.Modifier
import java.text.MessageFormat
import java.util.Locale
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.moe.toolwindow.ManagedVmKeys as K

class ManagedVmPresentationTest {
    private val a = owned('a')
    private val b = owned('b')
    private val c = owned('c')
    private val d = owned('d')
    private val e = owned('e')
    private val ready = """{"ready":true,"code":"PROVIDER_PREREQUISITES_READY","platform":"linux"}"""
    private val unclaimed = """"executionReady":false,"verified":false"""
    private val emptyCleanup = """{"schema":"moe-vm-cleanup-v1","deleted":[],"preserved":[],"errors":[],"invalid":0}"""

    private fun owned(hex: Char) = "moe-vm-" + hex.toString().repeat(20)
    private fun vm(name: String, phase: String = "owned", state: String = "Running", tries: String = "1") =
        """{"instance":"$name","phase":"$phase","state":"$state","launchTries":$tries,"taskId":"task-1"}"""
    private fun statusLine(vms: List<String> = listOf(vm(a)), provider: String = ready, flags: String = unclaimed) =
        """{"schema":"moe-vm-status-v1","provider":$provider,$flags,"instances":[${vms.joinToString(",")}],"invalid":0}"""
    private fun decode(command: ManagedVmCommand, line: String, exit: Int = 0, timedOut: Boolean = false) =
        ManagedVmPresentation.decode(command, "$line\n", exit, timedOut)
    private fun status(vms: List<String> = listOf(vm(a)), provider: String = ready, flags: String = unclaimed) =
        decode(STATUS, statusLine(vms, provider, flags))
    private fun text(key: String, vararg args: Any) = ManagedVmText(key, args.toList())
    private fun code(code: String) = text(K.CODE_PREFIX + code, code)

    @Test
    fun `P1 provider readiness never implies execution readiness or verification`() {
        val notReady = listOf(text(K.PROVIDER_READY), text(K.EXECUTION_NOT_READY), text(K.NOT_VERIFIED))
        for (flags in listOf("null", "\"true\"", "1", "{}", "false").map { """"executionReady":$it,"verified":$it""" } + """"x":0""") {
            assertEquals(flags, notReady, ManagedVmPresentation.readiness(status(flags = flags)))
        }
        assertEquals(
            listOf(text(K.PROVIDER_READY), text(K.EXECUTION_READY), text(K.VERIFIED)),
            ManagedVmPresentation.readiness(status(flags = """"executionReady":true,"verified":true"""))
        )
        val missing = """{"ready":false,"code":"PROVIDER_NOT_FOUND"}"""
        assertEquals(text(K.PROVIDER_NOT_READY, code("PROVIDER_NOT_FOUND")), ManagedVmPresentation.readiness(status(provider = missing))[0])
        assertEquals(text(K.PROVIDER_NOT_READY, text(K.NO_CODE)), ManagedVmPresentation.readiness(status(provider = """{"ready":"true"}"""))[0])
        for (report in listOf(null, Unreadable(K.MALFORMED), Refused("LEDGER_UNREADABLE"))) {
            assertEquals(listOf(text(K.PROVIDER_UNKNOWN), text(K.EXECUTION_NOT_READY), text(K.NOT_VERIFIED)), ManagedVmPresentation.readiness(report))
        }
    }

    @Test
    fun `P2 rows are owned ledger instances only and commands name no instance`() {
        val report = status(listOf(vm(b, "launching", "Unknown"), vm(a, "absent", "Absent", "3"), vm(c, "collision"), vm(d, "deleted")))
        assertEquals(
            listOf(ManagedVmRow(b, "launching", "Unknown", 1, "task-1"), ManagedVmRow(a, "absent", "Absent", 3, "task-1")),
            ManagedVmPresentation.rows(report)
        )
        for (name in listOf("moe-vm-primary", "primary", "moe-vm-" + "A".repeat(20), a + "0", "$a\\n", "")) {
            assertEquals(name, Unreadable(K.NOT_OWNED), status(listOf(vm(a), vm(name))))
        }
        assertEquals(Unreadable(K.NOT_OWNED), status(listOf(vm(a), vm(a, "absent"))))
        assertEquals(Unreadable(K.NOT_OWNED), decode(CLEANUP, """{"schema":"moe-vm-cleanup-v1","deleted":["$a"],"preserved":[],"errors":[{"instance":"$a","code":"X"}],"invalid":0}"""))
        assertEquals(listOf("C:/a b/vm-control.mjs", "status", "--project", "D:/my repo"), STATUS.args("C:/a b/vm-control.mjs", "D:/my repo"))
        assertEquals(listOf("reconcile", "cleanup"), listOf(RECONCILE, CLEANUP).map { it.args("s", "p")[1] })
        assertEquals(listOf(2), ManagedVmCommand::class.java.methods.filter { it.name == "args" }.map { it.parameterCount })
    }

    @Test
    fun `P3 actions are single flight and need a readable status with a ready provider`() {
        fun actions(report: ManagedVmReport?, running: Boolean = false) = ManagedVmPresentation.actions(report, running)
        assertEquals(ManagedVmActions(refresh = true, reconcile = true, cleanup = true), actions(status()))
        assertEquals(ManagedVmActions(true, true, false), actions(status(emptyList())))
        assertEquals(ManagedVmActions(true, true, false), actions(status(listOf(vm(a, "reserved"), vm(b, "collision"), vm(c, "deleted")))))
        assertEquals(ManagedVmActions(true, false, false), actions(status(provider = """{"ready":false}""")))
        for (report in listOf(null, Unreadable(K.MALFORMED), Refused("LEDGER_UNREADABLE"), decode(CLEANUP, emptyCleanup))) {
            assertEquals(ManagedVmActions(true, false, false), actions(report))
        }
        for (report in listOf(null, status())) assertEquals(ManagedVmActions(false, false, false), actions(report, running = true))
    }

    @Test
    fun `P4 strong profile is blocked for every report and nothing activates it`() {
        val claims = status(flags = """"executionReady":true,"verified":true""")
        for (report in listOf(null, status(), claims, Unreadable(K.MALFORMED), Refused("VM_CONTROL_FAILED"), decode(CLEANUP, emptyCleanup))) {
            assertEquals(text(K.STRONG_PROFILE_BLOCKED), ManagedVmPresentation.strongProfile(report))
        }
        assertEquals(setOf("refresh", "reconcile", "cleanup"), ManagedVmActions::class.java.declaredFields.map { it.name }.toSet())
        assertEquals(listOf("STATUS", "RECONCILE", "CLEANUP"), ManagedVmCommand.values().map { it.name })
    }

    @Test
    fun `P5 reports and refusals render as fixed keys`() {
        val cleanup = """{"schema":"moe-vm-cleanup-v1","deleted":["$a"],"preserved":[{"instance":"$b","reason":"job-lease-held"},""" +
            """{"instance":"$c","reason":"new-reason"}],"errors":[{"instance":"$d","code":"LIFECYCLE_STATE_UNKNOWN"},{"instance":"$e","code":"NEW_CODE"}],"invalid":2}"""
        assertEquals(
            listOf(
                text(K.DELETED, a), text(K.PRESERVED, b, text(K.REASON_PREFIX + "job-lease-held", "job-lease-held")),
                text(K.PRESERVED, c, text(K.UNKNOWN_CODE, "new-reason")), text(K.CLEANUP_ERROR, d, code("LIFECYCLE_STATE_UNKNOWN")),
                text(K.CLEANUP_ERROR, e, text(K.UNKNOWN_CODE, "NEW_CODE")), text(K.INVALID_RECORDS, 2)
            ),
            ManagedVmPresentation.notes(decode(CLEANUP, cleanup))
        )
        val reconcile = """{"schema":"moe-vm-reconcile-v1","reconciled":[{"instance":"$a","from":"launching","to":"owned"}],"unknown":["$b"],"invalid":0}"""
        assertEquals(listOf(text(K.RECONCILED, a, "launching", "owned"), text(K.RECONCILE_UNKNOWN, b)), ManagedVmPresentation.notes(decode(RECONCILE, reconcile)))
        assertEquals(listOf(text(K.NOTHING_CHANGED)), ManagedVmPresentation.notes(decode(CLEANUP, emptyCleanup)))
        assertEquals(listOf(code("LEDGER_UNREADABLE")), ManagedVmPresentation.notes(decode(STATUS, """{"schema":"moe-vm-status-v1","code":"LEDGER_UNREADABLE","instances":[]}""")))
        assertEquals(listOf(text(K.UNKNOWN_CODE, "SOMETHING_NEW")), ManagedVmPresentation.notes(decode(RECONCILE, """{"code":"SOMETHING_NEW"}""")))
        assertEquals(emptyList<ManagedVmText>(), ManagedVmPresentation.notes(status()))
    }

    @Test
    fun `P5 malformed, oversized, failed or timed out output is unreadable without producer text`() {
        val ok = statusLine()
        val cases = listOf(
            decode(STATUS, "Error: secret /home/me stack") to K.MALFORMED, decode(STATUS, "$ok\n$ok") to K.MALFORMED,
            decode(STATUS, "") to K.MALFORMED, decode(STATUS, "$ok x") to K.MALFORMED, decode(STATUS, "{'schema':'moe-vm-status-v1'}") to K.MALFORMED,
            decode(STATUS, ok.replace("status-v1", "status-v2")) to K.MALFORMED, decode(STATUS, emptyCleanup) to K.MALFORMED,
            decode(STATUS, """{"code":"see /tmp/x"}""") to K.MALFORMED, decode(STATUS, """{"schema":"moe-vm-status-v1"}""") to K.MALFORMED,
            status(listOf(vm(a, "weird"))) to K.MALFORMED, status(listOf(vm(a, state = "<b>Exploded</b>"))) to K.MALFORMED,
            status(listOf(vm(a, tries = "-1"))) to K.MALFORMED, status(listOf(vm(a, tries = "1.5"))) to K.MALFORMED,
            status(provider = """{"ready":false,"code":"lower case"}""") to K.MALFORMED,
            decode(STATUS, ok.dropLast(1) + ",\"pad\":\"" + "x".repeat(70_000) + "\"}") to K.TOO_LARGE,
            decode(STATUS, ok, exit = 2) to K.FAILED, decode(STATUS, ok, timedOut = true) to K.TIMED_OUT
        )
        for ((report, key) in cases) {
            assertEquals(Unreadable(key), report)
            assertEquals(listOf(text(key)), ManagedVmPresentation.notes(report))
        }
    }

    @Test
    fun `P6 producer codes render their own text and the bundle codes are exactly KNOWN_CODES`() {
        val bundle = Properties()
        checkNotNull(ManagedVmPresentationTest::class.java.getResourceAsStream("/messages/MoeBundle.properties")).use { bundle.load(it) }
        val codeKey = Regex("""moe\.managedVm\.code\.[A-Z][A-Z0-9_]*""")
        val bundled = bundle.stringPropertyNames().filter { codeKey.matches(it) }.map { it.removePrefix(K.CODE_PREFIX) }.toSet()
        assertEquals(ManagedVmPresentation.KNOWN_CODES, bundled)

        val provider = ManagedVmPresentation.readiness(status(provider = """{"ready":false,"code":"VERSION_MISMATCH"}"""))[0]
        assertEquals(text(K.PROVIDER_NOT_READY, code("VERSION_MISMATCH")), provider)
        val cleanup = """{"schema":"moe-vm-cleanup-v1","deleted":[],"preserved":[],"errors":[{"instance":"$d","code":"LIFECYCLE_NOT_OWNER"},""" +
            """{"instance":"$e","code":"LEDGER_WRITE_FAILED"}],"invalid":0}"""
        val errors = ManagedVmPresentation.notes(decode(CLEANUP, cleanup))
        assertEquals(listOf(text(K.CLEANUP_ERROR, d, code("LIFECYCLE_NOT_OWNER")), text(K.CLEANUP_ERROR, e, code("LEDGER_WRITE_FAILED"))), errors)

        fun render(t: ManagedVmText): String =
            MessageFormat(bundle.getProperty(t.key), Locale.ROOT).format(t.args.map { if (it is ManagedVmText) render(it) else it }.toTypedArray<Any>())
        val notOwner = "This VM record belongs to another task attempt, so Moe left it untouched; reconcile, then refresh."
        val writeFailed = "Its ledger record could not be written; the VM may already be gone. " +
            "Check free space and permissions under ~/.moe/runner-state (or MOE_RUNNER_STATE_DIR), then clean up again."
        assertEquals(
            "VM provider: not ready. The Multipass client and daemon versions differ; restart Multipass, or reinstall it, so both run the same approved version.",
            render(provider)
        )
        assertEquals(listOf("$d: not deleted. $notOwner", "$e: not deleted. $writeFailed"), errors.map(::render))
    }

    @Test
    fun `every key and code has plain bundle text`() {
        val bundle = Properties()
        checkNotNull(ManagedVmPresentationTest::class.java.getResourceAsStream("/messages/MoeBundle.properties")).use { bundle.load(it) }
        val keys = K::class.java.declaredFields.filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }
            .map { it.get(null) as String }.filterNot { it.endsWith(".") }
        val all = keys + K.COLUMNS + ManagedVmPresentation.KNOWN_CODES.map { K.CODE_PREFIX + it } + ManagedVmPresentation.REASONS.map { K.REASON_PREFIX + it }
        assertEquals(all.size, all.toSet().size)
        for (key in all) {
            val value = bundle.getProperty(key)
            assertTrue("$key missing", !value.isNullOrBlank())
            assertFalse("$key: no HTML or single quote", value.contains('<') || value.contains('\''))
            assertFalse(key, MessageFormat(value, Locale.ROOT).format(arrayOf<Any>("A", "B", "C")).contains("{"))
        }
    }
}
