// Tests src/generated/initFiles.ts; the subject is prebuild-generated, but this test is handwritten.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeInitFiles, ROLE_DOCS, SUBAGENT_DOCS, GITIGNORE_CONTENT } from '../generated/initFiles.js';

const MARKER_RE = /^<!--\s*moe-generated:\s*sha=([a-f0-9]{6,64})\s*-->/;

// Daemon-written record directories under .moe/ are local runtime state. A new
// one must be added to this list, to GITIGNORE_CONTENT
// (scripts/generate-init-files.ts), and to the repository root .gitignore.
const WAVE1_RUNTIME_DIRS = ['attempts/', 'candidates/', 'checks/', 'reviews/', 'receipts/'] as const;
// The .moe/.gitignore every project got before the Wave 1 directories existed.
const BUNDLED_GITIGNORE_V1 = '# Moe runtime files (not shared)\ndaemon.json\ndaemon.lock\nworkers/\nproposals/\n';

const trimmedLines = (text: string) => text.split(/\r?\n/).map((line) => line.trim());

describe('Wave 1 record directories are gitignored', () => {
  it('GITIGNORE_CONTENT lists every Wave 1 record directory as its own trimmed line', () => {
    expect(trimmedLines(GITIGNORE_CONTENT)).toEqual(expect.arrayContaining([...WAVE1_RUNTIME_DIRS]));
  });

  it('repository .gitignore ignores the Wave 1 record directories', () => {
    const rootGitignore = fs.readFileSync(new URL('../../../../.gitignore', import.meta.url), 'utf-8');
    expect(trimmedLines(rootGitignore)).toEqual(
      expect.arrayContaining(WAVE1_RUNTIME_DIRS.map((dir) => `.moe/${dir}`))
    );
  });
});

