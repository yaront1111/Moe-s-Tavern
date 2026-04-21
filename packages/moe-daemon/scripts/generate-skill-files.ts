/**
 * Reads docs/skills/<name>/SKILL.md (+ SOURCE.md per skill) and
 * docs/skills/manifest.json + LICENSE-VENDORED.md from the repo root,
 * and generates src/util/skillFiles.ts with their contents embedded
 * as template-literal strings so the daemon can write them at init
 * without needing the source docs directory at runtime.
 *
 * Mirrors generate-init-files.ts.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const skillsDir = path.join(repoRoot, 'docs', 'skills');
const manifestPath = path.join(skillsDir, 'manifest.json');
const licensePath = path.join(skillsDir, 'LICENSE-VENDORED.md');
const outPath = path.join(__dirname, '..', 'src', 'util', 'skillFiles.ts');

if (!fs.existsSync(skillsDir)) {
  console.log('docs/skills not found — skipping skillFiles.ts regeneration (using committed version)');
  process.exit(0);
}

function escapeTemplateLiteral(s: string): string {
  // Normalize CRLF → LF first so Windows-edited skill files don't bake
  // \r\n into the embedded template literals.
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

type SkillFile = { relPath: string; content: string };
const skillFiles: SkillFile[] = [];

const skillDirs = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const name of skillDirs) {
  const dir = path.join(skillsDir, name);
  for (const fname of ['SKILL.md', 'SOURCE.md']) {
    const fp = path.join(dir, fname);
    if (fs.existsSync(fp)) {
      skillFiles.push({
        relPath: `${name}/${fname}`,
        content: fs.readFileSync(fp, 'utf-8'),
      });
    }
  }
}

const manifestContent = fs.existsSync(manifestPath)
  ? fs.readFileSync(manifestPath, 'utf-8')
  : '{ "version": 1, "skills": [] }\n';

const licenseContent = fs.existsSync(licensePath)
  ? fs.readFileSync(licensePath, 'utf-8')
  : '';

const skillEntries = skillFiles.map(
  (f) => `  '${f.relPath}': \`${escapeTemplateLiteral(f.content.trimEnd())}\``
);

const output = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/skills/**
// Regenerate: npm run generate-skill-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';

/**
 * Full content of every SKILL.md (and its SOURCE.md, when vendored), keyed by
 * relative path under .moe/skills/. Auto-generated from docs/skills/.
 */
export const SKILL_FILES: Record<string, string> = {
${skillEntries.join(',\n')}
};

/**
 * Content for .moe/skills/manifest.json, auto-generated from
 * docs/skills/manifest.json. Used by the agent wrapper to inject a
 * lean "Available Skills" section into the system prompt.
 */
export const SKILL_MANIFEST = \`${escapeTemplateLiteral(manifestContent.trimEnd())}\`;

/**
 * Content for .moe/skills/LICENSE-VENDORED.md, auto-generated from
 * docs/skills/LICENSE-VENDORED.md. Records attribution for vendored skills.
 */
export const SKILL_LICENSE = \`${escapeTemplateLiteral(licenseContent.trimEnd())}\`;

/**
 * Writes the curated skill pack into an existing .moe directory.
 * Skips files that already exist (idempotent — safe to backfill onto
 * existing projects).
 */
export function writeSkillFiles(moePath: string): void {
  const skillsDir = path.join(moePath, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Write each skill file (SKILL.md + SOURCE.md per skill directory).
  for (const [relPath, content] of Object.entries(SKILL_FILES)) {
    const fullPath = path.join(skillsDir, relPath);
    const parent = path.dirname(fullPath);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, content);
    }
  }

  // Write manifest (skip if already exists — user may have customized).
  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, SKILL_MANIFEST);
  }

  // Write attribution.
  const licensePath = path.join(skillsDir, 'LICENSE-VENDORED.md');
  if (!fs.existsSync(licensePath) && SKILL_LICENSE) {
    fs.writeFileSync(licensePath, SKILL_LICENSE);
  }
}
`;

fs.writeFileSync(outPath, output);
console.log(
  'Generated ' +
    outPath +
    ' (' +
    skillFiles.length +
    ' skill files across ' +
    skillDirs.length +
    ' skills)'
);
