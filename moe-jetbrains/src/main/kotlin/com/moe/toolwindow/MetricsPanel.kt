package com.moe.toolwindow

import com.moe.model.ActivityEvent
import com.moe.model.ChatMessage
import com.moe.model.Decision
import com.moe.model.MetricsAggregate
import com.moe.model.MoeState
import com.moe.model.PinEntry
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.BoardStyles
import com.moe.util.MoeBundle
import com.moe.util.MoeDuration
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.Alarm
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridLayout
import java.time.Instant
import java.time.temporal.ChronoUnit
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTable
import javax.swing.SwingUtilities
import javax.swing.table.DefaultTableModel

/**
 * Metrics tool-window tab. Calls `requestMetrics` on the daemon every 30s
 * while the tab is visible and renders headline KPIs + a per-epic breakdown
 * table. Render is intentionally simple — tables only, no charts.
 */
class MetricsPanel(private val project: Project) :
    JBPanel<MetricsPanel>(BorderLayout()), Disposable {

    private val service = project.service<MoeProjectService>()
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val refreshIntervalMs = 30_000

    private val firstPassValue = makeKpiValue()
    private val avgWallClockValue = makeKpiValue()
    private val avgReopenValue = makeKpiValue()
    private val totalCompletedValue = makeKpiValue()
    private val lastUpdatedLabel = JBLabel("").apply {
        foreground = BoardStyles.textSecondary
        font = JBUI.Fonts.smallFont()
    }
    private val emptyStateLabel = JBLabel(MoeBundle.message("moe.metrics.empty")).apply {
        foreground = BoardStyles.textSecondary
        border = JBUI.Borders.empty(8)
    }

    private val perEpicModel = object : DefaultTableModel() {
        override fun isCellEditable(row: Int, column: Int): Boolean = false
    }.apply {
        setColumnIdentifiers(arrayOf<Any>(
            MoeBundle.message("moe.metrics.col.epic"),
            MoeBundle.message("moe.metrics.col.completed"),
            MoeBundle.message("moe.metrics.col.avgReopen"),
            MoeBundle.message("moe.metrics.col.avgWallClock")
        ))
    }
    private val perEpicTable = JTable(perEpicModel).apply {
        rowHeight = 22
        autoCreateRowSorter = true
        fillsViewportHeight = true
    }

    private var rangeDays: Int? = 30
    private val stateListener: MoeStateListener
    @Volatile private var disposed = false
    @Volatile private var visibleTab = false
    private var lastAggregate: MetricsAggregate? = null

    init {
        background = BoardStyles.boardBackground
        isOpaque = true

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 6, 4)).apply {
            isOpaque = false
            border = JBUI.Borders.empty(6, 12, 0, 12)
        }
        toolbar.add(JBLabel(MoeBundle.message("moe.metrics.rangeLabel")))
        toolbar.add(rangeChip(MoeBundle.message("moe.metrics.range.7d"), 7))
        toolbar.add(rangeChip(MoeBundle.message("moe.metrics.range.30d"), 30))
        toolbar.add(rangeChip(MoeBundle.message("moe.metrics.range.all"), null))
        toolbar.add(lastUpdatedLabel)

        val kpiBar = JPanel(GridLayout(1, 4, 8, 0)).apply {
            isOpaque = false
            border = JBUI.Borders.empty(8, 12, 4, 12)
        }
        kpiBar.add(kpiCard(MoeBundle.message("moe.metrics.kpi.firstPass"), firstPassValue))
        kpiBar.add(kpiCard(MoeBundle.message("moe.metrics.kpi.avgWallClock"), avgWallClockValue))
        kpiBar.add(kpiCard(MoeBundle.message("moe.metrics.kpi.avgReopen"), avgReopenValue))
        kpiBar.add(kpiCard(MoeBundle.message("moe.metrics.kpi.totalCompleted"), totalCompletedValue))

        val top = JPanel(BorderLayout()).apply {
            isOpaque = false
        }
        top.add(toolbar, BorderLayout.NORTH)
        top.add(kpiBar, BorderLayout.SOUTH)
        add(top, BorderLayout.NORTH)

        val perEpicWrap = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(6, 12, 12, 12)
        }
        perEpicWrap.add(JBLabel(MoeBundle.message("moe.metrics.perEpic")).apply {
            font = font.deriveFont(Font.BOLD)
            border = JBUI.Borders.emptyBottom(4)
        }, BorderLayout.NORTH)
        val tableScroll = JBScrollPane(perEpicTable).apply {
            preferredSize = Dimension(600, 200)
            border = JBUI.Borders.customLine(BoardStyles.borderColor)
        }
        perEpicWrap.add(tableScroll, BorderLayout.CENTER)

        val centerStack = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(perEpicWrap, BorderLayout.CENTER)
            add(emptyStateLabel, BorderLayout.SOUTH)
        }
        emptyStateLabel.isVisible = true
        add(JBScrollPane(centerStack).apply {
            border = JBUI.Borders.empty()
            viewport.background = BoardStyles.boardBackground
        }, BorderLayout.CENTER)

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {}
            override fun onStatus(connected: Boolean, message: String) {
                if (connected) requestRefresh()
            }
            override fun onError(operation: String, message: String) {}
            override fun onActivityLog(events: List<ActivityEvent>) {}
            override fun onChatMessage(message: ChatMessage) {}
            override fun onChatMessages(channel: String, messages: List<ChatMessage>) {}
            override fun onPins(channel: String, pins: List<PinEntry>) {}
            override fun onPinCreated(channel: String, pin: PinEntry) {}
            override fun onPinRemoved(channel: String, messageId: String) {}
            override fun onPinToggled(channel: String, pin: PinEntry) {}
            override fun onDecisions(decisions: List<Decision>) {}
            override fun onDecisionProposed(decision: Decision) {}
            override fun onDecisionResolved(decision: Decision) {}
            override fun onMetrics(aggregate: MetricsAggregate) {
                if (disposed) return
                SwingUtilities.invokeLater { renderAggregate(aggregate) }
            }
        }
        service.addListener(stateListener)
    }

    /**
     * Called by the parent tabbed pane when this tab becomes visible.
     * Starts polling; stops when not visible to avoid daemon chatter.
     */
    fun setTabVisible(visible: Boolean) {
        visibleTab = visible
        if (visible) {
            requestRefresh()
            schedulePoll()
        } else {
            alarm.cancelAllRequests()
        }
    }

    private fun schedulePoll() {
        if (disposed || !visibleTab) return
        alarm.cancelAllRequests()
        alarm.addRequest({
            if (disposed || !visibleTab) return@addRequest
            requestRefresh()
            schedulePoll()
        }, refreshIntervalMs)
    }

    private fun requestRefresh() {
        if (disposed) return
        // Translate the range into an ISO-8601 sinceIso the daemon can filter on.
        val sinceIso = rangeDays?.let {
            Instant.now().minus(it.toLong(), ChronoUnit.DAYS).toString()
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                service.requestMetrics(epicId = null, sinceIso = sinceIso, limit = null)
            } catch (_: Exception) {
                // Network errors are surfaced via onError; swallow here to keep the UI alive.
            }
        }
    }

    private fun renderAggregate(aggregate: MetricsAggregate) {
        lastAggregate = aggregate
        val hasAny = aggregate.totalCompleted != null
            || aggregate.firstPassApprovalPct != null
            || aggregate.avgReopenCount != null
            || aggregate.avgWallClockMs != null
            || aggregate.perEpic.isNotEmpty()
        emptyStateLabel.isVisible = !hasAny

        firstPassValue.text = aggregate.firstPassApprovalPct?.let { "%.0f%%".format(it * 100.0) } ?: "—"
        avgWallClockValue.text = MoeDuration.humanise(aggregate.avgWallClockMs)
        avgReopenValue.text = aggregate.avgReopenCount?.let { "%.1f".format(it) } ?: "—"
        totalCompletedValue.text = aggregate.totalCompleted?.toString() ?: "—"

        perEpicModel.setRowCount(0)
        for (row in aggregate.perEpic) {
            perEpicModel.addRow(arrayOf<Any?>(
                row.epicTitle ?: row.epicId,
                row.completed,
                row.avgReopenCount?.let { "%.1f".format(it) } ?: "—",
                MoeDuration.humanise(row.avgWallClockMs)
            ))
        }

        val now = Instant.now().toString()
        lastUpdatedLabel.text = MoeBundle.message("moe.metrics.lastUpdated", now)
    }

    private fun kpiCard(label: String, valueLabel: JBLabel): JComponent {
        val card = JPanel(BorderLayout()).apply {
            isOpaque = true
            background = BoardStyles.cardBackground
            border = JBUI.Borders.compound(
                JBUI.Borders.customLine(BoardStyles.borderColor),
                JBUI.Borders.empty(10, 12)
            )
        }
        val header = JBLabel(label).apply {
            foreground = BoardStyles.textSecondary
            font = JBUI.Fonts.smallFont()
        }
        card.add(header, BorderLayout.NORTH)
        card.add(valueLabel, BorderLayout.CENTER)
        return card
    }

    private fun makeKpiValue(): JBLabel {
        return JBLabel("—").apply {
            foreground = BoardStyles.textPrimary
            font = font.deriveFont(Font.BOLD, font.size + 8f)
        }
    }

    private fun rangeChip(label: String, days: Int?): JComponent {
        val chip = JBLabel(label).apply {
            isOpaque = true
            border = JBUI.Borders.empty(2, 8)
            font = JBUI.Fonts.smallFont()
            cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        }
        fun applyStyle() {
            val active = days == rangeDays
            chip.background = if (active) BoardStyles.statusTint("PLANNING") else BoardStyles.columnHeaderBackground
            chip.foreground = if (active) BoardStyles.textPrimary else BoardStyles.textSecondary
        }
        applyStyle()
        chip.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                rangeDays = days
                // Restyle siblings
                (chip.parent?.components ?: emptyArray()).forEach { c ->
                    if (c is JBLabel && c !== lastUpdatedLabel) {
                        // crude restyle: defer to next paint cycle via revalidate
                    }
                }
                // Force a full re-render of all chips by walking the toolbar
                chip.parent?.components?.forEach { sibling ->
                    if (sibling is JBLabel && sibling !== lastUpdatedLabel) {
                        val text = sibling.text
                        val match = when (text) {
                            MoeBundle.message("moe.metrics.range.7d") -> 7
                            MoeBundle.message("moe.metrics.range.30d") -> 30
                            MoeBundle.message("moe.metrics.range.all") -> null
                            else -> Int.MIN_VALUE
                        }
                        if (match != Int.MIN_VALUE) {
                            val isActive = match == rangeDays
                            sibling.background = if (isActive) BoardStyles.statusTint("PLANNING") else BoardStyles.columnHeaderBackground
                            sibling.foreground = if (isActive) BoardStyles.textPrimary else BoardStyles.textSecondary
                            sibling.repaint()
                        }
                    }
                }
                requestRefresh()
            }
        })
        return chip
    }

    override fun dispose() {
        disposed = true
        alarm.cancelAllRequests()
        service.removeListener(stateListener)
    }
}
