package com.moe.util

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
                  "agentCommand": "codex",
                  "enableAgentTeams": true,
                  "columnLimits": { "WORKING": 2, "REVIEW": 3 },
                  "autoCommit": false,
                  "checkpointCommits": false,
                  "checkpointPush": false,
                  "commitBoardState": false,
                  "commitHooks": true,
                  "consolidationBranch": "moe/work-*",
                  "qualityGate": "npm run lint",
                  "qualityGateScope": "everyTask",
                  "attribution": { "undeclared": "never" },
                  "taskSizing": {
                    "warnSteps": 3,
                    "maxSteps": 6,
                    "warnDistinctFiles": 2,
                    "maxDistinctFiles": 4
                  }
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
        assertEquals("codex", settings.agentCommand)
        assertEquals(true, settings.enableAgentTeams)
        assertEquals(mapOf("WORKING" to 2, "REVIEW" to 3), settings.columnLimits)
        assertFalse(settings.autoCommit)
        assertFalse(settings.checkpointCommits)
        assertFalse(settings.checkpointPush)
        assertFalse(settings.commitBoardState)
        assertTrue(settings.commitHooks)
        assertEquals("moe/work-*", settings.consolidationBranch)
        assertEquals("npm run lint", settings.qualityGate)
        assertEquals("everyTask", settings.qualityGateScope)
        assertEquals("never", settings.attributionUndeclared)
        assertEquals(3, settings.taskSizing.warnSteps)
        assertEquals(6, settings.taskSizing.maxSteps)
        assertEquals(2, settings.taskSizing.warnDistinctFiles)
        assertEquals(4, settings.taskSizing.maxDistinctFiles)
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
                  "agentCommand": null,
                  "enableAgentTeams": [],
                  "columnLimits": "none",
                  "autoCommit": "no",
                  "checkpointCommits": {},
                  "commitHooks": "true",
                  "qualityGateScope": "whenever",
                  "attribution": [],
                  "taskSizing": { "warnSteps": 0, "maxSteps": -4 }
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
        assertEquals("claude", settings.agentCommand)
        assertEquals(false, settings.enableAgentTeams)
        assertNull(settings.columnLimits)
        // The daemon reads these as `settings.X !== false`, so any non-boolean is
        // TRUE. Gson's asBoolean would turn the string "no" into false.
        assertTrue(settings.autoCommit)
        assertTrue(settings.checkpointCommits)
        // commitHooks is `settings.commitHooks === true`, so the string "true" is FALSE.
        assertFalse(settings.commitHooks)
        assertEquals("epicFinal", settings.qualityGateScope)
        assertEquals("solo", settings.attributionUndeclared)
        assertEquals(8, settings.taskSizing.warnSteps)
        assertEquals(12, settings.taskSizing.maxSteps)
    }

    @Test
    fun `settings absent from project json parse to the daemon defaults`() {
        val state = parseState(
            """
            {
              "project": { "id": "proj-1", "name": "Moe" },
              "epics": [],
              "tasks": []
            }
            """.trimIndent()
        )

        val settings = state.project.settings
        requireNotNull(settings)
        assertTrue(settings.autoCommit)
        assertTrue(settings.checkpointCommits)
        assertTrue(settings.checkpointPush)
        assertTrue(settings.commitBoardState)
        assertFalse(settings.commitHooks)
        assertEquals("", settings.consolidationBranch)
        assertEquals("", settings.qualityGate)
        assertEquals("epicFinal", settings.qualityGateScope)
        assertEquals("solo", settings.attributionUndeclared)
        assertEquals(8, settings.taskSizing.warnSteps)
        assertEquals(12, settings.taskSizing.maxSteps)
        assertEquals(5, settings.taskSizing.warnDistinctFiles)
        assertEquals(10, settings.taskSizing.maxDistinctFiles)
    }

    @Test
    fun `an inverted task sizing band lifts max to warn`() {
        val state = parseState(
            """
            {
              "project": {
                "id": "proj-1",
                "name": "Moe",
                "settings": { "taskSizing": { "warnSteps": 9, "maxSteps": 2 } }
              },
              "epics": [],
              "tasks": []
            }
            """.trimIndent()
        )

        val settings = state.project.settings
        requireNotNull(settings)
        assertEquals(9, settings.taskSizing.warnSteps)
        assertEquals(9, settings.taskSizing.maxSteps)
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
