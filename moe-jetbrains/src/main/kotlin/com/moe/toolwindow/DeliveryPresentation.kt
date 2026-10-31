package com.moe.toolwindow

import com.moe.model.TaskDelivery

enum class DeliveryOutcome { PASS, FAIL }

data class DeliveryRow(
    val labelKey: String,
    val value: String,
    val fullValue: String = value,
    val outcome: DeliveryOutcome? = null
)

object DeliveryPresentation {
    const val TITLE_KEY = "moe.delivery.title"
    fun rows(delivery: TaskDelivery?): List<DeliveryRow> {
        if (delivery == null) return emptyList()
        return buildList {
            val candidate = delivery.currentCandidate
            addValue("moe.delivery.candidateSha", candidate?.treeSha?.takeIf { it.isNotEmpty() } ?: candidate?.shortSha, sha = true)
            addValue("moe.delivery.candidateBase", candidate?.baseRevision, sha = true)
            val run = delivery.latestCheckRun
            val reported = run?.outcome
            addValue("moe.delivery.checkCommand", run?.command)
            // This is what the runner REPORTED, never proof the daemon executed a check.
            // Mirrors the daemon gate rule: only exit 0 with no outcome or exactly "passed" reads as passed.
            run?.exitCode?.let { code ->
                val passed = code == 0 && (reported.isNullOrEmpty() || reported == "passed")
                val key = when {
                    passed -> "moe.delivery.checkPassed"
                    code != 0 -> "moe.delivery.checkFailed"
                    else -> "moe.delivery.checkNotPassed"
                }
                add(DeliveryRow(key, code.toString(), outcome = if (passed) DeliveryOutcome.PASS else DeliveryOutcome.FAIL))
            }
            addValue("moe.delivery.checkOutcome", reported)
            addValue("moe.delivery.checkSource", run?.source)
            // The delivery policy's verdict, never inferred from the reported run above.
            when (delivery.requiredCheckSatisfied) {
                true -> add(DeliveryRow("moe.delivery.requiredCheckCounted", "yes", outcome = DeliveryOutcome.PASS))
                false -> add(DeliveryRow("moe.delivery.requiredCheckNotCounted", "no", outcome = DeliveryOutcome.FAIL))
                null -> Unit
            }
            addValue("moe.delivery.receiptTarget", delivery.deliveryReceipt?.target)
            addValue("moe.delivery.landedRevision", delivery.deliveryReceipt?.landedRevision, sha = true)
            addValue("moe.delivery.attemptPhase", delivery.attemptPhase)
        }
    }

    private fun MutableList<DeliveryRow>.addValue(key: String, value: String?, sha: Boolean = false) {
        if (value.isNullOrEmpty()) return
        add(DeliveryRow(key, if (sha) value.take(8) else value, value))
    }
}
