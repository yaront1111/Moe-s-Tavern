/**
 * Reads docs/roles/*.md and docs/agent-context.md from the repo root
 * and generates src/util/initFiles.ts with their contents embedded
 * as template-literal strings so the daemon can write them at init
 * without needing the source docs directory at runtime.
 *
 * Each generated file is stamped with a leading HTML comment
 *   <!-- moe-generated: sha=<hex12> -->
 * so `writeInitFiles` can detect a stale Moe-generated doc at upgrade time
 * and replace it, while still preserving user-authored customizations
 * (which won't carry the marker).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rolesDir = path.join(repoRoot, 'docs', 'roles');
const agentContextPath = path.join(repoRoot, 'docs', 'agent-context.md');
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
  const trimmed = rawContent.trimEnd();
  const sha = sha12(trimmed);
  return `<!-- moe-generated: sha=${sha} -->\n\n${trimmed}`;
}

const roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.md')).sort();
const roleEntries = roleFiles.map(f => {
  const content = fs.readFileSync(path.join(rolesDir, f), 'utf-8');
  const stamped = stampMarker(content);
  return `  '${f}': \`${escapeTemplateLiteral(stamped)}\``;
});

const agentContext = fs.readFileSync(agentContextPath, 'utf-8');
const agentContextStamped = stampMarker(agentContext);

const output = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/roles/*.md and docs/agent-context.md
// Regenerate: npm run generate-init-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';

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
 * Content for .moe/agent-context.md, auto-generated from docs/agent-context.md.
 * Same sha-stamped marker convention as ROLE_DOCS.
 */
export const AGENT_CONTEXT_CONTENT = \`${escapeTemplateLiteral(agentContextStamped)}\`;

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
  const mDisk = onDisk.match(GENERATED_MARKER_RE);
  const mBundled = bundled.match(GENERATED_MARKER_RE);
  if (!mDisk || !mBundled) return false;
  return mDisk[1] !== mBundled[1];
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
      fs.writeFileSync(filePath, content);
      continue;
    }
    const onDisk = fs.readFileSync(filePath, 'utf-8');
    if (shouldUpgradeGeneratedDoc(onDisk, content)) {
      fs.writeFileSync(filePath, content);
    }
  }

  // Write / upgrade agent-context.md
  const agentContextPath = path.join(moePath, 'agent-context.md');
  if (!fs.existsSync(agentContextPath)) {
    fs.writeFileSync(agentContextPath, AGENT_CONTEXT_CONTENT);
  } else {
    const onDisk = fs.readFileSync(agentContextPath, 'utf-8');
    if (shouldUpgradeGeneratedDoc(onDisk, AGENT_CONTEXT_CONTENT)) {
      fs.writeFileSync(agentContextPath, AGENT_CONTEXT_CONTENT);
    }
  }

  // Write .gitignore (skip if already exists — trivial content, no upgrade logic needed)
  const gitignorePath = path.join(moePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT);
  }
}
`;

fs.writeFileSync(outPath, output);
console.log('Generated ' + outPath + ' (' + roleFiles.length + ' role docs + agent-context, sha-stamped)');
