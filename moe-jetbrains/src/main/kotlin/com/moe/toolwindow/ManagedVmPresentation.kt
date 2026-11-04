package com.moe.toolwindow

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.google.gson.TypeAdapter
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.StringReader

/** A `MoeBundle` key and its arguments (a nested [ManagedVmText] resolves too), never producer text. */
data class ManagedVmText(val key: String, val args: List<Any> = emptyList())

data class ManagedVmRow(val instance: String, val phase: String, val state: String, val launchTries: Int, val taskId: String)

data class ManagedVmActions(val refresh: Boolean, val reconcile: Boolean, val cleanup: Boolean)

/** `scripts/local-runner/vm-control.mjs <verb> --project <path>`; no command takes an instance name. */
enum class ManagedVmCommand(private val verb: String, internal val schema: String, val timeoutMs: Long) {
    STATUS("status", "moe-vm-status-v1", 120_000),
    RECONCILE("reconcile", "moe-vm-reconcile-v1", 120_000),
    // Each owned delete may take the producer 120 s.
    CLEANUP("cleanup", "moe-vm-cleanup-v1", 20 * 60_000);

    fun args(script: String, basePath: String): List<String> = listOf(script, verb, "--project", basePath)
}

sealed interface ManagedVmReport {
    data class Status(val providerReady: Boolean, val providerCode: String?, val executionReady: Boolean, val verified: Boolean,
        val instances: List<ManagedVmRow>, val invalid: Int) : ManagedVmReport
    /** A reconcile or cleanup report, already as texts. */
    data class Outcome(val notes: List<ManagedVmText>) : ManagedVmReport
    /** The producer's own refusal: a fixed code, such as LEDGER_UNREADABLE. */
    data class Refused(val code: String) : ManagedVmReport
    data class Unreadable(val key: String) : ManagedVmReport
}

object ManagedVmKeys {
    const val TAB = "moe.tab.managedVms"
    const val INTRO = "moe.managedVm.intro"
    const val PROVIDER_UNKNOWN = "moe.managedVm.provider.unknown"
    const val PROVIDER_READY = "moe.managedVm.provider.ready"
    const val PROVIDER_NOT_READY = "moe.managedVm.provider.notReady"
    const val NO_CODE = "moe.managedVm.code.none"
    const val EXECUTION_READY = "moe.managedVm.execution.ready"
    const val EXECUTION_NOT_READY = "moe.managedVm.execution.notReady"
    const val VERIFIED = "moe.managedVm.verified"
    const val NOT_VERIFIED = "moe.managedVm.notVerified"
    const val STRONG_PROFILE_BLOCKED = "moe.managedVm.strongProfile.blocked"
    const val UNKNOWN_CODE = "moe.managedVm.code.unknown"
    const val CODE_PREFIX = "moe.managedVm.code."
    const val REASON_PREFIX = "moe.managedVm.reason."
    const val INVALID_RECORDS = "moe.managedVm.invalidRecords"
    const val NOTHING_CHANGED = "moe.managedVm.nothingChanged"
    const val RECONCILED = "moe.managedVm.reconciled"
    const val RECONCILE_UNKNOWN = "moe.managedVm.reconcileUnknown"
    const val DELETED = "moe.managedVm.deleted"
    const val PRESERVED = "moe.managedVm.preserved"
    const val CLEANUP_ERROR = "moe.managedVm.cleanupError"
    const val MALFORMED = "moe.managedVm.unreadable.malformed"
    const val NOT_OWNED = "moe.managedVm.unreadable.notOwned"
    const val TOO_LARGE = "moe.managedVm.unreadable.tooLarge"
    const val FAILED = "moe.managedVm.unreadable.failed"
    const val TIMED_OUT = "moe.managedVm.unreadable.timedOut"
    const val CANCELLED = "moe.managedVm.unreadable.cancelled"
    const val SCRIPT_MISSING = "moe.managedVm.unreadable.scriptMissing"
    const val NODE_MISSING = "moe.managedVm.unreadable.nodeMissing"
    const val BUTTON_REFRESH = "moe.managedVm.button.refresh"
    const val BUTTON_RECONCILE = "moe.managedVm.button.reconcile"
    const val BUTTON_CLEANUP = "moe.managedVm.button.cleanup"
    const val CLEANUP_CONFIRM = "moe.managedVm.cleanup.confirm"
    val COLUMNS = listOf("instance", "phase", "state", "tries", "task").map { "moe.managedVm.column.$it" }
}

