import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SKILL_FILES, SKILL_MANIFEST, writeSkillFiles } from './skillFiles.js';

/**
 * Skill files are vendored into the daemon by generate-skill-files.ts and
 * written into .moe/skills/ at init. They used to be create-only, which meant
 * an edited SKILL.md never reached a project that had already been initialized.
 * These tests pin the sha-marker upgrade path that fixes that — and the
 * user-customization escape hatch that keeps it safe.
 */
describe('writeSkillFiles', () => {
  let moePath: string;

  beforeEach(() => {
    moePath = fs.mkdtempSync(path.join(os.tmpdir(), 'moe-skills-test-'));
  });

  afterEach(() => {
    fs.rmSync(moePath, { recursive: true, force: true });
  });

  const planningPath = () => path.join(moePath, 'skills', 'moe-planning', 'SKILL.md');

  it('stamps every vendored SKILL.md with a frontmatter marker', () => {
    const skillMds = Object.entries(SKILL_FILES).filter(([rel]) => rel.endsWith('/SKILL.md'));
    expect(skillMds.length).toBeGreaterThan(0);
    for (const [rel, content] of skillMds) {
      expect(content, `${rel} must open with the frontmatter marker`)
        .toMatch(/^---\n# moe-generated: sha=[a-f0-9]{12}\n/);
    }
  });

  it('creates skill files that do not exist yet', () => {
    writeSkillFiles(moePath);
    expect(fs.existsSync(planningPath())).toBe(true);
    expect(fs.readFileSync(planningPath(), 'utf-8')).toBe(SKILL_FILES['moe-planning/SKILL.md']);
  });

  it('upgrades a skill file whose marker sha is stale', () => {
    fs.mkdirSync(path.join(moePath, 'skills', 'moe-planning'), { recursive: true });
    fs.writeFileSync(
      planningPath(),
      '---\n# moe-generated: sha=000000000000\nname: moe-planning\n---\n\nOLD BODY'
    );

    writeSkillFiles(moePath);

    expect(fs.readFileSync(planningPath(), 'utf-8')).toBe(SKILL_FILES['moe-planning/SKILL.md']);
  });

  it('preserves a user-customized skill file (no marker)', () => {
    fs.mkdirSync(path.join(moePath, 'skills', 'moe-planning'), { recursive: true });
    const custom = '---\nname: moe-planning\n---\n\nMY OWN PLANNING RULES';
    fs.writeFileSync(planningPath(), custom);

    writeSkillFiles(moePath);

    expect(fs.readFileSync(planningPath(), 'utf-8')).toBe(custom);
  });

  it('does not rewrite when the marker sha already matches', () => {
    const bundled = SKILL_FILES['moe-planning/SKILL.md'];
    const sha = /sha=([a-f0-9]{12})/.exec(bundled)![1];
    // Same sha, tampered body: an up-to-date marker must short-circuit the
    // write, so the tampered body surviving proves no rewrite happened.
    const tampered = `---\n# moe-generated: sha=${sha}\nname: moe-planning\n---\n\nTAMPERED`;
    fs.mkdirSync(path.join(moePath, 'skills', 'moe-planning'), { recursive: true });
    fs.writeFileSync(planningPath(), tampered);

    writeSkillFiles(moePath);

    expect(fs.readFileSync(planningPath(), 'utf-8')).toBe(tampered);
  });

  // manifest.json can't carry a comment, so its marker is a top-level JSON key.
  describe('manifest.json', () => {
    const manifestPath = () => path.join(moePath, 'skills', 'manifest.json');

    it('is stamped with a parseable marker key', () => {
      expect(SKILL_MANIFEST).toMatch(/^\{\n {2}"moeGeneratedSha": "[a-f0-9]{12}",\n/);
      const parsed = JSON.parse(SKILL_MANIFEST);
      expect(parsed.moeGeneratedSha).toMatch(/^[a-f0-9]{12}$/);
      // The marker must not have displaced any real content.
      expect(parsed.version).toBe(1);
      expect(Array.isArray(parsed.skills)).toBe(true);
    });

    it('upgrades a stale manifest', () => {
      fs.mkdirSync(path.join(moePath, 'skills'), { recursive: true });
      fs.writeFileSync(manifestPath(), '{\n  "moeGeneratedSha": "000000000000",\n  "version": 1,\n  "skills": []\n}');

      writeSkillFiles(moePath);

      expect(fs.readFileSync(manifestPath(), 'utf-8')).toBe(SKILL_MANIFEST);
    });

    it('preserves a manifest with the marker key stripped', () => {
      fs.mkdirSync(path.join(moePath, 'skills'), { recursive: true });
      const custom = '{\n  "version": 1,\n  "skills": []\n}';
      fs.writeFileSync(manifestPath(), custom);

      writeSkillFiles(moePath);

      expect(fs.readFileSync(manifestPath(), 'utf-8')).toBe(custom);
    });
  });

  it('lists the epic-breakdown skill in the manifest and ships its SKILL.md', () => {
    const names = JSON.parse(SKILL_MANIFEST).skills.map((s: { name: string }) => s.name);
    expect(names).toContain('moe-epic-breakdown');
    expect(SKILL_FILES['moe-epic-breakdown/SKILL.md']).toBeDefined();
  });

  // Regression: stamping JSON by extension injected "moeGeneratedSha" into
  // ros2-skill's vendored robot profile — a real data payload, not a Moe doc.
  // Only the top-level skills manifest may carry the marker.
  it('never injects a marker into a skill-vendored data file', () => {
    for (const [rel, content] of Object.entries(SKILL_FILES)) {
      if (rel.endsWith('.md')) continue;
      expect(content, `${rel} must be vendored byte-for-byte`).not.toContain('moeGeneratedSha');
    }
    const profile = SKILL_FILES['ros2-skill/.profiles/lekiwi_profile.json'];
    if (profile) {
      expect(JSON.parse(profile).moeGeneratedSha).toBeUndefined();
      expect(profile.trimStart().startsWith('{\n  "schema_version"')).toBe(true);
    }
  });

  it('leaves non-markdown vendored assets create-only', () => {
    const assetRel = Object.keys(SKILL_FILES).find((rel) => !rel.endsWith('.md'));
    if (!assetRel) return; // no binary/template assets vendored right now
    const assetPath = path.join(moePath, 'skills', ...assetRel.split('/'));
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, 'USER VERSION');

    writeSkillFiles(moePath);

    expect(fs.readFileSync(assetPath, 'utf-8')).toBe('USER VERSION');
  });
});
