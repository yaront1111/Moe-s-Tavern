package com.moe.toolwindow

import com.moe.model.DeliveryCandidate
import com.moe.model.DeliveryCheckRun
import com.moe.model.DeliveryReceipt
import com.moe.model.TaskDelivery
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeliveryPresentationTest {
    private val sha = "Ab".repeat(20)
    private val base = "Cd".repeat(20)
    private val landed = "Ef".repeat(20)
    private val expected = listOf(
        DeliveryRow("moe.delivery.candidateSha", "AbAbAbAb", sha),
        DeliveryRow("moe.delivery.candidateBase", "CdCdCdCd", base),
        DeliveryRow("moe.delivery.checkCommand", " npm.cmd test "),
        DeliveryRow("moe.delivery.checkPassed", "0", outcome = DeliveryOutcome.PASS),
        DeliveryRow("moe.delivery.receiptTarget", "refs/heads/Pilot"),
        DeliveryRow("moe.delivery.landedRevision", "EfEfEfEf", landed),
        DeliveryRow("moe.delivery.attemptPhase", "finalizing")
    )

    private fun evidence(mask: Int = 127) = TaskDelivery(
        currentCandidate = DeliveryCandidate(
            treeSha = sha.takeIf { mask and 1 != 0 }, baseRevision = base.takeIf { mask and 2 != 0 }
        ),
        latestCheckRun = DeliveryCheckRun(" npm.cmd test ".takeIf { mask and 4 != 0 }, 0.takeIf { mask and 8 != 0 }),
        deliveryReceipt = DeliveryReceipt("refs/heads/Pilot".takeIf { mask and 16 != 0 }, landed.takeIf { mask and 32 != 0 }),
        attemptPhase = "finalizing".takeIf { mask and 64 != 0 }
    )

    @Test
    fun `all delivery rows render in contract order`() {
        assertEquals(expected, DeliveryPresentation.rows(evidence()))
    }

    @Test
    fun `every partial combination shows only its present rows`() {
        for (mask in 0..127) {
            assertEquals("mask $mask", expected.filterIndexed { i, _ -> mask and (1 shl i) != 0 },
                DeliveryPresentation.rows(evidence(mask)))
        }
    }

    @Test
    fun `legacy null and empty evidence render nothing exactly as before`() {
        for (input in listOf(null, TaskDelivery(), evidence(0), TaskDelivery(
            DeliveryCandidate(treeSha = "", baseRevision = ""), DeliveryCheckRun(command = ""),
            DeliveryReceipt("", ""), ""
        ))) assertEquals(emptyList<DeliveryRow>(), DeliveryPresentation.rows(input))
    }

    @Test
    fun `zero passes and every signed nonzero exit code fails`() {
        for (code in listOf(0, -1, 1, Int.MIN_VALUE, Int.MAX_VALUE)) {
            val outcome = if (code == 0) DeliveryOutcome.PASS else DeliveryOutcome.FAIL
            val key = if (code == 0) "moe.delivery.checkPassed" else "moe.delivery.checkFailed"
            assertEquals(listOf(DeliveryRow(key, code.toString(), outcome = outcome)),
                DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun(exitCode = code))))
        }
    }

    @Test
    fun `sha abbreviation retains full exact value and accepts short-only payloads`() {
        assertEquals(listOf(DeliveryRow("moe.delivery.candidateSha", "AbAbAbAb", sha)),
            DeliveryPresentation.rows(TaskDelivery(currentCandidate = DeliveryCandidate(treeSha = sha, shortSha = "wrong"))))
        assertEquals(listOf(DeliveryRow("moe.delivery.candidateSha", "aBc123")),
            DeliveryPresentation.rows(TaskDelivery(currentCandidate = DeliveryCandidate(shortSha = "aBc123"))))
    }

    @Test
    fun `reported text is never trimmed or interpreted as markup`() {
        val command = " <html> npm test\n  "
        assertEquals(listOf(DeliveryRow("moe.delivery.checkCommand", command)),
            DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun(command = command))))
    }

    @Test
    fun `a reported pass the policy does not count never reads as a counted required check`() {
        for ((command, source) in listOf("node gate.cjs" to "agent-reported", "node lint.cjs" to "runner-observed")) {
            assertEquals(
                listOf(
                    DeliveryRow("moe.delivery.checkCommand", command),
                    DeliveryRow("moe.delivery.checkPassed", "0", outcome = DeliveryOutcome.PASS),
                    DeliveryRow("moe.delivery.checkSource", source),
                    DeliveryRow("moe.delivery.requiredCheckNotCounted", "no", outcome = DeliveryOutcome.FAIL)
                ),
                DeliveryPresentation.rows(
                    TaskDelivery(latestCheckRun = DeliveryCheckRun(command, 0, source), requiredCheckSatisfied = false)
                )
            )
        }
    }

    @Test
    fun `a counted gate pass reads as counted, and a null verdict adds no policy row`() {
        val gate = DeliveryCheckRun("node gate.cjs", 0, "runner-observed")
        val reported = listOf(
            DeliveryRow("moe.delivery.checkCommand", "node gate.cjs"),
            DeliveryRow("moe.delivery.checkPassed", "0", outcome = DeliveryOutcome.PASS),
            DeliveryRow("moe.delivery.checkSource", "runner-observed")
        )
        val counted = DeliveryRow("moe.delivery.requiredCheckCounted", "yes", outcome = DeliveryOutcome.PASS)
        assertEquals(reported + counted, DeliveryPresentation.rows(TaskDelivery(latestCheckRun = gate, requiredCheckSatisfied = true)))
        assertEquals(reported, DeliveryPresentation.rows(TaskDelivery(latestCheckRun = gate)))
        // The gate passed earlier; the LAST run is a failing non-gate one. Both truths show.
        assertEquals(
            listOf(
                DeliveryRow("moe.delivery.checkCommand", "node lint.cjs"),
                DeliveryRow("moe.delivery.checkFailed", "1", outcome = DeliveryOutcome.FAIL),
                DeliveryRow("moe.delivery.checkSource", "runner-observed"),
                counted
            ),
            DeliveryPresentation.rows(
                TaskDelivery(latestCheckRun = DeliveryCheckRun("node lint.cjs", 1, "runner-observed"), requiredCheckSatisfied = true)
            )
        )
    }

    private fun gateRows(code: Int, outcome: String?) =
        DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun("node gate.cjs", code, "runner-observed", outcome)))

    private fun gateExpected(verdict: DeliveryRow, outcome: String) = listOf(
        DeliveryRow("moe.delivery.checkCommand", "node gate.cjs"),
        verdict,
        DeliveryRow("moe.delivery.checkOutcome", outcome),
        DeliveryRow("moe.delivery.checkSource", "runner-observed")
    )

    @Test
    fun `an exit 0 run whose recorded outcome is not passed never renders as passed`() {
        val notPassed = DeliveryRow("moe.delivery.checkNotPassed", "0", outcome = DeliveryOutcome.FAIL)
        for (outcome in listOf("timeout", "infra-failure", "skipped", "inconclusive", "code-failure", "cancelled", "Passed", " passed")) {
            val rows = gateRows(0, outcome)
            assertEquals("outcome '$outcome'", gateExpected(notPassed, outcome), rows)
            assertTrue("outcome '$outcome'", rows.none { it.labelKey == "moe.delivery.checkPassed" || it.outcome == DeliveryOutcome.PASS })
        }
    }

    @Test
    fun `an exit 0 run recorded as passed renders as passed with its outcome`() {
        val passed = DeliveryRow("moe.delivery.checkPassed", "0", outcome = DeliveryOutcome.PASS)
        assertEquals(gateExpected(passed, "passed"), gateRows(0, "passed"))
    }

    @Test
    fun `a nonzero exit renders as failed whatever the recorded outcome`() {
        for (code in listOf(1, -9)) for (outcome in listOf(null, "passed", "timeout", "code-failure")) {
            assertEquals(
                "exit $code outcome $outcome",
                listOfNotNull(
                    DeliveryRow("moe.delivery.checkFailed", code.toString(), outcome = DeliveryOutcome.FAIL),
                    outcome?.let { DeliveryRow("moe.delivery.checkOutcome", it) }
                ),
                DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun(exitCode = code, outcome = outcome)))
            )
        }
    }

    @Test
    fun `a run without a recorded outcome keeps the exit code rendering`() {
        for (outcome in listOf(null, "")) {
            assertEquals(
                "outcome '$outcome'",
                listOf(DeliveryRow("moe.delivery.checkPassed", "0", outcome = DeliveryOutcome.PASS)),
                DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun(exitCode = 0, outcome = outcome)))
            )
        }
    }

    @Test
    fun `an outcome without an exit code renders only the outcome row`() {
        assertEquals(
            listOf(DeliveryRow("moe.delivery.checkOutcome", "timeout")),
            DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun(outcome = "timeout")))
        )
    }

    @Test
    fun `every emitted bundle key has a translation`() {
        val properties = Properties()
        requireNotNull(javaClass.classLoader.getResourceAsStream("messages/MoeBundle.properties")).use(properties::load)
        val keys = (DeliveryPresentation.rows(evidence()) + DeliveryPresentation.rows(
            TaskDelivery(latestCheckRun = DeliveryCheckRun(exitCode = 1, source = "agent-reported"), requiredCheckSatisfied = false)
        ) + DeliveryPresentation.rows(TaskDelivery(requiredCheckSatisfied = true)) +
            DeliveryPresentation.rows(TaskDelivery(latestCheckRun = DeliveryCheckRun(exitCode = 0, outcome = "timeout"))))
            .map { it.labelKey } + DeliveryPresentation.TITLE_KEY
        assertEquals(14, keys.toSet().size)
        for (key in keys) assertTrue("Missing $key", !properties.getProperty(key).isNullOrEmpty())
    }
}