/**
 * The Managed VMs tab's contract with CQ-I03a's `vm-control.mjs`, free of IntelliJ classes like [AccountPresentation].
 * - Provider readiness is not execution readiness or verification: three lines, and only a literal JSON `true`
 *   counts for the last two.
 * - The IDE never offers strong-profile (verified-local) activation; the daemon refuses it with
 *   EXECUTION_PROFILE_NOT_READY until isolation, runner evidence and delivery are certified.
 * - Ownership is the producer's R06 ledger and the IDE never names an instance. A report naming anything outside
 *   the owned-name shape, or one name twice, is unreadable as a whole.
 */
object ManagedVmPresentation {
    /** The producer's cap (64 KiB) plus its newline. */
    private const val MAX_REPORT_BYTES = 64 * 1024
    internal val KNOWN_CODES = setOf(
        "PLATFORM_UNSUPPORTED", "PREREQUISITES_UNAVAILABLE", "PROVIDER_PREREQUISITES_READY", "PROVIDER_NOT_FOUND",
        "PROVIDER_ACCESS_DENIED", "PROVIDER_TIMEOUT", "HOST_UNSUPPORTED", "VERSION_UNSUPPORTED", "DRIVER_UNSUPPORTED",
        "VM_CONTROL_FAILED", "VM_CONTROL_REPORT_TOO_LARGE", "LEDGER_UNREADABLE", "LIFECYCLE_STATE_UNKNOWN",
        "MANIFEST_INVALID", "VERSION_MISMATCH", "PROVIDER_OUTPUT_INVALID", "DOCTOR_INPUT_INVALID", "PROVIDER_COMMAND_FAILED",
        "PROVIDER_OUTPUT_LIMIT", "PROVIDER_INPUT_INVALID", "LIFECYCLE_INPUT_INVALID", "LIFECYCLE_NAME_COLLISION",
        "LIFECYCLE_RETRY_EXHAUSTED", "LIFECYCLE_NOT_OWNER", "LIFECYCLE_PHASE_INVALID", "LEDGER_INPUT_INVALID",
        "LEDGER_RECORD_INVALID", "LEDGER_CONFLICT", "LEDGER_WRITE_FAILED", "IMAGE_IDENTITY_CHANGED"
    )
    internal val REASONS = setOf("attempt-active", "attempt-unknown", "job-lease-held", "lease-unknown")
    // lifecycle.mjs isOwnedInstanceName, PHASES, STATES (plus vm-control's Absent) and validOwner.
    private val OWNED = Regex("moe-vm-[0-9a-f]{20}")
    private val PHASES = setOf("reserved", "launching", "owned", "absent", "failed", "collision", "deleted")
    private val STATES = setOf("Running", "Stopped", "Deleted", "Starting", "Restarting", "Delayed Shutdown",
        "Suspending", "Suspended", "Unavailable", "Unknown", "Absent")
    private val TASK_ID = Regex("task-[A-Za-z0-9]{1,64}")
    private val CODE = Regex("[A-Z][A-Z0-9_]{0,63}")
    private val REASON = Regex("[a-z][a-z-]{0,31}")
    /** collision is a foreign VM that held the reserved name; deleted is gone. Neither is shown as owned. */
    private val HIDDEN = setOf("collision", "deleted")
    /** The phases cleanup acts on (lifecycle.mjs LAUNCHED). */
    private val LAUNCHED = setOf("launching", "owned", "absent", "failed")
    private val JSON: TypeAdapter<JsonElement> = Gson().getAdapter(JsonElement::class.java)

