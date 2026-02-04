package com.moe.toolwindow.board

import com.intellij.ui.JBColor
import com.intellij.ui.components.JBPanel
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.LayoutManager
import java.awt.RenderingHints

open class RoundedPanel(
    private val radius: Int,
    private val outline: JBColor? = null,
    layout: LayoutManager? = null
) : JBPanel<RoundedPanel>(layout) {

    init {
        isOpaque = false
    }

    override fun paintComponent(g: Graphics) {
        super.paintComponent(g)
        val g2 = g.create() as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2.color = background
        g2.fillRoundRect(0, 0, width - 1, height - 1, radius, radius)
        if (outline != null) {
            g2.color = outline
            g2.drawRoundRect(0, 0, width - 1, height - 1, radius, radius)
        }
        g2.dispose()
    }
}
