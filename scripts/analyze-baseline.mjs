#!/usr/bin/env node
// Read-only CLI over scripts/baseline-report.mjs. Errors are one bounded line that
// names the file basename and field path, never the file content.
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildBaselineReport, formatBaselineReport, readBaselineRecord, readExpectedManifest } from './baseline-report.mjs';
import { buildUsageReport } from './usage-report.mjs';

const USAGE = 'Usage: node scripts/analyze-baseline.mjs --records DIR [--project DIR] [--expected FILE] [--json]';
const MAX_BYTES = 1024 * 1024;
const fail = message => { throw new Error(message); };
const label = file => path.basename(file).replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
const isDirectory = directory => { try { return statSync(directory).isDirectory(); } catch { return false; } };

function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = { '--records': 'records', '--project': 'project', '--expected': 'expected' }[args[i]];
    if (flag && !options[flag] && args[i + 1] && !args[i + 1].startsWith('--')) options[flag] = args[++i];
    else if (args[i] === '--json' && !options.json) options.json = true;
    else fail(USAGE);
  }
  if (!options.records) fail(USAGE);
  for (const flag of ['records', 'project']) if (options[flag] && !isDirectory(options[flag])) fail(`--${flag}: is not a readable directory`);
  return options;
}

function readJson(file, validate) {
  let stat;
  let body;
  try { stat = lstatSync(file); } catch { fail(`${label(file)}: is unreadable`); }
  if (!stat.isFile()) fail(`${label(file)}: is not a regular file`);
  if (stat.size > MAX_BYTES) fail(`${label(file)}: exceeds ${MAX_BYTES} bytes`);
  try { body = readFileSync(file, 'utf8'); } catch { fail(`${label(file)}: is unreadable`); }
  try { body = JSON.parse(body); } catch { fail(`${label(file)}: is not valid JSON`); }
  try { return validate(body); } catch (error) { fail(`${label(file)}: ${error.message}`); }
}

function main(options) {
  const expected = options.expected ? readJson(options.expected, readExpectedManifest) : null;
  let names;
  try { names = readdirSync(options.records).filter(name => name.endsWith('.json')).sort((a, b) => a < b ? -1 : a > b ? 1 : 0); }
  catch { fail('--records: is not a readable directory'); }
  const records = names.map(name => readJson(path.join(options.records, name), readBaselineRecord));
  const usageByWorkload = {};
  for (const { workload: { id } } of records) {
    if (options.project && isDirectory(path.join(options.project, id))) usageByWorkload[id] = buildUsageReport(path.join(options.project, id));
  }
  try { return buildBaselineReport({ records, usageByWorkload, expected }); }
  catch (error) { fail(error.message.replace(/^records\[(\d+)\]/, (_, index) => label(names[index]))); }
}

try {
  const options = parse(process.argv.slice(2));
  const report = main(options);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatBaselineReport(report));
} catch (error) {
  console.error(`analyze-baseline: ${error.message}`.replace(/[\r\n]+/g, ' ').slice(0, 300));
  process.exitCode = 1;
}
