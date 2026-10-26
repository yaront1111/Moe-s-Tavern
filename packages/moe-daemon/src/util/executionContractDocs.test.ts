import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EXECUTION_CONTRACT_FIELDS } from '../state/validators.js';

/**
 * Doc-contract guard for the revision-bound execution contract (CQ-F03..F12a).
 * Reads the reference docs off disk: removed stale statements must stay gone,
 * and the landed codeNames, fields and env vars must stay documented in the
 * section that owns them. EXECUTION_CONTRACT_FIELDS is the drift anchor for the
 * contract field list. Every gate snapshot carries docs/, so nothing is skipped.
 */

const utilDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(utilDir, '..', '..', '..', '..');

function readDoc(name: string): string {
  const file = path.join(repoRoot, 'docs', name);
  if (!fs.existsSync(file)) throw new Error(`missing doc file: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

/** Text from the `### <heading>` line to the next `##`/`###` heading; throws when the heading is missing. */
function section(doc: string, heading: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith('### ') && line.slice(4).trim() === heading);
  if (start < 0) throw new Error(`missing heading: ### ${heading}`);
  const end = lines.findIndex((line, i) => i > start && /^#{2,3} /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

const mcp = readDoc('MCP_SERVER.md');
const schema = readDoc('SCHEMA.md');
const freshness = readDoc('PLAN_APPROVAL_FRESHNESS.md');
const configuration = readDoc('CONFIGURATION.md');

const STRICT_CODES = [
  'attemptId', 'generation', 'sessionId', 'STEP_ENTRY_IDENTITY_REQUIRED', 'ATTEMPT_SUPERSEDED',
  'ATTEMPT_NOT_RUNNING', 'PLAN_REVISION_NOT_APPROVED', 'CONTEXT_RECEIPT_STALE',
];
const RECEIPT_STATUSES = [
  'recorded', 'record-failed', 'identity-unreadable', 'no-session', 'no-running-attempt', 'not-attempt-owner',
];

function expectAll(text: string, needles: string[]): void {
  for (const needle of needles) expect(text.includes(needle), `missing: ${needle}`).toBe(true);
}

describe('execution contract docs: stale statements are gone', () => {
  it.each([
    ['PLAN_APPROVAL_FRESHNESS.md', freshness, ['is still a legal approval', 'approval without the field still works', 'token-free by design', 'still send `{taskId}` only']],
    ['SCHEMA.md', schema, ['remains a legal legacy approval']],
    ['MCP_SERVER.md', mcp, ['Unchanged and still token-free: **SPEED/TURBO auto-approval**', 'do not enforce it yet', 'A number means a revision-checked human approval']],
  ])('%s', (_name, doc, stale) => {
    for (const text of stale) expect(doc.includes(text), `stale: ${text}`).toBe(false);
  });
});

describe('execution contract docs: landed contract is documented', () => {
  it('moe.get_context documents sessionId, servedContext and every receiptStatus', () => {
    expectAll(section(mcp, 'moe.get_context'), ['sessionId', 'servedContext', 'packetId', ...RECEIPT_STATUSES]);
  });

  it.each(['moe.start_step', 'moe.complete_step', 'moe.complete_task'])('%s documents strict identity and codeNames', (tool) => {
    expectAll(section(mcp, tool), STRICT_CODES);
  });

  it('moe.complete_task documents the evidence refusal', () => {
    expectAll(section(mcp, 'moe.complete_task'), ['EXECUTION_EVIDENCE_INELIGIBLE']);
  });

  it('MCP_SERVER.md documents proxy refusals and the SPEED/TURBO stamp', () => {
    expectAll(mcp, ['EXECUTION_IDENTITY_SUBSTITUTED', 'EXECUTION_IDENTITY_INVALID', 'PLAN_AUTO_APPROVED']);
  });

  it('SCHEMA.md documents the new fields and every execution contract field', () => {
    expectAll(schema, [
      'approvedPlanRevision', 'executionContract', 'contextReceipt', 'ServedContextReceipt',
      'stepCompletions', 'StepCompletionEvidence', ...EXECUTION_CONTRACT_FIELDS,
    ]);
  });

  it('CONFIGURATION.md documents the execution identity env vars', () => {
    expectAll(configuration, ['MOE_SESSION_ID', 'MOE_ATTEMPT_ID', 'MOE_ATTEMPT_GENERATION']);
  });

  it('section() fails loudly on a missing heading', () => {
    expect(() => section(mcp, 'moe.no_such_tool')).toThrow('missing heading: ### moe.no_such_tool');
  });
});
