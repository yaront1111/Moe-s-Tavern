package com.moe.toolwindow

import com.moe.model.Task

/**
 * Why a BLOCKED task is parked. Each cause clears differently, which is the
 * whole point of naming it: a dependency wait clears itself when its
 * prerequisites finish, a resource wait clears on the lease grant, and a plain
 * external block needs a person.
 *
 * [badgeKey] and [clearanceKey] are `MoeBundle` property keys, never localized
 * text — this type is deliberately free of any IntelliJ dependency so JUnit can
 * assert it with no IDE fixture, and `MoeBundle` wraps `DynamicBundle`, which
 * needs the platform. The Swing callers resolve the keys.
 */
enum class BlockCause(val badgeKey: String, val clearanceKey: String) {
    RESOURCE_WAIT(
        badgeKey = "moe.blocker.cause.resourceWait",
        clearanceKey = "moe.blocker.clears.resourceWait"
    ),
    DEPENDENCY_WAIT(
        badgeKey = "moe.blocker.cause.dependencyWait",
        clearanceKey = "moe.blocker.clears.dependencyWait"
    ),
    EXTERNAL_BLOCK(
        badgeKey = "moe.blocker.cause.externalBlock",
        clearanceKey = "moe.blocker.clears.externalBlock"
    )
}

/**
 * What a board card shows: at most one block-cause chip plus an entirely
 * independent attention chip.
 *
 * [needsHumanReview] is the daemon's own flag, read verbatim. It is never
 * inferred from status, from the reason text or from a critique verdict, and it
 * survives a task leaving BLOCKED — the QA reject path normally sets it on a
 * REVIEW task, which is exactly why it cannot be tied to [cause].
 */
data class TaskBlockerBadges(
    val cause: BlockCause?,
    val needsHumanReview: Boolean
) {
    /** True when the card has at least one badge to draw. */
    val hasAny: Boolean get() = cause != null || needsHumanReview
}

/**
 * What the task detail dialog shows. Every string is daemon-supplied content
 * that the caller must render as literal plain text — a `blockedReason` is
 * arbitrary agent output and must never be interpreted as markup.
 *
 * When [cause] is null the task is not actively blocked, so every block field
 * here is empty: leftover metadata on a task that has moved on must not render
 * as a live block. Only [needsHumanReview] survives that gate.
 *
 * [reason] is the recorded reason verbatim, or null when it was missing or
 * blank; [reasonFallbackKey] is non-null exactly when [reason] is null and
 * there is a live block, and holds the `MoeBundle` key for the fallback text.
 */
data class TaskBlockerDetail(
    val cause: BlockCause?,
    val reason: String?,
    val reasonFallbackKey: String?,
    val prerequisiteIds: List<String>,
    val resourceId: String?,
    val fromStatus: String?,
    val blockedAt: String?,
    val needsHumanReview: Boolean
)

/**
 * The one place that decides whether a task is displayed as blocked and why.
 *
 * Headless on purpose: no Swing, no IntelliJ, no daemon call, no clock. The
 * board card and the detail dialog both ask this object rather than re-deriving
 * the rule inline, so the JUnit coverage really covers what the user sees.
 *
 * Read-only display over state the daemon already sends. Nothing here changes
 * lifecycle behaviour.
 */
object TaskBlockerPresentation {

    /** The only status that can carry a live block. */
    const val BLOCKED_STATUS = "BLOCKED"

    const val SECTION_TITLE_KEY = "moe.blocker.section.title"
    const val ATTENTION_BADGE_KEY = "moe.blocker.attention.badge"
    const val ATTENTION_CLEARS_KEY = "moe.blocker.attention.clears"
    const val REASON_LABEL_KEY = "moe.blocker.reason"
    const val REASON_MISSING_KEY = "moe.blocker.reason.missing"
    const val PREREQUISITES_KEY = "moe.blocker.prerequisites"
    const val RESOURCE_ID_KEY = "moe.blocker.resourceId"
    const val FROM_STATUS_KEY = "moe.blocker.fromStatus"
    const val BLOCKED_AT_KEY = "moe.blocker.blockedAt"

