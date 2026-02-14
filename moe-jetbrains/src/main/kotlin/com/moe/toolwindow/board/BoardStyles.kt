package com.moe.toolwindow.board

import com.intellij.ui.JBColor
import java.awt.Color

object BoardStyles {
    val boardBackground = JBColor(Color(0xF5F6F8), Color(0x1E1F22))
    val columnBackground = JBColor(Color(0xFFFFFF), Color(0x2B2D30))
    val columnHeaderBackground = JBColor(Color(0xF1F3F5), Color(0x26282C))
    val cardBackground = JBColor(Color(0xFFFFFF), Color(0x313337))
    val cardHoverBackground = JBColor(Color(0xF7F9FB), Color(0x3A3D41))
    val borderColor = JBColor(Color(0xD9DDE1), Color(0x3C3F44))
    val textPrimary = JBColor(Color(0x1F2328), Color(0xE6E6E6))
    val textSecondary = JBColor(Color(0x6B7280), Color(0xA7ABB1))
    val connectedBackground = JBColor(Color(0xDCFCE7), Color(0x1F2D1F))
    val connectedText = JBColor(Color(0x166534), Color(0x86EFAC))
    val disconnectedBackground = JBColor(Color(0xFEE2E2), Color(0x321C1C))
    val disconnectedText = JBColor(Color(0x991B1B), Color(0xFCA5A5))

    const val columnWidth = 260

    private data class StatusPalette(val light: Color, val dark: Color)

    private fun palette(status: String): StatusPalette {
        return when (status) {
            "BACKLOG" -> StatusPalette(Color(0x9AA0A6), Color(0x8C8F94))
            "PLANNING" -> StatusPalette(Color(0x3B82F6), Color(0x60A5FA))
            "AWAITING_APPROVAL" -> StatusPalette(Color(0xF59E0B), Color(0xFBBF24))
            "WORKING" -> StatusPalette(Color(0x14B8A6), Color(0x2DD4BF))
            "REVIEW" -> StatusPalette(Color(0x10B981), Color(0x34D399))
            "DONE" -> StatusPalette(Color(0x16A34A), Color(0x22C55E))
            "PLANNED" -> StatusPalette(Color(0x9AA0A6), Color(0x8C8F94))
            "ACTIVE" -> StatusPalette(Color(0x3B82F6), Color(0x60A5FA))
            "COMPLETED" -> StatusPalette(Color(0x16A34A), Color(0x22C55E))
            else -> StatusPalette(Color(0x9AA0A6), Color(0x8C8F94))
        }
    }

    fun statusColor(status: String): JBColor {
        val palette = palette(status)
        return JBColor(palette.light, palette.dark)
    }

    fun statusTint(status: String): JBColor {
        val palette = palette(status)
        val light = Color(palette.light.red, palette.light.green, palette.light.blue, 32)
        val dark = Color(palette.dark.red, palette.dark.green, palette.dark.blue, 48)
        return JBColor(light, dark)
    }
}
