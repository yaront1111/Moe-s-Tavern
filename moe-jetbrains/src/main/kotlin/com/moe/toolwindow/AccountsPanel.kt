package com.moe.toolwindow

import com.moe.model.AccountRotation
import com.moe.model.ClaudeAccount
import com.moe.model.MoeState
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.toolwindow.board.BoardStyles
import com.moe.toolwindow.board.WrapLayout
import com.moe.util.MoeBundle
import com.moe.util.TerminalAgentLauncher
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.ui.table.JBTable
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import java.awt.Font
import java.awt.datatransfer.StringSelection
import java.time.Instant
import java.time.ZoneId
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.ListSelectionModel
import javax.swing.SpinnerNumberModel
import javax.swing.Timer
import javax.swing.table.AbstractTableModel
import javax.swing.table.DefaultTableCellRenderer

/** Resolves a presentation text with the plugin bundle. */
internal fun AccountText.resolve(): String = MoeBundle.message(key, *args.toTypedArray())

/**
 * The Accounts tab: this machine's Claude accounts, in the order Moe uses
 * them. List edits go to the daemon over the socket; sign in, check and sign
 * out run the daemon's `accounts` CLI in an IDE terminal tab, because claude's
 * own prompts need a person and the daemon never runs claude.
 */
class AccountsPanel(private val project: Project) : JBPanel<AccountsPanel>(BorderLayout()), Disposable {
    private val service = project.service<MoeProjectService>()
    private val tableModel = AccountTableModel()
    private val table = JBTable(tableModel)
    private val errorNote = note(BoardStyles.disconnectedText).apply {
        isOpaque = true
        background = BoardStyles.disconnectedBackground
        border = JBUI.Borders.empty(4, 8)
    }
    private val fileNote = note(BoardStyles.textSecondary)
    private val switchSpinner = JSpinner(SpinnerNumberModel(DEFAULT_SWITCH_PERCENT, 1, 100, 1))
    private val switchTimer = Timer(SWITCH_DEBOUNCE_MS) { sendSwitchPercent() }.apply { isRepeats = false }
    private val addButton = button(AccountKeys.BUTTON_ADD) { addAccount() }
    private val signInButton = button(AccountKeys.BUTTON_SIGN_IN) { selected()?.let { runCli(listOf("login", it.id)) } }
    private val checkButton = button(AccountKeys.BUTTON_CHECK) { runCli(listOf("check")) }
    private val signOutButton = button(AccountKeys.BUTTON_SIGN_OUT) { signOut() }
    private val renameButton = button(AccountKeys.BUTTON_RENAME) { rename() }
    private val moveUpButton = button(AccountKeys.BUTTON_MOVE_UP) { selected()?.let { service.moveAccount(it.id, -1) } }
    private val moveDownButton = button(AccountKeys.BUTTON_MOVE_DOWN) { selected()?.let { service.moveAccount(it.id, 1) } }
    private val removeButton = button(AccountKeys.BUTTON_REMOVE) { remove() }
    private val labelValidator = object : InputValidator {
        override fun checkInput(inputString: String?): Boolean = AccountPresentation.isValidLabel(inputString.orEmpty())
        override fun canClose(inputString: String?): Boolean = checkInput(inputString)
    }
    private var rotation: AccountRotation? = null
    private var hasState = false
    private var connected = service.isConnected()
    private var updatingSpinner = false
    /** This tab sent ADD_ACCOUNT; its ACCOUNT_ADDED reply opens the new account's sign-in. */
    private var awaitingAdd = false
    private var stateListener: MoeStateListener? = null

    init {
        border = JBUI.Borders.empty(8)
        background = BoardStyles.boardBackground

        table.apply {
            setSelectionMode(ListSelectionModel.SINGLE_SELECTION)
            setShowGrid(false)
            // Labels are typed by people; a cell never renders one as HTML.
            setDefaultRenderer(Any::class.java, DefaultTableCellRenderer().apply { putClientProperty("html.disable", true) })
            selectionModel.addListSelectionListener { if (!it.valueIsAdjusting) updateActions() }
        }
        COLUMN_WIDTHS.forEachIndexed { index, width -> table.columnModel.getColumn(index).preferredWidth = width }

        switchSpinner.addChangeListener { if (!updatingSpinner) switchTimer.restart() }
        (switchSpinner.editor as? JSpinner.DefaultEditor)?.textField?.columns = 3

        val switchRow = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            isOpaque = false
            add(JBLabel(MoeBundle.message(AccountKeys.SWITCH_AT)).apply { labelFor = switchSpinner })
            add(switchSpinner)
            add(JBLabel(MoeBundle.message(AccountKeys.SWITCH_AT_UNIT)))
        }
        val buttonRow = JPanel(WrapLayout(FlowLayout.LEFT, 4, 4)).apply {
            isOpaque = false
            for (button in listOf(addButton, signInButton, checkButton, signOutButton, renameButton, moveUpButton, moveDownButton, removeButton)) {
                add(button)
            }
        }
        val top = JPanel(VerticalLayout(6)).apply {
            isOpaque = false
            border = JBUI.Borders.emptyBottom(6)
            add(JBLabel(MoeBundle.message(AccountKeys.TITLE)).apply { font = font.deriveFont(Font.BOLD, 14f) })
            add(note(BoardStyles.textSecondary).apply { text = MoeBundle.message(AccountKeys.INTRO) })
            add(errorNote)
            add(switchRow)
            add(buttonRow)
        }

