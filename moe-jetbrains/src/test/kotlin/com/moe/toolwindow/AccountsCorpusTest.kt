package com.moe.toolwindow

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.moe.model.AccountRotation
import com.moe.util.MoeJson
import org.junit.Assert.assertEquals
import org.junit.Test
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneId
import java.util.Properties

/**
 * One client-neutral corpus, two consumers: moe-vscode's tests/accounts-corpus.test.cjs (VSC-13, task-065e4812) replays
 * the same bytes through src/util/AccountPresentation.ts, and VSC-15 (task-357ed3ae) checks its context keys against
 * `expectActions`. Same rule as ClientVerdictCorpusTest (CQ-I06b): a row the clients disagree on is fixed or filed,
 * never given a client-specific expectation.
 *
 * Each row's `rotation` is the daemon's AccountRotationView wire JSON (or null), parsed exactly as the client parses
 * it: through MoeJson.parseAccountRotation (the ACCOUNTS_UPDATED path in MoeMessageDispatcher) and through
 * MoeJson.parseState (STATE_SNAPSHOT), which must agree. `expectRows`, `expectChips` and `expectActions` are what
 * AccountPresentation.rows, chips and actions return for it at the corpus' fixed `now` and `zone`. Every text is a
 * `{key, args}` pair: a JSON integer arg is an Int and a JSON string is a String, so 92 and "92" never compare equal.
 * `labels` pins AccountPresentation.isValidLabel against the daemon's rule (registry.ts normalizeLabel).
 */
class AccountsCorpusTest {
    private val corpus = loadCorpus()
    private val rows = objects("rows")
    private val labels = objects("labels")

    @Test
    fun `the corpus is well formed`() {
        val problems = mutableListOf<String>()
        val version = corpus.get("version")
        if (version == null || !version.isJsonPrimitive || !version.asJsonPrimitive.isNumber || version.asString != "1") {
            problems += "version: expected 1"
        }
        if (text(corpus, "now")?.let { runCatching { Instant.parse(it) }.isSuccess } != true) problems += "now: not an ISO instant"
        if (text(corpus, "zone")?.let { runCatching { ZoneId.of(it) }.isSuccess } != true) problems += "zone: not a zone id"
        if (rows.size < 12) problems += "rows: ${rows.size}, expected at least 12"
        if (labels.size < 8) problems += "labels: ${labels.size}, expected at least 8"
        problems += idProblems(rows, ROW_ID)
        problems += idProblems(labels, LABEL_ID)
        rows.forEach { row -> rowProblems(row).forEach { problems += "${idOf(row)}: $it" } }
        labels.forEach { label -> labelProblems(label).forEach { problems += "${idOf(label)}: $it" } }
        assertEquals("malformed corpus", emptyList<String>(), problems)
    }

    @Test
    fun `every rotation row renders its rows, chips and actions`() {
        val now = Instant.parse(text(corpus, "now"))
        val zone = ZoneId.of(text(corpus, "zone"))
        val failures = rows.flatMap { row ->
            val id = idOf(row)
            val problems = try { renderMismatches(row, now, zone) } catch (e: Exception) { listOf("threw $e") }
            problems.map { "$id: $it" }
        }
        assertEquals("accounts rows that diverge", emptyList<String>(), failures)
    }

    @Test
    fun `every label case follows the daemon rule`() {
        val failures = labels.mapNotNull { label ->
            val problem = try {
                val input = text(label, "input") ?: throw IllegalStateException("input is not a string")
                val valid = label.get("valid").asBoolean
                val actual = AccountPresentation.isValidLabel(input)
                if (actual == valid) null else "isValidLabel(${show(input)}) expected $valid, got $actual"
            } catch (e: Exception) {
                "threw $e"
            }
            problem?.let { "${idOf(label)}: $it" }
        }
        assertEquals("label cases that diverge", emptyList<String>(), failures)
    }

    @Test
    fun `corpus text keys are exactly the bundle's account presentation keys`() {
        val stream = requireNotNull(javaClass.classLoader.getResourceAsStream(BUNDLE)) { "$BUNDLE is missing from the test classpath" }
        val properties = Properties().also { props -> stream.use(props::load) }
        val texts = rows.flatMap(::textsOf)
        val used = texts.map { it.get("key").asString }.toSet()
        val empty = used.filter { properties.getProperty(it).isNullOrEmpty() }.sorted()
        assertEquals("corpus keys with no bundle text", emptyList<String>(), empty)
        val bundleKeys = properties.stringPropertyNames().filter { PRESENTATION_KEY.matches(it) }.toSet()
        assertEquals("bundle keys missing from the corpus: ${bundleKeys - used}, unknown: ${used - bundleKeys}", bundleKeys, used)
        val badCounts = texts.mapNotNull { t ->
            val key = t.get("key").asString
            val placeholders = PLACEHOLDER.findAll(properties.getProperty(key)).map { it.groupValues[1] }.toSet().size
            val args = t.getAsJsonArray("args").size()
            if (placeholders == args) null else "$key: $args args, $placeholders placeholders"
        }.distinct().sorted()
        assertEquals("texts whose args count differs from the bundle's placeholders", emptyList<String>(), badCounts)
    }

