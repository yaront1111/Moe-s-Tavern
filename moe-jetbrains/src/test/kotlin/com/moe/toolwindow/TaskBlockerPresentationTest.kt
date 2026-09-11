package com.moe.toolwindow

import com.google.gson.JsonParser
import com.moe.model.Task
import com.moe.util.MoeJson
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards the blocker/attention display rule that both the board card and the
 * task detail dialog consume.
 *
 * Every fixture is built from raw daemon task JSON through [MoeJson.parseTask]
 * rather than a [Task] constructor, so the three distinct empty shapes the
 * parser really produces stay distinguishable here: an omitted, null or
 * wrong-shape `blockedOnTaskIds` parses to null, while a real `[]` and an
 * all-invalid array parse to an empty list.
 *
 * Headless on purpose: no IDE fixture, no daemon, no Swing.
 */
class TaskBlockerPresentationTest {

    private companion object {
        const val REASON = "Waiting on the staging database migration"
        const val BLOCKED_AT = "2026-09-11T10:00:00Z"
    }

    /** Build a task from raw JSON; [fields] are extra `"key":value` pairs. */
    private fun task(status: String, vararg fields: String): Task {
        val json = (listOf(
            "\"id\":\"task-abc1\"",
            "\"epicId\":\"epic-1\"",
            "\"title\":\"A task\"",
            "\"description\":\"\"",
            "\"status\":\"$status\"",
            "\"order\":1.0",
            "\"definitionOfDone\":[]",
            "\"implementationPlan\":[]"
        ) + fields.filter { it.isNotBlank() }).joinToString(",", "{", "}")
        return MoeJson.parseTask(JsonParser.parseString(json).asJsonObject)
    }

    // ------------------------------------------------------------ the three causes

    @Test
    fun `a blocked task holding a resource id is a resource wait`() {
        val blocked = task("BLOCKED", "\"blockedResourceId\":\"benchmark-box\"", "\"blockedReason\":\"$REASON\"")

        assertEquals(BlockCause.RESOURCE_WAIT, TaskBlockerPresentation.cause(blocked))
        assertEquals(
            TaskBlockerBadges(BlockCause.RESOURCE_WAIT, false),
            TaskBlockerPresentation.badges(blocked)
        )
        assertEquals("moe.blocker.cause.resourceWait", BlockCause.RESOURCE_WAIT.badgeKey)
        assertEquals("moe.blocker.clears.resourceWait", BlockCause.RESOURCE_WAIT.clearanceKey)
    }

    @Test
    fun `a blocked task holding prerequisite ids is a dependency wait`() {
        val blocked = task(
            "BLOCKED",
            "\"blockedOnTaskIds\":[\"task-dep1\",\"task-dep2\"]",
            "\"blockedReason\":\"$REASON\""
        )

        assertEquals(BlockCause.DEPENDENCY_WAIT, TaskBlockerPresentation.cause(blocked))
        assertEquals(listOf("task-dep1", "task-dep2"), TaskBlockerPresentation.prerequisiteIds(blocked))
        assertEquals("moe.blocker.cause.dependencyWait", BlockCause.DEPENDENCY_WAIT.badgeKey)
        assertEquals("moe.blocker.clears.dependencyWait", BlockCause.DEPENDENCY_WAIT.clearanceKey)
    }

    @Test
    fun `a blocked task with neither a resource nor usable ids is an external block`() {
        val blocked = task("BLOCKED", "\"blockedReason\":\"$REASON\"")

        assertEquals(BlockCause.EXTERNAL_BLOCK, TaskBlockerPresentation.cause(blocked))
        assertEquals(emptyList<String>(), TaskBlockerPresentation.prerequisiteIds(blocked))
        assertEquals("moe.blocker.cause.externalBlock", BlockCause.EXTERNAL_BLOCK.badgeKey)
        assertEquals("moe.blocker.clears.externalBlock", BlockCause.EXTERNAL_BLOCK.clearanceKey)
    }

