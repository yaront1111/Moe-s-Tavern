import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeUsageContext, readMoeRecord } from './usage-receipt.mjs';

// The wrapper sends metadata through the environment so PowerShell 5.1 never
// has to round-trip JSON quotes through native argv. No prompt text belongs here.
try {
  const project = process.argv[2];
  if (!project || !path.isAbsolute(project)) throw new Error('project');
  const supplied = JSON.parse(process.env.MOE_USAGE_CONTEXT_JSON || '{}');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('context');
  const context = normalizeUsageContext(supplied);
  // Canonical correlation is snapshotted once, here at launch preparation and
  // before the provider starts, so a later replan or runner change is not
  // attributed to this launch. Caller-supplied planRevision/runnerId are never
  // trusted: only the task record with the exact id, and only an attempt whose
  // id, taskId and workerId all match, contribute. A missing, mismatched or
  // unreadable record leaves the value null; a legacy task without
  // planRevision stays unknown here rather than the daemon's read-as-0.
  const task = readMoeRecord(project, 'tasks', context.taskId);
  const attempt = readMoeRecord(project, 'attempts', context.attemptId);
  const owned = attempt && context.workerId && attempt.taskId === context.taskId && attempt.workerId === context.workerId;
  const launchId = randomUUID();
  const directory = path.join(project, 'logs', 'moe-usage');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${launchId}.jsonl`);
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ file, context: normalizeUsageContext({ ...context, launchId,
    planRevision: task?.planRevision, runnerId: owned ? attempt.runnerId : null }) }));
} catch {
  // Diagnostic failures cannot prevent coding, verification or postflight.
  console.error('[usage] MOE_USAGE_REPORT_UNAVAILABLE');
}
