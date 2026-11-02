package com.moe.toolwindow

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.moe.model.Task
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * One client-neutral corpus, three consumers: JetBrains' TaskBlockerPresentation here, and moe-vscode's
 * TaskDetailPanel.ts and media/board.js in VSC-9 (task-06dda5c1, tests/blocker-corpus.test.cjs). Same rule as
 * ClientVerdictCorpusTest (CQ-I06b): a row the clients disagree on is fixed or filed, never given a
 * client-specific expectation.
 *
 * Only the cause, the prerequisite ids and the attention flag are shared. Wording differs by client on purpose.
 * Each row's `task` is the daemon's /ws task frame, parsed exactly as the client parses it.
 */
class BlockerCorpusTest {
    private val corpus = loadCorpus()
    private val rows: List<JsonObject> = corpus.getAsJsonArray("rows").map { it.asJsonObject }

    @Test
    fun `the corpus is well formed`() {
        val problems = mutableListOf<String>()
        if (corpus.get("version")?.takeIf { it.isJsonPrimitive }?.asString != "1") problems += "version: expected 1"
        if (rows.size < 14) problems += "rows: ${rows.size}, expected at least 14"
        val ids = rows.map { it.get("id")?.takeIf { e -> e.isJsonPrimitive }?.asString ?: "?" }
        ids.groupBy { it }.filter { it.value.size > 1 }.keys.forEach { problems += "$it: duplicate id" }
        rows.forEachIndexed { index, row ->
            val id = ids[index]
            if (!id.matches(ID)) problems += "$id: id does not match B[0-9]{2}"
            rowProblems(row).forEach { problems += "$id: $it" }
        }
        assertEquals("malformed rows", emptyList<String>(), problems)
    }

    @Test
    fun `every row reaches its cause, prerequisites and attention flag`() {
        val failures = rows.mapNotNull { row ->
            val id = row.get("id").asString
            val problem = try { replayMismatch(row) } catch (e: Exception) { "threw $e" }
            problem?.let { "$id: $it" }
        }
        assertEquals("blocker rows that diverge", emptyList<String>(), failures)
    }

    private data class Observed(val cause: String?, val prerequisiteIds: List<String>, val needsHumanReview: Boolean)

    private fun observe(task: Task) = Observed(
        TaskBlockerPresentation.cause(task)?.name,
        TaskBlockerPresentation.prerequisiteIds(task),
        TaskBlockerPresentation.badges(task).needsHumanReview
    )

    private fun replayMismatch(row: JsonObject): String? {
        val task = row.getAsJsonObject("task")
        val snapshot = JsonObject().apply {
            add("project", JsonObject().apply { addProperty("id", "proj-corpus"); addProperty("name", "corpus") })
            add("epics", JsonArray())
            add("tasks", JsonArray().apply { add(task.deepCopy()) })
        }
        val viaTask = observe(MoeJson.parseTask(task.deepCopy()))
        val viaState = observe(MoeJson.parseState(snapshot).tasks.single())
        if (viaTask != viaState) return "parseTask gave $viaTask, parseState gave $viaState"
        val expected = Observed(
            row.get("cause").takeUnless { it.isJsonNull }?.asString,
            row.getAsJsonArray("prerequisiteIds").map { it.asString },
            row.get("needsHumanReview").asBoolean
        )
        return if (expected == viaTask) null
        else "expected (${expected.cause}, ${expected.prerequisiteIds}, ${expected.needsHumanReview}), " +
            "got (${viaTask.cause}, ${viaTask.prerequisiteIds}, ${viaTask.needsHumanReview})"
    }

    private fun rowProblems(row: JsonObject): List<String> {
        val problems = mutableListOf<String>()
        if (!isString(row.get("note")) || row.get("note").asString.isEmpty()) problems += "note must be a non-empty string"
        val task = row.get("task")
        if (task == null || !task.isJsonObject) {
            problems += "task must be an object"
        } else {
            val obj = task.asJsonObject
            if (!isString(obj.get("id"))) problems += "task.id must be a string"
            if (!isString(obj.get("epicId"))) problems += "task.epicId must be a string"
            obj.keySet().filter { it !in TASK_MEMBERS }.forEach { problems += "task.$it is not a member this corpus uses" }
        }
        val cause = row.get("cause")
        if (cause == null || !(cause.isJsonNull || (isString(cause) && cause.asString in CAUSES))) {
            problems += "cause must be one of $CAUSES or null"
        }
        val ids = row.get("prerequisiteIds")
        if (ids == null || !ids.isJsonArray || ids.asJsonArray.any { !isString(it) }) problems += "prerequisiteIds must be an array of strings"
        val flag = row.get("needsHumanReview")
        if (flag == null || !flag.isJsonPrimitive || !flag.asJsonPrimitive.isBoolean) problems += "needsHumanReview must be a boolean"
        return problems
    }

    private fun isString(e: JsonElement?): Boolean = e != null && e.isJsonPrimitive && e.asJsonPrimitive.isString

    private fun loadCorpus(): JsonObject {
        val stream = javaClass.getResourceAsStream(RESOURCE) ?: throw AssertionError("$RESOURCE is missing from the test classpath")
        return try {
            stream.reader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonObject }
        } catch (e: Exception) {
            throw AssertionError("$RESOURCE is unreadable: $e", e)
        }
    }

    private companion object {
        const val RESOURCE = "/client-blocker.json"
        val ID = Regex("B[0-9]{2}")
        val CAUSES = BlockCause.entries.map { it.name }.toSet()
        val TASK_MEMBERS = setOf(
            "id", "epicId", "status", "needsHumanReview",
            "blockedReason", "blockedOnTaskIds", "blockedResourceId", "blockedFromStatus", "blockedAt"
        )
    }
}
