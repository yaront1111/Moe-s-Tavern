package com.moe.toolwindow

import com.moe.model.AccountCli
import com.moe.model.AccountRotation
import com.moe.model.ClaudeAccount
import com.moe.model.UsageWindow
import com.moe.model.Worker
import com.moe.toolwindow.AccountKeys.CHIP_ACTIVE
import com.moe.toolwindow.AccountKeys.CHIP_ACTIVE_NO_DATA
import com.moe.toolwindow.AccountKeys.CHIP_ERROR
import com.moe.toolwindow.AccountKeys.CHIP_MORE
import com.moe.toolwindow.AccountKeys.CHIP_NONE_SIGNED_IN
import com.moe.toolwindow.AccountKeys.CHIP_NO_DATA
import com.moe.toolwindow.AccountKeys.CHIP_SPENT
import com.moe.toolwindow.AccountKeys.CHIP_USAGE
import com.moe.toolwindow.AccountKeys.SIGN_IN_OTHER
import com.moe.toolwindow.AccountKeys.SIGN_IN_SIGNED_OUT
import com.moe.toolwindow.AccountKeys.SIGN_IN_SUBSCRIPTION
import com.moe.toolwindow.AccountKeys.STATUS_ACTIVE
import com.moe.toolwindow.AccountKeys.STATUS_ACTIVE_SEATS
import com.moe.toolwindow.AccountKeys.STATUS_IN_USE
import com.moe.toolwindow.AccountKeys.STATUS_READY
import com.moe.toolwindow.AccountKeys.STATUS_SIGN_IN_NEEDED
import com.moe.toolwindow.AccountKeys.STATUS_SPENT_UNTIL
import com.moe.toolwindow.AccountKeys.USAGE_NONE
import com.moe.toolwindow.AccountKeys.USAGE_PERCENT
import com.moe.toolwindow.AccountKeys.USAGE_RESETS
import java.lang.reflect.Modifier
import java.text.MessageFormat
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.Locale
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountPresentationTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val now: Instant = Instant.parse("2026-10-20T12:00:00Z")
    private val cli = AccountCli("/usr/bin/node", "/opt/moe/daemon/accounts/cli.js")

    private fun account(
        id: String,
        label: String = id,
        signIn: String = "subscription",
        windows: Map<String, UsageWindow> = emptyMap(),
        peakPercent: Double? = null,
        blockedUntil: String? = null,
        active: Boolean = false,
        seats: List<String> = emptyList()
    ) = ClaudeAccount(id, label, signIn, null, windows, peakPercent, blockedUntil, active, seats)

    private fun rotation(accounts: List<ClaudeAccount>, error: String? = null, cli: AccountCli? = this.cli) =
        AccountRotation("/home/dev/.moe/claude-accounts.json", 90, error, cli, accounts)

    private fun text(key: String, vararg args: Any) = AccountText(key, args.toList())

    private fun worker(accountId: String?) = Worker("worker-a", "CLAUDE", "", null, "CODING", null, accountId = accountId)

    private val spent = account(
        "acct-1", "Work Max",
        windows = mapOf(
            "five_hour" to UsageWindow(92.7, "2026-10-20T14:05:00Z"),
            "seven_day" to UsageWindow(40.0, "2026-10-23T09:00:00Z"),
            "seven_day_opus" to UsageWindow(61.2, null)
        ),
        peakPercent = 92.7, blockedUntil = "2026-10-20T14:05:00Z", seats = listOf("worker-a")
    )
    private val signedOut = account("acct-2", "Personal", signIn = "signed_out")
    private val otherLogin = account("acct-3", signIn = "other")
    private val activeWithSeats = account(
        "acct-4", "Spare",
        windows = mapOf("five_hour" to UsageWindow(12.0, null)),
        peakPercent = 12.0, active = true, seats = listOf("worker-b", "qa-c")
    )

    // ------------------------------------------------------------- table rows

    @Test
    fun `rows show sign-in, both usage windows and status in registry order`() {
        assertEquals(
            listOf(
                AccountRow(
                    "acct-1", 1, "Work Max", text(SIGN_IN_SUBSCRIPTION),
                    text(USAGE_RESETS, 92, "14:05"), text(USAGE_PERCENT, 61), text(STATUS_SPENT_UNTIL, "14:05")
                ),
                AccountRow("acct-2", 2, "Personal", text(SIGN_IN_SIGNED_OUT), text(USAGE_NONE), text(USAGE_NONE), text(STATUS_SIGN_IN_NEEDED)),
                AccountRow("acct-3", 3, "acct-3", text(SIGN_IN_OTHER), text(USAGE_NONE), text(USAGE_NONE), text(STATUS_SIGN_IN_NEEDED)),
                AccountRow(
                    "acct-4", 4, "Spare", text(SIGN_IN_SUBSCRIPTION),
                    text(USAGE_PERCENT, 12), text(USAGE_NONE), text(STATUS_ACTIVE_SEATS, 2)
                )
            ),
            AccountPresentation.rows(rotation(listOf(spent, signedOut, otherLogin, activeWithSeats)), now, zone)
        )
    }

    @Test
    fun `no rotation or an unusable account file gives no rows`() {
        assertEquals(emptyList<AccountRow>(), AccountPresentation.rows(null, now, zone))
        assertEquals(emptyList<AccountRow>(), AccountPresentation.rows(rotation(emptyList(), error = "bad file"), now, zone))
    }

    @Test
    fun `status puts sign-in first, then spent, active, in use and ready`() {
        fun status(account: ClaudeAccount) = AccountPresentation.rows(rotation(listOf(account)), now, zone).single().status

        val blocked = "2026-10-21T03:00:00Z"
        assertEquals(text(STATUS_SIGN_IN_NEEDED), status(account("a", signIn = "signed_out", blockedUntil = blocked, active = true)))
        assertEquals(text(STATUS_SIGN_IN_NEEDED), status(account("a", signIn = "other", active = true, seats = listOf("w"))))
        assertEquals(text(STATUS_SPENT_UNTIL, "10-21 03:00"), status(account("a", blockedUntil = blocked, active = true)))
        assertEquals(text(STATUS_ACTIVE_SEATS, 1), status(account("a", active = true, seats = listOf("w"))))
        assertEquals(text(STATUS_ACTIVE), status(account("a", active = true)))
        assertEquals(text(STATUS_IN_USE, 2), status(account("a", seats = listOf("w", "q"))))
        assertEquals(text(STATUS_READY), status(account("a")))
    }

    @Test
    fun `weekly shows the busiest seven_day window and nothing when none has a percent`() {
        fun weekly(windows: Map<String, UsageWindow>) =
            AccountPresentation.rows(rotation(listOf(account("a", windows = windows))), now, zone).single().weekly

        assertEquals(
            text(USAGE_RESETS, 75, "10-23 09:00"),
            weekly(mapOf("seven_day" to UsageWindow(75.5, "2026-10-23T09:00:00Z"), "seven_day_sonnet" to UsageWindow(20.0, null)))
        )
        assertEquals(text(USAGE_NONE), weekly(mapOf("seven_day" to UsageWindow(null, "2026-10-23T09:00:00Z"))))
        assertEquals(text(USAGE_NONE), weekly(mapOf("five_hour" to UsageWindow(50.0, null))))
    }

    @Test
    fun `percent is floored so a reading under the switch point never shows as it`() {
        assertEquals(89, AccountPresentation.percent(89.99))
        assertEquals(90, AccountPresentation.percent(90.0))
        assertEquals(100, AccountPresentation.percent(100.0))
        assertEquals(0, AccountPresentation.percent(0.4))
        assertEquals(0, AccountPresentation.percent(-3.0))
    }

    @Test
    fun `times read as HH-mm today and MM-dd HH-mm on another day, in the given zone`() {
        assertEquals("23:59", AccountPresentation.time("2026-10-20T23:59:00Z", now, zone))
        assertEquals("10-21 00:01", AccountPresentation.time("2026-10-21T00:01:00.000Z", now, zone))
        assertEquals("10-19 08:00", AccountPresentation.time("2026-10-19T08:00:00Z", now, zone))
        // 22:30Z is already tomorrow at UTC+3.
        assertEquals("10-21 01:30", AccountPresentation.time("2026-10-20T22:30:00Z", now, ZoneOffset.ofHours(3)))
        assertEquals("soon", AccountPresentation.time("soon", now, zone))
    }

    // ------------------------------------------------------------- header line

    @Test
    fun `the header line has one chip per subscription account in registry order`() {
        val usage = account("acct-5", "Lab", peakPercent = 33.3)
        val noData = account("acct-6", "Fresh")
        val activeNoData = account("acct-7", "Night", active = true)
        assertEquals(
            listOf(
                text(CHIP_SPENT, "Work Max", "14:05"),
                text(CHIP_ACTIVE, "Spare", 12),
                text(CHIP_USAGE, "Lab", 33),
                text(CHIP_NO_DATA, "Fresh")
            ),
            AccountPresentation.chips(rotation(listOf(spent, signedOut, activeWithSeats, otherLogin, usage, noData)), now, zone)
        )
        assertEquals(listOf(text(CHIP_ACTIVE_NO_DATA, "Night")), AccountPresentation.chips(rotation(listOf(activeNoData)), now, zone))
    }

    @Test
    fun `the header line says when it cannot show usage`() {
        assertEquals(emptyList<AccountText>(), AccountPresentation.chips(null, now, zone))
        assertEquals(emptyList<AccountText>(), AccountPresentation.chips(rotation(emptyList()), now, zone))
        assertEquals(listOf(text(CHIP_ERROR)), AccountPresentation.chips(rotation(emptyList(), error = "bad file"), now, zone))
        assertEquals(listOf(text(CHIP_NONE_SIGNED_IN)), AccountPresentation.chips(rotation(listOf(signedOut, otherLogin)), now, zone))
    }

    @Test
    fun `the header line shows four chips and counts the rest`() {
        val accounts = (1..7).map { account("acct-$it", "A$it", peakPercent = it.toDouble()) }
        assertEquals(
            (1..4).map { text(CHIP_USAGE, "A$it", it) } + text(CHIP_MORE, 3),
            AccountPresentation.chips(rotation(accounts), now, zone)
        )
        assertEquals(4, AccountPresentation.chips(rotation(accounts.take(4)), now, zone).size)
    }

    @Test
    fun `header chips shorten long labels`() {
        assertEquals(
            listOf(text(CHIP_NO_DATA, "x".repeat(20)), text(CHIP_NO_DATA, "y".repeat(17) + "...")),
            AccountPresentation.chips(rotation(listOf(account("a", "x".repeat(20)), account("b", "y".repeat(21)))), now, zone)
        )
    }

    // ------------------------------------------------------------- worker cards

    @Test
    fun `a worker card title names the account its seat runs on`() {
        val labels = AccountPresentation.labels(rotation(listOf(spent, account("acct-8", "Personal Pro Max"))))
        assertEquals(mapOf("acct-1" to "Work Max", "acct-8" to "Personal Pro Max"), labels)
        assertEquals(emptyMap<String, String>(), AccountPresentation.labels(null))

        assertEquals("CLAUDE", AccountPresentation.workerTitle(worker(null), labels))
        assertEquals("CLAUDE · Work Max", AccountPresentation.workerTitle(worker("acct-1"), labels))
        assertEquals("CLAUDE · acct-9", AccountPresentation.workerTitle(worker("acct-9"), labels))
        assertEquals("CLAUDE · Personal ...", AccountPresentation.workerTitle(worker("acct-8"), labels))
    }

    // ------------------------------------------------------------- controls

    @Test
    fun `list edits need the daemon and command-line actions need only its paths`() {
        val two = rotation(listOf(spent, signedOut))
        val none = AccountActions(
            add = false, rename = false, moveUp = false, moveDown = false, removeOnly = false,
            signIn = false, signOut = false, signOutAndRemove = false, check = false, switchAt = false
        )

        assertEquals(none, AccountPresentation.actions(null, null, connected = true))
        assertEquals(none, AccountPresentation.actions(rotation(emptyList(), error = "bad file"), null, connected = true))
        assertEquals(
            none.copy(add = true, check = true, switchAt = true),
            AccountPresentation.actions(two, null, connected = true)
        )
        assertEquals(
            none.copy(add = true, check = true, switchAt = true),
            AccountPresentation.actions(two, "acct-gone", connected = true)
        )
        val first = AccountPresentation.actions(two, "acct-1", connected = true)
        assertEquals(
            none.copy(
                add = true, rename = true, moveDown = true, removeOnly = true,
                signIn = true, signOut = true, signOutAndRemove = true, check = true, switchAt = true
            ),
            first
        )
        assertEquals(first.copy(moveUp = true, moveDown = false), AccountPresentation.actions(two, "acct-2", connected = true))
        assertEquals(
            none.copy(signIn = true, signOut = true, signOutAndRemove = true, check = true),
            AccountPresentation.actions(two, "acct-1", connected = false)
        )
        assertEquals(
            first.copy(signIn = false, signOut = false, signOutAndRemove = false, check = false),
            AccountPresentation.actions(rotation(listOf(spent, signedOut), cli = null), "acct-1", connected = true)
        )
        assertEquals(none.copy(add = true, switchAt = true), AccountPresentation.actions(rotation(emptyList()), null, connected = true))
    }

    @Test
    fun `no account can be added past the daemon limit`() {
        val full = rotation((1..AccountPresentation.MAX_ACCOUNTS).map { account("acct-$it") })
        assertFalse(AccountPresentation.actions(full, null, connected = true).add)
        assertTrue(AccountPresentation.actions(rotation(full.accounts.drop(1)), null, connected = true).add)
    }

    @Test
    fun `labels follow the daemon rule`() {
        val max = "x".repeat(AccountPresentation.MAX_LABEL_LENGTH)
        for (ok in listOf("", "   ", "Work Max", max, " $max ")) assertTrue("'$ok'", AccountPresentation.isValidLabel(ok))
        for (bad in listOf(max + "x", "a\tb", "a\nb", "a\u0000b", "a\u007Fb")) assertFalse("'$bad'", AccountPresentation.isValidLabel(bad))
    }

    // ------------------------------------------------------------- bundle guard

    @Test
    fun `every account key is in the bundle with as many placeholders as its callers pass`() {
        val bundle = Properties()
        val stream = checkNotNull(javaClass.getResourceAsStream("/messages/MoeBundle.properties")) {
            "MoeBundle.properties is not on the test classpath"
        }
        stream.use { bundle.load(it) }

        val keys = AccountKeys::class.java.declaredFields
            .filter { Modifier.isStatic(it.modifiers) && it.type == String::class.java }
            .map { it.get(null) as String }
        assertEquals("AccountKeys must not repeat a key", keys.size, keys.toSet().size)
        assertEquals(61, keys.size)
        assertEquals(AccountKeys.COLUMNS.size, AccountKeys.COLUMNS.toSet().size)
        assertTrue(keys.containsAll(AccountKeys.COLUMNS))

        // What the presentation emits, plus the panel's own parameterized texts.
        val emitted = AccountPresentation.rows(rotation(listOf(spent, signedOut, otherLogin, activeWithSeats, account("r"))), now, zone)
            .flatMap { listOf(it.signIn, it.fiveHour, it.weekly, it.status) } +
            listOf(account("a", active = true), account("b", active = true, seats = listOf("w")), account("c", seats = listOf("w")))
                .flatMap { AccountPresentation.rows(rotation(listOf(it)), now, zone).map { row -> row.status } } +
            AccountPresentation.chips(rotation(listOf(spent, activeWithSeats) + (1..3).map { account("u$it", peakPercent = 1.0) }), now, zone) +
            AccountPresentation.chips(rotation(listOf(account("n"), account("m", active = true))), now, zone) +
            AccountPresentation.chips(rotation(emptyList(), error = "bad"), now, zone) +
            AccountPresentation.chips(rotation(listOf(signedOut)), now, zone)
        val panelArgs = mapOf(
            AccountKeys.FILE to 1, AccountKeys.ERROR to 1, AccountKeys.HEADER to 1, AccountKeys.HEADER_TOOLTIP to 1,
            AccountKeys.SIGN_OUT_CONFIRM to 1, AccountKeys.REMOVE_CONFIRM to 1, AccountKeys.TERMINAL_UNAVAILABLE to 1
        )
        val emittedKeys = emitted.map { it.key }.toSet()
        val presentationPrefixes = listOf("moe.accounts.signIn.", "moe.accounts.usage.", "moe.accounts.status.", "moe.accounts.chip.")
        assertEquals(
            "the presentation keys this test formats",
            keys.filter { key -> presentationPrefixes.any { key.startsWith(it) } }.toSet(),
            emittedKeys
        )
        val argCounts = emitted.associate { it.key to it.args.size } + panelArgs

        for (key in keys) {
            val value = bundle.getProperty(key)
            assertFalse("$key is missing or blank in MoeBundle.properties", value.isNullOrBlank())
            assertTrue("$key must stay ASCII", value.all { it == '\n' || it in ' '..'~' })
            val placeholders = Regex("\\{(\\d+)}").findAll(value).map { it.groupValues[1] }.toSet().size
            assertEquals("$key placeholders", argCounts[key] ?: 0, placeholders)
            if (placeholders > 0) assertFalse("$key: MessageFormat drops a single quote", value.contains('\''))
        }
        for (text in emitted) {
            assertTrue("${text.key} is not an AccountKeys key", text.key in keys)
            assertFalse(MessageFormat(bundle.getProperty(text.key), Locale.ROOT).format(text.args.toTypedArray()).contains("{"))
        }

        assertEquals("92% (resets 14:05)", MessageFormat(bundle.getProperty(USAGE_RESETS), Locale.ROOT).format(arrayOf<Any>(92, "14:05")))
        assertEquals(
            "Add an account, then sign in with your Claude subscription in the terminal tab that opens.",
            bundle.getProperty(AccountKeys.EMPTY)
        )
    }
}
