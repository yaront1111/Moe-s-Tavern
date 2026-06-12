/**
 * Reads docs/roles/*.md and docs/agents/moe-*.md from the repo root and
 * generates src/util/initFiles.ts with their contents embedded as template-
 * literal strings so the daemon can write them at init without needing the
 * source docs directory at runtime.
 *
 * Each generated file is stamped with a leading HTML comment
 *   <!-- moe-generated: sha=<hex12> -->
 * so `writeInitFiles` can detect a stale Moe-generated doc at upgrade time
 * and replace it, while still preserving user-authored customizations
 * (which won't carry the marker).
 *
 * NOTE: agent-context.md is no longer auto-injected into agent system
 * prompts (role doc + CLAUDE.md cover the same ground). The file remains
 * on disk in existing projects but is not regenerated for new ones.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rolesDir = path.join(repoRoot, 'docs', 'roles');
const subagentsDir = path.join(repoRoot, 'docs', 'agents');
const outPath = path.join(__dirname, '..', 'src', 'util', 'initFiles.ts');

// Skip regeneration when docs dir is not available (e.g. Docker builds
// where the build context is only packages/moe-daemon). The committed
// initFiles.ts is used as-is in that case.
if (!fs.existsSync(rolesDir)) {
  console.log('docs/roles not found — skipping initFiles.ts regeneration (using committed version)');
  process.exit(0);
}

function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function sha12(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
}

function stampMarker(rawContent: string): string {
  // LF-normalize before hashing so the sha is stable across checkout
  // line-ending settings — the JetBrains plugin stamps the same content at
  // runtime (MoeProjectInitializer.stampMarker) and the shas must agree or
  // the two writers ping-pong overwrites.
  const trimmed = rawContent.replace(/\r\n/g, '\n').trimEnd();
  const sha = sha12(trimmed);
  return `<!-- moe-generated: sha=${sha} -->\n\n${trimmed}`;
}

function stampFrontmatterMarker(rawContent: string): string {
  // Subagent defs are YAML-frontmatter files: Claude Code's loader requires
  // the `---` delimiter on line 1, so the marker goes INSIDE the frontmatter
  // as a YAML comment instead of an HTML comment above it.
  const trimmed = rawContent.replace(/\r\n/g, '\n').trimEnd();
  const sha = sha12(trimmed);
  if (trimmed.startsWith('---\n')) {
    return `---\n# moe-generated: sha=${sha}\n${trimmed.slice(4)}`;
  }
  return `<!-- moe-generated: sha=${sha} -->\n\n${trimmed}`;
}

const roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.md')).sort();
const roleEntries = roleFiles.map(f => {
  const content = fs.readFileSync(path.join(rolesDir, f), 'utf-8');
  const stamped = stampMarker(content);
  return `  '${f}': \`${escapeTemplateLiteral(stamped)}\``;
});

// Subagent definitions live under docs/agents/moe-<name>.md. Only files matching
// that prefix are bundled — the directory also contains uppercase role docs
// (ARCHITECT.md, WORKER.md, REVIEWER.md, README.md) that are documentation, not
// Claude Code subagent definitions.
const subagentFiles = fs.existsSync(subagentsDir)
  ? fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md') && f.startsWith('moe-')).sort()
  : [];
const subagentEntries = subagentFiles.map(f => {
  const content = fs.readFileSync(path.join(subagentsDir, f), 'utf-8');
  const stamped = stampFrontmatterMarker(content);
  return `  '${f}': \`${escapeTemplateLiteral(stamped)}\``;
});

const output = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/roles/*.md
// Regenerate: npm run generate-init-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';
import { atomicWriteText } from './atomicWrite.js';

/**
 * Full content of role docs, auto-generated from docs/roles/*.md.
 *
 * Each value is stamped with a leading \`<!-- moe-generated: sha=<hex12> -->\`
 * marker that \`writeInitFiles\` reads to decide whether an existing on-disk
 * copy is a stale Moe-generated doc (→ overwrite) or a user customization
 * (→ leave alone). Users who want to customize a role doc should delete the
 * marker line — that opts the file out of future auto-upgrades.
 */
export const ROLE_DOCS: Record<string, string> = {
${roleEntries.join(',\n')}
};

