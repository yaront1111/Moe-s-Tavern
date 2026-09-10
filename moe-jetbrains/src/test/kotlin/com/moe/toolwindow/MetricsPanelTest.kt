package com.moe.toolwindow

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Guards the first-pass approval KPI unit. The daemon emits `firstPassApprovalPct`
 * already in percent units (0..100), so the panel must render it as-is.
 */
class MetricsPanelTest {
    @Test
    fun `no task approved first pass renders as zero percent`() {
        assertEquals("0%", MetricsPanel.firstPassApprovalText(0.0))
    }

    @Test
    fun `half of the tasks approved first pass renders as fifty percent`() {
        assertEquals("50%", MetricsPanel.firstPassApprovalText(50.0))
    }

    @Test
    fun `every task approved first pass renders as one hundred percent`() {
        assertEquals("100%", MetricsPanel.firstPassApprovalText(100.0))
    }

    @Test
    fun `a missing first-pass rate stays the em dash placeholder`() {
        // U+2014 EM DASH - the exact glyph MetricsPanel uses for every missing KPI.
        assertEquals("—", MetricsPanel.firstPassApprovalText(null))
    }
}
