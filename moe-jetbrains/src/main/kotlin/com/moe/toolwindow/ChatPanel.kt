package com.moe.toolwindow

import com.moe.model.ChatChannel
import com.moe.model.ChatMessage
import com.moe.model.Decision
import com.moe.model.MoeState
import com.moe.model.PinEntry
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.BoardStyles
import com.moe.util.MoeBundle
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.openapi.ui.ComboBox
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.FlowLayout
import java.awt.Font
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JEditorPane
import javax.swing.event.HyperlinkEvent
import javax.swing.ScrollPaneConstants
import javax.swing.SwingUtilities

class ChatPanel(private val project: Project) : JBPanel<ChatPanel>(BorderLayout()), Disposable {
    private val service = project.service<MoeProjectService>()
    private var stateListener: MoeStateListener? = null

    private val channelCombo = ComboBox<ChatChannel>()
    private val channelModel = DefaultComboBoxModel<ChatChannel>()
    private val messagesPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        background = BoardStyles.boardBackground
    }
    private val messagesScroll = JBScrollPane(messagesPanel).apply {
        border = JBUI.Borders.empty()
        viewport.background = BoardStyles.boardBackground
        horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
        verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
    }
    private val inputField = JBTextField().apply {
        emptyText.text = MoeBundle.message("moe.chat.inputPlaceholder")
    }
    private val sendButton = JButton(MoeBundle.message("moe.chat.send"))
    private val noMessagesLabel = JBLabel(MoeBundle.message("moe.chat.noMessages")).apply {
        foreground = BoardStyles.textSecondary
        horizontalAlignment = JBLabel.CENTER
        border = JBUI.Borders.empty(20)
    }

    private var currentChannelId: String? = null
    private val messagesByChannel = mutableMapOf<String, MutableList<ChatMessage>>()
    private val pinsByChannel = mutableMapOf<String, MutableList<PinEntry>>()
    private val maxMessagesPerChannel = 500
    private val workerStatusMap = mutableMapOf<String, String>()
    private val decisionsMap = mutableMapOf<String, Decision>()
    private var pinsCollapsed = false
    private var updatingChannels = false
    private var lastChannelFingerprint = ""
    private var notificationsEnabled = true
    private var soundEnabled = true
    private val mutedChannels = mutableSetOf<String>()

    private val pinnedPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = true
        background = BoardStyles.boardBackground
        border = JBUI.Borders.emptyBottom(4)
        isVisible = false
    }
    private val pinnedHeaderLabel = JBLabel("\uD83D\uDCCC Pinned (0)").apply {
        font = font.deriveFont(Font.BOLD, font.size2D - 1f)
        foreground = BoardStyles.textSecondary
        cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
        border = JBUI.Borders.empty(4, 8)
    }
    private val pinnedListPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        isOpaque = false
    }
    @Volatile private var disposed = false

    init {
        border = JBUI.Borders.empty(8)
        background = BoardStyles.boardBackground

        // Load notification settings
        val props = PropertiesComponent.getInstance(project)
        notificationsEnabled = props.getBoolean("moe.chat.notifications.enabled", true)
        soundEnabled = props.getBoolean("moe.chat.notifications.soundEnabled", true)

        // Channel selector toolbar
        channelCombo.model = channelModel
        channelCombo.renderer = object : javax.swing.DefaultListCellRenderer() {
            override fun getListCellRendererComponent(
                list: javax.swing.JList<*>?,
                value: Any?,
                index: Int,
                isSelected: Boolean,
                cellHasFocus: Boolean
            ): Component {
                super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus)
                val ch = value as? ChatChannel
                text = if (ch != null) "#${ch.name}" else MoeBundle.message("moe.chat.noChannels")
                return this
            }
        }
        channelCombo.addActionListener {
            if (updatingChannels) return@addActionListener
            val selected = channelCombo.selectedItem as? ChatChannel ?: return@addActionListener
            if (selected.id != currentChannelId) {
                currentChannelId = selected.id
                refreshMessages()
                refreshPinnedPanel()
                service.requestMessages(selected.id)
                service.requestPins(selected.id)
            }
        }

        val notifToggle = JButton(if (notificationsEnabled) "\uD83D\uDD14" else "\uD83D\uDD15").apply {
            toolTipText = "Toggle notifications"
            isFocusPainted = false
            addActionListener {
                notificationsEnabled = !notificationsEnabled
                text = if (notificationsEnabled) "\uD83D\uDD14" else "\uD83D\uDD15"
                PropertiesComponent.getInstance(project).setValue("moe.chat.notifications.enabled", notificationsEnabled)
            }
        }

        val toolbar = JPanel(FlowLayout(FlowLayout.LEFT, 8, 4)).apply {
            isOpaque = false
            add(JBLabel(MoeBundle.message("moe.chat.channelLabel")))
            add(channelCombo)
            add(notifToggle)
        }

        // Input panel
        inputField.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    sendCurrentMessage()
                }
            }
        })
        sendButton.addActionListener { sendCurrentMessage() }

        val inputPanel = JPanel(BorderLayout(4, 0)).apply {
            isOpaque = false
            border = JBUI.Borders.emptyTop(4)
            add(inputField, BorderLayout.CENTER)
            add(sendButton, BorderLayout.EAST)
        }

        // Pinned section setup
        pinnedHeaderLabel.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                pinsCollapsed = !pinsCollapsed
                pinnedListPanel.isVisible = !pinsCollapsed
                pinnedPanel.revalidate()
                pinnedPanel.repaint()
            }
        })
        pinnedPanel.add(pinnedHeaderLabel)
        pinnedPanel.add(pinnedListPanel)

        val centerPanel = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(pinnedPanel, BorderLayout.NORTH)
            add(messagesScroll, BorderLayout.CENTER)
        }

        add(toolbar, BorderLayout.NORTH)
        add(centerPanel, BorderLayout.CENTER)
        add(inputPanel, BorderLayout.SOUTH)

        showNoMessages()

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    workerStatusMap.clear()
                    state.workers.forEach { workerStatusMap[it.id] = it.status }
                    updateChannels(state.channels)
                }
            }

            override fun onStatus(connected: Boolean, message: String) {
                if (disposed) return
                if (connected) {
                    service.requestChannels()
                }
            }

            override fun onChatMessage(message: ChatMessage) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    appendMessage(message)
                    notifyIfNeeded(message)
                }
            }

            override fun onChatMessages(channel: String, messages: List<ChatMessage>) {
                if (disposed) return
                SwingUtilities.invokeLater { setMessages(channel, messages) }
            }

            override fun onPins(channel: String, pins: List<PinEntry>) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    pinsByChannel[channel] = pins.toMutableList()
                    if (channel == currentChannelId) refreshPinnedPanel()
                }
            }

            override fun onPinCreated(channel: String, pin: PinEntry) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    val list = pinsByChannel.getOrPut(channel) { mutableListOf() }
                    if (list.none { it.messageId == pin.messageId }) {
                        list.add(pin)
                    }
                    if (channel == currentChannelId) refreshPinnedPanel()
                }
            }

            override fun onPinRemoved(channel: String, messageId: String) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    pinsByChannel[channel]?.removeAll { it.messageId == messageId }
                    if (channel == currentChannelId) refreshPinnedPanel()
                }
            }

            override fun onPinToggled(channel: String, pin: PinEntry) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    val list = pinsByChannel[channel] ?: return@invokeLater
                    val idx = list.indexOfFirst { it.messageId == pin.messageId }
                    if (idx >= 0) list[idx] = pin
                    if (channel == currentChannelId) refreshPinnedPanel()
                }
            }

            override fun onDecisions(decisions: List<Decision>) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    decisionsMap.clear()
                    decisions.forEach { decisionsMap[it.id] = it }
                    refreshMessages()
                }
            }

            override fun onDecisionProposed(decision: Decision) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    decisionsMap[decision.id] = decision
                    refreshMessages()
                }
            }

            override fun onDecisionResolved(decision: Decision) {
                if (disposed) return
                SwingUtilities.invokeLater {
                    decisionsMap[decision.id] = decision
                    refreshMessages()
                }
            }
        }
        service.addListener(stateListener!!)

        // Request initial data
        service.requestChannels()
        service.requestDecisions()
    }

    private fun updateChannels(channels: List<ChatChannel>) {
        val fingerprint = channels.map { it.id }.sorted().joinToString(",")
        if (fingerprint == lastChannelFingerprint) return
        lastChannelFingerprint = fingerprint

        updatingChannels = true
        try {
            val previousId = currentChannelId
            channelModel.removeAllElements()
            channels.sortedBy { it.name }.forEach { channelModel.addElement(it) }

            if (channelModel.size > 0) {
                val toSelect = if (previousId != null) {
                    channels.find { it.id == previousId }
                } else {
                    channels.find { it.type == "general" } ?: channels.firstOrNull()
                }
                if (toSelect != null) {
                    channelCombo.selectedItem = toSelect
                    currentChannelId = toSelect.id
                    if (toSelect.id != previousId) {
                        service.requestMessages(toSelect.id)
                        service.requestPins(toSelect.id)
                    }
                }
            }
        } finally {
            updatingChannels = false
        }
    }

    private fun sendCurrentMessage() {
        val text = inputField.text?.trim() ?: return
        if (text.isEmpty()) return
        val channelId = currentChannelId ?: return
        service.sendChatMessage(channelId, text)
        inputField.text = ""
        inputField.requestFocusInWindow()
    }

    private fun appendMessage(message: ChatMessage) {
        val list = messagesByChannel.getOrPut(message.channel) { mutableListOf() }
        if (list.none { it.id == message.id }) {
            list.add(message)
            if (list.size > maxMessagesPerChannel) {
                list.subList(0, list.size - maxMessagesPerChannel).clear()
            }
        }
        if (message.channel == currentChannelId) {
            try {
                // Incremental add: remove trailing glue, add bubble, re-add glue
                val componentCount = messagesPanel.componentCount
                if (componentCount > 0 && messagesPanel.getComponent(componentCount - 1) is Box.Filler) {
                    messagesPanel.remove(componentCount - 1)
                } else if (componentCount == 1 && messagesPanel.getComponent(0) === noMessagesLabel) {
                    messagesPanel.removeAll()
                }
                messagesPanel.add(createMessageBubble(message))
                messagesPanel.add(Box.createVerticalGlue())
                messagesPanel.revalidate()
                messagesPanel.repaint()
                SwingUtilities.invokeLater {
                    val bar = messagesScroll.verticalScrollBar
                    bar.value = bar.maximum
                }
            } catch (_: Exception) {
                refreshMessages()
            }
        }
    }

    private fun setMessages(channel: String, messages: List<ChatMessage>) {
        messagesByChannel[channel] = messages.toMutableList()
        if (channel == currentChannelId) {
            refreshMessages()
        }
    }

    private fun refreshMessages() {
        messagesPanel.removeAll()
        val channelId = currentChannelId
        val messages = if (channelId != null) messagesByChannel[channelId] else null
        if (messages.isNullOrEmpty()) {
            showNoMessages()
        } else {
            messages.forEach { msg -> messagesPanel.add(createMessageBubble(msg)) }
            messagesPanel.add(Box.createVerticalGlue())
        }
        messagesPanel.revalidate()
        messagesPanel.repaint()
        // Auto-scroll to bottom
        SwingUtilities.invokeLater {
            val bar = messagesScroll.verticalScrollBar
            bar.value = bar.maximum
        }
    }

    private fun showNoMessages() {
        messagesPanel.removeAll()
        messagesPanel.add(noMessagesLabel)
        messagesPanel.revalidate()
        messagesPanel.repaint()
    }

    private fun refreshPinnedPanel() {
        val channelId = currentChannelId
        val pins = if (channelId != null) pinsByChannel[channelId] else null

        if (pins.isNullOrEmpty()) {
            pinnedPanel.isVisible = false
            return
        }

        pinnedPanel.isVisible = true
        pinnedHeaderLabel.text = "\uD83D\uDCCC Pinned (${pins.size})"
        pinnedListPanel.removeAll()

        if (!pinsCollapsed) {
            val messages = if (channelId != null) messagesByChannel[channelId] else null
            for (pin in pins) {
                val msg = messages?.find { it.id == pin.messageId }
                val row = JPanel(FlowLayout(FlowLayout.LEFT, 4, 1)).apply {
                    isOpaque = false
                    maximumSize = java.awt.Dimension(Int.MAX_VALUE, 28)
                }

                val checkbox = JCheckBox().apply {
                    isSelected = pin.done
                    isOpaque = false
                    addActionListener {
                        if (channelId != null) {
                            service.togglePinDone(channelId, pin.messageId)
                        }
                    }
                }

                val contentText = if (msg != null) {
                    val truncated = if (msg.content.length > 120) msg.content.take(120) + "..." else msg.content
                    "${msg.sender}: $truncated"
                } else {
                    "(message ${pin.messageId.take(8)})"
                }
                val contentLabel = JBLabel(contentText).apply {
                    font = font.deriveFont(font.size2D - 1f)
                    foreground = if (pin.done) BoardStyles.textSecondary else BoardStyles.textPrimary
                    if (pin.done) {
                        @Suppress("DEPRECATION")
                        val attrs = font.attributes.toMutableMap()
                        attrs[java.awt.font.TextAttribute.STRIKETHROUGH] = java.awt.font.TextAttribute.STRIKETHROUGH_ON
                        font = font.deriveFont(attrs)
                    }
                }

                val unpinButton = JBLabel("\u2715").apply {
                    foreground = BoardStyles.textSecondary
                    cursor = java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
                    toolTipText = "Unpin"
                    addMouseListener(object : java.awt.event.MouseAdapter() {
                        override fun mouseClicked(e: java.awt.event.MouseEvent) {
                            if (channelId != null) {
                                service.unpinMessage(channelId, pin.messageId)
                            }
                        }
                    })
                }

                row.add(checkbox)
                row.add(contentLabel)
                row.add(unpinButton)
                pinnedListPanel.add(row)
            }
        }

        pinnedListPanel.isVisible = !pinsCollapsed
        pinnedPanel.revalidate()
        pinnedPanel.repaint()
    }

    private fun escapeHtml(text: String): String {
        return text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
    }

    private fun markdownToHtml(content: String): String {
        return try {
            val normalized = content.replace("\r\n", "\n")
            // Extract fenced code blocks to placeholders
            val codeBlocks = mutableListOf<String>()
            var processed = Regex("```\\w*\\n([\\s\\S]*?)```").replace(normalized) { match ->
                val idx = codeBlocks.size
                val code = escapeHtml(match.groupValues[1].trimEnd('\n'))
                codeBlocks.add("<pre style=\"background:#1e1e1e;color:#d4d4d4;padding:6px;margin:4px 0;font-family:monospace;\"><code>$code</code></pre>")
                "%%CODEBLOCK_${idx}%%"
            }

            // Escape HTML in non-code portions
            processed = escapeHtml(processed)

            // Inline code
            processed = Regex("`([^`]+)`").replace(processed) { match ->
                "<code style=\"background:#2d2d2d;padding:1px 4px;font-family:monospace;\">${match.groupValues[1]}</code>"
            }

            // Bold
            processed = Regex("\\*\\*(.+?)\\*\\*").replace(processed) { match ->
                "<b>${match.groupValues[1]}</b>"
            }

            // Italic
            processed = Regex("\\*(.+?)\\*").replace(processed) { match ->
                "<i>${match.groupValues[1]}</i>"
            }

            // Links [text](url) - only allow safe protocols
            processed = Regex("\\[([^]]+)]\\(([^)]+)\\)").replace(processed) { match ->
                val url = match.groupValues[2]
                val text = match.groupValues[1]
                if (url.matches(Regex("^(https?:|mailto:).*", RegexOption.IGNORE_CASE))) {
                    "<a href=\"$url\">$text</a>"
                } else {
                    text
                }
            }

            // Unordered list items (- item)
            processed = Regex("((?:^|\\n)- .+(?:\\n- .+)*)").replace(processed) { match ->
                val items = match.value.trim().split("\n").joinToString("") { line ->
                    "<li>${line.removePrefix("- ")}</li>"
                }
                "<ul>$items</ul>"
            }

            // Ordered list items (1. item)
            processed = Regex("((?:^|\\n)\\d+\\. .+(?:\\n\\d+\\. .+)*)").replace(processed) { match ->
                val items = match.value.trim().split("\n").joinToString("") { line ->
                    "<li>${line.replace(Regex("^\\d+\\.\\s"), "")}</li>"
                }
                "<ol>$items</ol>"
            }

            // File path linkification (2+ segments, optional :line) — exclude URLs
            processed = Regex("(?<!://)(?<![\">/])\\b([\\w.-]+/(?:[\\w.-]+/)*[\\w.-]+(?::(\\d+))?)").replace(processed) { match ->
                val fullPath = match.groupValues[1]
                "<a href=\"file://$fullPath\">$fullPath</a>"
            }

            // Newlines to <br>
            processed = processed.replace("\n", "<br>")

            // Restore code blocks
            for (i in codeBlocks.indices) {
                processed = processed.replace("%%CODEBLOCK_${i}%%", codeBlocks[i])
            }

            processed
        } catch (_: Exception) {
            escapeHtml(content)
        }
    }

    private fun createMessageBubble(message: ChatMessage): JPanel {
        val isSystem = message.sender == "system"
        val bubble = JPanel(BorderLayout(4, 2)).apply {
            isOpaque = true
            background = if (isSystem) {
                JBColor(Color(0xFFF3CD), Color(0x332D1A))
            } else {
                BoardStyles.cardBackground
            }
            border = BorderFactory.createCompoundBorder(
                JBUI.Borders.empty(2, 0),
                JBUI.Borders.empty(6, 8)
            )
            maximumSize = java.awt.Dimension(Int.MAX_VALUE, Int.MAX_VALUE)
        }

        val senderLabel = JBLabel(message.sender).apply {
            font = font.deriveFont(Font.BOLD, font.size2D)
            foreground = senderColor(message.sender)
        }

        val timestampLabel = JBLabel(formatTimestamp(message.timestamp)).apply {
            font = font.deriveFont(font.size2D - 1f)
            foreground = BoardStyles.textSecondary
        }

        val headerPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply {
            isOpaque = false
            if (message.sender != "human" && message.sender != "system") {
                val status = workerStatusMap[message.sender] ?: "IDLE"
                val dotColor = statusDotColor(status)
                add(object : JPanel() {
                    init {
                        isOpaque = false
                        preferredSize = java.awt.Dimension(8, 8)
                        maximumSize = java.awt.Dimension(8, 8)
                    }
                    override fun paintComponent(g: java.awt.Graphics) {
                        super.paintComponent(g)
                        val g2 = g as java.awt.Graphics2D
                        g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
                        g2.color = dotColor
                        g2.fillOval(0, 0, 8, 8)
                    }
                })
            }
            add(senderLabel)
            add(timestampLabel)
        }

        val textColor = if (isSystem) {
            JBColor(Color(0x664D03), Color(0xFFD966))
        } else {
            BoardStyles.textPrimary
        }
        val colorHex = String.format("#%06x", textColor.rgb and 0xFFFFFF)
        val htmlBody = try {
            if (isSystem) "<i>${escapeHtml(message.content)}</i>" else markdownToHtml(message.content)
        } catch (_: Exception) {
            escapeHtml(message.content)
        }
        val fullHtml = "<html><body style=\"color:$colorHex;margin:0;padding:0;font-family:sans-serif;\">$htmlBody</body></html>"
        val contentArea = JEditorPane("text/html", fullHtml).apply {
            isEditable = false
            isOpaque = false
            border = JBUI.Borders.empty()
            putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
            addHyperlinkListener { event ->
                if (event.eventType == HyperlinkEvent.EventType.ACTIVATED) {
                    try {
                        val url = event.description ?: return@addHyperlinkListener
                        if (url.startsWith("file://")) {
                            openFileFromPath(url.removePrefix("file://"))
                        } else if (url.startsWith("http://") || url.startsWith("https://")) {
                            BrowserUtil.browse(url)
                        }
                    } catch (_: Exception) { /* ignore click errors */ }
                }
            }
        }

        // Reply quote if applicable
        val northPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
        }
        if (message.replyTo != null) {
            val parentMsg = messagesByChannel[message.channel]?.find { it.id == message.replyTo }
            if (parentMsg != null) {
                val truncated = if (parentMsg.content.length > 100) parentMsg.content.take(100) + "..." else parentMsg.content
                val quoteLabel = JBLabel("${parentMsg.sender}: $truncated").apply {
                    font = font.deriveFont(font.size2D - 1f)
                    foreground = BoardStyles.textSecondary
                    border = BorderFactory.createCompoundBorder(
                        BorderFactory.createMatteBorder(0, 2, 0, 0, BoardStyles.textSecondary),
                        JBUI.Borders.empty(2, 6, 2, 0)
                    )
                }
                northPanel.add(quoteLabel)
            }
        }
        northPanel.add(headerPanel)

        bubble.add(northPanel, BorderLayout.NORTH)

        // Decision card + content wrapped in a vertical panel
        val centerPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
        }
        centerPanel.add(contentArea)

        // Render decision card if message has decisionId
        val decisionId = message.decisionId
        if (decisionId != null) {
            val decision = decisionsMap[decisionId]
            if (decision != null) {
                centerPanel.add(createDecisionCard(decision))
            }
        }
        bubble.add(centerPanel, BorderLayout.CENTER)

        if (message.mentions.isNotEmpty()) {
            val mentionsLabel = JBLabel("@${message.mentions.joinToString(" @")}").apply {
                font = font.deriveFont(font.size2D - 1f)
                foreground = JBColor(Color(0x3B82F6), Color(0x60A5FA))
            }
            bubble.add(mentionsLabel, BorderLayout.SOUTH)
        }

        // Right-click context menu for pin/unpin — evaluate state at click time
        if (!isSystem) {
            val channelId = message.channel
            val popup = object : JPopupMenu() {
                override fun show(invoker: Component?, x: Int, y: Int) {
                    removeAll()
                    val isPinned = pinsByChannel[channelId]?.any { it.messageId == message.id } == true
                    val pinItem = JMenuItem(if (isPinned) "Unpin Message" else "Pin Message")
                    pinItem.addActionListener {
                        if (isPinned) {
                            service.unpinMessage(channelId, message.id)
                        } else {
                            service.pinMessage(channelId, message.id)
                        }
                    }
                    add(pinItem)
                    super.show(invoker, x, y)
                }
            }
            bubble.componentPopupMenu = popup
        }

        return bubble
    }

    private fun createDecisionCard(decision: Decision): JPanel {
        val goldBorder = Color(0xD4A017)
        val card = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = true
            background = JBColor(Color(0xFFF8E1), Color(0x2A2517))
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createMatteBorder(1, 3, 1, 1, goldBorder),
                JBUI.Borders.empty(6, 8)
            )
            maximumSize = java.awt.Dimension(Int.MAX_VALUE, Int.MAX_VALUE)
            alignmentX = Component.LEFT_ALIGNMENT
        }

        val label = JBLabel("\u2696 Decision").apply {
            font = font.deriveFont(Font.BOLD, font.size2D - 1f)
            foreground = JBColor(Color(0xB8860B), Color(0xD4A017))
        }
        card.add(label)
        card.add(Box.createVerticalStrut(4))

        val contentLabel = JBLabel("<html><body style=\"margin:0;padding:0;\">${escapeHtml(decision.content)}</body></html>").apply {
            foreground = BoardStyles.textPrimary
            alignmentX = Component.LEFT_ALIGNMENT
        }
        card.add(contentLabel)
        card.add(Box.createVerticalStrut(6))

        if (decision.status == "proposed") {
            val buttonsPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0)).apply { isOpaque = false }

            val approveBtn = JButton("\u2713 Approve").apply {
                foreground = Color(0x22C55E)
                font = font.deriveFont(font.size2D - 1f)
                isFocusPainted = false
                addActionListener { service.approveDecision(decision.id) }
            }

            val rejectBtn = JButton("\u2717 Reject").apply {
                foreground = Color(0xEF4444)
                font = font.deriveFont(font.size2D - 1f)
                isFocusPainted = false
                addActionListener { service.rejectDecision(decision.id) }
            }

            buttonsPanel.add(approveBtn)
            buttonsPanel.add(rejectBtn)
            card.add(buttonsPanel)
        } else {
            val statusColor = if (decision.status == "approved") Color(0x22C55E) else Color(0xEF4444)
            val statusIcon = if (decision.status == "approved") "\u2713 Approved" else "\u2717 Rejected"
            val statusText = if (decision.approvedBy != null) "$statusIcon by ${decision.approvedBy}" else statusIcon
            val statusLabel = JBLabel(statusText).apply {
                foreground = statusColor
                font = font.deriveFont(Font.BOLD, font.size2D - 1f)
            }
            card.add(statusLabel)
        }

        return card
    }

    private fun notifyIfNeeded(message: ChatMessage) {
        try {
            if (!notificationsEnabled) return
            if (message.sender == "human" || message.sender == "system") return
            if (mutedChannels.contains(message.channel)) return
            val truncated = if (message.content.length > 80) message.content.take(80) + "..." else message.content
            try {
                NotificationGroupManager.getInstance()
                    .getNotificationGroup("Moe Notifications")
                    .createNotification(
                        "Moe Chat",
                        "${message.sender}: $truncated",
                        NotificationType.INFORMATION
                    )
                    .notify(project)
            } catch (_: Exception) {
                // Notification group not found, fall back to beep only
            }
            if (soundEnabled) {
                try {
                    java.awt.Toolkit.getDefaultToolkit().beep()
                } catch (_: Exception) {
                    // Beep not available on all platforms
                }
            }
        } catch (_: Exception) {
            // Never break message flow
        }
    }

    private fun openFileFromPath(pathWithLine: String) {
        try {
            val parts = pathWithLine.split(":")
            val filePath = parts[0]
            val line = if (parts.size > 1) parts[1].toIntOrNull() ?: 0 else 0

            val basePath = project.basePath ?: return
            val absPath = java.io.File(basePath, filePath).absolutePath
            val vFile = LocalFileSystem.getInstance().findFileByPath(absPath)
            if (vFile != null) {
                val descriptor = OpenFileDescriptor(project, vFile, maxOf(0, line - 1), 0)
                FileEditorManager.getInstance(project).openTextEditor(descriptor, true)
            } else {
                com.intellij.openapi.ui.Messages.showWarningDialog(
                    project, "File not found: $filePath", "Open File"
                )
            }
        } catch (_: Exception) { /* ignore file open errors */ }
    }

    private fun statusDotColor(status: String): Color {
        return when (status) {
            "CODING" -> Color(0x22C55E)
            "PLANNING" -> Color(0xA855F7)
            "BLOCKED" -> Color(0xEF4444)
            "REVIEWING" -> Color(0xF59E0B)
            else -> Color(0x888888)
        }
    }

    private fun senderColor(sender: String): JBColor {
        return when (sender) {
            "system" -> JBColor(Color(0x664D03), Color(0xFFD966))
            "human" -> JBColor(Color(0x2563EB), Color(0x93C5FD))
            else -> {
                val hash = sender.hashCode() and 0x7FFFFFFF
                val hue = (hash % 360) / 360f
                val lightColor = Color.getHSBColor(hue, 0.6f, 0.4f)
                val darkColor = Color.getHSBColor(hue, 0.4f, 0.8f)
                JBColor(lightColor, darkColor)
            }
        }
    }

    private fun formatTimestamp(timestamp: String): String {
        return try {
            val instant = java.time.Instant.parse(timestamp)
            val formatter = java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss")
                .withZone(java.time.ZoneId.systemDefault())
            formatter.format(instant)
        } catch (_: Exception) {
            timestamp
        }
    }

    override fun dispose() {
        disposed = true
        stateListener?.let { service.removeListener(it) }
        stateListener = null
    }
}