    private class Refusal(val key: String) : RuntimeException(null, null, false, false)

    /** Never throws: anything but one well-formed report line for [command] is [ManagedVmReport.Unreadable]. */
    fun decode(command: ManagedVmCommand, stdout: String, exitCode: Int, timedOut: Boolean): ManagedVmReport = when {
        timedOut -> ManagedVmReport.Unreadable(ManagedVmKeys.TIMED_OUT)
        exitCode != 0 -> ManagedVmReport.Unreadable(ManagedVmKeys.FAILED)
        stdout.toByteArray(Charsets.UTF_8).size > MAX_REPORT_BYTES -> ManagedVmReport.Unreadable(ManagedVmKeys.TOO_LARGE)
        else -> try {
            parse(command, stdout)
        } catch (refusal: Refusal) {
            ManagedVmReport.Unreadable(refusal.key)
        } catch (_: Exception) {
            ManagedVmReport.Unreadable(ManagedVmKeys.MALFORMED)
        }
    }

    fun readiness(report: ManagedVmReport?): List<ManagedVmText> {
        val status = report as? ManagedVmReport.Status
        val provider = when {
            status == null -> ManagedVmText(ManagedVmKeys.PROVIDER_UNKNOWN)
            status.providerReady -> ManagedVmText(ManagedVmKeys.PROVIDER_READY)
            else -> ManagedVmText(ManagedVmKeys.PROVIDER_NOT_READY, listOf(status.providerCode?.let(::refusal) ?: ManagedVmText(ManagedVmKeys.NO_CODE)))
        }
        return listOf(
            provider,
            ManagedVmText(if (status?.executionReady == true) ManagedVmKeys.EXECUTION_READY else ManagedVmKeys.EXECUTION_NOT_READY),
            ManagedVmText(if (status?.verified == true) ManagedVmKeys.VERIFIED else ManagedVmKeys.NOT_VERIFIED)
        )
    }

    /** Blocked whatever a report claims: activation needs certification this IDE cannot check. */
    @Suppress("UNUSED_PARAMETER")
    fun strongProfile(report: ManagedVmReport?): ManagedVmText = ManagedVmText(ManagedVmKeys.STRONG_PROFILE_BLOCKED)

    fun rows(report: ManagedVmReport?): List<ManagedVmRow> =
        (report as? ManagedVmReport.Status)?.instances.orEmpty().filter { it.phase !in HIDDEN }

    fun actions(lastStatus: ManagedVmReport?, running: Boolean): ManagedVmActions {
        val status = (lastStatus as? ManagedVmReport.Status)?.takeIf { it.providerReady && !running }
        return ManagedVmActions(!running, status != null, rows(status).any { it.phase in LAUNCHED })
    }

    fun notes(report: ManagedVmReport?): List<ManagedVmText> = when (report) {
        is ManagedVmReport.Status -> invalidNote(report.invalid)
        is ManagedVmReport.Outcome -> report.notes
        is ManagedVmReport.Refused -> listOf(refusal(report.code))
        is ManagedVmReport.Unreadable -> listOf(ManagedVmText(report.key))
        null -> emptyList()
    }

    fun refusal(code: String): ManagedVmText =
        ManagedVmText(if (code in KNOWN_CODES) ManagedVmKeys.CODE_PREFIX + code else ManagedVmKeys.UNKNOWN_CODE, listOf(code))

    private fun reason(reason: String): ManagedVmText =
        ManagedVmText(if (reason in REASONS) ManagedVmKeys.REASON_PREFIX + reason else ManagedVmKeys.UNKNOWN_CODE, listOf(reason))

