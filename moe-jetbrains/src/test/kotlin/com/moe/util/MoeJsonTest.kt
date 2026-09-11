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

    private fun parseTask(taskJson: String) =
        MoeJson.parseTask(JsonParser.parseString(taskJson).asJsonObject)

    private fun parseSnapshotTask(taskJson: String) = parseState(
        """
        {
          "project": { "id": "proj-1", "name": "Moe" },
          "epics": [],
          "tasks": [$taskJson]
        }
        """.trimIndent()
    ).tasks.single()

    /**
     * One live task payload. [legacyField] is spliced in verbatim so a caller can
     * add a deprecated key the client no longer models; everything else is the live
     * runtime data that must survive such a payload completely untouched.
     */
    private fun liveTaskJson(legacyField: String = ""): String {
        val legacy = if (legacyField.isBlank()) "" else "$legacyField,"
        return """
        {
          $legacy
          "id": "task-live",
          "epicId": "epic-live",
          "title": "Live task",
          "description": "desc",
          "status": "WORKING",
          "priority": "HIGH",
          "order": 3.5,
          "definitionOfDone": ["dod-1", "dod-2"],
          "prLink": "https://example.test/pr/1",
          "reopenReason": "qa reject",
          "assignedWorkerId": "worker-1",
          "hasPendingQuestion": true,
          "contextFetchedBy": ["worker-1"],
          "stepsCompleted": ["step-1"],
          "reopenCount": 2,
          "taskRails": ["rail-1"],
          "comments": [
            {
              "id": "c-1",
              "author": "qa-1",
              "content": "looks good",
              "timestamp": "2026-09-11T10:02:00.000Z"
            }
          ],
          "metrics": {
            "plannedStepCount": 6,
            "plannedDistinctFileCount": 4,
            "executedStepCount": 5,
            "reopenCount": 2,
            "rejectCount": 1,
            "wallClockMs": 600000,
            "firstClaimAt": "2026-09-11T10:00:00.000Z",
            "doneAt": "2026-09-11T10:10:00.000Z"
          },
          "priorHandoffs": [
            {
              "from": "worker-1",
              "to": "qa-1",
              "createdAt": "2026-09-11T10:09:00.000Z",
              "whatIsDone": "parser",
              "whatRemains": "review",
              "pitfalls": "two call sites",
              "openQuestions": "none"
            }
          ],
          "failedDodItems": [
            { "item": "dod-2", "rejectedAt": "2026-09-11T09:00:00.000Z", "rejectedBy": "qa-1" }
          ],
          "planCritiqueResult": {
            "verdict": "approve",
            "concerns": ["watch the second constructor"],
            "reviewedBy": "governor-1",
            "reviewedAt": "2026-09-11T09:30:00.000Z"
          },
          "planSizeWarnings": ["6 steps"],
          "verification": {
            "command": "gradlew test",
            "exitCode": 0,
            "outputTail": "BUILD SUCCESSFUL",
            "reportedAt": "2026-09-11T10:10:00.000Z"
          },
          "reviewSummary": "verified",
          "implementationPlan": [
            {
              "stepId": "step-1",
              "description": "Implement",
              "status": "COMPLETED",
              "affectedFiles": ["src/A.kt"],
              "modifiedFiles": ["src/A.kt", "src/B.kt"],
              "note": "verified",
              "startedAt": "2026-09-11T10:00:00.000Z",
              "completedAt": "2026-09-11T10:08:00.000Z"
            }
          ]
        }
        """.trimIndent()
    }

    /**
     * The same task as [liveTaskJson] but with wrong-typed values on fields that have
     * nothing to do with the legacy time budget, so a caller can prove the parser stayed
     * as permissive about unrelated malformed input as it has always been.
     */
    private fun malformedTaskJson(legacyField: String): String {
        return """
        {
          $legacyField,
          "id": "task-live",
          "epicId": "epic-live",
          "title": "Live task",
          "description": "desc",
          "status": "WORKING",
          "order": "not-a-number",
          "reopenCount": "two",
          "definitionOfDone": "dod-1",
          "taskRails": 9,
          "comments": "none",
          "metrics": "none",
          "implementationPlan": {},
          "reviewSummary": "verified"
        }
        """.trimIndent()
    }

    /** The deprecated per-task time-budget payload, fully populated with its timestamps. */
    private val populatedLegacyTimeBudget =
        "\"budget\": {\"wallClockMs\": 600000, \"warnedAt\": \"2026-09-11T10:05:00.000Z\"," +
            " \"escalatedAt\": \"2026-09-11T10:09:00.000Z\"}"

    /** Every legacy time-budget shape the daemon has persisted, plus the malformed ones. */
    private val legacyTimeBudgetShapes = listOf(
        "\"budget\": null",
        "\"budget\": {}",
        "\"budget\": {\"wallClockMs\": 600000}",
        populatedLegacyTimeBudget,
        "\"budget\": \"45m\"",
        "\"budget\": 42",
        "\"budget\": []"
    )

    @Test
    fun `a populated legacy time budget does not change the parsed task`() {
        val withoutLegacy = parseTask(liveTaskJson())
        val withLegacy = parseTask(liveTaskJson(populatedLegacyTimeBudget))

        assertEquals(withoutLegacy, withLegacy)
    }

    @Test
    fun `a populated legacy time budget does not change the snapshot task`() {
        val withoutLegacy = parseSnapshotTask(liveTaskJson())
        val withLegacy = parseSnapshotTask(liveTaskJson(populatedLegacyTimeBudget))

        assertEquals(withoutLegacy, withLegacy)
        assertEquals(parseTask(liveTaskJson(populatedLegacyTimeBudget)), withLegacy)
    }

    @Test
    fun `every legacy time budget shape parses identically through both paths`() {
        val baselineSingle = parseTask(liveTaskJson())
        val baselineSnapshot = parseSnapshotTask(liveTaskJson())

        for (shape in legacyTimeBudgetShapes) {
            assertEquals("single-task parse changed for $shape", baselineSingle, parseTask(liveTaskJson(shape)))
            assertEquals(
                "snapshot parse changed for $shape",
                baselineSnapshot,
                parseSnapshotTask(liveTaskJson(shape))
            )
        }
    }

    @Test
    fun `live runtime data survives a legacy time budget payload`() {
        for (shape in legacyTimeBudgetShapes + "") {
            val task = parseTask(liveTaskJson(shape))

            assertEquals("task-live", task.id)
            assertEquals("epic-live", task.epicId)
            assertEquals("WORKING", task.status)
            assertEquals(3.5, task.order, 0.0)
            assertEquals(2, task.reopenCount)
            assertEquals(listOf("dod-1", "dod-2"), task.definitionOfDone)
            assertEquals(listOf("rail-1"), task.taskRails)
            assertEquals(listOf("step-1"), task.stepsCompleted)
            assertTrue(task.hasPendingQuestion)

            val metrics = requireNotNull(task.metrics) { "metrics dropped for $shape" }
            assertEquals(600000L, metrics.wallClockMs)
            assertEquals("2026-09-11T10:00:00.000Z", metrics.firstClaimAt)
            assertEquals("2026-09-11T10:10:00.000Z", metrics.doneAt)
            assertEquals(6, metrics.plannedStepCount)
            assertEquals(4, metrics.plannedDistinctFileCount)
            assertEquals(5, metrics.executedStepCount)
            assertEquals(2, metrics.reopenCount)
            assertEquals(1, metrics.rejectCount)

            val step = task.implementationPlan.single()
            assertEquals("step-1", step.stepId)
            assertEquals("COMPLETED", step.status)
            assertEquals(listOf("src/A.kt", "src/B.kt"), step.modifiedFiles)
            assertEquals("verified", step.note)

            val comment = requireNotNull(task.comments) { "comments dropped for $shape" }.single()
            assertEquals("c-1", comment.id)
            assertEquals("looks good", comment.content)

            assertEquals("approve", requireNotNull(task.planCritiqueResult).verdict)
            assertEquals("dod-2", requireNotNull(task.failedDodItems).single().item)
            assertEquals("qa-1", requireNotNull(task.priorHandoffs).single().to)
            assertEquals(listOf("6 steps"), task.planSizeWarnings)
            assertEquals(0, requireNotNull(task.verification).exitCode)
            assertEquals("verified", task.reviewSummary)
        }
    }

    @Test
    fun `a malformed legacy time budget leaves unrelated error handling intact`() {
        for (shape in listOf("\"budget\": \"45m\"", "\"budget\": []", populatedLegacyTimeBudget)) {
            val single = parseTask(malformedTaskJson(shape))
            val snapshot = parseSnapshotTask(malformedTaskJson(shape))

            assertEquals("parser paths disagreed for $shape", single, snapshot)
            assertEquals("task-live", single.id)
            assertEquals("Live task", single.title)
            assertEquals("WORKING", single.status)
            assertEquals(0.0, single.order, 0.0)
            assertEquals(0, single.reopenCount)
            assertEquals(emptyList<String>(), single.definitionOfDone)
            assertNull(single.taskRails)
            assertEquals(emptyList<Any>(), single.comments)
            assertNull(single.metrics)
            assertTrue(single.implementationPlan.isEmpty())
            assertEquals("verified", single.reviewSummary)
        }
    }
}
