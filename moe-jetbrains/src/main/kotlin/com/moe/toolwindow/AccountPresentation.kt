package com.moe.toolwindow

import com.moe.model.AccountRotation
import com.moe.model.ClaudeAccount
import com.moe.model.UsageWindow
import com.moe.model.Worker
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.floor

/**
 * A `MoeBundle` key and its arguments, never resolved text. Like
 * [TaskBlockerPresentation], this file stays free of IntelliJ classes so JUnit
 * can check it without an IDE; the Swing callers resolve the text.
 */
data class AccountText(val key: String, val args: List<Any> = emptyList())

/** One row of the Accounts tab, in the order Moe uses the accounts. */
data class AccountRow(
    val id: String,
    /** 1-based place in that order. */
    val position: Int,
    val label: String,
    val signIn: AccountText,
    val fiveHour: AccountText,
    val weekly: AccountText,
    val status: AccountText
)

/** Which Accounts tab controls work right now. */
data class AccountActions(
    val add: Boolean,
    val rename: Boolean,
    val moveUp: Boolean,
    val moveDown: Boolean,
    val removeOnly: Boolean,
    val signIn: Boolean,
    val signOut: Boolean,
    val signOutAndRemove: Boolean,
    val check: Boolean,
    val switchAt: Boolean
)

/** Every bundle key the Accounts tab, the header line and their dialogs use. */
object AccountKeys {
    const val TAB = "moe.tab.accounts"
    const val TITLE = "moe.accounts.title"
    const val INTRO = "moe.accounts.intro"
    const val FILE = "moe.accounts.file"
    const val ERROR = "moe.accounts.error"
    const val NO_CLI = "moe.accounts.noCli"
    const val SWITCH_AT = "moe.accounts.switchAt"
    const val SWITCH_AT_UNIT = "moe.accounts.switchAt.unit"
    const val EMPTY = "moe.accounts.empty"
    const val NOT_CONNECTED = "moe.accounts.notConnected"
    const val UNSUPPORTED = "moe.accounts.unsupported"

    const val COLUMN_POSITION = "moe.accounts.column.position"
    const val COLUMN_ACCOUNT = "moe.accounts.column.account"
    const val COLUMN_SIGN_IN = "moe.accounts.column.signIn"
    const val COLUMN_FIVE_HOUR = "moe.accounts.column.fiveHour"
    const val COLUMN_WEEKLY = "moe.accounts.column.weekly"
    const val COLUMN_STATUS = "moe.accounts.column.status"

    const val SIGN_IN_SUBSCRIPTION = "moe.accounts.signIn.subscription"
    const val SIGN_IN_SIGNED_OUT = "moe.accounts.signIn.signedOut"
    const val SIGN_IN_OTHER = "moe.accounts.signIn.other"
    const val USAGE_NONE = "moe.accounts.usage.none"
    const val USAGE_PERCENT = "moe.accounts.usage.percent"
    const val USAGE_RESETS = "moe.accounts.usage.resets"
    const val STATUS_SIGN_IN_NEEDED = "moe.accounts.status.signInNeeded"
    const val STATUS_SPENT_UNTIL = "moe.accounts.status.spentUntil"
    const val STATUS_ACTIVE = "moe.accounts.status.active"
    const val STATUS_ACTIVE_SEATS = "moe.accounts.status.activeSeats"
    const val STATUS_IN_USE = "moe.accounts.status.inUse"
    const val STATUS_READY = "moe.accounts.status.ready"

    const val HEADER = "moe.accounts.header"
    const val HEADER_TOOLTIP = "moe.accounts.header.tooltip"
    const val CHIP_ERROR = "moe.accounts.chip.error"
    const val CHIP_NONE_SIGNED_IN = "moe.accounts.chip.noneSignedIn"
    const val CHIP_SPENT = "moe.accounts.chip.spent"
    const val CHIP_ACTIVE = "moe.accounts.chip.active"
    const val CHIP_ACTIVE_NO_DATA = "moe.accounts.chip.activeNoData"
    const val CHIP_USAGE = "moe.accounts.chip.usage"
    const val CHIP_NO_DATA = "moe.accounts.chip.noData"
    const val CHIP_MORE = "moe.accounts.chip.more"