    @Test
    fun `the resource wait wins over prerequisite ids and attention stays independent`() {
        // The precedence proof. The daemon's dependency auto-unblock skips
        // resource-waiting rows and the lease grant clears all block metadata,
        // so a row carrying both is really waiting on the lease.
        val blocked = task(
            "BLOCKED",
            "\"blockedResourceId\":\"benchmark-box\"",
            "\"blockedOnTaskIds\":[\"task-dep1\"]",
            "\"needsHumanReview\":true",
            "\"blockedReason\":\"$REASON\""
        )

        assertEquals(
            TaskBlockerBadges(BlockCause.RESOURCE_WAIT, true),
            TaskBlockerPresentation.badges(blocked)
        )
        val detail = TaskBlockerPresentation.detail(blocked)!!
        assertEquals(BlockCause.RESOURCE_WAIT, detail.cause)
        assertEquals(true, detail.needsHumanReview)
        assertEquals("benchmark-box", detail.resourceId)
        // The ids are still reported verbatim even though they lost the cause race.
        assertEquals(listOf("task-dep1"), detail.prerequisiteIds)
    }

    @Test
    fun `an ordinary task carries no cause and no attention`() {
        val working = task("WORKING")

        assertEquals(TaskBlockerBadges(null, false), TaskBlockerPresentation.badges(working))
        assertEquals(false, TaskBlockerPresentation.badges(working).hasAny)
        assertNull(TaskBlockerPresentation.detail(working))
    }

    // --------------------------------------------------------- empty/missing shapes

    @Test
    fun `every unusable dependency shape falls through to the external block`() {
        val shapes = listOf(
            "" to "field omitted",
            "\"blockedOnTaskIds\":null" to "explicit null",
            "\"blockedOnTaskIds\":[]" to "real empty array",
            "\"blockedOnTaskIds\":[\"\",\"   \",\"\\t\"]" to "only blank ids",
            "\"blockedOnTaskIds\":\"task-dep1\"" to "wrong shape (string, not array)"
        )
        for ((field, label) in shapes) {
            val blocked = task("BLOCKED", field)
            assertEquals(label, BlockCause.EXTERNAL_BLOCK, TaskBlockerPresentation.cause(blocked))
            assertEquals(label, emptyList<String>(), TaskBlockerPresentation.prerequisiteIds(blocked))
        }
    }

    @Test
    fun `a null dependency list and a real empty list are both unusable but stay distinct on the model`() {
        val missing = task("BLOCKED")
        val empty = task("BLOCKED", "\"blockedOnTaskIds\":[]")

        // The parser keeps them apart...
        assertNull(missing.blockedOnTaskIds)
        assertEquals(emptyList<String>(), empty.blockedOnTaskIds)
        // ...and the presentation deliberately treats both as "no dependency".
        assertEquals(BlockCause.EXTERNAL_BLOCK, TaskBlockerPresentation.cause(missing))
        assertEquals(BlockCause.EXTERNAL_BLOCK, TaskBlockerPresentation.cause(empty))
    }

    @Test
    fun `a blank resource id falls through to the next branch`() {
        val blankWithDeps = task(
            "BLOCKED",
            "\"blockedResourceId\":\"\"",
            "\"blockedOnTaskIds\":[\"task-dep1\"]"
        )
        assertEquals(BlockCause.DEPENDENCY_WAIT, TaskBlockerPresentation.cause(blankWithDeps))
        assertNull(TaskBlockerPresentation.detail(blankWithDeps)!!.resourceId)

        val whitespaceAlone = task("BLOCKED", "\"blockedResourceId\":\"   \"")
        assertEquals(BlockCause.EXTERNAL_BLOCK, TaskBlockerPresentation.cause(whitespaceAlone))
        assertNull(TaskBlockerPresentation.detail(whitespaceAlone)!!.resourceId)
    }