    private fun parse(command: ManagedVmCommand, stdout: String): ManagedVmReport {
        val line = stdout.removeSuffix("\n")
        if (line.isEmpty() || line.any { it == '\n' || it == '\r' }) fail()
        // A new JsonReader is strict, and TypeAdapter.read keeps it so (Gson.fromJson would not).
        val reader = JsonReader(StringReader(line))
        val root = JSON.read(reader).obj()
        if (reader.peek() != JsonToken.END_DOCUMENT) fail()
        val schema = root.get("schema")?.text()
        if (schema != null && schema != command.schema) fail()
        root.get("code")?.let { return ManagedVmReport.Refused(it.matching(CODE)) }
        if (schema == null) fail()
        val seen = mutableSetOf<String>()
        fun owned(element: JsonElement) = element.text().also { if (!OWNED.matches(it) || !seen.add(it)) fail(ManagedVmKeys.NOT_OWNED) }
        fun JsonObject.each(name: String) = member(name).items()
        val count = root.member("invalid").count()
        val invalid = invalidNote(count)
        return when (command) {
            ManagedVmCommand.STATUS -> root.member("provider").obj().let { provider ->
                ManagedVmReport.Status(
                    provider.get("ready").isTrue(), provider.get("code")?.matching(CODE),
                    root.get("executionReady").isTrue(),
                    root.get("verified").isTrue(),
                    root.each("instances").map { it.obj() }.map {
                        ManagedVmRow(owned(it.member("instance")), it.member("phase").oneOf(PHASES), it.member("state").oneOf(STATES),
                            it.member("launchTries").count(), it.member("taskId").matching(TASK_ID))
                    },
                    count
                )
            }
            ManagedVmCommand.RECONCILE -> outcome(
                root.each("reconciled").map { it.obj() }.map {
                    ManagedVmText(ManagedVmKeys.RECONCILED, listOf(owned(it.member("instance")), it.member("from").oneOf(PHASES), it.member("to").oneOf(PHASES)))
                } + root.each("unknown").map { ManagedVmText(ManagedVmKeys.RECONCILE_UNKNOWN, listOf(owned(it))) } + invalid
            )
            ManagedVmCommand.CLEANUP -> outcome(
                root.each("deleted").map { ManagedVmText(ManagedVmKeys.DELETED, listOf(owned(it))) } +
                    root.each("preserved").map { it.obj() }.map {
                        ManagedVmText(ManagedVmKeys.PRESERVED, listOf(owned(it.member("instance")), reason(it.member("reason").matching(REASON))))
                    } +
                    root.each("errors").map { it.obj() }.map {
                        ManagedVmText(ManagedVmKeys.CLEANUP_ERROR, listOf(owned(it.member("instance")), refusal(it.member("code").matching(CODE))))
                    } + invalid
            )
        }
    }

    private fun outcome(notes: List<ManagedVmText>) =
        ManagedVmReport.Outcome(notes.ifEmpty { listOf(ManagedVmText(ManagedVmKeys.NOTHING_CHANGED)) })

    private fun invalidNote(count: Int) =
        if (count > 0) listOf(ManagedVmText(ManagedVmKeys.INVALID_RECORDS, listOf(count))) else emptyList()

    private fun fail(key: String = ManagedVmKeys.MALFORMED): Nothing = throw Refusal(key)
    private fun JsonObject.member(name: String): JsonElement = get(name) ?: fail()
    private fun JsonElement.obj(): JsonObject = this as? JsonObject ?: fail()
    private fun JsonElement.items(): JsonArray = this as? JsonArray ?: fail()
    private fun JsonElement.text(): String = (this as? JsonPrimitive)?.takeIf { it.isString }?.asString ?: fail()
    private fun JsonElement.matching(regex: Regex): String = text().takeIf(regex::matches) ?: fail()
    private fun JsonElement.oneOf(allowed: Set<String>): String = text().takeIf { it in allowed } ?: fail()
    private fun JsonElement?.isTrue(): Boolean = this is JsonPrimitive && isBoolean && asBoolean
    private fun JsonElement.count(): Int = (this as? JsonPrimitive)?.takeIf { it.isNumber }
        ?.let { runCatching { it.asBigDecimal.intValueExact() }.getOrNull() }?.takeIf { it >= 0 } ?: fail()
}