    const val BUTTON_ADD = "moe.accounts.button.add"
    const val BUTTON_SIGN_IN = "moe.accounts.button.signIn"
    const val BUTTON_CHECK = "moe.accounts.button.check"
    const val BUTTON_SIGN_OUT = "moe.accounts.button.signOut"
    const val BUTTON_RENAME = "moe.accounts.button.rename"
    const val BUTTON_MOVE_UP = "moe.accounts.button.moveUp"
    const val BUTTON_MOVE_DOWN = "moe.accounts.button.moveDown"
    const val BUTTON_REMOVE = "moe.accounts.button.remove"

    const val ADD_TITLE = "moe.accounts.add.title"
    const val ADD_PROMPT = "moe.accounts.add.prompt"
    const val RENAME_TITLE = "moe.accounts.rename.title"
    const val RENAME_PROMPT = "moe.accounts.rename.prompt"
    const val SIGN_OUT_TITLE = "moe.accounts.signOut.title"
    const val SIGN_OUT_CONFIRM = "moe.accounts.signOut.confirm"
    const val REMOVE_TITLE = "moe.accounts.remove.title"
    const val REMOVE_CONFIRM = "moe.accounts.remove.confirm"
    const val REMOVE_SIGN_OUT = "moe.accounts.remove.signOut"
    const val REMOVE_ONLY = "moe.accounts.remove.only"
    const val CANCEL = "moe.button.cancel"
    const val TERMINAL_TAB = "moe.accounts.terminal.tab"
    const val TERMINAL_UNAVAILABLE_TITLE = "moe.accounts.terminal.unavailableTitle"
    const val TERMINAL_UNAVAILABLE = "moe.accounts.terminal.unavailable"

    val COLUMNS = listOf(COLUMN_POSITION, COLUMN_ACCOUNT, COLUMN_SIGN_IN, COLUMN_FIVE_HOUR, COLUMN_WEEKLY, COLUMN_STATUS)
}

object AccountPresentation {
    /** The daemon's limits (accounts/registry.ts). */
    const val MAX_ACCOUNTS = 32
    const val MAX_LABEL_LENGTH = 64
    /** Joins the header line's account chips. */
    const val SEPARATOR = "  ·  "
    /** Chips the header shows before "+N more". */
    const val MAX_HEADER_CHIPS = 4
    private const val WORKER_LABEL_LENGTH = 12
    private const val CHIP_LABEL_LENGTH = 20
    private const val SUBSCRIPTION = "subscription"
    private const val FIVE_HOUR = "five_hour"
    private const val WEEKLY_PREFIX = "seven_day"
    private val SAME_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    private val OTHER_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")

    fun rows(rotation: AccountRotation?, now: Instant, zone: ZoneId): List<AccountRow> =
        rotation?.accounts.orEmpty().mapIndexed { index, account ->
            AccountRow(
                id = account.id,
                position = index + 1,
                label = account.label,
                signIn = AccountText(signInKey(account.signIn)),
                fiveHour = usage(account.windows[FIVE_HOUR], now, zone),
                // The busiest weekly window (seven_day, seven_day_opus, ...): any of them
                // reaching the switch point moves the seats.
                weekly = usage(
                    account.windows.filterKeys { it.startsWith(WEEKLY_PREFIX) }.values.maxByOrNull { it.percent ?: -1.0 },
                    now,
                    zone
                ),
                status = status(account, now, zone)
            )
        }

    /** The header line: nothing without accounts, else one chip per subscription account. */
    fun chips(rotation: AccountRotation?, now: Instant, zone: ZoneId): List<AccountText> {
        if (rotation == null) return emptyList()
        if (rotation.error != null) return listOf(AccountText(AccountKeys.CHIP_ERROR))
        if (rotation.accounts.isEmpty()) return emptyList()
        val signedIn = rotation.accounts.filter { it.signIn == SUBSCRIPTION }
        if (signedIn.isEmpty()) return listOf(AccountText(AccountKeys.CHIP_NONE_SIGNED_IN))
        val chips = signedIn.take(MAX_HEADER_CHIPS).map { chip(it, now, zone) }
        val hidden = signedIn.size - chips.size
        return if (hidden > 0) chips + AccountText(AccountKeys.CHIP_MORE, listOf(hidden)) else chips
    }

    fun labels(rotation: AccountRotation?): Map<String, String> =
        rotation?.accounts.orEmpty().associate { it.id to it.label }

    /** A worker card's title: its type, plus the account its seat runs on. */
    fun workerTitle(worker: Worker, labels: Map<String, String>): String {
        val accountId = worker.accountId ?: return worker.type
        return worker.type + " · " + shorten(labels[accountId] ?: accountId, WORKER_LABEL_LENGTH)
    }

