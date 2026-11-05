package com.moe.toolwindow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** File path linkification in chat (J10): a path inside a URL or a markdown link's anchor was cut into a file:// link. */
class ChatPanelLinkifyTest {
    @Test
    fun `a markdown link's anchor is left whole`() {
        val anchor = "<a href=\"https://example.com/docs/guide\">see src/guide.md</a>"
        assertEquals("read $anchor now", ChatPanel.linkifyPaths("read $anchor now"))
    }

    @Test
    fun `a bare URL is left whole`() {
        val text = "PR https://github.com/org/repo/pull/12 is open"
        assertEquals(text, ChatPanel.linkifyPaths(text))
    }

    @Test
    fun `a bare file path is linked, with its line`() {
        assertEquals(
            "see <a href=\"file://src/foo.ts:12\">src/foo.ts:12</a> and <a href=\"file://docs/a.md\">docs/a.md</a>",
            ChatPanel.linkifyPaths("see src/foo.ts:12 and docs/a.md")
        )
    }

    @Test
    fun `a path after a URL is still linked`() {
        assertEquals(
            "https://example.com/a/b then <a href=\"file://src/x.kt\">src/x.kt</a>",
            ChatPanel.linkifyPaths("https://example.com/a/b then src/x.kt")
        )
    }

    @Test
    fun `markdownToHtml links paths through linkifyPaths`() {
        val path = "src/main/kotlin/com/moe/toolwindow/ChatPanel.kt"
        val file = listOf(File(path), File("moe-jetbrains/$path")).first { it.isFile }
        val src = file.readText().replace("\r\n", "\n")
        val body = src.substringAfter("private fun markdownToHtml(").substringBefore("private fun createMessageBubble(")
        assertTrue(body.contains("processed = linkifyPaths(processed)"))
    }
}
