// Guard for the CQ rollout promotion decision record (CQ-M06a): docs/baselines/cq-m06/README.md.
// Test-only. It runs no agent workload and enables no profile. Every quoted baseline figure is
// recomputed from docs/baselines/cq-m04/report.json, the decision is pinned to the readiness
// authority (assertExecutionProfileReady) and to the activation gaps (activationGaps), and the
// honesty statements must stay. Its inputs throw named errors: a guard that passes when it
// cannot find its input is worse than no guard.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertExecutionProfileReady } from '../delivery/executionProfile.js';
import { activationGaps } from '../state/profileRollout.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const README = 'docs/baselines/cq-m06/README.md';
const REPORT = 'docs/baselines/cq-m04/report.json';
const SUPPORT_STATUSES = ['certified', 'not certified', 'unsupported', 'not run'];
const STATEMENTS = [
  'Skipped real-VM tests do not certify support.',
  'Claimed savings: none.',
  'Tokens are not monetary cost.',
  'Pilot: unmeasured.',
];

interface Line { readonly n: number; readonly text: string }
type Count = number | null | undefined;
interface Row {
  planning?: { plannerSessions?: Count };
  retrieval?: { sourceRetrievals?: Count };
  latency?: { firstCodeChangeMs?: Count; endToEndMs?: Count };
}
interface Report {
  inputs: { moeCommits: string[]; corpusVersions: number[]; repetitionsPlanned: number[] };
  rows: Row[];
  summary: {
    workloads: number;
    acceptance: { accepted: number; rejected: number; notAssessed: number };
    usage: { totals: { reasoningTokens: { observedTokens: number | null } } };
    efficiency: { observedTokens: number | null; observedTokensPerAcceptedChange: number | null; complete: boolean };
  };
}

function readText(rel: string): string {
  let raw: string;
  try {
    raw = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  } catch (error) {
    throw new Error(`ROLLOUT_DECISION_INPUT_MISSING: ${rel} cannot be read (${(error as Error).message})`);
  }
  if (raw.trim() === '') throw new Error(`ROLLOUT_DECISION_INPUT_EMPTY: ${rel} is empty`);
  return raw;
}

/** CRLF-safe, with 1-indexed line numbers for failure messages. */
function toLines(raw: string): Line[] {
  return raw.split(/\r?\n/).map((text, index) => ({ n: index + 1, text }));
}

const readme = (): Line[] => toLines(readText(README));
const report: Report = JSON.parse(readText(REPORT));

const numbers = (values: Count[]): number[] => values.filter((value): value is number => typeof value === 'number');
const fmt = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));
const unknownCount = (pick: (row: Row) => Count): string =>
  String(report.rows.filter((row) => typeof pick(row) !== 'number').length);

/** Middle value; an even count rounds the mean of the two middle values; 'unknown' when empty. */
function median(values: number[]): string {
  if (values.length === 0) return 'unknown';
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return String(sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2));
}

const planner = numbers(report.rows.map((row) => row.planning?.plannerSessions));
const endToEnd = numbers(report.rows.map((row) => row.latency?.endToEndMs));
const total = String(report.rows.length);
const eff = report.summary.efficiency;
const word = (value: number | null): string => (value === null ? 'unknown' : String(value));