    /**
     * Every `MoeBundle` key this object can hand a caller. The bundle guard test
     * walks this list, so a key added without a translation fails the build
     * instead of shipping a raw placeholder to a user.
     */
    @JvmStatic
    fun allMessageKeys(): List<String> = listOf(
        SECTION_TITLE_KEY,
        ATTENTION_BADGE_KEY,
        ATTENTION_CLEARS_KEY,
        REASON_LABEL_KEY,
        REASON_MISSING_KEY,
        PREREQUISITES_KEY,
        RESOURCE_ID_KEY,
        FROM_STATUS_KEY,
        BLOCKED_AT_KEY
    ) + BlockCause.entries.flatMap { listOf(it.badgeKey, it.clearanceKey) }

    /**
     * Why [task] is parked, or null when it is not actively blocked.
     *
     * The status gate is load-bearing: a task that has left BLOCKED usually
     * still carries its blocker fields, and rendering those as a live block
     * would be worse than showing nothing.
     *
     * Within BLOCKED the order is fixed. A resource wait wins over a dependency
     * wait because the daemon's dependency auto-unblock deliberately skips
     * resource-waiting rows and the lease grant clears all block metadata, so a
     * row carrying both is really waiting on the lease.
     */
    @JvmStatic
    fun cause(task: Task): BlockCause? {
        if (task.status != BLOCKED_STATUS) return null
        if (!task.blockedResourceId.isNullOrBlank()) return BlockCause.RESOURCE_WAIT
        if (prerequisiteIds(task).isNotEmpty()) return BlockCause.DEPENDENCY_WAIT
        return BlockCause.EXTERNAL_BLOCK
    }

    /** Badges for a board card. Total function: no input shape throws. */
    @JvmStatic
    fun badges(task: Task): TaskBlockerBadges =
        TaskBlockerBadges(cause = cause(task), needsHumanReview = task.needsHumanReview)

    /**
     * The detail section, or null when there is nothing to show — neither a live
     * block nor the attention flag.
     *
     * Total function: it returns a value for every input rather than throwing,
     * because it runs inside paint and refresh paths.
     */
    @JvmStatic
    fun detail(task: Task): TaskBlockerDetail? {
        val cause = cause(task)
        val attention = task.needsHumanReview
        if (cause == null) {
            // Not actively blocked: offer no block detail at all, but keep the
            // independent attention flag.
            return if (attention) {
                TaskBlockerDetail(
                    cause = null,
                    reason = null,
                    reasonFallbackKey = null,
                    prerequisiteIds = emptyList(),
                    resourceId = null,
                    fromStatus = null,
                    blockedAt = null,
                    needsHumanReview = true
                )
            } else {
                null
            }
        }
        val reason = task.blockedReason?.takeIf { it.isNotBlank() }
        return TaskBlockerDetail(
            cause = cause,
            reason = reason,
            reasonFallbackKey = if (reason == null) REASON_MISSING_KEY else null,
            prerequisiteIds = prerequisiteIds(task),
            resourceId = task.blockedResourceId?.takeIf { it.isNotBlank() },
            fromStatus = task.blockedFromStatus?.takeIf { it.isNotBlank() },
            // Passed through exactly as sent: no date parsing, no reformatting.
            blockedAt = task.blockedAt?.takeIf { it.isNotBlank() },
            needsHumanReview = attention
        )
    }

    /**
     * The prerequisite ids the task RECORDED as waited on, in the order the
     * daemon sent them, duplicates kept, each id verbatim.
     *
     * These are not "unfinished tasks" — the daemon also treats archived and
     * deleted ids as satisfied — so the caller must not present them as a count
     * of outstanding work.
     *
     * Blank and whitespace-only ids are dropped: they can never identify a task,
     * and an array of nothing but blanks must fall through to the next cause
     * rather than claim a dependency wait. A null list (field missing, null or
     * the wrong shape) and a real empty array both give an empty list here.
     */
    @JvmStatic
    fun prerequisiteIds(task: Task): List<String> =
        task.blockedOnTaskIds.orEmpty().filter { it.isNotBlank() }
}
