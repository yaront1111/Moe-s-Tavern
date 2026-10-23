import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

// An interactive Moe seat (the wrapper loads this mod only for a claude TUI
// whose loop relaunches it) moves to the next Claude account the way a
// headless worker does: its session ends and the wrapper leases again. The
// daemon decides when. This mod marks submit_plan and chat_wait as calls the
// session can act on (acceptsAccountSwitch), notices the accountSwitch a moe
// reply carries, refuses new work after it, and runs /exit once the turn ends.
// Inert outside a leased seat (MOE_WORKER_ID and MOE_ACCOUNT_ID set by
// scripts/moe-agent.{sh,ps1}). Fails open: an error leaves the call as it was.

export const MARK = 'ACCOUNT-SWITCH:'
export const EXIT_DELAY_MS = 10_000

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

async function exit($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'exit' })
  } catch {
    $.ui.toast('Moe: this seat must restart on the next Claude account. Type /exit and Moe relaunches it.', { timeoutMs: 60_000 })
  }
}

/** Once the turn has ended: a hook the turn waits on cannot run a command. */
function leave($: EngineInterface, session: Session): void {
  if (!session.pending || session.exiting) return
  session.exiting = true
  const cause = session.pending.slice(MARK.length).trim().split('. ')[0]
  $.ui.toast(`Moe: ${cause}. This session ends in ${EXIT_DELAY_MS / 1000} s and restarts on the next account.`, { timeoutMs: EXIT_DELAY_MS })
  $.clock.after(EXIT_DELAY_MS, () => void exit($))
}

export const register: Register = on => {
  const session: Session = { exiting: false }

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) session.turnId = e.turnId
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = MOE_TOOL.exec(e.tool)?.[1]
    if (!tool || !(await isSeat($))) return next(e)
    if (session.pending && HELD.has(tool)) {
      // The model was told to end its turn and went on: end it here.
      if (e.agentId === undefined && session.turnId) void $.turn.abort({ turnId: session.turnId }).catch(() => undefined)
      return { deny: session.pending }
    }
    const r = await next(MARKED.has(tool) ? ({ ...e, acceptsAccountSwitch: true } as typeof e) : e)
    session.pending ??= switchInstruction(tool, r)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) leave($, session)
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
