import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

// An interactive Moe seat (the wrapper loads this mod only for a claude TUI
// whose loop relaunches it) ends its session when Moe says so, and the wrapper
// relaunches it. Two triggers, both decided by the daemon:
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
// Either way the mod refuses new work and runs /exit once the main turn ends.
// Fails open: an error leaves the call as it was.

export const MARK = 'ACCOUNT-SWITCH:'
export const ENDED = 'END-SESSION:'
export const EXIT_DELAY_MS = 10_000
const ENDED_FALLBACK = 'End your turn now: Moe relaunches this seat.'

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
  exiting: boolean
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

async function exit($: EngineInterface, ended: boolean): Promise<void> {
  try {
    await $.command.run({ command: 'exit' })
  } catch {
    $.ui.toast(ended
      ? 'Moe: this task session is over. Type /exit and Moe relaunches it.'
      : 'Moe: this seat must restart on the next Claude account. Type /exit and Moe relaunches it.', { timeoutMs: 60_000 })
  }
}

/** Once the turn has ended: a hook the turn waits on cannot run a command. */
function leave($: EngineInterface, session: Session): void {
  if (!session.pending || session.exiting) return
  session.exiting = true
  const ended = session.pending.startsWith(ENDED)
  const cause = session.pending.slice(MARK.length).trim().split('. ')[0]
  $.ui.toast(ended
    ? `Moe: this task session is over. This session ends in ${EXIT_DELAY_MS / 1000} s and Moe relaunches it.`
    : `Moe: ${cause}. This session ends in ${EXIT_DELAY_MS / 1000} s and restarts on the next account.`, { timeoutMs: EXIT_DELAY_MS })
  $.clock.after(EXIT_DELAY_MS, () => void exit($, ended))
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
    if (e.agentId === undefined) {
      // An earlier mod can skip classic.StopFailure; check usage independently.
      await checkHardLimit($, session)
      leave($, session)
    }
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
