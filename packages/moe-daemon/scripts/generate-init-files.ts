/**
 * Reads docs/roles/*.md and docs/agent-context.md from the repo root
 * and generates src/util/initFiles.ts with their contents embedded
 * as template-literal strings so the daemon can write them at init
 * without needing the source docs directory at runtime.
 */
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const rolesDir = path.join(repoRoot, 'docs', 'roles');
const agentContextPath = path.join(repoRoot, 'docs', 'agent-context.md');
const outPath = path.join(import.meta.dirname, '..', 'src', 'util', 'initFiles.ts');

function escapeTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.md')).sort();
const roleEntries = roleFiles.map(f => {
  const content = fs.readFileSync(path.join(rolesDir, f), 'utf-8');
  return `  '${f}': \`${escapeTemplateLiteral(content.trimEnd())}\``;
});

const agentContext = fs.readFileSync(agentContextPath, 'utf-8');

const output = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT MANUALLY
// Source of truth: docs/roles/*.md and docs/agent-context.md
// Regenerate: npm run generate-init-files (runs automatically on build)
// =============================================================================

import fs from 'fs';
import path from 'path';

/**
 * Full content of role docs, auto-generated from docs/roles/*.md.
 * Embedded here so all init paths produce consistent role docs
 * even when the source docs directory is not available.
 */
export const ROLE_DOCS: Record<string, string> = {
${roleEntries.join(',\n')}
};

/**
 * Content for .moe/agent-context.md, auto-generated from docs/agent-context.md
 */
export const AGENT_CONTEXT_CONTENT = \`${escapeTemplateLiteral(agentContext.trimEnd())}\`;

/**
 * Content for .moe/.gitignore
 */
export const GITIGNORE_CONTENT = \`# Moe runtime files (not shared)
daemon.json
daemon.lock
workers/
proposals/
\`;

/**
 * Writes role docs and .gitignore into an existing .moe directory.
 * Skips files that already exist to avoid overwriting user customizations.
 */
export function writeInitFiles(moePath: string): void {
  // Ensure roles directory exists
  const rolesDir = path.join(moePath, 'roles');
  if (!fs.existsSync(rolesDir)) {
    fs.mkdirSync(rolesDir, { recursive: true });
  }

  // Write role docs (skip if already exists)
  for (const [filename, content] of Object.entries(ROLE_DOCS)) {
    const filePath = path.join(rolesDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
    }
  }

  // Write agent-context.md (skip if already exists)
  const agentContextPath = path.join(moePath, 'agent-context.md');
  if (!fs.existsSync(agentContextPath)) {
    fs.writeFileSync(agentContextPath, AGENT_CONTEXT_CONTENT);
  }

  // Write .gitignore (skip if already exists)
  const gitignorePath = path.join(moePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT);
  }
}
`;

fs.writeFileSync(outPath, output);
console.log('Generated ' + outPath + ' (' + roleFiles.length + ' role docs + agent-context)');
