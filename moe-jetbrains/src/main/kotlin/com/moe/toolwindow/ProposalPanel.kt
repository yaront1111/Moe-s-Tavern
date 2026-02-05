package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.model.RailProposal
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.BoardStyles
import com.moe.util.MoeBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.components.service
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.FlowLayout
import java.awt.Font
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import com.intellij.openapi.Disposable
import javax.swing.BorderFactory
import javax.swing.JPanel

class ProposalPanel(private val project: Project) : JBPanel<ProposalPanel>(BorderLayout()), Disposable {
    private val service = project.service<MoeProjectService>()
    private val listPanel = JPanel(VerticalLayout(8))
    private var proposals: List<RailProposal> = emptyList()
    private var stateListener: MoeStateListener? = null

    init {
        border = JBUI.Borders.empty(8)
        background = BoardStyles.boardBackground

        val header = JBLabel(MoeBundle.message("moe.proposal.title")).apply {
            font = font.deriveFont(Font.BOLD, 14f)
            border = JBUI.Borders.empty(0, 0, 8, 0)
        }

        listPanel.isOpaque = false

        val scrollPane = JBScrollPane(listPanel).apply {
            border = JBUI.Borders.empty()
            viewport.background = BoardStyles.boardBackground
        }

        add(header, BorderLayout.NORTH)
        add(scrollPane, BorderLayout.CENTER)

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                proposals = state.proposals.filter { it.status == "PENDING" }
                updateList()
            }

            override fun onStatus(connected: Boolean, message: String) {
                // Not used
            }
        }
        service.addListener(stateListener!!)
    }

    override fun dispose() {
        stateListener?.let { service.removeListener(it) }
        stateListener = null
    }

    private fun updateList() {
        listPanel.removeAll()

        if (proposals.isEmpty()) {
            listPanel.add(JBLabel(MoeBundle.message("moe.message.noPendingProposals")).apply {
                foreground = BoardStyles.textSecondary
            })
        } else {
            for (proposal in proposals) {
                listPanel.add(createProposalCard(proposal))
            }
        }

        listPanel.revalidate()
        listPanel.repaint()
    }

    private fun createProposalCard(proposal: RailProposal): JPanel {
        val card = JPanel(BorderLayout()).apply {
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(BoardStyles.borderColor),
                JBUI.Borders.empty(8)
            )
            background = BoardStyles.cardBackground
        }

        val content = JPanel(VerticalLayout(4)).apply {
            isOpaque = false
        }

        // Defensive null checks for fields that might be null from JSON deserialization
        val proposalType = proposal.proposalType.ifBlank { "Unknown" }
        val targetScope = proposal.targetScope.ifBlank { "Unknown" }
        val proposedValue = proposal.proposedValue.ifBlank { "(empty)" }
        val reason = proposal.reason
        val taskId = proposal.taskId.ifBlank { "unknown" }
        val workerId = proposal.workerId.ifBlank { "unknown" }

        content.add(JBLabel("$proposalType - $targetScope").apply {
            font = font.deriveFont(Font.BOLD)
        })

        if (!proposal.currentValue.isNullOrBlank()) {
            content.add(JBLabel(MoeBundle.message("moe.proposal.current", proposal.currentValue)).apply {
                font = JBUI.Fonts.smallFont()
                foreground = BoardStyles.textSecondary
            })
        }

        content.add(JBLabel(MoeBundle.message("moe.proposal.proposed", proposedValue)).apply {
            font = JBUI.Fonts.smallFont()
        })

        if (reason.isNotBlank()) {
            content.add(JBLabel(MoeBundle.message("moe.proposal.reason", reason)).apply {
                font = JBUI.Fonts.smallFont()
                foreground = BoardStyles.textSecondary
            })
        }

        content.add(JBLabel(MoeBundle.message("moe.proposal.taskWorker", taskId.takeLast(8), workerId)).apply {
            font = JBUI.Fonts.smallFont()
            foreground = BoardStyles.textSecondary
        })

        val actions = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0)).apply {
            isOpaque = false
        }

        val approveBtn = JBLabel(MoeBundle.message("moe.button.approve")).apply {
            foreground = java.awt.Color(76, 175, 80)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    service.approveProposal(proposal.id)
                }
            })
        }

        val rejectBtn = JBLabel(MoeBundle.message("moe.button.reject")).apply {
            foreground = java.awt.Color(244, 67, 54)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    service.rejectProposal(proposal.id)
                }
            })
        }

        actions.add(approveBtn)
        actions.add(rejectBtn)

        card.add(content, BorderLayout.CENTER)
        card.add(actions, BorderLayout.SOUTH)

        return card
    }
}
