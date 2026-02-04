package com.moe.toolwindow.board

import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.JComponent

class StatusDot(private val color: JBColor) : JComponent() {
    override fun getPreferredSize(): Dimension = JBUI.size(8, 8)

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2.color = color
        g2.fillOval(0, 0, width, height)
        g2.dispose()
    }
}
