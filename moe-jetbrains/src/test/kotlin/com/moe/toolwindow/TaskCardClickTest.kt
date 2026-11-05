package com.moe.toolwindow

import com.moe.toolwindow.board.TaskCard
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.JLabel

/**
 * A click on a card's previous or next arrow moves the task and must not also open it. The card installs its click
 * listener on every child, the arrows included, after each arrow's own listener; no TaskCard is built headless.
 */
class TaskCardClickTest {
    private fun source(relative: String): String {
        val path = "src/main/kotlin/com/moe/$relative"
        val file = listOf(File(path), File("moe-jetbrains/$path")).firstOrNull { it.isFile }
            ?: throw IllegalStateException("Source not found: $path")
        return file.readText().replace("\r\n", "\n")
    }

    private fun click(source: JLabel, button: Int = MouseEvent.BUTTON1, clickCount: Int = 1) =
        MouseEvent(source, MouseEvent.MOUSE_CLICKED, 0L, 0, 1, 1, clickCount, false, button)

    @Test
    fun `a click an arrow handled does not open the task`() {
        val arrow = JLabel("\u25B6")
        val opens = mutableListOf<Boolean>()
        // The registration order of TaskCard: the arrow's own listener, then the card's.
        arrow.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = e.consume()
        })
        arrow.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                opens += TaskCard.opensTask(e)
            }
        })

        arrow.dispatchEvent(click(arrow))

        assertEquals("the card's listener still runs, and must not open the task", listOf(false), opens)
    }

    @Test
    fun `a single left click on the card opens the task, and no other click does`() {
        val title = JLabel("A task")
        assertTrue(TaskCard.opensTask(click(title)))
        assertFalse("a right click shows the menu", TaskCard.opensTask(click(title, button = MouseEvent.BUTTON3)))
        assertFalse(TaskCard.opensTask(click(title, clickCount = 2)))
    }

    @Test
    fun `the card's click handler opens the task only through opensTask`() {
        val src = source("toolwindow/board/TaskCard.kt")
        val start = "val dragAdapter = object : MouseAdapter()"
        assertTrue("dragAdapter delimiter must exist", src.contains(start))
        val handler = src.substringAfter(start).substringBefore("override fun mouseDragged")
        assertTrue(handler.contains("if (opensTask(e)) {"))
        assertEquals(1, Regex("onOpen\\(task\\)").findAll(handler).count())
        assertTrue(handler.indexOf("if (opensTask(e)) {") < handler.indexOf("onOpen(task)"))
    }
}