        add(top, BorderLayout.NORTH)
        add(JBScrollPane(table), BorderLayout.CENTER)
        add(fileNote.apply { border = JBUI.Borders.emptyTop(6) }, BorderLayout.SOUTH)

        stateListener = object : MoeStateListener {
            override fun onState(state: MoeState) {
                hasState = true
                rotation = state.accountRotation
                render()
            }

            override fun onStatus(connected: Boolean, message: String) {
                this@AccountsPanel.connected = connected
                render()
            }

            override fun onAccountAdded(accountId: String) {
                if (!awaitingAdd) return
                awaitingAdd = false
                runCli(listOf("login", accountId))
            }
        }
        service.addListener(stateListener!!)
        service.getState()?.let {
            hasState = true
            rotation = it.accountRotation
        }
        render()
    }

    override fun dispose() {
        switchTimer.stop()
        stateListener?.let { service.removeListener(it) }
        stateListener = null
    }

    private fun render() {
        val current = rotation
        val rows = AccountPresentation.rows(current, Instant.now(), ZoneId.systemDefault())
        if (rows != tableModel.rows) {
            val selectedId = selectedId()
            tableModel.update(rows)
            val index = rows.indexOfFirst { it.id == selectedId }
            if (index >= 0) table.selectionModel.setSelectionInterval(index, index)
        }
        val error = current?.error
        table.emptyText.setText(
            when {
                error != null -> ""
                current != null -> MoeBundle.message(AccountKeys.EMPTY)
                hasState && connected -> MoeBundle.message(AccountKeys.UNSUPPORTED)
                else -> MoeBundle.message(AccountKeys.NOT_CONNECTED)
            }
        )
        errorNote.display(
            when {
                error != null -> MoeBundle.message(AccountKeys.ERROR, error)
                current != null && current.cli == null -> MoeBundle.message(AccountKeys.NO_CLI)
                else -> null
            }
        )
        fileNote.display(current?.let { MoeBundle.message(AccountKeys.FILE, it.registryFile) })
        // A value the person is still changing is not overwritten by the daemon's older one.
        if (current != null && !switchTimer.isRunning && switchSpinner.value != current.switchAtPercent) {
            updatingSpinner = true
            try {
                switchSpinner.value = current.switchAtPercent
            } finally {
                updatingSpinner = false
            }
        }
        updateActions()
    }

    private fun updateActions() {
        val allowed = AccountPresentation.actions(rotation, selectedId(), connected)
        addButton.isEnabled = allowed.add
        signInButton.isEnabled = allowed.signIn
        checkButton.isEnabled = allowed.check
        signOutButton.isEnabled = allowed.signOut
        renameButton.isEnabled = allowed.rename
        moveUpButton.isEnabled = allowed.moveUp
        moveDownButton.isEnabled = allowed.moveDown
        removeButton.isEnabled = allowed.removeOnly || allowed.signOutAndRemove
        switchSpinner.isEnabled = allowed.switchAt
    }

    private fun selectedId(): String? = tableModel.rows.getOrNull(table.selectedRow)?.id

    private fun selected(): ClaudeAccount? {
        val id = selectedId() ?: return null
        return rotation?.accounts?.firstOrNull { it.id == id }
    }

    private fun addAccount() {
        val label = Messages.showInputDialog(
            project,
            MoeBundle.message(AccountKeys.ADD_PROMPT),
            MoeBundle.message(AccountKeys.ADD_TITLE),
            null,
            "",
            labelValidator
        ) ?: return
        awaitingAdd = true
        service.addAccount(label)
    }

    private fun rename() {
        val account = selected() ?: return
        val label = Messages.showInputDialog(
            project,
            MoeBundle.message(AccountKeys.RENAME_PROMPT),
            MoeBundle.message(AccountKeys.RENAME_TITLE),
            null,
            account.label,
            labelValidator
        ) ?: return
        if (label.trim() != account.label) service.renameAccount(account.id, label)
    }

    private fun signOut() {
        val account = selected() ?: return
        val choice = Messages.showOkCancelDialog(
            project,
            MoeBundle.message(AccountKeys.SIGN_OUT_CONFIRM, account.label),
            MoeBundle.message(AccountKeys.SIGN_OUT_TITLE),
            MoeBundle.message(AccountKeys.BUTTON_SIGN_OUT),
            MoeBundle.message(AccountKeys.CANCEL),
            Messages.getQuestionIcon()
        )
        if (choice == Messages.OK) runCli(listOf("logout", account.id))
    }

    private fun remove() {
        val account = selected() ?: return
        val allowed = AccountPresentation.actions(rotation, account.id, connected)
        val choices = mutableListOf<Pair<String, () -> Unit>>()
        if (allowed.signOutAndRemove) {
            // The CLI signs the account out first and keeps it listed if that fails.
            choices.add(MoeBundle.message(AccountKeys.REMOVE_SIGN_OUT) to { runCli(listOf("remove", account.id, "--sign-out")) })
        }
        if (allowed.removeOnly) {
            choices.add(MoeBundle.message(AccountKeys.REMOVE_ONLY) to { service.removeAccount(account.id) })
        }
        if (choices.isEmpty()) return
        val options = (choices.map { it.first } + MoeBundle.message(AccountKeys.CANCEL)).toTypedArray()
        val choice = Messages.showDialog(
            project,
            MoeBundle.message(AccountKeys.REMOVE_CONFIRM, account.label),
            MoeBundle.message(AccountKeys.REMOVE_TITLE),
            options,
            options.lastIndex,
            Messages.getWarningIcon()
        )
        // Cancel is past the end of choices, and closing the dialog returns -1.
        choices.getOrNull(choice)?.second?.invoke()
    }

    private fun runCli(args: List<String>) {
        val current = rotation ?: return
        val cli = current.cli ?: return
        val tab = MoeBundle.message(AccountKeys.TERMINAL_TAB)
        if (TerminalAgentLauncher.runAccountsCommand(project, cli, current.registryFile, args, tab)) return
        // No terminal tab: give the person the exact line to run where their agents run.
        val line = TerminalAgentLauncher.accountsCommandLine(project, cli, current.registryFile, args)
        CopyPasteManager.getInstance().setContents(StringSelection(line))
        Messages.showWarningDialog(
            project,
            MoeBundle.message(AccountKeys.TERMINAL_UNAVAILABLE, line),
            MoeBundle.message(AccountKeys.TERMINAL_UNAVAILABLE_TITLE)
        )
    }

    private fun sendSwitchPercent() {
        val percent = (switchSpinner.value as? Number)?.toInt() ?: return
        val current = rotation ?: return
        if (percent != current.switchAtPercent && AccountPresentation.actions(current, null, connected).switchAt) {
            service.setAccountSwitchPercent(percent)
        }
    }

    private fun button(key: String, action: () -> Unit) = JButton(MoeBundle.message(key)).apply {
        addActionListener { action() }
    }

    /** Read-only wrapping text: copyable, and never rendered as HTML. */
    private fun note(color: Color) = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        isOpaque = false
        border = JBUI.Borders.empty()
        font = JBUI.Fonts.label()
        foreground = color
    }

    private fun JBTextArea.display(value: String?) {
        isVisible = value != null
        if (value != null && text != value) text = value
    }

    private class AccountTableModel : AbstractTableModel() {
        private val columns = AccountKeys.COLUMNS.map { MoeBundle.message(it) }
        var rows: List<AccountRow> = emptyList()
            private set

        fun update(rows: List<AccountRow>) {
            this.rows = rows
            fireTableDataChanged()
        }

        override fun getRowCount(): Int = rows.size
        override fun getColumnCount(): Int = columns.size
        override fun getColumnName(column: Int): String = columns[column]

        override fun getValueAt(rowIndex: Int, columnIndex: Int): Any {
            val row = rows.getOrNull(rowIndex) ?: return ""
            return when (columnIndex) {
                0 -> row.position.toString()
                1 -> row.label
                2 -> row.signIn.resolve()
                3 -> row.fiveHour.resolve()
                4 -> row.weekly.resolve()
                5 -> row.status.resolve()
                else -> ""
            }
        }
    }

    private companion object {
        const val DEFAULT_SWITCH_PERCENT = 90
        /** Spinner clicks settle into one SET_ACCOUNT_SWITCH_PERCENT. */
        const val SWITCH_DEBOUNCE_MS = 600
        val COLUMN_WIDTHS = listOf(32, 160, 110, 150, 150, 170)
    }
}
