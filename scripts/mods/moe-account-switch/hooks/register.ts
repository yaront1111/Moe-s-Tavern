import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

// An interactive Moe seat (the wrapper loads this mod only for a claude TUI
// whose loop relaunches it) moves to the next Claude account the way a
// headless worker does: its session ends and the wrapper leases again. The
// daemon decides when. This mod marks submit_plan and chat_wait as calls the
// session can act on (acceptsAccountSwitch), notices the accountSwitch a moe
// reply carries, refuses new work after it, and runs /exit once the turn ends.
// Inert outside a leased seat (MOE_WORKER_ID and MOE_ACCOUNT_ID set by
// scripts/moe-agent.{sh,ps1}). Fails open: an error leaves the call as it was.
//
// The same exit ends a session whose work is over. The wrapper claims the next
// task only once the CLI exits, and a TUI stays open after the model stops, so
// an architect that found nothing left to plan, reached its session cap or
// answered a notification-only session parked until an operator typed /exit.
// Where the wrapper's loop claims for the seat (MOE_SESSION_ENDS_WHEN_IDLE,
// never a governor), a main turn that ends with the seat holding no task (its
// .moe/workers record, read-only) ends the session; the wrapper launches again
// only once a task is claimable.

export const MARK = 'ACCOUNT-SWITCH:'
export const EXIT_DELAY_MS = 10_000
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

/** The instruction of a moe reply that tells this seat to switch accounts, if it does. */
export function switchInstruction(tool: string, r: ToolCallResult): string | undefined {
  if (r.deny !== undefined) return undefined
  const text = textOf(r)
  if (r.isError) {
    // start_step refuses with the instruction as its error message.
    return tool === 'start_step' && text?.includes(MARK) ? text.slice(text.indexOf(MARK)) : undefined
  }
  if (!SIGNALS.has(tool) || !text) return undefined
  let reply: unknown
  try {
    reply = JSON.parse(text)
  } catch {
    return undefined
  }
  // Top level only: a chat message quoting the phrase sits under messages[].
  const instruction = (reply as { accountSwitch?: { instruction?: unknown } } | null)?.accountSwitch?.instruction
  return typeof instruction === 'string' && instruction.startsWith(MARK) ? instruction : undefined
}

type Session = {
  /** The switch instruction this session was given. */
  pending?: string
  /** The main loop's running turn. */
  turnId?: string
  exiting: boolean
}

async function isSeat($: EngineInterface): Promise<boolean> {
  return Boolean((await $.env.get('MOE_WORKER_ID')) && (await $.env.get('MOE_ACCOUNT_ID')))
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

async function exit($: EngineInterface, idle: boolean): Promise<void> {
  try {
    await $.command.run({ command: 'exit' })
  } catch {
    $.ui.toast(idle
      ? 'Moe: this seat holds no task. Type /exit and Moe claims the next one.'
      : 'Moe: this seat must restart on the next Claude account. Type /exit and Moe relaunches it.', { timeoutMs: 60_000 })
  }
}

/** Once the turn has ended: a hook the turn waits on cannot run a command. */
function leave($: EngineInterface, session: Session): void {
  if (!session.pending || session.exiting) return
  session.exiting = true
  const idle = session.pending === IDLE
  const cause = session.pending.slice(MARK.length).trim().split('. ')[0]
  $.ui.toast(idle
    ? `Moe: this seat holds no task. This session ends in ${EXIT_DELAY_MS / 1000} s and the wrapper claims the next one.`
    : `Moe: ${cause}. This session ends in ${EXIT_DELAY_MS / 1000} s and restarts on the next account.`, { timeoutMs: EXIT_DELAY_MS })
  $.clock.after(EXIT_DELAY_MS, () => void exit($, idle))
}

export const register: Register = on => {
  const session: Session = { exiting: false }

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) session.turnId = e.turnId
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = MOE_TOOL.exec(e.tool)?.[1]
    if (!tool) return next(e)
    if (session.pending && HELD.has(tool)) {
      // The model was told to end its turn and went on: end it here.
      if (e.agentId === undefined && session.turnId) void $.turn.abort({ turnId: session.turnId }).catch(() => undefined)
      return { deny: session.pending }
    }
    if (!(await isSeat($))) return next(e)
    const r = await next(MARKED.has(tool) ? ({ ...e, acceptsAccountSwitch: true } as typeof e) : e)
    session.pending ??= switchInstruction(tool, r)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    // An interrupted turn is the operator's, not the end of the seat's work.
    if (!session.pending && !e.isAborted && (await holdsNoTask($))) session.pending = IDLE
    leave($, session)
    return done
  }).catch(($, e, next) => next(e))

  // A hard limit before any switch point was reported: the seat cannot work on,
  // and the statusline sample already tells the daemon the account is spent.
  on('classic.StopFailure', async ($, e, next) => {
    const done = await next(e)
    if (e.error !== 'rate_limit' || e.agent_id !== undefined || session.pending || !(await isSeat($))) return done
    const { rateLimits } = await $.session.usage()
    if (rateLimits.some(window => window.percentUsed >= 100)) {
      session.pending = `${MARK} this Claude account reached its usage limit. End your turn now: Moe restarts this seat on the next account.`
      leave($, session)
    }
    return done
  }).catch(($, e, next) => next(e))
}
