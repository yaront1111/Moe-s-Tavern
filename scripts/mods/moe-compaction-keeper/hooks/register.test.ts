import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, SessionCompactInput } from 'claude-code'
import { KEEP } from './register.ts'

const ROOT = '/proj'
const TASK = {
  id: 'task-abc', title: 'Add login form', status: 'WORKING', reopenCount: 1,
  reopenReason: 'Tests missing for empty password',
  definitionOfDone: ['Form validates input', 'Unit tests cover errors'],
  implementationPlan: [
    { stepId: 'step-1', status: 'COMPLETED', description: 'Create LoginForm component' },
    { stepId: 'step-2', status: 'IN_PROGRESS', description: 'Add validation and tests' },
  ],
  rejectionDetails: { issues: [{ type: 'test_failure', file: 'src/Login.test.ts', line: 12, description: 'empty password not covered' }] },
}
const FILES: Record<string, string> = {
  [`${ROOT}/.moe/workers/worker-1.json`]: JSON.stringify({ currentTaskId: 'task-abc' }),
  [`${ROOT}/.moe/workers/worker-2.json`]: JSON.stringify({ currentTaskId: null }),
  [`${ROOT}/.moe/tasks/task-abc.json`]: JSON.stringify(TASK),
}
const SEAT = { MOE_WORKER_ID: 'worker-1', MOE_PROJECT_PATH: ROOT }

// Stands for core: answers file reads from FILES and compacts to a summary
// plus one kept message, recording what it was asked.
function engine(on: On) {
  const seen: SessionCompactInput[] = []
  on('fs.read', ($, e) => {
    const path = e.path.replaceAll('\\', '/') // the engine hands an absolute, platform-spelled path
    const text = FILES[Object.keys(FILES).find(k => path.endsWith(k)) ?? '']
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('session.compact', ($, e) => {
    seen.push(e)
    return { messages: [
      { role: 'user', text: 'SUMMARY', toolUses: [] },
      { role: 'assistant', text: 'kept', toolUses: [] },
    ] }
  })
  return seen
}

async function compact($: Engine, input: Partial<SessionCompactInput> = {}) {
  const done = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'old', toolUses: [] }], ...input })
  if (done.skip !== undefined) throw new Error(`skipped: ${done.skip}`)
  return done.messages.map(m => m.text)
}

test('a seat gets Moe instructions and the task snapshot after the summary', async ($, on) => {
  mock.env(on, SEAT)
  const seen = engine(on)
  const texts = await compact($, { instructions: 'keep the plan' })
  expect(seen[0]?.instructions).toBe(`keep the plan\n\n${KEEP}`)
  expect(texts.map(t => t.slice(0, 7))).toEqual(['SUMMARY', '[Moe ta', 'kept'])
  const note = texts[1] ?? ''
  expect(note).toContain('task task-abc (WORKING, reopened 1x): Add login form')
  expect(note).toContain('- step-2 IN_PROGRESS: Add validation and tests')
  expect(note).toContain('- Unit tests cover errors')
  expect(note).toContain('Last QA rejection: Tests missing for empty password')
  expect(note).toContain('- [test_failure] src/Login.test.ts:12 empty password not covered')
  expect(note).toContain('moe.get_context {"taskId":"task-abc"}')
})

test('outside a Moe seat the compaction is untouched', async ($, on) => {
  mock.env(on, {})
  const seen = engine(on)
  expect(await compact($, { instructions: 'mine' })).toEqual(['SUMMARY', 'kept'])
  expect(seen[0]?.instructions).toBe('mine')
})

test("a subagent's compaction is left alone", async ($, on) => {
  mock.env(on, SEAT)
  const seen = engine(on)
  expect(await compact($, { agentId: 'agent-7' })).toEqual(['SUMMARY', 'kept'])
  expect(seen[0]?.instructions).toBeUndefined()
})

test('precompute gets the instructions but no snapshot', async ($, on) => {
  mock.env(on, SEAT)
  const seen = engine(on)
  expect(await compact($, { trigger: 'precompute' })).toEqual(['SUMMARY', 'kept'])
  expect(seen[0]?.instructions).toBe(KEEP)
})

test('a seat with no current task gets the instructions but no snapshot', async ($, on) => {
  mock.env(on, { ...SEAT, MOE_WORKER_ID: 'worker-2' })
  const seen = engine(on)
  expect(await compact($)).toEqual(['SUMMARY', 'kept'])
  expect(seen[0]?.instructions).toBe(KEEP)
})

test('an unreadable board falls back to the engine compaction', async ($, on) => {
  mock.env(on, { ...SEAT, MOE_PROJECT_PATH: '/elsewhere' })
  const seen = engine(on)
  expect(await compact($)).toEqual(['SUMMARY', 'kept'])
  expect(seen[0]?.instructions).toBe(KEEP)
})
