package com.moe.services

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One client-neutral corpus, two consumers: moe-vscode's AgentSeatTracker port (VSC-20, task-7fa27666) replays these
 * same bytes, so a row the clients disagree on fails in one of them. A disagreement is fixed or filed, never given a
 * client-specific expectation (the CQ-I06b rule, see ClientVerdictCorpusTest).
 *
 * Replay: the store starts as `persisted`; every save overwrites it; `restart` builds a new tracker over the current
 * store (a new IDE session, so no seat is open); `connect` calls resendGone(); the deregister log spans restarts.
 * A row passes when the log equals `expectDeregistered` (order included) and the store equals `expectPersisted`.
 */
class SeatTrackerCorpusTest {
    private val corpus = loadCorpus()

    @Test
    fun `the corpus is well formed`() {
        assertEquals("version", 1, corpus.get("version").asInt)
        val rows = corpus.getAsJsonArray("rows").map { it.asJsonObject }
        assertTrue("rows: ${rows.size}", rows.size >= 10)
        val ids = rows.map { it.get("id").asString }
        assertEquals("duplicate ids", ids.size, ids.toSet().size)
        assertEquals("misnamed ids", emptyList<String>(), ids.filterNot { it.matches(Regex("S[0-9]{2}")) })
        val malformed = rows.flatMap { row ->
            row.getAsJsonArray("events").map { it.asJsonObject }.mapNotNull { event ->
                eventProblem(event)?.let { "${row.get("id").asString}: $it" }
            }
        }
        assertEquals("malformed events", emptyList<String>(), malformed)
    }

    @Test
    fun `every row replays to its expected deregistrations and saved list`() {
        val rows = corpus.getAsJsonArray("rows").map { it.asJsonObject }
        assertTrue("rows are missing", rows.isNotEmpty())
        val failures = rows.mapNotNull { row ->
            val problem = try { replayMismatch(row) } catch (e: Exception) { "threw $e" }
            problem?.let { "${row.get("id").asString}: $it" }
        }
        assertEquals("seat rows that diverge", emptyList<String>(), failures)
    }

    private fun eventProblem(event: JsonObject): String? {
        val op = event.get("op")?.asString ?: return "event without op: $event"
        if (op !in OPS) return "unknown op $op"
        val hasWorker = event.get("workerId")?.takeUnless { it.isJsonNull }?.asString?.isNotEmpty() == true
        return when {
            op in NEEDS_WORKER && !hasWorker -> "$op without workerId"
            op !in NEEDS_WORKER && event.has("workerId") -> "$op with a workerId"
            else -> null
        }
    }

    private fun replayMismatch(row: JsonObject): String? {
        var store = row.strings("persisted")
        val deregistered = mutableListOf<String>()
        fun newTracker() = AgentSeatTracker(load = { store }, save = { store = it }, deregister = { deregistered += it })
        var tracker = newTracker()
        for (event in row.getAsJsonArray("events").map { it.asJsonObject }) {
            eventProblem(event)?.let { return it }
            val workerId = event.get("workerId").stringOrNull()
            when (event.get("op").asString) {
                "launched" -> tracker.launched(workerId!!)
                "closed" -> tracker.closed(workerId!!)
                "acked" -> tracker.acked(workerId!!)
                "connect" -> tracker.resendGone()
                "restart" -> tracker = newTracker()
            }
        }
        val expectedDeregistered = row.strings("expectDeregistered")
        val expectedPersisted = row.strings("expectPersisted")
        return when {
            deregistered != expectedDeregistered -> "expected deregistered $expectedDeregistered, got $deregistered"
            store != expectedPersisted -> "expected persisted $expectedPersisted, got $store"
            else -> null
        }
    }

    private fun JsonObject.strings(name: String): List<String> = getAsJsonArray(name).map { it.asString }
    private fun JsonElement?.stringOrNull(): String? = this?.takeUnless { it.isJsonNull }?.asString

    private fun loadCorpus(): JsonObject {
        val stream = javaClass.getResourceAsStream(RESOURCE) ?: throw AssertionError("$RESOURCE is missing from the test classpath")
        return try {
            stream.reader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonObject }
        } catch (e: Exception) {
            throw AssertionError("$RESOURCE is unreadable: $e", e)
        }
    }

    private companion object {
        const val RESOURCE = "/client-seat-tracker.json"
        val OPS = setOf("launched", "closed", "connect", "acked", "restart")
        val NEEDS_WORKER = setOf("launched", "closed", "acked")
    }
}
