package com.moe.toolwindow

import com.moe.model.ChatChannel
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class ChatChannelSelectionTest {
    private val general = ChatChannel("chan-general", "general", "general")
    private val zeta = ChatChannel("chan-zeta", "zeta", "custom")
    private val alpha = ChatChannel("chan-alpha", "alpha", "role")
    private val qa = ChatChannel("chan-qa", "qa", "role")

    @Test
    fun stillListedPreviousIdIsKept() {
        assertSame(qa, ChatChannelSelection.choose(listOf(zeta, general, qa), "chan-qa"))
        assertSame(zeta, ChatChannelSelection.choose(listOf(general, zeta), "chan-zeta"))
    }

    @Test
    fun goneIdFallsBackToGeneralType() {
        assertSame(general, ChatChannelSelection.choose(listOf(zeta, general), "chan-deleted"))
    }

    @Test
    fun goneIdWithoutGeneralFallsBackToFirstInListOrder() {
        assertSame(zeta, ChatChannelSelection.choose(listOf(zeta, alpha), "chan-deleted"))
    }

    @Test
    fun noPreviousIdPicksGeneralElseFirst() {
        assertSame(general, ChatChannelSelection.choose(listOf(zeta, general), null))
        assertSame(zeta, ChatChannelSelection.choose(listOf(zeta, alpha), null))
    }

    @Test
    fun emptyListYieldsNull() {
        assertNull(ChatChannelSelection.choose(emptyList(), "chan-general"))
        assertNull(ChatChannelSelection.choose(emptyList(), null))
    }

    @Test
    fun firstOfTwoGeneralTypeChannelsWins() {
        val general2 = ChatChannel("chan-general-2", "general2", "general")
        assertSame(general, ChatChannelSelection.choose(listOf(zeta, general, general2), null))
        assertSame(general2, ChatChannelSelection.choose(listOf(zeta, general2, general), "chan-deleted"))
    }
}
