package com.moe.toolwindow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.awt.event.ItemEvent
import javax.swing.JComboBox

class CreateTaskDialogTest {
    @Test
    fun `fresh project can select create epic after the listener is installed`() {
        val createNew = "Create New Epic..."
        val combo = JComboBox(CreateTaskDialog.epicSelectionModel(emptyList(), createNew))
        var createRequests = 0
        combo.addItemListener { event ->
            if (event.stateChange == ItemEvent.SELECTED && event.item == createNew) {
                createRequests++
            }
        }

        combo.selectedItem = createNew

        assertEquals("Selecting the only option must open epic creation", 1, createRequests)
    }

    @Test
    fun `fresh project has no selected epic`() {
        val model = CreateTaskDialog.epicSelectionModel(emptyList(), "Create New Epic...")

        assertNull(model.selectedItem)
        assertEquals(1, model.size)
    }

    @Test
    fun `existing project keeps its first epic selected`() {
        val model = CreateTaskDialog.epicSelectionModel(listOf("First epic", "Second epic"), "Create New Epic...")

        assertEquals("First epic", model.selectedItem)
        assertEquals(3, model.size)
        assertEquals("Create New Epic...", model.getElementAt(2))
    }
}
