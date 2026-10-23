import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { EXIT_DELAY_MS } from './register.ts'

const SEAT = { MOE_WORKER_ID: 'governor-1', MOE_ACCOUNT_ID: 'acct-1' }
const CAUSE = 'Claude account One is at 93% of its usage limit (Moe switches at 90%)'
const switchReply = (next: string, rest: Record<string, unknown> = {}) => ({
  ...rest,
  accountSwitch: {
    from: 'acct-1', to: 'acct-2', fromPeakPercent: 93, switchAtPercent: 90, reason: 'usage',
    instruction: `ACCOUNT-SWITCH: ${CAUSE}. ${next}`,
  },
})
const WAIT_SWITCH = switchReply('End your turn now and do not call chat_wait again: Moe restarts this seat on Two.', { hasMessage: false })
const PLAN_SWITCH = switchReply('Your submission for task-1 is recorded. End your turn now and do not claim or plan another task: Moe restarts this seat on Two, and the new session picks up the next task.', { success: true })
const TURN = { answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' } as const

// Stands for core and the moe daemon: answers each moe tool with its reply as
// JSON text (as the MCP adapter sends it), a string reply as a tool error, and
// records what reached the daemon and what the mod asked of the engine. A call
// on $ (turn.abort, ui.toast, session.usage) is answered with { value }.
function engine(on: On, replies: Record<string, unknown> = {}) {
  const seen = { calls: [] as Record<string, unknown>[], commands: [] as string[], toasts: [] as string[], aborted: [] as string[] }
  on('tool.call', ($, e) => {
    seen.calls.push({ ...e })
    const reply = replies[e.tool.replace(/^mcp__moe__moe_/, '')] ?? { success: true }
    return typeof reply === 'string' ? { isError: true, result: reply } : { result: JSON.stringify(reply) }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.abort', ($, e) => { seen.aborted.push(e.turnId); return { value: undefined } })
  on('command.run', ($, e) => { seen.commands.push(e.command); return {} })
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('classic.StopFailure', () => ({}))
  return seen
}

const call = ($: Engine, name: string, args: Record<string, unknown> = {}) =>
  $.tool.call({ tool: `mcp__moe__moe_${name}`, ...args })

test('a switch reply ends the session once the turn is over, and only once', async ($, on) => {
  mock.env(on, SEAT)
  const clock = mock.clock(on)
  const seen = engine(on, { chat_wait: WAIT_SWITCH })
  await $.turn.start({ text: 'govern', turnId: 't1' })
  await call($, 'chat_wait', { workerId: 'governor-1' })
  expect(seen.calls[0]).toMatchObject({ acceptsAccountSwitch: true })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual([]) // the turn is still running

  await $.turn.complete({ ...TURN, turnId: 't1' })
  expect(seen.toasts).toEqual([`Moe: ${CAUSE}. This session ends in 10 s and restarts on the next account.`])
  await clock.advance(EXIT_DELAY_MS - 1)
  expect(seen.commands).toEqual([])
  await clock.advance(1)
  expect(seen.commands).toEqual(['exit'])

  await $.turn.complete({ ...TURN, turnId: 't2' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
})

test('after a switch reply new work is refused and the turn is ended', async ($, on) => {
  mock.env(on, SEAT)
  mock.clock(on)
  const seen = engine(on, { submit_plan: PLAN_SWITCH })
  await $.turn.start({ text: 'plan', turnId: 't1' })
  await call($, 'submit_plan', { taskId: 'task-1' })
  expect(seen.calls[0]).toMatchObject({ acceptsAccountSwitch: true })
  const claim = await call($, 'claim_next_task', { statuses: ['PLANNING'] })
  expect(claim.deny).toBe(PLAN_SWITCH.accountSwitch.instruction)
  expect(seen.aborted).toEqual(['t1'])
  expect(seen.calls).toHaveLength(1) // the claim never reached the daemon

  await call($, 'chat_send', { channel: '#general', content: 'handing off' })
  expect(seen.calls).toHaveLength(2) // anything else still runs
})

test('a chat message that quotes the phrase changes nothing', async ($, on) => {
  mock.env(on, SEAT)
  const clock = mock.clock(on)
  const quoted = { hasMessage: true, messages: [{ id: 'm1', content: WAIT_SWITCH.accountSwitch.instruction, ...WAIT_SWITCH }] }
  const seen = engine(on, { chat_wait: quoted })
  await $.turn.start({ text: 'govern', turnId: 't1' })
  await call($, 'chat_wait', { workerId: 'governor-1' })
  await call($, 'chat_wait', { workerId: 'governor-1' })
  expect(seen.calls).toHaveLength(2)
  await $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('without a leased account the mod stays out of the way', async ($, on) => {
  mock.env(on, { MOE_WORKER_ID: 'governor-1' })
  const clock = mock.clock(on)
  const seen = engine(on, { chat_wait: WAIT_SWITCH })
  await $.turn.start({ text: 'govern', turnId: 't1' })
  await call($, 'chat_wait', { workerId: 'governor-1' })
  expect(seen.calls[0]).not.toHaveProperty('acceptsAccountSwitch')
  await $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual([])
})

test("a subagent's turn ending leaves the session running", async ($, on) => {
  mock.env(on, SEAT)
  const clock = mock.clock(on)
  const seen = engine(on, { chat_wait: WAIT_SWITCH })
  await $.turn.start({ text: 'govern', turnId: 't1' })
  await call($, 'chat_wait', { workerId: 'governor-1' })
  await $.turn.complete({ ...TURN, turnId: 'sub-1', agentId: 'agent-1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual([])
  await $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
})

test("a worker's step-boundary switch ends an interactive worker's session too", async ($, on) => {
  mock.env(on, { ...SEAT, MOE_WORKER_ID: 'worker-1' })
  const clock = mock.clock(on)
  const seen = engine(on, {
    complete_step: switchReply('Step step-1 is saved. End your session now and do not start another step.', { success: true }),
  })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await call($, 'complete_step', { taskId: 'task-1', stepId: 'step-1' })
  expect(seen.calls[0]).not.toHaveProperty('acceptsAccountSwitch')
  expect((await call($, 'start_step', { taskId: 'task-1', stepId: 'step-2' })).deny).toMatch(/^ACCOUNT-SWITCH: /)
  await $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
})

test('a start_step refusal that names the switch counts as the signal', async ($, on) => {
  mock.env(on, { ...SEAT, MOE_WORKER_ID: 'worker-1' })
  const clock = mock.clock(on)
  const seen = engine(on, {
    start_step: `MCP error -32003: ACCOUNT-SWITCH: ${CAUSE}. Do not start step step-2 in this session; it stays pending.`,
  })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await call($, 'start_step', { taskId: 'task-1', stepId: 'step-2' })
  await $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
})

for (const [percent, exits] of [[100, true], [40, false]] as const) {
  test(`a rate-limit stop at ${percent}% usage ${exits ? 'ends' : 'leaves'} the session`, async ($, on) => {
    mock.env(on, SEAT)
    const clock = mock.clock(on)
    const seen = engine(on)
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: percent }] } }))
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(EXIT_DELAY_MS)
    expect(seen.commands).toEqual(exits ? ['exit'] : [])
  })
}