describe('writeInitFiles — sha-marker scaffold refresh', () => {
  let moeDir: string;

  beforeEach(() => {
    moeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-initfiles-'));
  });

  afterEach(() => {
    fs.rmSync(moeDir, { recursive: true, force: true });
  });

  const roleNames = Object.keys(ROLE_DOCS);
  const sampleRole = roleNames[0];
  const rolePath = (name: string) => path.join(moeDir, 'roles', name);

  it('creates every bundled role doc, sha-stamped, in an empty .moe', () => {
    writeInitFiles(moeDir);
    for (const name of roleNames) {
      const onDisk = fs.readFileSync(rolePath(name), 'utf-8');
      expect(onDisk).toBe(ROLE_DOCS[name]);
      expect(onDisk).toMatch(MARKER_RE);
    }
  });

  it('upgrades a role doc whose marker sha is stale', () => {
    fs.mkdirSync(path.join(moeDir, 'roles'), { recursive: true });
    fs.writeFileSync(
      rolePath(sampleRole),
      '<!-- moe-generated: sha=000000000000 -->\n\n# Old vendored doc\n'
    );
    writeInitFiles(moeDir);
    expect(fs.readFileSync(rolePath(sampleRole), 'utf-8')).toBe(ROLE_DOCS[sampleRole]);
  });

  it('preserves an unmarked role doc (user customization)', () => {
    fs.mkdirSync(path.join(moeDir, 'roles'), { recursive: true });
    const custom = '# My customized role\n\nDo it my way.\n';
    fs.writeFileSync(rolePath(sampleRole), custom);
    writeInitFiles(moeDir);
    expect(fs.readFileSync(rolePath(sampleRole), 'utf-8')).toBe(custom);
  });

  it('upgrades an unmarked role doc byte-identical to a shipped version (CRLF tolerated)', () => {
    // A vendored pre-stamp copy: a shipped body with no marker, checked out with CRLF.
    // Kept as a "customization" it would freeze the project on retired rules forever.
    fs.mkdirSync(path.join(moeDir, 'roles'), { recursive: true });
    const body = ROLE_DOCS[sampleRole].replace(MARKER_RE, '').trim();
    fs.writeFileSync(rolePath(sampleRole), body.replace(/\n/g, '\r\n') + '\r\n');
    writeInitFiles(moeDir);
    expect(fs.readFileSync(rolePath(sampleRole), 'utf-8')).toBe(ROLE_DOCS[sampleRole]);
  });

  it('preserves an unmarked role doc that differs from every shipped version by one line', () => {
    fs.mkdirSync(path.join(moeDir, 'roles'), { recursive: true });
    const edited = ROLE_DOCS[sampleRole].replace(MARKER_RE, '').trim() + '\n- Local rule.\n';
    fs.writeFileSync(rolePath(sampleRole), edited);
    writeInitFiles(moeDir);
    expect(fs.readFileSync(rolePath(sampleRole), 'utf-8')).toBe(edited);
  });

  it('does not rewrite a role doc whose marker sha already matches', () => {
    fs.mkdirSync(path.join(moeDir, 'roles'), { recursive: true });
    const currentSha = ROLE_DOCS[sampleRole].match(MARKER_RE)![1];
    // Same sha but tampered body: an up-to-date marker must short-circuit the
    // write, so the tampered body surviving proves no rewrite happened.
    const tampered = `<!-- moe-generated: sha=${currentSha} -->\n\nTAMPERED BODY\n`;
    fs.writeFileSync(rolePath(sampleRole), tampered);
    writeInitFiles(moeDir);
    expect(fs.readFileSync(rolePath(sampleRole), 'utf-8')).toBe(tampered);
  });

  it('creates .moe/.gitignore when missing and preserves an existing one', () => {
    writeInitFiles(moeDir);
    const gitignorePath = path.join(moeDir, '.gitignore');
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(GITIGNORE_CONTENT);

    fs.writeFileSync(gitignorePath, 'custom-ignore\n');
    writeInitFiles(moeDir);
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe('custom-ignore\n');
  });

  it.each([
    ['historical template', BUNDLED_GITIGNORE_V1],
    ['CRLF, no trailing newline, attempts/ already listed', '# Moe runtime files (not shared)\r\nworkers/\r\nattempts/'],
  ])('writeInitFiles appends missing Wave 1 dirs onto a bundled-style .moe/.gitignore (%s)', (_label, existing) => {
    const gitignorePath = path.join(moeDir, '.gitignore');
    fs.writeFileSync(gitignorePath, existing);
    writeInitFiles(moeDir);
    const onDisk = fs.readFileSync(gitignorePath, 'utf-8');
    writeInitFiles(moeDir); // every daemon start runs it again: no second append
    expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(onDisk);

    expect(onDisk.startsWith(existing)).toBe(true); // appended, user lines untouched
    const lines = trimmedLines(onDisk);
    for (const dir of WAVE1_RUNTIME_DIRS) {
      expect(lines.filter((line) => line === dir)).toEqual([dir]);
    }
  });

  it('writes subagent docs frontmatter-first, with the marker inside the frontmatter', () => {
    const subagentNames = Object.keys(SUBAGENT_DOCS);
    if (subagentNames.length === 0) return;
    writeInitFiles(moeDir);
    for (const name of subagentNames) {
      const onDisk = fs.readFileSync(path.join(moeDir, 'agents', name), 'utf-8');
      expect(onDisk).toBe(SUBAGENT_DOCS[name]);
      // Claude Code's subagent loader requires the YAML frontmatter delimiter
      // on line 1 — the upgrade marker must live INSIDE the frontmatter.
      expect(onDisk.startsWith('---\n')).toBe(true);
      expect(onDisk).toMatch(/^---\n# moe-generated: sha=[a-f0-9]{12}\n/);
    }
  });

  it('upgrades a subagent doc whose frontmatter marker sha is stale', () => {
    const subagentNames = Object.keys(SUBAGENT_DOCS);
    if (subagentNames.length === 0) return;
    const name = subagentNames[0];
    fs.mkdirSync(path.join(moeDir, 'agents'), { recursive: true });
    const agentPath = path.join(moeDir, 'agents', name);
    fs.writeFileSync(agentPath, '---\n# moe-generated: sha=000000000000\nname: old\n---\nold body\n');
    writeInitFiles(moeDir);
    expect(fs.readFileSync(agentPath, 'utf-8')).toBe(SUBAGENT_DOCS[name]);
  });
});
