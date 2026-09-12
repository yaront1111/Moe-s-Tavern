package com.moe.toolwindow

import com.google.gson.JsonParser
import com.moe.model.Task
import com.moe.toolwindow.TaskDetailDialog.KpiRow
import com.moe.toolwindow.TaskDetailDialog.MetricsPresentation
import com.moe.toolwindow.board.TaskCard
import com.moe.toolwindow.board.TaskCard.ElapsedPresentation
import com.moe.util.MoeJson
import java.time.Instant
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the retirement of the deprecated task time budget from the JetBrains
 * board card and detail dialog while keeping the live elapsed wall-clock
 * presentation.
 *
 * Every fixture is built from raw legacy task JSON through [MoeJson.parseTask]
 * (never a `TaskBudget` constructor) so these assertions survive the later
 * removal of the compatibility model/parser fields, and every derived time is
 * computed against the fixed [NOW] rather than the wall clock.
 */
class TaskTimingPresentationTest {

    private companion object {
        const val FIRST_CLAIM = "2026-09-11T10:00:00Z"
        val NOW: Instant = Instant.parse("2026-09-11T10:10:00Z")
        const val REMAINING_KEY = "moe.metrics.budgetRemaining"

        /** Every legacy `budget` JSON shape the daemon ever persisted, plus the malformed ones. */
        val BUDGET_VARIANTS = listOf(
            "\"budget\":null",
            "\"budget\":{}",
            "\"budget\":7",
            "\"budget\":\"5m\"",
            "\"budget\":[]",
            "\"budget\":{\"wallClockMs\":0}",
            "\"budget\":{\"wallClockMs\":-1}",
            "\"budget\":{\"wallClockMs\":1000}",
            "\"budget\":{\"wallClockMs\":600000}",
            "\"budget\":{\"wallClockMs\":99999999999}",
            "\"budget\":{\"wallClockMs\":1000,\"warnedAt\":\"2026-09-11T10:05:00Z\"," +
                "\"escalatedAt\":\"2026-09-11T10:07:00Z\"}"
        )
    }

    private fun task(vararg fields: String): Task {
        val json = (listOf(
            "\"id\":\"task-abc1\"",
            "\"epicId\":\"epic-1\"",
            "\"title\":\"A task\"",
            "\"description\":\"\"",
            "\"status\":\"WORKING\"",
            "\"order\":1.0",
            "\"definitionOfDone\":[]",
            "\"implementationPlan\":[]"
        ) + fields.filter { it.isNotBlank() }).joinToString(",", "{", "}")
        return MoeJson.parseTask(JsonParser.parseString(json).asJsonObject)
    }

    private fun card(task: Task): ElapsedPresentation? = TaskCard.elapsedPresentation(task, NOW)

    private fun detail(task: Task): MetricsPresentation? = TaskDetailDialog.metricsPresentation(task, NOW)

    private fun kpi(task: Task, labelKey: String): String? =
        detail(task)?.kpis?.firstOrNull { it.labelKey == labelKey }?.value

    // ---------------------------------------------------------------- card badge