/**
 * Claude Code subagent definitions, auto-generated from docs/agents/moe-*.md.
 * \`writeInitFiles\` writes these to \`.moe/agents/\` so the agent launcher can
 * mirror them into \`.claude/agents/\` for Claude Code's subagent loader.
 * Same upgrade convention as ROLE_DOCS, but the marker is embedded as a YAML
 * comment INSIDE the frontmatter (the loader needs \`---\` on line 1).
 */
export const SUBAGENT_DOCS: Record<string, string> = {
${subagentEntries.join(',\n')}
};

/**
 * Content for .moe/.gitignore
 */
export const GITIGNORE_CONTENT = \`# Moe runtime files (not shared)
daemon.json
daemon.lock
workers/
proposals/
\`;

const GENERATED_MARKER_RE = /^<!--\\s*moe-generated:\\s*sha=([a-f0-9]{6,64})\\s*-->/;
// YAML-comment form used for frontmatter docs (subagent defs), where an HTML
// comment above the \`---\` delimiter would break Claude Code's loader.
const FRONTMATTER_MARKER_RE = /^---\\r?\\n#\\s*moe-generated:\\s*sha=([a-f0-9]{6,64})\\s*\\r?\\n/;

function markerSha(content: string): string | null {
  const m = content.match(GENERATED_MARKER_RE) || content.match(FRONTMATTER_MARKER_RE);
  return m ? m[1] : null;
}

/**
 * Returns true if the existing on-disk content is a Moe-generated doc whose
 * marker-sha differs from the embedded content's marker-sha (i.e. the bundled
 * daemon has a newer version than what's on disk).
 *
 * Returns false in all other cases:
 *   - no marker on disk → user-customized, preserve it
 *   - marker matches → up to date, no write needed
 *   - malformed marker → treat as user content
 */
function shouldUpgradeGeneratedDoc(onDisk: string, bundled: string): boolean {
  const diskSha = markerSha(onDisk);
  const bundledSha = markerSha(bundled);
  if (!diskSha || !bundledSha) return false;
  return diskSha !== bundledSha;
}

/**
 * Writes role docs and .gitignore into an existing .moe directory.
 *
 * - Missing files are created.
 * - Files whose first line carries a \`<!-- moe-generated: sha=<X> -->\` marker
 *   whose sha differs from the bundled content's marker are OVERWRITTEN
 *   (this is the upgrade path for the iron-law skill directive etc.).
 * - Files without the marker are left alone (treated as user customizations).
 */
export function writeInitFiles(moePath: string): void {
  // Ensure roles directory exists
  const rolesDir = path.join(moePath, 'roles');
  if (!fs.existsSync(rolesDir)) {
    fs.mkdirSync(rolesDir, { recursive: true });
  }

  // Write role docs (create if missing, upgrade if stale Moe-generated)
  for (const [filename, content] of Object.entries(ROLE_DOCS)) {
    const filePath = path.join(rolesDir, filename);
    if (!fs.existsSync(filePath)) {
      atomicWriteText(filePath, content);
      continue;
    }
    const onDisk = fs.readFileSync(filePath, 'utf-8');
    if (shouldUpgradeGeneratedDoc(onDisk, content)) {
      atomicWriteText(filePath, content);
    }
  }

  // Write Claude Code subagent defs to .moe/agents/. The agent launcher mirrors
  // these into .claude/agents/ so Claude Code's subagent loader picks them up.
  if (Object.keys(SUBAGENT_DOCS).length > 0) {
    const agentsDir = path.join(moePath, 'agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    for (const [filename, content] of Object.entries(SUBAGENT_DOCS)) {
      const filePath = path.join(agentsDir, filename);
      if (!fs.existsSync(filePath)) {
        atomicWriteText(filePath, content);
        continue;
      }
      const onDisk = fs.readFileSync(filePath, 'utf-8');
      if (shouldUpgradeGeneratedDoc(onDisk, content)) {
        atomicWriteText(filePath, content);
      }
    }
  }

  // agent-context.md is no longer auto-written to new projects (role doc +
  // CLAUDE.md cover the same ground). Existing projects keep their copy.

  // Write .gitignore (skip if already exists — trivial content, no upgrade logic needed)
  const gitignorePath = path.join(moePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    atomicWriteText(gitignorePath, GITIGNORE_CONTENT);
  }
}
`;

fs.writeFileSync(outPath, output);
console.log('Generated ' + outPath + ' (' + roleFiles.length + ' role docs + ' + subagentFiles.length + ' subagents, sha-stamped)');
