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
            addValue("moe.delivery.checkCommand", delivery.latestCheckRun?.command)
            // This is what the runner REPORTED, never proof the daemon executed a check.
            delivery.latestCheckRun?.exitCode?.let { code ->
                val outcome = if (code == 0) DeliveryOutcome.PASS else DeliveryOutcome.FAIL
                val key = if (outcome == DeliveryOutcome.PASS) "moe.delivery.checkPassed" else "moe.delivery.checkFailed"
                add(DeliveryRow(key, code.toString(), outcome = outcome))
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