    /** Parses the rotation both ways, then compares rows, chips and actions; each mismatch is one line. */
    private fun renderMismatches(row: JsonObject, now: Instant, zone: ZoneId): List<String> {
        val raw = row.get("rotation")
        val rotation: AccountRotation? = if (raw.isJsonNull) null else {
            val viaMessage = MoeJson.parseAccountRotation(raw.asJsonObject.deepCopy())
            val viaState = MoeJson.parseState(snapshotOf(raw.asJsonObject)).accountRotation
            if (viaMessage == null || viaMessage != viaState) {
                return listOf("parseAccountRotation gave $viaMessage, parseState gave $viaState")
            }
            viaMessage
        }
        val selectedId = row.get("selectedId").takeUnless { it.isJsonNull }?.asString
        val connected = row.get("connected").asBoolean
        val problems = mutableListOf<String>()
        fun <T> compare(which: String, expected: T, actual: T) {
            if (expected != actual) problems += "$which expected $expected, got $actual"
        }
        compare("rows", expectedRows(row), AccountPresentation.rows(rotation, now, zone))
        compare("chips", row.getAsJsonArray("expectChips").map(::accountText), AccountPresentation.chips(rotation, now, zone))
        compare("actions", expectedActions(row), AccountPresentation.actions(rotation, selectedId, connected))
        return problems
    }

    private fun snapshotOf(rotation: JsonObject) = JsonObject().apply {
        add("project", JsonObject().apply { addProperty("id", "proj-corpus"); addProperty("name", "corpus") })
        add("accountRotation", rotation.deepCopy())
    }

    private fun expectedRows(row: JsonObject): List<AccountRow> = row.getAsJsonArray("expectRows").map {
        val e = it.asJsonObject
        AccountRow(
            id = e.get("id").asString,
            position = intOf(e.get("position")),
            label = e.get("label").asString,
            signIn = accountText(e.get("signIn")),
            fiveHour = accountText(e.get("fiveHour")),
            weekly = accountText(e.get("weekly")),
            status = accountText(e.get("status")),
            vmToken = accountText(e.get("vmToken"))
        )
    }

    private fun expectedActions(row: JsonObject): AccountActions {
        val a = row.getAsJsonObject("expectActions")
        fun flag(name: String) = a.get(name).asBoolean
        return AccountActions(
            add = flag("add"), rename = flag("rename"), moveUp = flag("moveUp"), moveDown = flag("moveDown"),
            removeOnly = flag("removeOnly"), signIn = flag("signIn"), signOut = flag("signOut"),
            signOutAndRemove = flag("signOutAndRemove"), check = flag("check"), switchAt = flag("switchAt"),
            setVmToken = flag("setVmToken"), removeVmToken = flag("removeVmToken")
        )
    }

    private fun accountText(e: JsonElement): AccountText {
        val obj = e.asJsonObject
        return AccountText(obj.get("key").asString, obj.getAsJsonArray("args").map(::arg))
    }

    private fun arg(e: JsonElement): Any = if (isString(e)) e.asString else intOf(e)

    private fun intOf(e: JsonElement): Int = BigDecimal(e.asString).intValueExact()

    /** Every text the row expects: five per account row, then the chips. */
    private fun textsOf(row: JsonObject): List<JsonObject> =
        row.getAsJsonArray("expectRows").flatMap { r -> ROW_TEXTS.map { r.asJsonObject.get(it).asJsonObject } } +
            row.getAsJsonArray("expectChips").map { it.asJsonObject }

    private fun idProblems(items: List<JsonObject>, pattern: Regex): List<String> {
        val ids = items.map(::idOf)
        return ids.groupBy { it }.filter { it.value.size > 1 }.keys.map { "$it: duplicate id" } +
            ids.filter { !pattern.matches(it) }.map { "$it: id does not match ${pattern.pattern}" }
    }

    private fun rowProblems(row: JsonObject): List<String> {
        val problems = mutableListOf<String>()
        if (row.keySet() != ROW_MEMBERS) problems += "members ${row.keySet()}, expected $ROW_MEMBERS"
        if (text(row, "note").isNullOrEmpty()) problems += "note must be a non-empty string"
        val rotation = row.get("rotation")
        if (rotation == null || !(rotation.isJsonNull || rotation.isJsonObject)) problems += "rotation must be null or an object"
        val selected = row.get("selectedId")
        if (selected == null || !(selected.isJsonNull || isString(selected))) problems += "selectedId must be null or a string"
        val connected = row.get("connected")
        if (connected == null || !connected.isJsonPrimitive || !connected.asJsonPrimitive.isBoolean) problems += "connected must be a boolean"
        problems += arrayProblems("expectRows", row.get("expectRows"), ::expectRowProblems)
        problems += arrayProblems("expectChips", row.get("expectChips"), ::textProblems)
        problems += actionProblems(row.get("expectActions"))
        return problems
    }

