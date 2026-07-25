/**
 * Reads docs/skills/<name>/SKILL.md (+ SOURCE.md per skill) and
 * docs/skills/manifest.json + LICENSE-VENDORED.md from the repo root,
 * and generates src/util/skillFiles.ts with their contents embedded
 * as template-literal strings so the daemon can write them at init
 * without needing the source docs directory at runtime.
 *
 * Mirrors generate-init-files.ts.
 */
import crypto from 'crypto';
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

function sha12(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Stamps a markdown skill file with the same sha marker convention as
 * generate-init-files.ts, so `writeSkillFiles` can tell "bundled copy is newer"
 * from "user edited this file".
 *
 * SKILL.md carries YAML frontmatter and the loaders require `---` on line 1, so
 * the marker goes INSIDE the frontmatter as a YAML comment (same trick the
 * subagent defs use). Plain markdown gets the HTML-comment form.
 *
 * LF-normalize before hashing: the JetBrains plugin stamps the same content at
 * runtime (MoeProjectInitializer.stampSkillFile) and the shas must agree, or the
 * two writers ping-pong overwrites on every project open.
 */
function stampSkillFile(relPath: string, rawContent: string): string {
  // ONLY the top-level skills manifest gets the JSON marker. Never stamp by
  // extension: a skill can vendor its own .json data files (ros2-skill ships
  // robot profiles) and injecting a key into those corrupts real payloads.
  if (relPath === 'manifest.json') return stampJsonMarker(rawContent);
  if (!relPath.endsWith('.md')) return rawContent;
  const trimmed = rawContent.replace(/\r\n/g, '\n').trimEnd();
  const sha = sha12(trimmed);
  if (trimmed.startsWith('---\n')) {
    return `---\n# moe-generated: sha=${sha}\n${trimmed.slice(4)}`;
  }
  return `<!-- moe-generated: sha=${sha} -->\n\n${trimmed}`;
}

/**
 * JSON has no comment syntax, so manifest.json carries its marker as a real
 * top-level key injected textually after the opening brace. Textual injection
 * (rather than parse → re-serialize) is deliberate: the JetBrains plugin has to
 * produce byte-identical output, and no two JSON serializers agree on spacing.
 *
 * An unexpected shape is returned unstamped — that file then has no marker and
 * stays create-only, which is the safe direction.
 */
function stampJsonMarker(rawContent: string): string {
  const trimmed = rawContent.replace(/\r\n/g, '\n').trimEnd();
  if (!trimmed.startsWith('{\n')) return trimmed;
  const sha = sha12(trimmed);
  return `{\n  "moeGeneratedSha": "${sha}",\n${trimmed.slice(2)}`;
}

type SkillFile = { relPath: string; content: string };
const skillFiles: SkillFile[] = [];

const skillDirs = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// Walk every file under a skill directory (SKILL.md, SOURCE.md, and any
// nested asset like templates/CMakeLists.txt) so domain skills that ship
// scaffolds are vendored whole, not just their top-level markdown.
function collectSkillFiles(name: string, dir: string, prefix: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectSkillFiles(name, abs, rel);
    } else if (entry.isFile()) {
      skillFiles.push({
        relPath: `${name}/${rel}`,
        content: fs.readFileSync(abs, 'utf-8'),
      });
    }
  }
}

for (const name of skillDirs) {
  collectSkillFiles(name, path.join(skillsDir, name), '');
}

const manifestContent = fs.existsSync(manifestPath)
  ? fs.readFileSync(manifestPath, 'utf-8')
  : '{ "version": 1, "skills": [] }\n';

const licenseContent = fs.existsSync(licensePath)
  ? fs.readFileSync(licensePath, 'utf-8')
  : '';

const skillEntries = skillFiles.map(
  (f) => `  '${f.relPath}': \`${escapeTemplateLiteral(stampSkillFile(f.relPath, f.content).trimEnd())}\``
);

