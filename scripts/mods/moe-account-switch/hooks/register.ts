import type { EngineInterface, Register, Timer, ToolCallResult } from 'claude-code'

// An interactive Moe seat (the wrapper loads this mod only for a claude TUI
// whose loop relaunches it) ends its session when Moe says so, and the wrapper
// relaunches it. Three triggers:
// - Account switch: the seat moves to the next Claude account the way a
//   headless worker does. This mod marks submit_plan and chat_wait as calls the
//   session can act on (acceptsAccountSwitch) and notices the accountSwitch a
//   moe reply carries, or claude stopping at the usage limit. Needs a leased
//   seat (MOE_WORKER_ID and MOE_ACCOUNT_ID set by scripts/moe-agent.{sh,ps1}).
// - END_SESSION: the sessionHandoff a moe reply addresses to this seat
//   (report_blocked freed it, or a claim_next_task/wait_for_task refusal over a
//   resource-held task). A TUI cannot end itself, and the next task needs a
//   fresh wrapper pre-flight. Needs only MOE_WORKER_ID and a session that draws
//   on a surface (never a -p run).
// - Idle: the session's work is over. The wrapper claims the next task only
//   once the CLI exits, and a TUI stays open after the model stops, so an
//   architect that found nothing left to plan, reached its session cap or
//   answered a notification-only session parked until an operator typed /exit.
//   Where the wrapper's loop claims for the seat (MOE_SESSION_ENDS_WHEN_IDLE,
//   never a governor), a main turn that ends with the seat holding no task (its
//   .moe/workers record, read-only) ends the session; the wrapper launches again
//   only once a task is claimable.
// In each case the mod refuses new work and runs /exit 10 s after the main turn
// ends. /exit alone may leave the CLI up: over running background work claude
// opens 'Background work is running', which waits for a person (11-02: 3h50m).
// So the mod names its own CLI just before /exit, and 60 s later, with no main
// turn running, terminates it. A refused /exit or a failed termination asks for
// /exit by hand, and the next main turn that ends tries again.
// Fails open: an error leaves the call as it was.

export const MARK = 'ACCOUNT-SWITCH:'
export const ENDED = 'END-SESSION:'
export const EXIT_DELAY_MS = 10_000
/** After /exit, how long a CLI still up waits before the mod terminates it; after a termination, before the mod gives up on it. */
export const FORCE_EXIT_DELAY_MS = 60_000
const ENDED_FALLBACK = 'End your turn now: Moe relaunches this seat.'
/** New work is refused with this once a session whose seat holds no task is ending. */
export const IDLE = 'SESSION-END: this seat holds no task, so this session is ending. End your turn now: the wrapper claims the next task in a fresh session.'

const MOE_TOOL = /^mcp__.+__moe_([a-z_]+)$/
/** The daemon switches a seat between tasks only when the call says the session can end itself. */
const MARKED = new Set(['submit_plan', 'chat_wait'])
/** Replies whose top-level accountSwitch tells the seat to switch. */
const SIGNALS = new Set(['submit_plan', 'chat_wait', 'complete_step'])
/** Calls that start new work: refused once a switch is due. */
const HELD = new Set(['claim_next_task', 'wait_for_task', 'chat_wait', 'start_step'])

/** The reply as the model read it: core's text, or a hook's own result. */
function textOf(r: ToolCallResult): string | undefined {
  if (typeof r.text === 'string') return r.text
  if (typeof r.result === 'string') return r.result
  if (!Array.isArray(r.result)) return undefined
  return r.result.map(block => (typeof block?.text === 'string' ? block.text : '')).join('')
}

