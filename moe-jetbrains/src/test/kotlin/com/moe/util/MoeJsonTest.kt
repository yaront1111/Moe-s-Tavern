package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import com.moe.model.Task
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

    // ---- Blocker and human-attention metadata: display data only ----

    private val nullSafeGson = GsonBuilder().serializeNulls().create()

    private val blockerKeys = listOf(
        "needsHumanReview",
        "blockedReason",
        "blockedOnTaskIds",
        "blockedResourceId",
        "blockedFromStatus",
        "blockedAt"
    )

    /**
     * The six metadata values a parsed Task must carry, built without the production
     * parsers. [assertBlocker] compares them with Gson's null-serializing view of the
     * parsed Task, so an absent field fails as a dropped key instead of passing as a
     * default, and the suite compiles against a Task that does not declare the fields.
     */
    private fun expectedBlocker(
        needsHumanReview: Boolean = false,
        blockedReason: String? = null,
        blockedOnTaskIds: List<String>? = null,
        blockedResourceId: String? = null,
        blockedFromStatus: String? = null,
        blockedAt: String? = null
    ): JsonObject = JsonObject().apply {
        addProperty("needsHumanReview", needsHumanReview)
        addProperty("blockedReason", blockedReason)
        val ids = blockedOnTaskIds?.let { list -> JsonArray().also { array -> list.forEach { array.add(it) } } }
        add("blockedOnTaskIds", ids ?: JsonNull.INSTANCE)
        addProperty("blockedResourceId", blockedResourceId)
        addProperty("blockedFromStatus", blockedFromStatus)
        addProperty("blockedAt", blockedAt)
    }

    private fun assertBlocker(label: String, expected: JsonObject, task: Task) {
        assertEquals("$label: expectation must name all six keys", blockerKeys.toSet(), expected.keySet())
        val actual = nullSafeGson.toJsonTree(task).asJsonObject
        for (key in blockerKeys) {
            assertTrue("$label: parsed Task dropped $key", actual.has(key))
            assertEquals("$label: $key", expected.get(key), actual.get(key))
        }
    }

    /** A task payload with [members] spliced in verbatim as extra JSON object members. */
    private fun blockerTaskJson(members: String, status: String = "BLOCKED", id: String = "task-blocked"): String {
        val extra = if (members.isBlank()) "" else "$members,"
        return """
        {
          $extra
          "id": "$id",
          "epicId": "epic-blocked",
          "title": "Blocked task",
          "description": "desc",
          "status": "$status",
          "priority": "HIGH",
          "order": 2.25,
          "definitionOfDone": ["dod-1"],
          "reopenReason": "qa reject",
          "assignedWorkerId": "worker-9"
        }
        """.trimIndent()
    }

    private fun blockerMembers(fields: Map<String, String>) =
        fields.entries.joinToString(",\n") { (key, literal) -> "\"$key\": $literal" }

    private fun snapshotTasks(vararg taskJson: String): List<Task> {
        val tasks = parseState(
            """{"project": {"id": "proj-1", "name": "Moe"}, "epics": [], "tasks": [${taskJson.joinToString(",")}]}"""
        ).tasks
        assertEquals("snapshot dropped a task", taskJson.size, tasks.size)
        return tasks
    }

    /** Parses one payload through the single-task update path AND the state snapshot path. */
    private fun bothPaths(taskJson: String, id: String = "task-blocked"): List<Pair<String, Task>> {
        val parsed = listOf("parseTask" to parseTask(taskJson), "parseState" to snapshotTasks(taskJson).single())
        for ((path, task) in parsed) assertEquals("$path lost the task identity", id, task.id)
        return parsed
    }

    private fun assertCompanions(label: String, task: Task, status: String = "BLOCKED") {
        assertEquals("$label: epicId", "epic-blocked", task.epicId)
        assertEquals("$label: title", "Blocked task", task.title)
        assertEquals("$label: status", status, task.status)
        assertEquals("$label: priority", "HIGH", task.priority)
        assertEquals("$label: order", 2.25, task.order, 0.0)
        assertEquals("$label: definitionOfDone", listOf("dod-1"), task.definitionOfDone)
        assertEquals("$label: reopenReason", "qa reject", task.reopenReason)
        assertEquals("$label: assignedWorkerId", "worker-9", task.assignedWorkerId)
    }

    /**
     * Fully populated metadata. The reason is multi-line Unicode with JSON escapes, the
     * dependency ids are out of order with a duplicate, and the timestamp carries an
     * offset and microseconds: every value must survive exactly as sent.
     */
    private val populatedBlockerMembers = """
        "needsHumanReview": true,
        "blockedReason": "Build box busy \u2014 lease held by task-other\n\t\"C:\\moe\\build\" ✓ 日本語 🚧",
        "blockedOnTaskIds": ["task-b", "task-a", "task-b"],
        "blockedResourceId": "jetbrains-gradle",
        "blockedFromStatus": "WORKING",
        "blockedAt": "2026-09-11T12:34:56.789123+03:00"
    """.trimIndent()

    private val populatedBlocker = expectedBlocker(
        needsHumanReview = true,
        blockedReason = "Build box busy \u2014 lease held by task-other\n\t\"C:\\moe\\build\" ✓ 日本語 🚧",
        blockedOnTaskIds = listOf("task-b", "task-a", "task-b"),
        blockedResourceId = "jetbrains-gradle",
        blockedFromStatus = "WORKING",
        blockedAt = "2026-09-11T12:34:56.789123+03:00"
    )

    /** One valid value per key, so every malformed case varies exactly one field. */
    private val validBlockerFields = linkedMapOf(
        "needsHumanReview" to "true",
        "blockedReason" to "\"waiting on task-a\"",
        "blockedOnTaskIds" to "[\"task-a\"]",
        "blockedResourceId" to "\"jetbrains-gradle\"",
        "blockedFromStatus" to "\"REVIEW\"",
        "blockedAt" to "\"2026-09-11T10:00:00Z\""
    )

    private val validBlocker = expectedBlocker(
        needsHumanReview = true,
        blockedReason = "waiting on task-a",
        blockedOnTaskIds = listOf("task-a"),
        blockedResourceId = "jetbrains-gradle",
        blockedFromStatus = "REVIEW",
        blockedAt = "2026-09-11T10:00:00Z"
    )

    @Test
    fun `populated blocker metadata survives snapshot and update parsing`() {
        val json = blockerTaskJson(populatedBlockerMembers)

        for ((path, task) in bothPaths(json)) {
            assertCompanions(path, task)
            assertBlocker(path, populatedBlocker, task)
        }
        assertEquals(parseTask(json), snapshotTasks(json).single())
    }

    @Test
    fun `a gson round trip preserves blocker metadata`() {
        for ((path, parsed) in bothPaths(blockerTaskJson(populatedBlockerMembers))) {
            assertBlocker(path, populatedBlocker, parsed)

            val restored = nullSafeGson.fromJson(nullSafeGson.toJson(parsed), Task::class.java)
            assertBlocker("$path via Gson", populatedBlocker, restored)
            assertEquals("$path via Gson", parsed, restored)

            val restoredJson = nullSafeGson.toJson(restored)
            assertEquals("$path reparsed by parseTask", parsed, parseTask(restoredJson))
            assertEquals("$path reparsed by parseState", parsed, snapshotTasks(restoredJson).single())
        }
    }

    @Test
    fun `absent blocker metadata parses to false and null defaults`() {
        val explicitNulls = blockerMembers(blockerKeys.associateWith { "null" })

        for ((shape, members) in listOf("omitted" to "", "explicit null" to explicitNulls)) {
            for ((path, task) in bothPaths(blockerTaskJson(members))) {
                assertCompanions("$path $shape", task)
                assertBlocker("$path $shape", expectedBlocker(), task)
            }
        }
    }

    @Test
    fun `wrong-kind blocker metadata is ignored field by field`() {
        // A single-member array is the shape Gson's asString and asBoolean silently unwrap.
        val notStrings = listOf("42", "-7.5", "true", "{\"text\": \"x\"}", "[\"x\"]")
        val notBooleans = listOf("\"true\"", "\"false\"", "1", "{\"value\": true}", "[true]")
        val notArrays = listOf("\"task-a\"", "42", "true", "{\"0\": \"task-a\"}")
        val cases = listOf("blockedReason", "blockedResourceId", "blockedFromStatus", "blockedAt")
            .flatMap { key -> notStrings.map { key to it } } +
            notBooleans.map { "needsHumanReview" to it } +
            notArrays.map { "blockedOnTaskIds" to it }
        val neighbour = blockerTaskJson(blockerMembers(validBlockerFields), id = "task-second")

        for ((key, literal) in cases) {
            val label = "$key=$literal"
            val json = blockerTaskJson(blockerMembers(validBlockerFields + (key to literal)))
            val expected = validBlocker.deepCopy().apply {
                add(key, if (key == "needsHumanReview") JsonPrimitive(false) else JsonNull.INSTANCE)
            }
            for ((path, task) in bothPaths(json)) {
                assertCompanions("$path $label", task)
                assertBlocker("$path $label", expected, task)
            }
            val (malformed, valid) = snapshotTasks(json, neighbour)
            assertEquals(label, listOf("task-blocked", "task-second"), listOf(malformed.id, valid.id))
            assertBlocker("neighbour of $label", validBlocker, valid)
        }
    }

    @Test
    fun `blocker dependency arrays keep only real strings in order`() {
        val large = (0 until 10_000).joinToString(",", "[", "]") { if (it % 2 == 0) "\"task-$it\"" else "$it" }
        val arrays = listOf(
            "[\"task-b\", 42, \"task-a\", true, null, {\"id\": \"task-x\"}, [\"task-c\"], \"task-b\", \"\", \"  \", \"42\"]" to
                listOf("task-b", "task-a", "task-b", "", "  ", "42"),
            "[]" to emptyList<String>(),
            "[1, false, null, {}, [\"task-a\"]]" to emptyList<String>(),
            large to (0 until 10_000 step 2).map { "task-$it" }
        )
        for ((literal, ids) in arrays) {
            for ((path, task) in bothPaths(blockerTaskJson("\"blockedOnTaskIds\": $literal"))) {
                assertBlocker("$path ${literal.take(48)}", expectedBlocker(blockedOnTaskIds = ids), task)
            }
        }

        for (members in listOf("", "\"blockedOnTaskIds\": null", "\"blockedOnTaskIds\": \"task-a\"")) {
            for ((path, task) in bothPaths(blockerTaskJson(members))) {
                assertBlocker("$path '$members'", expectedBlocker(), task)
            }
        }
    }

    @Test
    fun `a cleared payload does not inherit earlier blocker metadata`() {
        val explicitClear = blockerMembers(blockerKeys.associateWith { if (it == "needsHumanReview") "false" else "null" })

        val clearedByShape = listOf("omitted" to "", "explicit clear" to explicitClear).map { (shape, members) ->
            val blocked = bothPaths(blockerTaskJson(populatedBlockerMembers))
            val blockedBefore = blocked.map { (_, task) -> nullSafeGson.toJson(task) }

            val cleared = bothPaths(blockerTaskJson(members, status = "WORKING"))
            for ((path, task) in cleared) {
                assertCompanions("$path $shape", task, status = "WORKING")
                assertBlocker("$path $shape after BLOCKED", expectedBlocker(), task)
            }
            for ((index, earlier) in blocked.withIndex()) {
                val (path, task) = earlier
                assertEquals("$path earlier task changed", blockedBefore[index], nullSafeGson.toJson(task))
                assertBlocker("$path earlier task", populatedBlocker, task)
            }
            cleared
        }
        assertEquals(clearedByShape[0], clearedByShape[1])
    }

    @Test
    fun `human attention is independent of status reason and critique`() {
        for ((path, task) in bothPaths(blockerTaskJson("\"needsHumanReview\": true", status = "REVIEW"))) {
            assertCompanions("$path REVIEW", task, status = "REVIEW")
            assertBlocker("$path REVIEW", expectedBlocker(needsHumanReview = true), task)
        }

        val humanReason = "Needs human review: an operator must confirm the approach"
        val soundsHuman = blockerTaskJson(
            "\"blockedReason\": \"$humanReason\", " +
                "\"planCritiqueResult\": {\"verdict\": \"block\", \"concerns\": [\"needs a human decision\"]}"
        )
        for ((path, task) in bothPaths(soundsHuman)) {
            assertEquals("$path critique", "block", requireNotNull(task.planCritiqueResult).verdict)
            assertBlocker("$path human-sounding BLOCKED", expectedBlocker(blockedReason = humanReason), task)
        }

        val dataOnly = linkedMapOf(
            "blockedReason" to "\"\"",
            "blockedOnTaskIds" to "[\"\"]",
            "blockedResourceId" to "\" \"",
            "blockedFromStatus" to "\"NOT_A_STATUS\"",
            "blockedAt" to "\"last tuesday\""
        )
        val asSent = expectedBlocker(
            blockedReason = "",
            blockedOnTaskIds = listOf(""),
            blockedResourceId = " ",
            blockedFromStatus = "NOT_A_STATUS",
            blockedAt = "last tuesday"
        )
        for ((path, task) in bothPaths(blockerTaskJson(blockerMembers(dataOnly), status = "WORKING"))) {
            assertCompanions("$path WORKING", task, status = "WORKING")
            assertBlocker("$path WORKING", asSent, task)
        }
    }

    @Test
    fun `legacy task fields keep their permissive coercion`() {
        val legacy = """{"id": "task-legacy", "epicId": "epic-legacy", "title": 42, "hasPendingQuestion": "true"}"""

        for ((path, task) in bothPaths(legacy, id = "task-legacy")) {
            assertEquals("$path numeric title", "42", task.title)
            assertTrue("$path string hasPendingQuestion", task.hasPendingQuestion)
        }
    }
}
