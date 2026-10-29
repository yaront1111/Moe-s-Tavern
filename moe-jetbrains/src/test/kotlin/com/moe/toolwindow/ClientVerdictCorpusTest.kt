package com.moe.toolwindow

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.moe.toolwindow.PlanReviewApprovalState.Decision
import com.moe.toolwindow.PlanReviewApprovalState.Phase
import com.moe.toolwindow.PlanReviewApprovalState.TaskSnapshot
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import com.moe.toolwindow.ManagedVmKeys as K

/**
 * CQ-I06b: one client-neutral corpus, two consumers. moe-vscode's tests/plan-review.test.cjs and
 * tests/managed-vm-verdicts.test.cjs read these same bytes, so a row the clients disagree on fails in one of them.
 * A disagreement is fixed or filed, never given a client-specific expectation.
 *
 * Approval verdicts, after rendering AWAITING_APPROVAL at `rendered`, one click and the row's events:
 * - confirmed: success; pending: a later WORKING at `rendered` confirms;
 * - latched: Approve unusable, and a later WORKING at `rendered` still does not confirm;
 * - rearmed: AWAITING_APPROVAL at `rendered` makes Approve usable and the next click resends `rendered`.
 */
class ClientVerdictCorpusTest {
    private val corpus = loadCorpus()
    private val taskId = corpus.get("taskId").asString

    @Test
    fun `the corpus is complete with unique ids and only shared verdicts`() {
        val approval = corpus.getAsJsonArray("approval").map { it.asJsonObject }
        val vm = corpus.getAsJsonArray("vm").map { it.asJsonObject }
        val ids = (approval + vm).map { it.get("id").asString }
        assertEquals("duplicate ids", ids.size, ids.toSet().size)
        val misnamed = approval.map { it.get("id").asString }.filterNot { it.matches(Regex("A[0-9]{2}")) } +
            vm.map { it.get("id").asString }.filterNot { it.matches(Regex("V[0-9]{2}")) }
        assertEquals("misnamed ids", emptyList<String>(), misnamed)
        assertTrue("approval rows: ${approval.size}", approval.size >= 25)
        assertTrue("vm rows: ${vm.size}", vm.size >= 20)
        val unknown = approval.filter { it.get("verdict").asString !in APPROVAL_VERDICTS } +
            vm.filter { !VM_VERDICT.matches(it.get("verdict").asString) }
        assertEquals("unknown verdicts", emptyList<String>(), unknown.map { it.get("id").asString })
    }

    @Test
    fun `every approval row reaches its verdict`() = assertRows("approval", ::approvalMismatch)

    @Test
    fun `every vm row reaches its verdict`() = assertRows("vm", ::vmMismatch)

    /** Runs every row and fails once, naming each failing id, so one bad row never hides another. */
    private fun assertRows(section: String, mismatch: (JsonObject) -> String?) {
        val rows = corpus.getAsJsonArray(section).map { it.asJsonObject }
        assertTrue("$section rows are missing", rows.isNotEmpty())
        val failures = rows.mapNotNull { row ->
            val problem = try { mismatch(row) } catch (e: Exception) { "threw $e" }
            problem?.let { "${row.get("id").asString}: $it" }
        }
        assertEquals("$section rows that diverge", emptyList<String>(), failures)
    }

    private fun approvalMismatch(row: JsonObject): String? {
        val rendered = row.get("rendered").stringOrNull()
        val expected = row.get("verdict").asString
        val revision = rendered?.toLong() ?: PlanReviewApprovalState.LEGACY_EFFECTIVE_REVISION
        val approval = PlanReviewApprovalState(taskId)
        val awaiting = snapshot(PlanReviewApprovalState.STATUS_AWAITING_APPROVAL, rendered)
        approval.onRendered(awaiting)
        val send = Decision.Send(taskId, revision)
        approval.onApproveClicked(true, awaiting).let { if (it != send) return "first click gave $it" }
        row.getAsJsonArray("events").forEach { apply(approval, it.asJsonObject) }
        val observed = when (approval.currentPhase) {
            Phase.FINISHED -> "confirmed"
            Phase.PENDING -> "pending"
            Phase.INVALIDATED -> "latched"
            Phase.READY -> "rearmed"
            else -> "phase ${approval.currentPhase}"
        }
        if (observed != expected) return "expected $expected, got $observed"
        val working = snapshot(PlanReviewApprovalState.STATUS_WORKING, rendered)
        return when (expected) {
            "confirmed" -> null
            "pending" -> "WORKING probe did not confirm".takeUnless { approval.onStateUpdate(working); approval.currentPhase == Phase.FINISHED }
            "latched" -> when {
                approval.approveEnabled -> "Approve is usable"
                else -> "WORKING probe confirmed".takeIf { approval.onStateUpdate(working); approval.currentPhase == Phase.FINISHED }
            }
            else -> {
                approval.onStateUpdate(awaiting)
                if (!approval.approveEnabled) "AWAITING_APPROVAL probe left Approve unusable"
                else approval.onApproveClicked(true, awaiting).let { if (it == send) null else "probe click gave $it" }
            }
        }
    }

