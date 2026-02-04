package com.moe.toolwindow

import com.moe.model.MoeState
import com.moe.model.RailProposal
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.BoardStyles
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
import javax.swing.BorderFactory
import javax.swing.JPanel

class ProposalPanel(private val project: Project) : JBPanel<ProposalPanel>(BorderLayout()) {
    private val service = project.service<MoeProjectService>()
    private val listPanel = JPanel(VerticalLayout(8))
    private var proposals: List<RailProposal> = emptyList()

    init {
        border = JBUI.Borders.empty(8)
        background = BoardStyles.boardBackground

        val header = JBLabel("Rail Proposals").apply {
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

        service.addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {
                proposals = state.proposals.filter { it.status == "PENDING" }
                updateList()
            }

            override fun onStatus(connected: Boolean, message: String) {
                // Not used
            }
        })
    }

    private fun updateList() {
        listPanel.removeAll()

        if (proposals.isEmpty()) {
            listPanel.add(JBLabel("No pending proposals").apply {
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

        content.add(JBLabel("${proposal.proposalType} - ${proposal.targetScope}").apply {
            font = font.deriveFont(Font.BOLD)
        })

        if (!proposal.currentValue.isNullOrBlank()) {
            content.add(JBLabel("Current: ${proposal.currentValue}").apply {
                font = JBUI.Fonts.smallFont()
                foreground = BoardStyles.textSecondary
            })
        }

        content.add(JBLabel("Proposed: ${proposal.proposedValue}").apply {
            font = JBUI.Fonts.smallFont()
        })

        if (proposal.reason.isNotBlank()) {
            content.add(JBLabel("Reason: ${proposal.reason}").apply {
                font = JBUI.Fonts.smallFont()
                foreground = BoardStyles.textSecondary
            })
        }

        content.add(JBLabel("Task: ${proposal.taskId.takeLast(8)} | Worker: ${proposal.workerId}").apply {
            font = JBUI.Fonts.smallFont()
            foreground = BoardStyles.textSecondary
        })

        val actions = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0)).apply {
            isOpaque = false
        }

        val approveBtn = JBLabel("Approve").apply {
            foreground = java.awt.Color(76, 175, 80)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    service.approveProposal(proposal.id)
                }
            })
        }

        val rejectBtn = JBLabel("Reject").apply {
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