const output = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/skills/**
// Regenerate: npm run generate-skill-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';
import { atomicWriteText } from './atomicWrite.js';

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
export const SKILL_MANIFEST = \`${escapeTemplateLiteral(stampJsonMarker(manifestContent))}\`;

/**
 * Content for .moe/skills/LICENSE-VENDORED.md, auto-generated from
 * docs/skills/LICENSE-VENDORED.md. Records attribution for vendored skills.
 */
export const SKILL_LICENSE = \`${escapeTemplateLiteral(
  licenseContent ? stampSkillFile('LICENSE-VENDORED.md', licenseContent) : ''
)}\`;

const GENERATED_MARKER_RE = /^<!--\\s*moe-generated:\\s*sha=([a-f0-9]{6,64})\\s*-->/;
// YAML-comment form used for frontmatter docs (SKILL.md), where an HTML comment
// above the \`---\` delimiter would break the skill loader.
const FRONTMATTER_MARKER_RE = /^---\\r?\\n#\\s*moe-generated:\\s*sha=([a-f0-9]{6,64})\\s*\\r?\\n/;
// JSON has no comments, so manifest.json carries its marker as a top-level key.
const JSON_MARKER_RE = /"moeGeneratedSha"\\s*:\\s*"([a-f0-9]{6,64})"/;

function markerSha(content: string): string | null {
  const m =
    content.match(GENERATED_MARKER_RE) ||
    content.match(FRONTMATTER_MARKER_RE) ||
    content.match(JSON_MARKER_RE);
  return m ? m[1] : null;
}

/**
 * Returns true when the on-disk file is a Moe-generated skill doc whose marker
 * sha differs from the bundled copy's — i.e. this daemon ships a newer version.
 *
 * False in every other case:
 *   - no marker on disk → user-customized, preserve it
 *   - marker matches → up to date, no write needed
 *   - malformed marker → treat as user content
 */
function shouldUpgradeSkillFile(onDisk: string, bundled: string): boolean {
  const diskSha = markerSha(onDisk);
  const bundledSha = markerSha(bundled);
  if (!diskSha || !bundledSha) return false;
  return diskSha !== bundledSha;
}

/**
 * Writes the curated skill pack into an existing .moe directory.
 *
 * - Missing files are created.
 * - Markdown files carrying a stale \`moe-generated: sha=<X>\` marker are
 *   OVERWRITTEN — this is the upgrade path that lets edited skills actually
 *   reach projects that were initialized before the edit.
 * - Files without a marker are left alone (user customizations; deleting the
 *   marker line opts a file out of future auto-upgrades).
 * - Non-markdown assets (vendored templates etc.) stay create-only.
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
      atomicWriteText(fullPath, content);
      continue;
    }
    const onDisk = fs.readFileSync(fullPath, 'utf-8');
    if (shouldUpgradeSkillFile(onDisk, content)) {
      atomicWriteText(fullPath, content);
    }
  }

  // Write manifest (same marker semantics — its marker is a JSON key, so a
  // user who strips "moeGeneratedSha" pins their customized manifest).
  const manifestPath = path.join(skillsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    atomicWriteText(manifestPath, SKILL_MANIFEST);
  } else if (shouldUpgradeSkillFile(fs.readFileSync(manifestPath, 'utf-8'), SKILL_MANIFEST)) {
    atomicWriteText(manifestPath, SKILL_MANIFEST);
  }

  // Write attribution.
  const licensePath = path.join(skillsDir, 'LICENSE-VENDORED.md');
  if (SKILL_LICENSE) {
    if (!fs.existsSync(licensePath)) {
      atomicWriteText(licensePath, SKILL_LICENSE);
    } else if (shouldUpgradeSkillFile(fs.readFileSync(licensePath, 'utf-8'), SKILL_LICENSE)) {
      atomicWriteText(licensePath, SKILL_LICENSE);
    }
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