/** A moe reply's JSON, unless the call was refused or failed. */
function replyOf(r: ToolCallResult): unknown {
  if (r.deny !== undefined || r.isError) return undefined
  const text = textOf(r)
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The instruction of a moe reply that tells this seat to switch accounts, if it does. */
export function switchInstruction(tool: string, r: ToolCallResult): string | undefined {
  if (r.deny !== undefined) return undefined
  if (r.isError) {
    const text = textOf(r)
    // start_step refuses with the instruction as its error message.
    return tool === 'start_step' && text?.includes(MARK) ? text.slice(text.indexOf(MARK)) : undefined
  }
  if (!SIGNALS.has(tool)) return undefined
  // Top level only: a chat message quoting the phrase sits under messages[].
  const instruction = (replyOf(r) as { accountSwitch?: { instruction?: unknown } } | null | undefined)?.accountSwitch?.instruction
  return typeof instruction === 'string' && instruction.startsWith(MARK) ? instruction : undefined
}

/** The instruction of a moe reply that ends this seat's session, if it does. */
export function endSessionInstruction(r: ToolCallResult, workerId: string): string | undefined {
  // Top level only, as for accountSwitch.
  const handoff = (replyOf(r) as { sessionHandoff?: unknown } | null | undefined)?.sessionHandoff
  if (typeof handoff !== 'object' || handoff === null) return undefined
  const { action, workerId: addressee, reason } = handoff as Record<string, unknown>
  // A handoff the daemon addressed to another seat is not this session's to end.
  if (action !== 'END_SESSION' || addressee !== workerId) return undefined
  return `${ENDED} ${typeof reason === 'string' && reason.trim() ? reason.trim() : ENDED_FALLBACK}`
}

type Session = {
  /** The instruction that ends this session: an account switch or END_SESSION. */
  pending?: string
  /** The main loop's running turn. */
  turnId?: string
  /** A main turn is running: the mod never terminates the CLI under it. */
  running: boolean
  /** The exit attempt in flight. One that ends with the session still up clears it, so the next main turn's end tries again. */
  attempt?: Attempt
}

/** One try at ending the session: its toast, /exit, then the fallback termination. */
type Attempt = {
  ending: Ending
  /** What terminates this CLI, named just before /exit; undefined when it could not be named. */
  argv?: readonly string[]
  /** The fallback's timer, cancelled when the attempt ends. */
  timer?: Timer
  /** A termination went out: the next check gives up on it. */
  delivered: boolean
}

async function isSeat($: EngineInterface): Promise<boolean> {
  return Boolean((await $.env.get('MOE_WORKER_ID')) && (await $.env.get('MOE_ACCOUNT_ID')))
}

async function checkHardLimit($: EngineInterface, session: Session): Promise<void> {
  if (session.pending || !(await isSeat($))) return
  const { rateLimits } = await $.session.usage()
  if (rateLimits.some(window => window.percentUsed >= 100)) {
    session.pending ??= `${MARK} this Claude account reached its usage limit. End your turn now: Moe restarts this seat on the next account.`
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** The wrapper's loop claims for this seat and its record names no task: the session's work is over. */
async function holdsNoTask($: EngineInterface): Promise<boolean> {
  const workerId = await $.env.get('MOE_WORKER_ID')
  if (!workerId || !SAFE_ID.test(workerId) || !(await $.env.get('MOE_SESSION_ENDS_WHEN_IDLE'))) return false
  const root = (await $.env.get('MOE_PROJECT_PATH')) || '.'
  try {
    const worker: unknown = JSON.parse(await $.fs.read(`${root}/.moe/workers/${workerId}.json`))
    return typeof worker === 'object' && worker !== null && !(worker as { currentTaskId?: unknown }).currentTaskId
  } catch {
    return false // no readable record: keep the session
  }
}

/** Why the pending instruction ends the session. */
type Ending = 'switch' | 'ended' | 'idle'

function endingOf(pending: string): Ending {
  if (pending === IDLE) return 'idle'
  return pending.startsWith(ENDED) ? 'ended' : 'switch'
}

/** What the person is asked once an attempt has not ended the session. */
const MANUAL: Record<Ending, string> = {
  switch: 'Moe: this seat must restart on the next Claude account. Type /exit and Moe relaunches it.',
  ended: 'Moe: this task session is over. Type /exit and Moe relaunches it.',
  idle: 'Moe: this seat holds no task. Type /exit and Moe claims the next one.',
}

/** A session directory with a drive letter or a UNC prefix: claude runs on Windows. */
const WINDOWS_CWD = /^(?:[A-Za-z]:[\\/]|\\\\)/
// Stops this PowerShell's parent (this CLI, created before it), then that CLI's
// other descendants, skipping itself and conhost.exe. No double quote: Windows
// PowerShell 5.1 drops them from a -Command argument (task-76d4500a).
const STOP_CLI_PS = "$all = @(Get-CimInstance Win32_Process); $self = $all | Where-Object { $_.ProcessId -eq $PID }; $cli = $all | Where-Object { $_.ProcessId -eq $self.ParentProcessId -and $_.CreationDate -le $self.CreationDate }; if ($null -eq $cli) { exit 3 }; $doomed = New-Object System.Collections.ArrayList; function Add-Tree($p) { foreach ($c in $all) { if ($c.ParentProcessId -eq $p.ProcessId -and $c.ProcessId -ne $PID -and $c.Name -ne 'conhost.exe' -and $c.CreationDate -ge $p.CreationDate) { Add-Tree $c; [void]$doomed.Add($c.ProcessId) } } }; Add-Tree $cli; foreach ($id in $doomed) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }; Stop-Process -Id $cli.ProcessId -Force"

/** The command that terminates this CLI, or undefined when it cannot be named. */
async function nameCli($: EngineInterface): Promise<readonly string[] | undefined> {
  try {
    if (WINDOWS_CWD.test(await $.session.cwd())) return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', STOP_CLI_PS]
    // $.process.run spawns argv directly, so this child's parent is this CLI.
    const { exitCode, stdout } = await $.process.run(['sh', '-c', 'echo "$PPID"'], { timeoutMs: 5_000 })
    const text = stdout.trim()
    const pid = Number(text)
    // Never pid 1 or less: an orphaned child reads its reaper, not this CLI.
    if (exitCode !== 0 || !/^\d+$/.test(text) || !Number.isSafeInteger(pid) || pid <= 1) return undefined
    // SIGTERM runs claude's own shutdown, which stops its background work and exits 143.
    return ['sh', '-c', 'kill -TERM "$1"', 'sh', String(pid)]
  } catch {
    return undefined
  }
}

/** Ends an attempt that left the session up: /exit by hand, and the next main turn's end tries again. */
function giveUp($: EngineInterface, session: Session, attempt: Attempt): void {
  if (session.attempt !== attempt) return
  session.attempt = undefined
  try {
    $.ui.toast(MANUAL[attempt.ending], { timeoutMs: 60_000 })
    attempt.timer?.cancel()
  } catch {
    // A timer left armed finds its attempt over and does nothing.
  }
}

/** FORCE_EXIT_DELAY_MS after /exit the CLI is still up: end it, once no main turn runs. */
async function force($: EngineInterface, session: Session, attempt: Attempt): Promise<void> {
  if (session.attempt !== attempt) return
  try {
    if (attempt.delivered) {
      giveUp($, session, attempt) // it outlived its termination
      return
    }
    if (session.running) {
      attempt.timer = $.clock.after(FORCE_EXIT_DELAY_MS, () => void force($, session, attempt))
      return
    }
    if (!attempt.argv) {
      giveUp($, session, attempt)
      return
    }
    const { exitCode } = await $.process.run(attempt.argv, { timeoutMs: 30_000 })
    if (session.attempt !== attempt) return
    if (exitCode !== 0) {
      giveUp($, session, attempt)
      return
    }
    attempt.delivered = true
    attempt.timer = $.clock.after(FORCE_EXIT_DELAY_MS, () => void force($, session, attempt))
  } catch {
    giveUp($, session, attempt)
  }
}

async function exit($: EngineInterface, session: Session, attempt: Attempt): Promise<void> {
  // Named now, while this CLI is alive.
  attempt.argv = await nameCli($)
  try {
    // Armed before /exit, and kept when /exit resolves: over a running shell,
    // subagent, monitor, MCP task or session cron claude's /exit opens a dialog
    // with no timeout, and Stay or a background session's detach leaves it up.
    attempt.timer = $.clock.after(FORCE_EXIT_DELAY_MS, () => void force($, session, attempt))
  } catch {
    giveUp($, session, attempt)
  }
  try {
    await $.command.run({ command: 'exit' })
  } catch {
    // Refused: claude holds a plugin's input after a person's Stop.
    giveUp($, session, attempt)
  }
}

/** Once the turn has ended: a hook the turn waits on cannot run a command. */
function leave($: EngineInterface, session: Session): void {
  if (!session.pending || session.attempt) return
  const attempt: Attempt = { ending: endingOf(session.pending), delivered: false }
  session.attempt = attempt
  const cause = session.pending.slice(MARK.length).trim().split('. ')[0]
  try {
    $.ui.toast(attempt.ending === 'ended'
      ? `Moe: this task session is over. This session ends in ${EXIT_DELAY_MS / 1000} s and Moe relaunches it.`
      : attempt.ending === 'idle'
        ? `Moe: this seat holds no task. This session ends in ${EXIT_DELAY_MS / 1000} s and the wrapper claims the next one.`
        : `Moe: ${cause}. This session ends in ${EXIT_DELAY_MS / 1000} s and restarts on the next account.`, { timeoutMs: EXIT_DELAY_MS })
    $.clock.after(EXIT_DELAY_MS, () => void exit($, session, attempt))
  } catch {
    session.attempt = undefined // the next main turn's end tries again
  }
}

export const register: Register = on => {
  const session: Session = { running: false }

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      session.turnId = e.turnId
      session.running = true
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = MOE_TOOL.exec(e.tool)?.[1]
    if (!tool) return next(e)
    const workerId = await $.env.get('MOE_WORKER_ID')
    if (!workerId) return next(e)
    if (session.pending && HELD.has(tool)) {
      // The model was told to end its turn and went on: end it here.
      if (e.agentId === undefined && session.turnId) void $.turn.abort({ turnId: session.turnId }).catch(() => undefined)
      return { deny: session.pending }
    }
    const leased = Boolean(await $.env.get('MOE_ACCOUNT_ID'))
    const r = await next(leased && MARKED.has(tool) ? ({ ...e, acceptsAccountSwitch: true } as typeof e) : e)
    if (leased) session.pending ??= switchInstruction(tool, r)
    const ended = session.pending ? undefined : endSessionInstruction(r, workerId)
    // A -p run draws on no surface, and its session ends with its turn anyway.
    if (ended && (await $.session.surfaces()).length > 0) session.pending ??= ended
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    session.running = false
    // An earlier mod can skip classic.StopFailure; check usage independently.
    await checkHardLimit($, session)
    // An interrupted turn is the operator's, not the end of the seat's work.
    if (!session.pending && !e.isAborted && (await holdsNoTask($))) session.pending = IDLE
    leave($, session)
    return done
  }).catch(($, e, next) => next(e))

  // A hard limit before any switch point was reported: the seat cannot work on,
  // and the statusline sample already tells the daemon the account is spent.
  on('classic.StopFailure', async ($, e, next) => {
    const done = await next(e)
    if (e.error !== 'rate_limit' || e.agent_id !== undefined || session.pending) return done
    await checkHardLimit($, session)
    leave($, session)
    return done
  }).catch(($, e, next) => next(e))
}
