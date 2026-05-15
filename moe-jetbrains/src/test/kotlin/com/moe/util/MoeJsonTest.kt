package com.moe.util

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class MoeJsonTest {
    private fun parseState(json: String) =
        MoeJson.parseState(JsonParser.parseString(json).asJsonObject)

    @Test
    fun `parseState preserves project settings from daemon snapshot`() {
        val state = parseState(
            """
            {
              "project": {
                "id": "proj-1",
                "name": "Moe",
                "rootPath": "D:/work/moe",
                "settings": {
                  "approvalMode": "TURBO",
                  "speedModeDelayMs": 1234,
                  "autoCreateBranch": false,
                  "branchPattern": "custom/{taskId}",
                  "commitPattern": "fix: {taskTitle}",
                  "agentCommand": "codex",
                  "enableAgentTeams": true,
                  "columnLimits": { "WORKING": 2, "REVIEW": 3 }
                }
              },
              "epics": [],
              "tasks": []
            }
            """.trimIndent()
        )

        val settings = state.project.settings
        requireNotNull(settings)
        assertEquals("TURBO", settings.approvalMode)
        assertEquals(1234, settings.speedModeDelayMs)
        assertFalse(settings.autoCreateBranch)
        assertEquals("custom/{taskId}", settings.branchPattern)
        assertEquals("fix: {taskTitle}", settings.commitPattern)
        assertEquals("codex", settings.agentCommand)
        assertEquals(true, settings.enableAgentTeams)
        assertEquals(mapOf("WORKING" to 2, "REVIEW" to 3), settings.columnLimits)
    }

    @Test
    fun `parseState falls back safely for malformed optional settings`() {
        val state = parseState(
            """
            {
              "project": {
                "id": "proj-1",
                "name": "Moe",
                "settings": {
                  "approvalMode": 42,
                  "speedModeDelayMs": "slow",
                  "autoCreateBranch": {},
                  "agentCommand": null,
                  "enableAgentTeams": [],
                  "columnLimits": "none"
                }
              },
              "epics": [],
              "tasks": []
            }
            """.trimIndent()
        )

        val settings = state.project.settings
        requireNotNull(settings)
        assertEquals("CONTROL", settings.approvalMode)
        assertEquals(2000, settings.speedModeDelayMs)
        assertEquals(true, settings.autoCreateBranch)
        assertEquals("claude", settings.agentCommand)
        assertEquals(false, settings.enableAgentTeams)
        assertNull(settings.columnLimits)
    }

    @Test
    fun `parseState preserves task runtime fields and step metadata`() {
        val state = parseState(
            """
            {
              "project": { "id": "proj-1", "name": "Moe" },
              "epics": [],
              "tasks": [
                {
                  "id": "task-1",
                  "epicId": "epic-1",
                  "title": "Runtime task",
                  "description": "desc",
                  "status": "WORKING",
                  "priority": "HIGH",
                  "order": 1,
                  "definitionOfDone": ["done"],
                  "taskRails": ["rail"],
                  "contextFetchedBy": ["worker-1"],
                  "stepsCompleted": ["step-1"],
                  "reopenCount": 2,
                  "implementationPlan": [
                    {
                      "stepId": "step-1",
                      "description": "Implement",
                      "status": "COMPLETED",
                      "affectedFiles": ["src/A.kt"],
                      "modifiedFiles": ["src/A.kt", "src/B.kt"],
                      "note": "verified",
                      "startedAt": "2026-04-28T01:00:00.000Z",
                      "completedAt": "2026-04-28T02:00:00.000Z"
                    }
                  ]
                }
              ]
            }
            """.trimIndent()
        )

        val task = state.tasks.single()
        assertEquals(2, task.reopenCount)
        assertEquals(listOf("rail"), task.taskRails)
        assertEquals(listOf("worker-1"), task.contextFetchedBy)
        assertEquals(listOf("step-1"), task.stepsCompleted)

        val step = task.implementationPlan.single()
        assertEquals(listOf("src/A.kt", "src/B.kt"), step.modifiedFiles)
        assertEquals("verified", step.note)
        assertEquals("2026-04-28T01:00:00.000Z", step.startedAt)
        assertEquals("2026-04-28T02:00:00.000Z", step.completedAt)
    }
}