    private fun arrayProblems(name: String, e: JsonElement?, check: (JsonElement) -> List<String>): List<String> =
        if (e == null || !e.isJsonArray) listOf("$name must be an array")
        else e.asJsonArray.mapIndexed { i, item -> check(item).map { "$name[$i]: $it" } }.flatten()

    private fun expectRowProblems(e: JsonElement): List<String> {
        if (!e.isJsonObject) return listOf("not an object")
        val obj = e.asJsonObject
        val problems = mutableListOf<String>()
        if (obj.keySet() != EXPECT_ROW_MEMBERS) problems += "members ${obj.keySet()}, expected $EXPECT_ROW_MEMBERS"
        listOf("id", "label").forEach { if (!isString(obj.get(it))) problems += "$it must be a string" }
        if (!isInteger(obj.get("position"))) problems += "position must be an integer"
        ROW_TEXTS.forEach { name -> problems += textProblems(obj.get(name)).map { "$name: $it" } }
        return problems
    }

    private fun textProblems(e: JsonElement?): List<String> {
        if (e == null || !e.isJsonObject) return listOf("not a text object")
        val obj = e.asJsonObject
        val problems = mutableListOf<String>()
        if (obj.keySet() != TEXT_MEMBERS) problems += "text members ${obj.keySet()}, expected $TEXT_MEMBERS"
        if (!isString(obj.get("key"))) problems += "key must be a string"
        val args = obj.get("args")
        if (args == null || !args.isJsonArray) problems += "args must be an array"
        else args.asJsonArray.forEachIndexed { i, a -> if (!isString(a) && !isInteger(a)) problems += "args[$i] must be a string or an integer" }
        return problems
    }

    private fun actionProblems(e: JsonElement?): List<String> {
        if (e == null || !e.isJsonObject) return listOf("expectActions must be an object")
        val obj = e.asJsonObject
        val problems = mutableListOf<String>()
        if (obj.keySet() != ACTION_MEMBERS) problems += "expectActions members ${obj.keySet()}, expected $ACTION_MEMBERS"
        obj.entrySet().forEach { (name, flag) ->
            if (!flag.isJsonPrimitive || !flag.asJsonPrimitive.isBoolean) problems += "expectActions.$name must be a boolean"
        }
        return problems
    }

    private fun labelProblems(label: JsonObject): List<String> {
        val problems = mutableListOf<String>()
        if (label.keySet() != LABEL_MEMBERS) problems += "members ${label.keySet()}, expected $LABEL_MEMBERS"
        if (text(label, "input") == null) problems += "input must be a string"
        val valid = label.get("valid")
        if (valid == null || !valid.isJsonPrimitive || !valid.asJsonPrimitive.isBoolean) problems += "valid must be a boolean"
        return problems
    }

    private fun isString(e: JsonElement?): Boolean = e != null && e.isJsonPrimitive && e.asJsonPrimitive.isString

    private fun isInteger(e: JsonElement?): Boolean =
        e != null && e.isJsonPrimitive && e.asJsonPrimitive.isNumber && runCatching { intOf(e) }.isSuccess

    private fun text(obj: JsonObject, name: String): String? = obj.get(name)?.takeIf(::isString)?.asString

    private fun idOf(obj: JsonObject): String = text(obj, "id") ?: "?"

    /** Control characters shown as escapes, so a failing label case stays readable. */
    private fun show(input: String): String =
        input.map { if (it < ' ' || it > '~') "\\u%04x".format(it.code) else it.toString() }.joinToString("", "\"", "\"")

    private fun objects(name: String): List<JsonObject> {
        val array = corpus.get(name)?.takeIf { it.isJsonArray }?.asJsonArray ?: throw AssertionError("$RESOURCE: $name must be an array")
        return array.map { it.takeIf { e -> e.isJsonObject }?.asJsonObject ?: throw AssertionError("$RESOURCE: $name holds a non-object") }
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
        const val RESOURCE = "/client-accounts.json"
        const val BUNDLE = "messages/MoeBundle.properties"
        val ROW_ID = Regex("C[0-9]{2}")
        val LABEL_ID = Regex("L[0-9]{2}")
        val PLACEHOLDER = Regex("\\{([0-9]+)}")
        val PRESENTATION_KEY = Regex("moe\\.accounts\\.(signIn|usage|status|chip|vmTokenState)\\..+")
        val ROW_TEXTS = listOf("signIn", "fiveHour", "weekly", "status", "vmToken")
        val TEXT_MEMBERS = setOf("key", "args")
        val LABEL_MEMBERS = setOf("id", "input", "valid")
        val ROW_MEMBERS = setOf("id", "note", "rotation", "selectedId", "connected", "expectRows", "expectChips", "expectActions")
        val EXPECT_ROW_MEMBERS = setOf("id", "position", "label") + ROW_TEXTS
        val ACTION_MEMBERS = setOf(
            "add", "rename", "moveUp", "moveDown", "removeOnly", "signIn", "signOut", "signOutAndRemove",
            "check", "switchAt", "setVmToken", "removeVmToken"
        )
    }
}
