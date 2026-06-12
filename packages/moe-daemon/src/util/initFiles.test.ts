import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeInitFiles, ROLE_DOCS, SUBAGENT_DOCS, GITIGNORE_CONTENT } from './initFiles.js';

const MARKER_RE = /^<!--\s*moe-generated:\s*sha=([a-f0-9]{6,64})\s*-->/;

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
