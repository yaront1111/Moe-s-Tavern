import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'
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
const usage = (...percents: number[]): SessionUsage => ({
  startedAt: 0, context: { window: 200_000 },
  rateLimits: percents.map((percentUsed, i) => ({ kind: i === 0 ? 'five_hour' : 'spend_limit', percentUsed })),
})

function engine(on: On, replies: Record<string, unknown> = {}, readUsage: () => SessionUsage | Promise<SessionUsage> = usage) {
  const seen = {
    calls: [] as Record<string, unknown>[], commands: [] as string[], toasts: [] as string[], aborted: [] as string[],
    completions: 0, usageReads: 0, stopFailures: 0, timers: 0,
  }
  on('tool.call', ($, e) => {
    seen.calls.push({ ...e })
    const reply = replies[e.tool.replace(/^mcp__moe__moe_/, '')] ?? { success: true }
    return typeof reply === 'string' ? { isError: true, result: reply } : { result: JSON.stringify(reply) }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => { seen.completions++; return { text: e.answer } })
  on('session.usage', async () => { seen.usageReads++; return { value: await readUsage() } })
  // A glob can observe the timer without duplicating mock.clock's exact hook.
  on('clock.*', ($, e, next) => { if (next.event === 'clock.after') seen.timers++; return next(e) })
  on('turn.abort', ($, e) => { seen.aborted.push(e.turnId); return { value: undefined } })
  on('command.run', ($, e) => { seen.commands.push(e.command); return {} })
  on('ui.toast', ($, e) => { seen.toasts.push(e.text); return { value: undefined } })
  on('classic.StopFailure', () => { seen.stopFailures++; return {} })
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
    const seen = engine(on, {}, () => usage(percent))
    await $.classic.StopFailure({ error: 'rate_limit' })
    await clock.advance(EXIT_DELAY_MS)
    expect(seen.commands).toEqual(exits ? ['exit'] : [])
  })
}

