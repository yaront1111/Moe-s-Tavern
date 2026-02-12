package com.moe.toolwindow.board

import java.awt.Container
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Insets

/**
 * A FlowLayout subclass that wraps components to the next line
 * when the container is too narrow to fit them on one row.
 */
class WrapLayout(align: Int = LEFT, hgap: Int = 5, vgap: Int = 5) : FlowLayout(align, hgap, vgap) {

    override fun preferredLayoutSize(target: Container): Dimension {
        return layoutSize(target, true)
    }

    override fun minimumLayoutSize(target: Container): Dimension {
        val dim = layoutSize(target, false)
        dim.width -= (hgap + 1)
        return dim
    }

    private fun layoutSize(target: Container, preferred: Boolean): Dimension {
        synchronized(target.treeLock) {
            val targetWidth = if (target.size.width > 0) target.size.width else Int.MAX_VALUE
            val insets: Insets = target.insets
            val maxWidth = targetWidth - (insets.left + insets.right + hgap * 2)

            if (maxWidth <= 0) {
                return if (preferred) super.preferredLayoutSize(target) else super.minimumLayoutSize(target)
            }

            val dim = Dimension(0, 0)
            var rowWidth = 0
            var rowHeight = 0

            for (i in 0 until target.componentCount) {
                val m = target.getComponent(i)
                if (m.isVisible) {
                    val d = if (preferred) m.preferredSize else m.minimumSize
                    if (rowWidth + d.width > maxWidth && rowWidth > 0) {
                        dim.width = maxOf(dim.width, rowWidth)
                        dim.height += rowHeight + vgap
                        rowWidth = 0
                        rowHeight = 0
                    }
                    if (rowWidth > 0) {
                        rowWidth += hgap
                    }
                    rowWidth += d.width
                    rowHeight = maxOf(rowHeight, d.height)
                }
            }

            dim.width = maxOf(dim.width, rowWidth)
            dim.height += rowHeight

            dim.width += insets.left + insets.right + hgap * 2
            dim.height += insets.top + insets.bottom + vgap * 2

            return dim
        }
    }
}