    @Test
    fun `a blocked task whose only usable id follows blanks is still a dependency wait`() {
        val blocked = task("BLOCKED", "\"blockedOnTaskIds\":[\"\",\"  \",\"task-dep9\"]")

        assertEquals(BlockCause.DEPENDENCY_WAIT, TaskBlockerPresentation.cause(blocked))
        assertEquals(listOf("task-dep9"), TaskBlockerPresentation.prerequisiteIds(blocked))
    }

    // ------------------------------------------------------------------- staleness

    @Test
    fun `leftover blocker metadata on a working task never renders as a live block`() {
        val stale = task(
            "WORKING",
            "\"blockedResourceId\":\"benchmark-box\"",
            "\"blockedOnTaskIds\":[\"task-dep1\"]",
            "\"blockedReason\":\"$REASON\"",
            "\"blockedFromStatus\":\"WORKING\"",
            "\"blockedAt\":\"$BLOCKED_AT\""
        )

        assertNull(TaskBlockerPresentation.cause(stale))
        assertEquals(TaskBlockerBadges(null, false), TaskBlockerPresentation.badges(stale))
        assertNull(TaskBlockerPresentation.detail(stale))
    }

    @Test
    fun `a review task keeps its attention flag but offers no active block detail`() {
        val review = task(
            "REVIEW",
            "\"needsHumanReview\":true",
            "\"blockedResourceId\":\"benchmark-box\"",
            "\"blockedOnTaskIds\":[\"task-dep1\"]",
            "\"blockedReason\":\"$REASON\"",
            "\"blockedFromStatus\":\"WORKING\"",
            "\"blockedAt\":\"$BLOCKED_AT\""
        )

        assertEquals(TaskBlockerBadges(null, true), TaskBlockerPresentation.badges(review))
        assertEquals(
            TaskBlockerDetail(
                cause = null,
                reason = null,
                reasonFallbackKey = null,
                prerequisiteIds = emptyList(),
                resourceId = null,
                fromStatus = null,
                blockedAt = null,
                needsHumanReview = true
            ),
            TaskBlockerPresentation.detail(review)
        )
    }

    @Test
    fun `attention survives a walk from blocked through working to review and clears with the flag`() {
        val blocked = task(
            "BLOCKED",
            "\"needsHumanReview\":true",
            "\"blockedOnTaskIds\":[\"task-dep1\"]",
            "\"blockedReason\":\"$REASON\""
        )
        assertEquals(TaskBlockerBadges(BlockCause.DEPENDENCY_WAIT, true), TaskBlockerPresentation.badges(blocked))

        val working = blocked.copy(status = "WORKING")
        assertEquals(TaskBlockerBadges(null, true), TaskBlockerPresentation.badges(working))

        val review = working.copy(status = "REVIEW")
        assertEquals(TaskBlockerBadges(null, true), TaskBlockerPresentation.badges(review))

        // Only the flag itself clears the attention badge.
        val cleared = review.copy(needsHumanReview = false)
        assertEquals(TaskBlockerBadges(null, false), TaskBlockerPresentation.badges(cleared))
        assertNull(TaskBlockerPresentation.detail(cleared))
    }

    @Test
    fun `attention is honoured on a task that is not blocked at all`() {
        val planning = task("PLANNING", "\"needsHumanReview\":true")

        assertEquals(TaskBlockerBadges(null, true), TaskBlockerPresentation.badges(planning))
        assertEquals(true, TaskBlockerPresentation.badges(planning).hasAny)
        assertEquals(true, TaskBlockerPresentation.detail(planning)!!.needsHumanReview)
    }

    // --------------------------------------------------------------- data fidelity

