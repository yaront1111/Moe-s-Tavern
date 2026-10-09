import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// A Moe seat (MOE_WORKER_ID set by scripts/moe-agent.{sh,ps1}) that auto-compacts
// keeps its task state two ways: the summarizer is told what a seat must not
// lose, and an authoritative snapshot of the task, read from .moe/ (read-only;
// the daemon is the only writer), lands right after the summary. Fails open:
// any error leaves the engine's own compaction untouched.

export const KEEP = [
  'This is a Moe agent seat working one task through the moe.* MCP tools.',
  'Keep verbatim: the task id, the current step id and what is left of it, every file edited and why,',
  'verification commands with their last result, unresolved errors, QA rejection items being fixed,',
  'and decisions made with their reasons. Drop file contents and raw tool output.',
].join(' ')

const SAFE_ID = /^[A-Za-z0-9._-]+$/

const clip = (value: unknown, max: number): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

type Step = { stepId?: string; status?: string; description?: string }
type Issue = { type?: string; description?: string; file?: string; line?: number }
type Task = {
  id?: string; title?: string; status?: string; reopenCount?: number; reopenReason?: string | null
  definitionOfDone?: string[]; implementationPlan?: Step[]
  rejectionDetails?: { failedDodItems?: string[]; issues?: Issue[] }
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

export async function snapshot($: EngineInterface, workerId: string): Promise<string | undefined> {
  if (!SAFE_ID.test(workerId)) return undefined
  const root = (await $.env.get('MOE_PROJECT_PATH')) || '.'
  const worker = await readJson<{ currentTaskId?: string | null }>($, `${root}/.moe/workers/${workerId}.json`)
  const taskId = worker?.currentTaskId
  if (!taskId || !SAFE_ID.test(taskId)) return undefined
  const task = await readJson<Task>($, `${root}/.moe/tasks/${taskId}.json`)
  if (!task) return undefined

  const steps = task.implementationPlan ?? []
  const current = steps.find(s => s.status !== 'COMPLETED')
  const lines = [
    '[Moe task snapshot, read from .moe/ after compaction. The board is the source of truth.]',
    `Seat ${workerId}, task ${taskId} (${task.status ?? '?'}, reopened ${task.reopenCount ?? 0}x): ${clip(task.title, 200)}`,
  ]
  if (steps.length) {
    lines.push('Steps:')
    for (const s of steps.slice(0, 30)) {
      lines.push(`- ${s.stepId} ${s.status}: ${clip(s.description, s === current ? 1500 : 120)}`)
    }
  }
  const dod = task.definitionOfDone ?? []
  if (dod.length) {
    lines.push('Definition of Done:')
    for (const item of dod.slice(0, 20)) lines.push(`- ${clip(item, 200)}`)
  }
  const rejection = task.rejectionDetails
  if (task.reopenReason || rejection?.issues?.length || rejection?.failedDodItems?.length) {
    lines.push(`Last QA rejection: ${clip(task.reopenReason, 500)}`)
    for (const item of (rejection?.failedDodItems ?? []).slice(0, 10)) lines.push(`- failed DoD: ${clip(item, 200)}`)
    for (const i of (rejection?.issues ?? []).slice(0, 10)) {
      const where = i.file ? ` ${i.file}${i.line ? `:${i.line}` : ''}` : ''
      lines.push(`- [${i.type ?? 'other'}]${where} ${clip(i.description, 300)}`)
    }
  }
  lines.push(`Before acting on details the summary may have lost, call moe.get_context {"taskId":"${taskId}"}.`)
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e) // a subagent's own transcript: not the seat's
    const workerId = await $.env.get('MOE_WORKER_ID')
    if (!workerId) return next(e) // not a Moe seat
    const instructions = e.instructions ? `${e.instructions}\n\n${KEEP}` : KEEP
    const done = await next({ ...e, instructions })
    if (done.skip !== undefined || e.trigger === 'precompute') return done
    const note = await snapshot($, workerId)
    if (!note) return done
    const row: SessionMessage = { role: 'user', text: note, toolUses: [] }
    const [summary, ...kept] = done.messages
    return { ...done, messages: summary ? [summary, row, ...kept] : [row] }
  }).catch(($, e, next) => next(e))
}
