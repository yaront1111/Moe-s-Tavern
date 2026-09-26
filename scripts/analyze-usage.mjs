#!/usr/bin/env node
import { buildUsageReport, formatUsageReport } from './usage-report.mjs';

const args = process.argv.slice(2);
let project;
let json = false;
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && !project && args[i + 1] && !args[i + 1].startsWith('--')) project = args[++i];
    else if (args[i] === '--json' && !json) json = true;
    else throw new Error('Usage: node scripts/analyze-usage.mjs --project PATH [--json]');
  }
  if (!project) throw new Error('Usage: node scripts/analyze-usage.mjs --project PATH [--json]');
  const report = buildUsageReport(project);
  console.log(json ? JSON.stringify(report, null, 2) : formatUsageReport(report));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