    private fun apply(approval: PlanReviewApprovalState, event: JsonObject) {
        val task = event.get("task")
        val error = event.get("error")?.asJsonObject
        when {
            task != null && task.isJsonNull -> approval.onStateUpdate(TaskSnapshot(false, null, PlanReviewApprovalState.tokenOf(null)))
            task != null -> task.asJsonObject.let { approval.onStateUpdate(snapshot(it.get("status").asString, it.get("planRevision")?.asString)) }
            error != null -> approval.onDaemonError(
                error.get("operation").stringOrNull(),
                when (val target = error.get("task").stringOrNull()) {
                    "self" -> taskId
                    "other" -> "task-other"
                    null -> null
                    else -> throw IllegalArgumentException("unknown error task $target")
                },
                error.get("codeName").stringOrNull()
            )
            event.get("connection")?.asString == "lost" -> approval.onConnectionLost()
            else -> throw IllegalArgumentException("unknown event $event")
        }
    }

    /** The dialog's path: a daemon task frame through MoeJson, then snapshotOf. Gson keeps the raw literal. */
    private fun snapshot(status: String, literal: String?): TaskSnapshot {
        val revision = literal?.let { ""","planRevision":$it""" } ?: ""
        val task = MoeJson.parseTask(JsonParser.parseString("""{"id":"$taskId","status":"$status"$revision}""").asJsonObject)
        return TaskSnapshot(true, task.status, PlanReviewApprovalState.tokenOf(task.planRevision))
    }

    private fun vmMismatch(row: JsonObject): String? {
        val command = ManagedVmCommand.valueOf(row.get("command").asString.uppercase())
        val stdout = row.get("oversize")?.let { "x".repeat(it.asInt) } ?: row.get("stdout").asString
        val report = ManagedVmPresentation.decode(command, stdout, row.get("exit").asInt, row.get("timedOut").asBoolean)
        val actions = ManagedVmPresentation.actions(report, row.get("running").asBoolean)
        val observed = listOf(
            verdictOf(report),
            READY_KEYS.zip(ManagedVmPresentation.readiness(report)) { key, text -> text.key == key },
            ManagedVmPresentation.rows(report).size,
            listOf(actions.refresh, actions.reconcile, actions.cleanup),
            ManagedVmPresentation.strongProfile(report) == ManagedVmText(K.STRONG_PROFILE_BLOCKED)
        )
        val expected = listOf(row.get("verdict").asString, row.booleans("readiness"), row.get("rows").asInt, row.booleans("actions"), true)
        return if (observed == expected) null else "expected $expected, got $observed"
    }

    private fun verdictOf(report: ManagedVmReport): String = when (report) {
        is ManagedVmReport.Status -> "status"
        is ManagedVmReport.Outcome -> "report"
        is ManagedVmReport.Refused -> "refused:${report.code}"
        is ManagedVmReport.Unreadable -> "unreadable:${UNREADABLE[report.key] ?: report.key}"
    }

    private fun JsonObject.booleans(name: String) = getAsJsonArray(name).map { it.asBoolean }
    private fun JsonElement?.stringOrNull(): String? = this?.takeUnless { it.isJsonNull }?.asString

    private fun loadCorpus(): JsonObject {
        val stream = javaClass.getResourceAsStream(RESOURCE) ?: throw AssertionError("$RESOURCE is missing from the test classpath")
        return try {
            stream.reader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonObject }
        } catch (e: Exception) {
            throw AssertionError("$RESOURCE is unreadable: $e", e)
        }
    }

    private companion object {
        const val RESOURCE = "/client-verdicts.json"
        val APPROVAL_VERDICTS = setOf("confirmed", "pending", "latched", "rearmed")
        val VM_VERDICT = Regex("status|report|refused:[A-Z][A-Z0-9_]*|unreadable:(malformed|not-owned|too-large|failed|timed-out)")
        val READY_KEYS = listOf(K.PROVIDER_READY, K.EXECUTION_READY, K.VERIFIED)
        val UNREADABLE = mapOf(K.MALFORMED to "malformed", K.NOT_OWNED to "not-owned", K.TOO_LARGE to "too-large",
            K.FAILED to "failed", K.TIMED_OUT to "timed-out")
    }
}
