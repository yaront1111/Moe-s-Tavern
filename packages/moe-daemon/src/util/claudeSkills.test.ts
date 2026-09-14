import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkClaudeSkills } from './claudeSkills.js';

/**
 * Regression coverage for the "Unknown skill" defect: the daemon recommends
 * skills by the directory name under `.moe/skills/`, but Claude Code resolves
 * project skills from `.claude/skills/`. Nothing bridged the two, so every
 * `nextAction.recommendedSkill` was unresolvable from a live seat.
 */

const roots: string[] = [];

function makeProject(skills: Record<string, string> = { 'explore-before-assume': BODY }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claude-skills-'));
  roots.push(root);
  for (const [name, body] of Object.entries(skills)) {
    const dir = path.join(root, '.moe', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  }
  return root;
}

const BODY = `---
# moe-generated: sha=bf1df322eab5
name: explore-before-assume
description: Verify symbols exist before building on them.
---

Body.
`;

/** Resolve through a symlink so the assertion works on both link and copy. */
function readExposed(root: string, name: string): string {
  return fs.readFileSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf-8');
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('linkClaudeSkills', () => {
  it('exposes a .moe skill at .claude/skills so the host Skill tool can resolve it', () => {
    const root = makeProject();

    const result = linkClaudeSkills(root);

    expect([...result.linked, ...result.copied]).toContain('explore-before-assume');
    expect(readExposed(root, 'explore-before-assume')).toBe(BODY);
  });

  it('is idempotent — a second call neither throws nor duplicates', () => {
    const root = makeProject();

    linkClaudeSkills(root);
    const second = linkClaudeSkills(root);

    expect([...second.linked, ...second.copied]).toEqual(['explore-before-assume']);
    expect(readExposed(root, 'explore-before-assume')).toBe(BODY);
  });

  it('propagates an upgraded skill body rather than pinning the init-time copy', () => {
    const root = makeProject();
    linkClaudeSkills(root);

    const upgraded = BODY.replace('sha=bf1df322eab5', 'sha=ffffffffffff').replace('Body.', 'Upgraded body.');
    fs.writeFileSync(path.join(root, '.moe', 'skills', 'explore-before-assume', 'SKILL.md'), upgraded);
    linkClaudeSkills(root);

    // This is the whole reason the implementation prefers a symlink: a copy
    // taken once at init would still read the old body here.
    expect(readExposed(root, 'explore-before-assume')).toBe(upgraded);
  });

  it('never clobbers a user-authored skill of the same name', () => {
    const root = makeProject();
    const userDir = path.join(root, '.claude', 'skills', 'explore-before-assume');
    fs.mkdirSync(userDir, { recursive: true });
    const userBody = '---\nname: explore-before-assume\ndescription: mine\n---\nUser owns this.\n';
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), userBody);

    const result = linkClaudeSkills(root);

    expect(result.skippedUserOwned).toContain('explore-before-assume');
    expect(readExposed(root, 'explore-before-assume')).toBe(userBody);
  });

  it('leaves a symlink the user aimed elsewhere alone', () => {
    const root = makeProject();
    const elsewhere = path.join(root, 'my-own-skill');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'custom');
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    try {
      fs.symlinkSync(elsewhere, path.join(root, '.claude', 'skills', 'explore-before-assume'), 'dir');
    } catch {
      return; // platform without symlinks; the copy path is covered above
    }

    const result = linkClaudeSkills(root);

    expect(result.skippedUserOwned).toContain('explore-before-assume');
    expect(readExposed(root, 'explore-before-assume')).toBe('custom');
  });

  it('skips manifest.json and other non-skill bookkeeping', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, '.moe', 'skills', 'manifest.json'), '{}');
    fs.writeFileSync(path.join(root, '.moe', 'skills', 'LICENSE-VENDORED.md'), 'x');

    linkClaudeSkills(root);

    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'LICENSE-VENDORED.md'))).toBe(false);
  });

  it('skips a directory with no SKILL.md instead of exposing an unloadable entry', () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.moe', 'skills', 'half-installed'), { recursive: true });

    const result = linkClaudeSkills(root);

    expect([...result.linked, ...result.copied]).not.toContain('half-installed');
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'half-installed'))).toBe(false);
  });

  it('produces a live link when given a RELATIVE project root', () => {
    // Regression: a relative link target resolves against the link's own
    // directory (.claude/skills/), not the process cwd, so passing a relative
    // root used to yield `.claude/skills/<root>/.moe/skills/<name>` — a dead
    // link that still reported success. The daemon takes its project path from
    // argv, so a relative root is reachable in production.
    const root = makeProject();
    const cwd = process.cwd();
    process.chdir(path.dirname(root));
    try {
      linkClaudeSkills(`./${path.basename(root)}`);
    } finally {
      process.chdir(cwd);
    }

    // Reading through the link is the assertion — a dangling link throws here.
    expect(readExposed(root, 'explore-before-assume')).toBe(BODY);
  });

  it('reports noSkillPack and creates nothing when .moe/skills is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-claude-skills-'));
    roots.push(root);

    const result = linkClaudeSkills(root);

    expect(result.noSkillPack).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'skills'))).toBe(false);
  });
});
