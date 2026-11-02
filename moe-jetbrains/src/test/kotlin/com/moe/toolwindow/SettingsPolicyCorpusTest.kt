package com.moe.toolwindow

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.moe.model.ProjectSettings
import com.moe.toolwindow.MoeSettingsDialog.PolicyRow
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * One client-neutral corpus, two consumers: moe-vscode's settings row (VSC-10, task-743e577a) replays the same bytes
 * through its own landing-policy rows. Same rule as ClientVerdictCorpusTest (CQ-I06b): a row the clients disagree on is
 * fixed or filed, never given a client-specific expectation.
 *
 * Each row's `settings` is the daemon's /ws `project.settings` block (null or an object), parsed exactly as the client
 * parses a STATE_SNAPSHOT (null stays null: no snapshot yet), and `expect` is the effective-policy rows the settings
 * dialog shows, order included. Rows P17 to P19 carry wire types the daemon and wrappers read strictly.
 */
class SettingsPolicyCorpusTest {
    private val corpus = loadCorpus()
    private val rows: List<JsonObject> = corpus.getAsJsonArray("rows").map { it.asJsonObject }

    @Test
    fun `the corpus is well formed`() {
        val problems = mutableListOf<String>()
        if (corpus.get("version")?.takeIf { it.isJsonPrimitive }?.asString != "1") problems += "version: expected 1"
        if (rows.size < 10) problems += "rows: ${rows.size}, expected at least 10"
        val ids = rows.map { it.get("id")?.takeIf { e -> e.isJsonPrimitive }?.asString ?: "?" }
        ids.groupBy { it }.filter { it.value.size > 1 }.keys.forEach { problems += "$it: duplicate id" }
        rows.forEachIndexed { index, row ->
            val id = ids[index]
            if (!id.matches(ID)) problems += "$id: id does not match P[0-9]{2}"
            rowProblems(row).forEach { problems += "$id: $it" }
        }
        assertEquals("malformed rows", emptyList<String>(), problems)
    }

    @Test
    fun `every row renders its expected policy rows`() {
        val failures = rows.mapNotNull { row ->
            val id = row.get("id").asString
            val problem = try { renderMismatch(row) } catch (e: Exception) { "threw $e" }
            problem?.let { "$id: $it" }
        }
        assertEquals("policy rows that diverge", emptyList<String>(), failures)
    }

    private fun renderMismatch(row: JsonObject): String? {
        val actual = MoeSettingsDialog.effectivePolicyRows(parsedSettings(row.get("settings")))
        val expected = row.getAsJsonArray("expect").map {
            val e = it.asJsonObject
            PolicyRow(e.get("label").asString, e.get("value").asString, e.get("detail").asString)
        }
        if (expected == actual) return null
        val differing = (0 until maxOf(expected.size, actual.size)).filter { expected.getOrNull(it) != actual.getOrNull(it) }
        return differing.joinToString("; ") { "row $it expected ${expected.getOrNull(it)}, got ${actual.getOrNull(it)}" }
    }

    /** Null stays null (no snapshot yet); an object takes the STATE_SNAPSHOT path, the only settings parse the client has. */
    private fun parsedSettings(settings: JsonElement): ProjectSettings? {
        if (settings.isJsonNull) return null
        val snapshot = JsonObject().apply {
            add("project", JsonObject().apply {
                addProperty("id", "proj-corpus")
                addProperty("name", "corpus")
                add("settings", settings.deepCopy())
            })
            add("epics", JsonArray())
            add("tasks", JsonArray())
        }
        return requireNotNull(MoeJson.parseState(snapshot).project.settings) { "parseState dropped the settings block" }
    }

    private fun rowProblems(row: JsonObject): List<String> {
        val problems = mutableListOf<String>()
        val note = row.get("note")
        if (note == null || !note.isJsonPrimitive || !note.asJsonPrimitive.isString || note.asString.isEmpty()) problems += "note must be a non-empty string"
        val settings = row.get("settings")
        when {
            settings == null -> problems += "settings member is missing"
            settings.isJsonNull -> Unit
            settings.isJsonObject -> problems += unknownMembers("settings", settings.asJsonObject, POLICY_SHAPE)
            else -> problems += "settings must be null or an object"
        }
        val expect = row.get("expect")
        if (expect == null || !expect.isJsonArray) problems += "expect must be an array"
        else expect.asJsonArray.forEachIndexed { i, e -> expectProblems(e).forEach { problems += "expect[$i]: $it" } }
        return problems
    }

    /** A key the policy never reads is a typo that would pass as a default; a nested shape of null marks a leaf key. */
    private fun unknownMembers(path: String, obj: JsonObject, shape: Map<String, Set<String>?>): List<String> =
        obj.keySet().flatMap { key ->
            val nested = shape[key]
            val value = obj.get(key)
            when {
                key !in shape -> listOf("$path.$key is not a policy member")
                nested == null -> emptyList()
                !value.isJsonObject -> listOf("$path.$key must be an object")
                else -> value.asJsonObject.keySet().filter { it !in nested }.map { "$path.$key.$it is not a policy member" }
            }
        }

    private fun expectProblems(e: JsonElement): List<String> {
        if (!e.isJsonObject) return listOf("not an object")
        val obj = e.asJsonObject
        val problems = mutableListOf<String>()
        if (obj.keySet() != EXPECT_MEMBERS) problems += "members ${obj.keySet()}, expected $EXPECT_MEMBERS"
        EXPECT_MEMBERS.forEach { name ->
            val v = obj.get(name)
            if (v == null || !v.isJsonPrimitive || !v.asJsonPrimitive.isString) problems += "$name must be a string"
        }
        return problems
    }

    private fun loadCorpus(): JsonObject {
        val stream = javaClass.getResourceAsStream(RESOURCE) ?: throw AssertionError("$RESOURCE is missing from the test classpath")
        return try {
            stream.reader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonObject }
        } catch (e: Exception) {
            throw AssertionError("$RESOURCE is unreadable: $e", e)
        }
    }

    private companion object {
        const val RESOURCE = "/client-settings-policy.json"
        val ID = Regex("P[0-9]{2}")
        val EXPECT_MEMBERS = setOf("label", "value", "detail")
        /** The project.settings members the landing-policy rows read: top-level key to nested key names (null marks a leaf). */
        val POLICY_SHAPE: Map<String, Set<String>?> = mapOf(
            "autoCommit" to null,
            "checkpointCommits" to null,
            "checkpointPush" to null,
            "commitBoardState" to null,
            "commitHooks" to null,
            "consolidationBranch" to null,
            "qualityGate" to null,
            "qualityGateScope" to null,
            "attribution" to setOf("undeclared"),
            "taskSizing" to setOf("warnSteps", "maxSteps", "warnDistinctFiles", "maxDistinctFiles")
        )
    }
}