/** A quoted figure: every match of `re` in the README must capture exactly `expected`, and one must exist. */
const FIGURES: Array<{ name: string; re: RegExp; expected: string[] }> = [
  { name: 'scope', re: /\(n=(\S+), (\S+) workloads/g, expected: [report.inputs.repetitionsPlanned.join(', '), String(report.summary.workloads)] },
  { name: 'workloads', re: /^- Workloads: (.+?)\s*$/g, expected: [String(report.summary.workloads)] },
  { name: 'repetitions', re: /^- Repetitions per workload: (.+?)\s*$/g, expected: [report.inputs.repetitionsPlanned.join(', ')] },
  { name: 'moeCommits', re: /^- Moe commits: (.+?)\s*$/g, expected: [report.inputs.moeCommits.join(', ')] },
  { name: 'corpusVersions', re: /^- Corpus versions: (.+?)\s*$/g, expected: [report.inputs.corpusVersions.join(', ')] },
  { name: 'accepted', re: /^- Accepted: (.+?)\s*$/g, expected: [String(report.summary.acceptance.accepted)] },
  { name: 'rejected', re: /^- Rejected: (.+?)\s*$/g, expected: [String(report.summary.acceptance.rejected)] },
  { name: 'notAssessed', re: /^- Not assessed: (.+?)\s*$/g, expected: [String(report.summary.acceptance.notAssessed)] },
  { name: 'plannerSessions', re: /mean planner sessions per workload: (\S+) \(observed in (\d+) of (\d+) workloads\)/g,
    expected: [planner.length ? fmt(planner.reduce((a, b) => a + b, 0) / planner.length) : 'unknown', String(planner.length), total] },
  { name: 'sourceRetrievals', re: /sourceRetrievals is unknown in (\d+) of (\d+) workloads/g,
    expected: [unknownCount((row) => row.retrieval?.sourceRetrievals), total] },
  { name: 'firstCodeChange', re: /firstCodeChangeMs is unknown in (\d+) of (\d+) workloads/g,
    expected: [unknownCount((row) => row.latency?.firstCodeChangeMs), total] },
  { name: 'endToEnd', re: /^- Median end-to-end time: (\S+) ms \(observed in (\d+) of (\d+) workloads\)/g,
    expected: [median(endToEnd), String(endToEnd.length), total] },
  { name: 'observedTokens', re: /^- Observed tokens: (\d+) \((\w+)\)\s*$/g,
    expected: [word(eff.observedTokens), eff.complete ? 'complete' : 'incomplete'] },
  { name: 'tokensPerAccepted', re: /^- Observed tokens per accepted change: (\S+)\s*$/g,
    expected: [word(eff.observedTokensPerAcceptedChange)] },
  { name: 'reasoningTokens', re: /^- Reasoning tokens: (\S+)\s*$/g, expected: [word(report.summary.usage.totals.reasoningTokens.observedTokens)] },
];

/** The lines of one `## heading` section, up to the next `## `. */
function section(lines: Line[], heading: string): Line[] {
  const start = lines.findIndex((line) => line.text.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`ROLLOUT_DECISION_SECTION_MISSING: ${README} has no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.text.startsWith('## '));
  return end < 0 ? rest : rest.slice(0, end);
}

interface Table { readonly header: string[]; readonly rows: Array<{ n: number; cells: string[] }> }

/** The section's markdown table: a header, a separator and at least one data row. */
function table(lines: Line[], heading: string): Table {
  const cellsOf = (text: string): string[] => text.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  const rows = section(lines, heading).filter((line) => line.text.trim().startsWith('|'));
  const [head, ...body] = rows.filter((line) => !/^\|[\s:|-]+\|?\s*$/.test(line.text.trim()));
  if (head === undefined || body.length === 0) {
    throw new Error(`ROLLOUT_DECISION_TABLE_MISSING: "## ${heading}" has no table with a data row`);
  }
  return { header: cellsOf(head.text), rows: body.map((line) => ({ n: line.n, cells: cellsOf(line.text) })) };
}

const column = (t: Table, name: string): number => {
  const index = t.header.findIndex((cell) => cell.toLowerCase().startsWith(name));
  if (index < 0) throw new Error(`ROLLOUT_DECISION_COLUMN_MISSING: no "${name}" column in ${t.header.join(' | ')}`);
  return index;
};

const strip = (cell: string): string => cell.replace(/`/g, '').trim();

function readinessRefusal(): string | null {
  try {
    assertExecutionProfileReady('verified-local');
    return null;
  } catch (error) {
    return (error as { codeName?: string }).codeName ?? 'UNKNOWN_REFUSAL';
  }
}

describe('CQ-M06a rollout decision record', () => {
  it('G1: records non-promotion while the readiness authority refuses or a capability is unsupported', () => {
    const decisions = readme().filter((line) => /^Decision: (promotion|non-promotion)$/.test(line.text));
    expect(decisions.map((line) => `${README}:${line.n}`)).toHaveLength(1);
    const blocked = readinessRefusal() !== null || activationGaps().length > 0;
    if (blocked) expect(decisions[0].text).toBe('Decision: non-promotion');
  });

  it.each(FIGURES)('G2: quotes $name exactly as report.json derives it', ({ name, re, expected }) => {
    const seen = readme().flatMap((line) => [...line.text.matchAll(re)].map((hit) => ({ n: line.n, got: hit.slice(1) })));
    expect(seen.length, `${README} never quotes ${name}`).toBeGreaterThan(0);
    for (const hit of seen) expect(hit.got, `${README}:${hit.n} ${name}`).toEqual(expected);
  });

  it('G3: the gates table is bound to the readiness authority and the live activation gaps', () => {
    const gates = table(readme(), 'Gates');
    const status = column(gates, 'status');
    const evidence = column(gates, 'evidence');
    const row = (name: string) => gates.rows.find((r) => strip(r.cells[0]).toLowerCase() === name);
    const refusal = readinessRefusal();
    const readiness = row('readiness');
    expect(readiness, 'a "readiness" gate row').toBeDefined();
    expect(strip(readiness!.cells[status])).toBe(refusal === null ? 'met' : 'unmet');
    if (refusal !== null) expect(readiness!.cells[evidence]).toContain(refusal);
    const gaps = activationGaps();
    for (const gap of gaps) {
      const gapRow = row(gap.capability);
      expect(gapRow, `a "${gap.capability}" gate row`).toBeDefined();
      expect(strip(gapRow!.cells[status])).toBe('unsupported');
      expect(gapRow!.cells[evidence]).toContain(gap.reason);
    }
    const listed = gates.rows.filter((r) => strip(r.cells[status]) === 'unsupported').map((r) => strip(r.cells[0]));
    expect(listed.sort()).toEqual(gaps.map((gap) => gap.capability).sort());
    for (const name of ['matched pilot', 'retrieval baseline']) {
      expect(row(name), `a "${name}" gate row`).toBeDefined();
      expect(strip(row(name)!.cells[status])).toBe('unmet');
    }
  });

  it('G4: keeps the honesty statements and reads every pilot value as unmeasured', () => {
    const lines = readme();
    for (const statement of STATEMENTS) {
      expect(lines.some((line) => line.text.includes(statement)), `${README} must say: ${statement}`).toBe(true);
    }
    const targets = table(lines, 'Targets');
    const pilot = column(targets, 'pilot');
    const outcome = column(targets, 'outcome');
    expect(targets.rows.map((r) => r.cells[0].slice(0, 3)).sort()).toEqual(['30%', '50%']);
    for (const r of targets.rows) {
      expect(r.cells[pilot], `${README}:${r.n} pilot`).toBe('unmeasured');
      expect(['unmeasured', 'unmeasurable against this baseline'], `${README}:${r.n} outcome`).toContain(r.cells[outcome]);
    }
  });

  it('G5: the only percentages are the 50% and 30% targets, each on a target line', () => {
    const found = readme().flatMap((line) => [...line.text.matchAll(/\d+(?:\.\d+)?%/g)].map((hit) => ({ n: line.n, text: line.text, pct: hit[0] })));
    for (const hit of found) {
      expect(['50%', '30%'], `${README}:${hit.n}: ${hit.text}`).toContain(hit.pct);
      expect(hit.text.toLowerCase(), `${README}:${hit.n} must be a target line`).toContain('target');
    }
    expect([...new Set(found.map((hit) => hit.pct))].sort()).toEqual(['30%', '50%']);
  });

  it('G6: every platform status is one of the allowed words', () => {
    const support = table(readme(), 'Platform support');
    const status = column(support, 'status');
    for (const r of support.rows) expect(SUPPORT_STATUSES, `${README}:${r.n} status`).toContain(strip(r.cells[status]));
  });
});

describe('guard helpers', () => {
  it('median rounds the mean of the two middle values for an even count and is unknown when empty', () => {
    expect(median([5, 1, 3])).toBe('3');
    expect(median([4, 1, 2, 9])).toBe('3');
    expect(median([1, 2])).toBe('2');
    expect(median([])).toBe('unknown');
  });

  it('fmt keeps integers and rounds fractions to two places; numbers drops null and missing values', () => {
    expect([fmt(1), fmt(1.5), fmt(1 / 3)]).toEqual(['1', '1.50', '0.33']);
    expect(numbers([1, null, undefined, 2])).toEqual([1, 2]);
  });

  it('toLines splits CRLF and LF alike with 1-indexed numbers', () => {
    expect(toLines('a\r\nb\nc')).toEqual([{ n: 1, text: 'a' }, { n: 2, text: 'b' }, { n: 3, text: 'c' }]);
  });

  it('table throws a named error for a missing section or a table without data rows', () => {
    expect(() => table(toLines('# t\n'), 'Gates')).toThrow('ROLLOUT_DECISION_SECTION_MISSING');
    expect(() => table(toLines('## Gates\n| A | B |\n|---|---|\n'), 'Gates')).toThrow('ROLLOUT_DECISION_TABLE_MISSING');
    expect(table(toLines('## Gates\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n'), 'Gates').rows[0].cells).toEqual(['1', '2']);
  });

  it('readText throws a named error for a missing or empty input', () => {
    expect(() => readText('docs/baselines/cq-m06/no-such-file.md')).toThrow('ROLLOUT_DECISION_INPUT_MISSING');
  });
});