    @Test
    fun `card falls back to the supplied now when there is no done timestamp`() {
        val presentation = card(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\"}"))
        assertEquals(
            ElapsedPresentation("10m", "Elapsed: started $FIRST_CLAIM, used 10m", 0x6B7280, 0xA7ABB1),
            presentation
        )
    }

    @Test
    fun `card prefers the recorded wall clock over the timestamp interval`() {
        val presentation = card(
            task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"wallClockMs\":120000}")
        )
        assertEquals("2m", presentation?.label)
        assertEquals("Elapsed: started $FIRST_CLAIM, used 2m", presentation?.tooltip)
    }

    @Test
    fun `card stops the clock at a valid done timestamp`() {
        val presentation = card(
            task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"2026-09-11T10:05:00Z\"}")
        )
        assertEquals("5m", presentation?.label)
    }

    @Test
    fun `card falls back to now when the done timestamp is malformed or missing`() {
        assertEquals(
            "10m",
            card(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"not-a-date\"}"))?.label
        )
        assertEquals(
            "10m",
            card(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"\"}"))?.label
        )
    }

    @Test
    fun `card clamps a future first claim and a done before the first claim to zero`() {
        assertEquals("0s", card(task("\"metrics\":{\"firstClaimAt\":\"2026-09-11T10:20:00Z\"}"))?.label)
        assertEquals(
            "0s",
            card(
                task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"2026-09-11T09:00:00Z\"}")
            )?.label
        )
    }

    @Test
    fun `card formats a nonpositive recorded duration as zero seconds`() {
        assertEquals(
            "0s",
            card(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"wallClockMs\":0}"))?.label
        )
        assertEquals(
            "0s",
            card(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"wallClockMs\":-5}"))?.label
        )
    }

    @Test
    fun `card needs a valid first claim even when a wall clock is recorded`() {
        assertNull(card(task()))
        assertNull(card(task("\"metrics\":{\"wallClockMs\":120000}")))
        assertNull(card(task("\"metrics\":{\"firstClaimAt\":null,\"wallClockMs\":120000}")))
        assertNull(card(task("\"metrics\":{\"firstClaimAt\":\"\",\"wallClockMs\":120000}")))
        assertNull(card(task("\"metrics\":{\"firstClaimAt\":\"   \",\"wallClockMs\":120000}")))
        assertNull(card(task("\"metrics\":{\"firstClaimAt\":\"11/09/2026\",\"wallClockMs\":120000}")))
    }

    @Test
    fun `a legacy budget never changes the card presentation`() {
        val metrics = "\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\"}"
        val expected = card(task(metrics))
        assertNotNull(expected)
        for (budget in BUDGET_VARIANTS) {
            assertEquals("budget variant $budget changed the card", expected, card(task(metrics, budget)))
        }
    }

    @Test
    fun `a budget only task renders neither a card badge nor a metrics section`() {
        for (budget in BUDGET_VARIANTS) {
            val budgetOnly = task(budget)
            assertNull("budget variant $budget rendered a card badge", card(budgetOnly))
            assertNull("budget variant $budget rendered a metrics section", detail(budgetOnly))
        }
    }

    // ------------------------------------------------------------- detail metrics

    @Test
    fun `a legacy budget never changes the detail presentation`() {
        val rich = arrayOf(
            "\"metrics\":{\"plannedStepCount\":4,\"executedStepCount\":3," +
                "\"plannedDistinctFileCount\":5,\"firstClaimAt\":\"$FIRST_CLAIM\"," +
                "\"reopenCount\":1,\"rejectCount\":2}",
            "\"planSizeWarnings\":[\"9 steps\"]",
            "\"reviewSummary\":\"ran the gate\"",
            "\"verification\":{\"command\":\"gradlew test\",\"exitCode\":0}",
            "\"failedDodItems\":[{\"item\":\"tests\"}]",
            "\"priorHandoffs\":[{\"from\":\"w1\",\"to\":\"w2\"}]",
            "\"planCritiqueResult\":{\"verdict\":\"pass\",\"concerns\":[\"tight\"]}"
        )
        val expected = detail(task(*rich))
        assertNotNull(expected)
        for (budget in BUDGET_VARIANTS) {
            assertEquals(
                "budget variant $budget changed the detail model",
                expected,
                detail(task(*rich, budget))
            )
        }
    }

    @Test
    fun `no KPI uses the retired remaining key and the bundle no longer defines it`() {
        for (budget in BUDGET_VARIANTS) {
            val kpis = detail(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\"}", budget))?.kpis.orEmpty()
            assertTrue(
                "budget variant $budget still produced a $REMAINING_KEY KPI",
                kpis.none { it.labelKey == REMAINING_KEY }
            )
        }
        val bundle = Properties()
        val stream = checkNotNull(javaClass.getResourceAsStream("/messages/MoeBundle.properties")) {
            "MoeBundle.properties is not on the test classpath"
        }
        stream.use { bundle.load(it) }
        assertNull("$REMAINING_KEY is still defined in MoeBundle.properties", bundle.getProperty(REMAINING_KEY))
        assertEquals("Wall-clock", bundle.getProperty("moe.metrics.wallClock"))
    }

    @Test
    fun `detail renders a recorded wall clock even without a first claim`() {
        assertEquals("2m", kpi(task("\"metrics\":{\"wallClockMs\":120000}"), "moe.metrics.wallClock"))
        assertEquals("0s", kpi(task("\"metrics\":{\"wallClockMs\":0}"), "moe.metrics.wallClock"))
    }

    @Test
    fun `detail derives wall clock from the timestamps against the supplied now`() {
        assertEquals(
            "10m",
            kpi(task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\"}"), "moe.metrics.wallClock")
        )
        assertEquals(
            "5m",
            kpi(
                task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"2026-09-11T10:05:00Z\"}"),
                "moe.metrics.wallClock"
            )
        )
        assertEquals(
            "10m",
            kpi(
                task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"nope\"}"),
                "moe.metrics.wallClock"
            )
        )
        assertEquals(
            "0s",
            kpi(task("\"metrics\":{\"firstClaimAt\":\"2026-09-11T10:20:00Z\"}"), "moe.metrics.wallClock")
        )
        assertNull(kpi(task("\"metrics\":{\"reopenCount\":0}"), "moe.metrics.wallClock"))
        assertNull(kpi(task("\"metrics\":{\"firstClaimAt\":\"broken\"}"), "moe.metrics.wallClock"))
    }

    @Test
    fun `detail keeps the step file reopen and reject KPIs in order`() {
        val full = task(
            "\"metrics\":{\"plannedStepCount\":4,\"executedStepCount\":3,\"plannedDistinctFileCount\":5," +
                "\"wallClockMs\":120000,\"reopenCount\":1,\"rejectCount\":2}"
        )
        assertEquals(
            listOf(
                KpiRow("moe.metrics.steps", "3 / 4"),
                KpiRow("moe.metrics.files", "5"),
                KpiRow("moe.metrics.wallClock", "2m"),
                KpiRow("moe.metrics.reopen", "1"),
                KpiRow("moe.metrics.reject", "2")
            ),
            detail(full)?.kpis
        )
        assertEquals("- / 4", kpi(task("\"metrics\":{\"plannedStepCount\":4}"), "moe.metrics.steps"))
        assertEquals("3 / -", kpi(task("\"metrics\":{\"executedStepCount\":3}"), "moe.metrics.steps"))
        assertNull(kpi(task("\"metrics\":{\"rejectCount\":0}"), "moe.metrics.steps"))
    }

    @Test
    fun `detail keeps explicit zero and task level reopen fallbacks`() {
        assertEquals("0", kpi(task("\"metrics\":{\"reopenCount\":0}"), "moe.metrics.reopen"))
        assertEquals("0", kpi(task("\"metrics\":{\"rejectCount\":0}"), "moe.metrics.reject"))
        assertEquals(
            "2",
            kpi(task("\"metrics\":{\"wallClockMs\":1000}", "\"reopenCount\":2"), "moe.metrics.reopen")
        )
        assertNull(kpi(task("\"metrics\":{\"wallClockMs\":1000}"), "moe.metrics.reopen"))
        assertNull(kpi(task("\"metrics\":{\"wallClockMs\":1000}"), "moe.metrics.reject"))
    }

    @Test
    fun `each supplemental item on its own still yields a populated section`() {
        val critique = detail(
            task("\"planCritiqueResult\":{\"verdict\":\"block\",\"concerns\":[\"too big\",\"no tests\"]," +
                "\"reviewedBy\":\"gov\",\"reviewedAt\":\"2026-09-11T09:00:00Z\"}")
        )
        assertEquals(emptyList<KpiRow>(), critique?.kpis)
        assertEquals(true, critique?.critique?.isBlock)
        assertEquals("BLOCK", critique?.critique?.verdictLabel)
        assertEquals(listOf("• too big", "• no tests"), critique?.critique?.concernLines)
        assertEquals("gov  2026-09-11T09:00:00Z", critique?.critique?.reviewerFooter)

        assertEquals(
            listOf("• 9 steps", "• 11 files"),
            detail(task("\"planSizeWarnings\":[\"9 steps\",\"11 files\"]"))?.sizeWarningLines
        )
        assertEquals(
            "$ gradlew test (exit 0)  @ 2026-09-11T10:09:00\nBUILD SUCCESSFUL",
            detail(
                task("\"verification\":{\"command\":\"gradlew test\",\"exitCode\":0," +
                    "\"reportedAt\":\"2026-09-11T10:09:00Z\",\"outputTail\":\"BUILD SUCCESSFUL\"}")
            )?.verificationBody
        )
        assertEquals("ran the gate", detail(task("\"reviewSummary\":\"ran the gate\""))?.reviewSummary)
        assertEquals(
            listOf("• tests missing"),
            detail(task("\"failedDodItems\":[{\"item\":\"tests missing\"}]"))?.failedDodLines
        )
        val handoff = detail(
            task("\"priorHandoffs\":[{\"from\":\"w1\",\"to\":\"w2\",\"createdAt\":\"2026-09-11T09:30:00Z\"," +
                "\"whatIsDone\":\"parser\",\"whatRemains\":\"ui\",\"pitfalls\":\"caches\"," +
                "\"openQuestions\":\"none\"}]")
        )?.handoffs?.single()
        assertEquals("#1 from w1 → w2  (2026-09-11T09:30:00Z)", handoff?.header)
        assertEquals("parser", handoff?.whatIsDone)
        assertEquals("ui", handoff?.whatRemains)
        assertEquals("caches", handoff?.pitfalls)
        assertEquals("none", handoff?.openQuestions)
    }

    @Test
    fun `a blank review summary alone does not open a section`() {
        assertNull(detail(task("\"reviewSummary\":\"   \"")))
        assertNull(detail(task("\"priorHandoffs\":[]", "\"failedDodItems\":[]", "\"planSizeWarnings\":[]")))
    }

    @Test
    fun `duplicate failed DoD items are grouped with counts in first seen order`() {
        val lines = detail(
            task("\"failedDodItems\":[{\"item\":\"tests\"},{\"item\":\"docs\"},{\"item\":\"tests\"}]")
        )?.failedDodLines
        assertEquals(listOf("• tests  (2 failures)", "• docs"), lines)
    }

    @Test
    fun `handoffs keep their supplied order and number from one`() {
        val headers = detail(
            task("\"priorHandoffs\":[{\"from\":\"a\"},{\"to\":\"b\"},{\"createdAt\":\"ts\"},{}]")
        )?.handoffs?.map { it.header }
        assertEquals(listOf("#1 from a", "#2 → b", "#3  (ts)", "#4"), headers)
    }

    @Test
    fun `a fully populated task keeps every supplement alongside the KPIs`() {
        val presentation = detail(
            task(
                "\"metrics\":{\"plannedStepCount\":2,\"executedStepCount\":2,\"wallClockMs\":60000}",
                "\"planCritiqueResult\":{\"verdict\":\"pass\"}",
                "\"planSizeWarnings\":[\"9 steps\"]",
                "\"verification\":{\"command\":\"gradlew test\"}",
                "\"reviewSummary\":\"checked\"",
                "\"failedDodItems\":[{\"item\":\"tests\"}]",
                "\"priorHandoffs\":[{\"from\":\"w1\"}]",
                "\"budget\":{\"wallClockMs\":1000,\"warnedAt\":\"2026-09-11T10:05:00Z\"}"
            )
        )
        assertEquals(
            listOf(KpiRow("moe.metrics.steps", "2 / 2"), KpiRow("moe.metrics.wallClock", "1m")),
            presentation?.kpis
        )
        assertEquals("PASS", presentation?.critique?.verdictLabel)
        assertNull(presentation?.critique?.reviewerFooter)
        assertEquals(listOf("• 9 steps"), presentation?.sizeWarningLines)
        assertEquals("$ gradlew test", presentation?.verificationBody)
        assertEquals("checked", presentation?.reviewSummary)
        assertEquals(listOf("• tests"), presentation?.failedDodLines)
        assertEquals(listOf("#1 from w1"), presentation?.handoffs?.map { it.header })
    }

    @Test
    fun `malformed and missing timestamps never throw on either surface`() {
        for (metrics in listOf(
            "\"metrics\":{}",
            "\"metrics\":null",
            "\"metrics\":{\"firstClaimAt\":\"2026-13-45T99:99:99Z\",\"doneAt\":\"\"}",
            "\"metrics\":{\"firstClaimAt\":7,\"doneAt\":false}",
            "\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"doneAt\":\"2026-09-11T10:20:00Z\"}"
        )) {
            card(task(metrics))
            detail(task(metrics))
        }
    }

    @Test
    fun `repeated and interleaved renders are stable`() {
        val a = task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\"}", "\"budget\":{\"wallClockMs\":1000}")
        val b = task("\"metrics\":{\"firstClaimAt\":\"$FIRST_CLAIM\",\"wallClockMs\":300000}")
        assertEquals(card(a), card(a))
        assertEquals("5m", card(b)?.label)
        assertEquals("10m", card(a)?.label)
        assertEquals(detail(b), detail(b))
    }
}
