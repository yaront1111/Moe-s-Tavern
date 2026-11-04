package com.moe.toolwindow

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Properties

/**
 * One client-neutral corpus, two consumers: moe-vscode's tests/delivery-corpus.test.cjs (VSC-8, task-185f728f)
 * replays the same bytes through TaskDetailPanel's deliveryRows. Same rule as ClientVerdictCorpusTest (CQ-I06b): a row
 * the clients disagree on is fixed or filed, never given a client-specific expectation.
 *
 * Each row's `delivery` is the daemon's /ws task.delivery (null or an object), parsed exactly as the client parses it,
 * and `expect` is the DeliveryPresentation.rows output, order included.
 */
class DeliveryCorpusTest {
    private val corpus = loadCorpus()
    private val rows: List<JsonObject> = corpus.getAsJsonArray("rows").map { it.asJsonObject }

    @Test
    fun `the corpus is well formed`() {
        val problems = mutableListOf<String>()
        if (corpus.get("version")?.takeIf { it.isJsonPrimitive }?.asString != "1") problems += "version: expected 1"
        if (rows.size < 12) problems += "rows: ${rows.size}, expected at least 12"
        val ids = rows.map { it.get("id")?.takeIf { e -> e.isJsonPrimitive }?.asString ?: "?" }
        ids.groupBy { it }.filter { it.value.size > 1 }.keys.forEach { problems += "$it: duplicate id" }
        rows.forEachIndexed { index, row ->
            val id = ids[index]
            if (!id.matches(ID)) problems += "$id: id does not match D[0-9]{2}"
            rowProblems(row).forEach { problems += "$id: $it" }
        }
        assertEquals("malformed rows", emptyList<String>(), problems)
    }

    @Test
    fun `every row renders its expected delivery rows`() {
        val failures = rows.mapNotNull { row ->
            val id = row.get("id").asString
            val problem = try { renderMismatch(row) } catch (e: Exception) { "threw $e" }
            problem?.let { "$id: $it" }
        }
        assertEquals("delivery rows that diverge", emptyList<String>(), failures)
    }

    @Test
    fun `corpus label keys are exactly the bundle's delivery row keys`() {
        val properties = Properties()
        requireNotNull(javaClass.classLoader.getResourceAsStream("messages/MoeBundle.properties")).use(properties::load)
        val used = rows.flatMap { row -> row.getAsJsonArray("expect").map { it.asJsonObject.get("labelKey").asString } }.toSet()
        val empty = used.filter { properties.getProperty(it).isNullOrEmpty() }.sorted()
        assertEquals("corpus label keys with no bundle text", emptyList<String>(), empty)
        val bundleKeys = properties.stringPropertyNames()
            .filter { it.startsWith("moe.delivery.") && it != DeliveryPresentation.TITLE_KEY }.toSet()
        assertEquals("bundle row keys missing from the corpus: ${bundleKeys - used}, unknown: ${used - bundleKeys}", bundleKeys, used)
    }

    private fun renderMismatch(row: JsonObject): String? {
        val delivery = row.get("delivery")
        val task = JsonObject().apply {
            addProperty("id", "task-corpus")
            addProperty("epicId", "epic-corpus")
            addProperty("status", "WORKING")
            add("delivery", delivery.deepCopy())
        }
        val snapshot = JsonObject().apply {
            add("project", JsonObject().apply { addProperty("id", "proj-corpus"); addProperty("name", "corpus") })
            add("epics", JsonArray())
            add("tasks", JsonArray().apply { add(task.deepCopy()) })
        }
        val viaTask = MoeJson.parseTask(task).delivery
        val viaState = MoeJson.parseState(snapshot).tasks.single().delivery
        if (viaTask != viaState) return "parseTask gave $viaTask, parseState gave $viaState"
        val expected = row.getAsJsonArray("expect").map {
            val e = it.asJsonObject
            DeliveryRow(
                e.get("labelKey").asString,
                e.get("value").asString,
                e.get("fullValue").asString,
                e.get("outcome").takeUnless { o -> o.isJsonNull }?.asString?.let(DeliveryOutcome::valueOf)
            )
        }
        val actual = DeliveryPresentation.rows(viaTask)
        return if (expected == actual) null else "expected $expected, got $actual"
    }

    private fun rowProblems(row: JsonObject): List<String> {
        val problems = mutableListOf<String>()
        val note = row.get("note")
        if (note == null || !note.isJsonPrimitive || !note.asJsonPrimitive.isString || note.asString.isEmpty()) problems += "note must be a non-empty string"
        val delivery = row.get("delivery")
        when {
            delivery == null -> problems += "delivery member is missing"
            delivery.isJsonNull -> Unit
            delivery.isJsonObject -> problems += unknownMembers("delivery", delivery.asJsonObject, DELIVERY_SHAPE)
            else -> problems += "delivery must be null or an object"
        }
        val expect = row.get("expect")
        if (expect == null || !expect.isJsonArray) problems += "expect must be an array"
        else expect.asJsonArray.forEachIndexed { i, e -> expectProblems(e).forEach { problems += "expect[$i]: $it" } }
        return problems
    }

    /** A member the daemon never sends is a typo; a nested shape of null marks a leaf member. */
    private fun unknownMembers(path: String, obj: JsonObject, shape: Map<String, Set<String>?>): List<String> =
        obj.keySet().flatMap { key ->
            val nested = shape[key]
            val value = obj.get(key)
            when {
                key !in shape -> listOf("$path.$key is not a daemon member")
                nested == null -> emptyList()
                value.isJsonNull -> emptyList()
                !value.isJsonObject -> listOf("$path.$key must be an object")
                else -> value.asJsonObject.keySet().filter { it !in nested }.map { "$path.$key.$it is not a daemon member" }
            }
        }

    private fun expectProblems(e: JsonElement): List<String> {
        if (!e.isJsonObject) return listOf("not an object")
        val obj = e.asJsonObject
        val problems = mutableListOf<String>()
        if (obj.keySet() != EXPECT_MEMBERS) problems += "members ${obj.keySet()}, expected $EXPECT_MEMBERS"
        listOf("labelKey", "value", "fullValue").forEach { name ->
            val v = obj.get(name)
            if (v == null || !v.isJsonPrimitive || !v.asJsonPrimitive.isString) problems += "$name must be a string"
        }
        val outcome = obj.get("outcome")
        if (outcome != null && !outcome.isJsonNull && !(outcome.isJsonPrimitive && outcome.asString in setOf("PASS", "FAIL"))) {
            problems += "outcome must be PASS, FAIL or null"
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
        const val RESOURCE = "/client-delivery.json"
        val ID = Regex("D[0-9]{2}")
        val EXPECT_MEMBERS = setOf("labelKey", "value", "fullValue", "outcome")
        /** TaskDelivery in packages/moe-daemon/src/state/deliveryProjection.ts: top-level member to nested member names. */
        val DELIVERY_SHAPE: Map<String, Set<String>?> = mapOf(
            "currentCandidate" to setOf("id", "treeSha", "shortSha", "baseRevision"),
            "latestCheckRun" to setOf("command", "exitCode", "source", "outcome"),
            "deliveryReceipt" to setOf("target", "landedRevision"),
            "requiredCheckSatisfied" to null,
            "attemptPhase" to null
        )
    }
}