    @Test
    fun `prerequisite ids keep their recorded order and duplicates`() {
        val blocked = task(
            "BLOCKED",
            "\"blockedOnTaskIds\":[\"task-zzz\",\"task-aaa\",\"task-zzz\",\"  \",\"task-mmm\"]"
        )

        assertEquals(
            listOf("task-zzz", "task-aaa", "task-zzz", "task-mmm"),
            TaskBlockerPresentation.prerequisiteIds(blocked)
        )
    }

    @Test
    fun `a multiline reason survives verbatim`() {
        val blocked = task(
            "BLOCKED",
            "\"blockedReason\":\"line one\\nline two\\n\\n<b>not markup</b>\""
        )

        assertEquals(
            "line one\nline two\n\n<b>not markup</b>",
            TaskBlockerPresentation.detail(blocked)!!.reason
        )
        assertNull(TaskBlockerPresentation.detail(blocked)!!.reasonFallbackKey)
    }

    @Test
    fun `a very long reason survives verbatim`() {
        val long = "x".repeat(5000)
        val blocked = task("BLOCKED", "\"blockedReason\":\"$long\"")

        val reason = TaskBlockerPresentation.detail(blocked)!!.reason
        assertEquals(5000, reason!!.length)
        assertEquals(long, reason)
    }

    @Test
    fun `a missing or blank reason yields the localized fallback key`() {
        val variants = listOf(
            "" to "field omitted",
            "\"blockedReason\":null" to "explicit null",
            "\"blockedReason\":\"\"" to "empty string",
            "\"blockedReason\":\"   \\t\"" to "whitespace only"
        )
        for ((field, label) in variants) {
            val detail = TaskBlockerPresentation.detail(task("BLOCKED", field))!!
            assertNull(label, detail.reason)
            assertEquals(label, "moe.blocker.reason.missing", detail.reasonFallbackKey)
        }
    }

    @Test
    fun `the recorded timestamp status and resource pass through untouched`() {
        val blocked = task(
            "BLOCKED",
            "\"blockedResourceId\":\"benchmark-box\"",
            "\"blockedFromStatus\":\"REVIEW\"",
            "\"blockedAt\":\"$BLOCKED_AT\"",
            "\"blockedReason\":\"$REASON\""
        )

        assertEquals(
            TaskBlockerDetail(
                cause = BlockCause.RESOURCE_WAIT,
                reason = REASON,
                reasonFallbackKey = null,
                prerequisiteIds = emptyList(),
                resourceId = "benchmark-box",
                fromStatus = "REVIEW",
                blockedAt = BLOCKED_AT,
                needsHumanReview = false
            ),
            TaskBlockerPresentation.detail(blocked)
        )
    }

    // ------------------------------------------------------------- bundle key guard

    @Test
    fun `every message key the presentation can emit is defined in the bundle`() {
        val bundle = Properties()
        val stream = checkNotNull(javaClass.getResourceAsStream("/messages/MoeBundle.properties")) {
            "MoeBundle.properties is not on the test classpath"
        }
        stream.use { bundle.load(it) }

        val keys = TaskBlockerPresentation.allMessageKeys()
        assertEquals("allMessageKeys must not repeat a key", keys.size, keys.toSet().size)
        assertEquals(15, keys.size)
        for (key in keys) {
            val value = bundle.getProperty(key)
            assertNotNull("$key is missing from MoeBundle.properties", value)
            assertTrue("$key has a blank value in MoeBundle.properties", value!!.isNotBlank())
        }
        // Spot-check the exact wording the user sees for each cause badge, so a
        // rename of a key cannot silently repoint a badge at another string.
        assertEquals("Resource wait", bundle.getProperty(BlockCause.RESOURCE_WAIT.badgeKey))
        assertEquals("Dependency wait", bundle.getProperty(BlockCause.DEPENDENCY_WAIT.badgeKey))
        assertEquals("External block", bundle.getProperty(BlockCause.EXTERNAL_BLOCK.badgeKey))
        assertEquals("Awaiting human review", bundle.getProperty(TaskBlockerPresentation.ATTENTION_BADGE_KEY))
    }
}