    fun actions(rotation: AccountRotation?, selectedId: String?, connected: Boolean): AccountActions {
        val usable = rotation != null && rotation.error == null
        val accounts = rotation?.accounts.orEmpty()
        val index = accounts.indexOfFirst { it.id == selectedId }
        val selected = usable && index >= 0
        // List edits go through the daemon; CLI commands run in a terminal and only need its paths.
        val edit = usable && connected
        val cli = usable && rotation.cli != null
        return AccountActions(
            add = edit && accounts.size < MAX_ACCOUNTS,
            rename = edit && selected,
            moveUp = edit && selected && index > 0,
            moveDown = edit && selected && index < accounts.size - 1,
            removeOnly = edit && selected,
            signIn = cli && selected,
            signOut = cli && selected,
            signOutAndRemove = cli && selected,
            check = cli && accounts.isNotEmpty(),
            switchAt = edit
        )
    }

    /** The daemon's label rule: trimmed, at most 64 characters, no control characters. Empty means the id. */
    fun isValidLabel(input: String): Boolean {
        val label = input.trim()
        return label.length <= MAX_LABEL_LENGTH && label.none { it.isISOControl() }
    }

    /** Floored, so 89.6% never reads as a 90% switch point. */
    internal fun percent(value: Double): Int = floor(value.coerceAtLeast(0.0)).toInt()

    /** HH:mm today, MM-dd HH:mm on another day; text that is not an ISO instant shows as sent. */
    internal fun time(iso: String, now: Instant, zone: ZoneId): String {
        val at = runCatching { Instant.parse(iso) }.getOrNull()?.atZone(zone) ?: return iso
        return at.format(if (at.toLocalDate() == now.atZone(zone).toLocalDate()) SAME_DAY else OTHER_DAY)
    }

    private fun signInKey(signIn: String): String = when (signIn) {
        SUBSCRIPTION -> AccountKeys.SIGN_IN_SUBSCRIPTION
        "other" -> AccountKeys.SIGN_IN_OTHER
        else -> AccountKeys.SIGN_IN_SIGNED_OUT
    }

    private fun usage(window: UsageWindow?, now: Instant, zone: ZoneId): AccountText {
        val value = window?.percent ?: return AccountText(AccountKeys.USAGE_NONE)
        val resetsAt = window.resetsAt ?: return AccountText(AccountKeys.USAGE_PERCENT, listOf(percent(value)))
        return AccountText(AccountKeys.USAGE_RESETS, listOf(percent(value), time(resetsAt, now, zone)))
    }

    private fun status(account: ClaudeAccount, now: Instant, zone: ZoneId): AccountText = when {
        account.signIn != SUBSCRIPTION -> AccountText(AccountKeys.STATUS_SIGN_IN_NEEDED)
        account.blockedUntil != null -> AccountText(AccountKeys.STATUS_SPENT_UNTIL, listOf(time(account.blockedUntil, now, zone)))
        account.active && account.seats.isNotEmpty() -> AccountText(AccountKeys.STATUS_ACTIVE_SEATS, listOf(account.seats.size))
        account.active -> AccountText(AccountKeys.STATUS_ACTIVE)
        account.seats.isNotEmpty() -> AccountText(AccountKeys.STATUS_IN_USE, listOf(account.seats.size))
        else -> AccountText(AccountKeys.STATUS_READY)
    }

    private fun chip(account: ClaudeAccount, now: Instant, zone: ZoneId): AccountText {
        val label = shorten(account.label, CHIP_LABEL_LENGTH)
        val peak = account.peakPercent?.let(::percent)
        return when {
            account.blockedUntil != null ->
                AccountText(AccountKeys.CHIP_SPENT, listOf(label, time(account.blockedUntil, now, zone)))
            account.active && peak != null -> AccountText(AccountKeys.CHIP_ACTIVE, listOf(label, peak))
            account.active -> AccountText(AccountKeys.CHIP_ACTIVE_NO_DATA, listOf(label))
            peak != null -> AccountText(AccountKeys.CHIP_USAGE, listOf(label, peak))
            else -> AccountText(AccountKeys.CHIP_NO_DATA, listOf(label))
        }
    }

    /** The header and worker cards have room for a short label only; the Accounts tab shows it whole. */
    private fun shorten(label: String, max: Int): String = if (label.length > max) label.take(max - 3) + "..." else label
}