test('a swallowed StopFailure still rotates at main completion', {
  plugins: [{ name: 'swallow-stop-failure', tier: 'prepend', register(on) {
    on('classic.StopFailure', () => ({}))
  } }],
}, async ($, on) => {
  mock.env(on, SEAT)
  const seen = engine(on, {}, () => usage(100))
  const clock = mock.clock(on)
  await $.turn.start({ text: 'govern', turnId: 't1' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(seen.stopFailures).toBe(0)
  expect(seen.usageReads).toBe(0)
  expect(seen.timers).toBe(0)
  expect(await $.turn.complete({ ...TURN, turnId: 't1', reason: 'error' })).toEqual({ text: 'ok' })
  expect(seen.completions).toBe(1)
  expect(seen.usageReads).toBe(1)
  expect(seen.timers).toBe(1)
  await clock.advance(EXIT_DELAY_MS - 1)
  expect(seen.commands).toEqual([])
  await clock.advance(1)
  expect(seen.commands).toEqual(['exit'])
  expect(seen.toasts).toEqual(['Moe: this Claude account reached its usage limit. This session ends in 10 s and restarts on the next account.'])
})

for (const percents of [[100], [99.9, 100], [0, 101], [0, 99.9], []]) {
  test(`completion without StopFailure checks all windows: ${JSON.stringify(percents)}`, async ($, on) => {
    mock.env(on, SEAT)
    const seen = engine(on, {}, () => usage(...percents))
    const clock = mock.clock(on)
    expect(await $.turn.complete({ ...TURN, turnId: 't1' })).toEqual({ text: 'ok' })
    expect(seen.stopFailures).toBe(0)
    expect(seen.usageReads).toBe(1)
    const exits = percents.some(percent => percent >= 100)
    expect(seen.timers).toBe(exits ? 1 : 0)
    expect(seen.toasts).toHaveLength(exits ? 1 : 0)
    await clock.advance(EXIT_DELAY_MS)
    expect(seen.commands).toEqual(exits ? ['exit'] : [])
  })
}

for (const env of [{ MOE_WORKER_ID: '', MOE_ACCOUNT_ID: 'acct-1' }, { MOE_WORKER_ID: 'governor-1', MOE_ACCOUNT_ID: '' }, { MOE_WORKER_ID: '', MOE_ACCOUNT_ID: '' }]) {
  test(`completion ignores a missing seat variable: ${JSON.stringify(env)}`, async ($, on) => {
    mock.env(on, env)
    const seen = engine(on, {}, () => usage(100))
    const clock = mock.clock(on)
    expect(await $.turn.complete({ ...TURN, turnId: 't1' })).toEqual({ text: 'ok' })
    expect(seen.usageReads).toBe(0)
    expect(seen.toasts).toEqual([])
    await clock.advance(EXIT_DELAY_MS)
    expect(seen.commands).toEqual([])
  })
}

test('a subagent does not read spent usage but the next main completion does', async ($, on) => {
  mock.env(on, SEAT)
  const seen = engine(on, {}, () => usage(100))
  const clock = mock.clock(on)
  await $.turn.complete({ ...TURN, turnId: 'sub-1', agentId: 'agent-1' })
  expect(seen.usageReads).toBe(0)
  expect(seen.toasts).toEqual([])
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual([])
  await $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
})

for (const failure of ['usage', 'env'] as const) {
  test(`${failure} failure leaves completion and future work unchanged`, async ($, on) => {
    let broken = true
    on('env.get', ($, e) => {
      if (broken && failure === 'env') throw new Error('env unavailable')
      return { value: SEAT[e.name as keyof typeof SEAT] }
    })
    const seen = engine(on, {}, () => {
      if (broken && failure === 'usage') throw new Error('usage unavailable')
      return usage(100)
    })
    const clock = mock.clock(on)
    expect(await $.turn.complete({ ...TURN, turnId: 't1' })).toEqual({ text: 'ok' })
    expect(seen.completions).toBe(1)
    expect(seen.toasts).toEqual([])
    expect(seen.timers).toBe(0)
    await clock.advance(EXIT_DELAY_MS)
    expect(seen.commands).toEqual([])
    broken = false
    expect((await call($, 'start_step')).deny).toBe(undefined)
    expect(seen.calls).toHaveLength(1)
    expect(await $.turn.complete({ ...TURN, turnId: 't2' })).toEqual({ text: 'ok' })
    expect(seen.completions).toBe(2)
    await clock.advance(EXIT_DELAY_MS)
    expect(seen.commands).toEqual(['exit'])
  })
}

test('a pending daemon instruction exits without reading unavailable usage', async ($, on) => {
  mock.env(on, SEAT)
  const seen = engine(on, { chat_wait: WAIT_SWITCH }, () => { throw new Error('usage unavailable') })
  const clock = mock.clock(on)
  await call($, 'chat_wait')
  expect(await $.turn.complete({ ...TURN, turnId: 't1' })).toEqual({ text: 'ok' })
  expect(seen.usageReads).toBe(0)
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
  expect(seen.toasts[0]).toContain(CAUSE)
})

for (const order of ['stop-first', 'completion-first', 'concurrent'] as const) {
  test(`${order} and repeated completions schedule only one exit`, async ($, on) => {
    mock.env(on, SEAT)
    const seen = engine(on, {}, () => usage(100))
    const clock = mock.clock(on)
    const complete = () => $.turn.complete({ ...TURN, turnId: 't1' })
    const stop = () => $.classic.StopFailure({ error: 'rate_limit' })
    if (order === 'stop-first') { await stop(); await complete() }
    if (order === 'completion-first') { await complete(); await stop() }
    if (order === 'concurrent') await Promise.all([complete(), complete(), stop()])
    await Promise.all([complete(), complete()])
    expect(seen.timers).toBe(1)
    expect(seen.toasts).toHaveLength(1)
    await clock.advance(EXIT_DELAY_MS * 2)
    expect(seen.commands).toEqual(['exit'])
  })
}

test('usage awaiting a daemon signal cannot replace its instruction', async ($, on) => {
  mock.env(on, SEAT)
  let resolveUsage!: (value: SessionUsage) => void
  const seen = engine(on, { chat_wait: WAIT_SWITCH }, () => new Promise(resolve => { resolveUsage = resolve }))
  const clock = mock.clock(on)
  const completion = $.turn.complete({ ...TURN, turnId: 't1' })
  await clock.settle()
  expect(seen.usageReads).toBe(1)
  await call($, 'chat_wait')
  resolveUsage(usage(100))
  expect(await completion).toEqual({ text: 'ok' })
  expect((await call($, 'start_step')).deny).toBe(WAIT_SWITCH.accountSwitch.instruction)
  expect(seen.toasts[0]).toContain(CAUSE)
  await clock.advance(EXIT_DELAY_MS)
  expect(seen.commands).toEqual(['exit'])
})
