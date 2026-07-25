package com.moe.util

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class MoeProjectInitializerTest {
    private val tempDirs = mutableListOf<File>()

    private fun tempDir(): File {
        val dir = Files.createTempDirectory("moe-init-test").toFile()
        tempDirs.add(dir)
        return dir
    }

    @After
    fun cleanup() {
        tempDirs.forEach { it.deleteRecursively() }
    }

    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e... → sha12 = 2cf24dba5fb0.
    // This pins the stamp format to the daemon's generate-init-files.ts output —
    // if either side changes its hashing, this test breaks first.
    @Test
    fun `stampMarker matches the daemon's marker format and sha`() {
        assertEquals("<!-- moe-generated: sha=2cf24dba5fb0 -->\n\nhello", MoeProjectInitializer.stampMarker("hello"))
    }

    @Test
    fun `stampMarker is insensitive to CRLF and trailing whitespace`() {
        val lf = MoeProjectInitializer.stampMarker("line1\nline2\n")
        val crlf = MoeProjectInitializer.stampMarker("line1\r\nline2\r\n")
        val noTrail = MoeProjectInitializer.stampMarker("line1\nline2")
        assertEquals(lf, crlf)
        assertEquals(lf, noTrail)
    }

    @Test
    fun `shouldUpgradeGeneratedDoc only fires on differing marker shas`() {
        val bundled = MoeProjectInitializer.stampMarker("new content")
        val staleOnDisk = "<!-- moe-generated: sha=000000000000 -->\n\nold content"
        val unmarkedOnDisk = "# My customized doc"

        assertTrue(MoeProjectInitializer.shouldUpgradeGeneratedDoc(staleOnDisk, bundled))
        assertFalse(MoeProjectInitializer.shouldUpgradeGeneratedDoc(unmarkedOnDisk, bundled))
        assertFalse(MoeProjectInitializer.shouldUpgradeGeneratedDoc(bundled, bundled))
    }

    @Test
    fun `writeGeneratedDoc creates a missing file stamped`() {
        val target = File(tempDir(), "worker.md")
        val stamped = MoeProjectInitializer.stampMarker("# Worker")
        MoeProjectInitializer.writeGeneratedDoc(target, stamped)
        assertEquals(stamped, target.readText())
    }

    @Test
    fun `writeGeneratedDoc upgrades a stale moe-generated file`() {
        val target = File(tempDir(), "worker.md")
        target.writeText("<!-- moe-generated: sha=000000000000 -->\n\n# Old worker doc")
        val stamped = MoeProjectInitializer.stampMarker("# New worker doc")
        MoeProjectInitializer.writeGeneratedDoc(target, stamped)
        assertEquals(stamped, target.readText())
    }

    @Test
    fun `writeGeneratedDoc preserves an unmarked user customization`() {
        val target = File(tempDir(), "worker.md")
        val custom = "# My way\n\nDo it my way."
        target.writeText(custom)
        MoeProjectInitializer.writeGeneratedDoc(target, MoeProjectInitializer.stampMarker("# Bundled"))
        assertEquals(custom, target.readText())
    }

    @Test
    fun `writeGeneratedDoc does not rewrite when the marker sha already matches`() {
        val target = File(tempDir(), "worker.md")
        val stamped = MoeProjectInitializer.stampMarker("# Worker")
        val sha = Regex("sha=([a-f0-9]{12})").find(stamped)!!.groupValues[1]
        // Same sha but tampered body: an up-to-date marker must short-circuit
        // the write, so the tampered body surviving proves no rewrite happened.
        val tampered = "<!-- moe-generated: sha=$sha -->\n\nTAMPERED"
        target.writeText(tampered)
        MoeProjectInitializer.writeGeneratedDoc(target, stamped)
        assertEquals(tampered, target.readText())
    }

    // Skill files lead with YAML frontmatter, so the marker has to live INSIDE
    // the frontmatter — an HTML comment above `---` breaks the skill loader.
    // Format is pinned to the daemon's generate-skill-files.ts stampSkillFile:
    // both writers stamp the same bytes or they ping-pong overwrites.
    @Test
    fun `stampSkillFile puts the marker inside YAML frontmatter`() {
        val raw = "---\nname: moe-planning\n---\n\nBody text.\n"
        val stamped = MoeProjectInitializer.stampSkillFile("SKILL.md", raw)
        val sha = Regex("^---\\n# moe-generated: sha=([a-f0-9]{12})\\n").find(stamped)?.groupValues?.get(1)
        assertTrue("marker must be line 2, inside the frontmatter: $stamped", sha != null)
        // The marker is injected into the existing frontmatter, not stacked on top
        // of a second opener — two `---` total (open + close), same as the source.
        assertEquals("---\n# moe-generated: sha=$sha\nname: moe-planning\n---\n\nBody text.", stamped)
    }

    @Test
    fun `stampSkillFile uses the HTML marker for non-frontmatter markdown`() {
        val stamped = MoeProjectInitializer.stampSkillFile("SOURCE.md", "hello")
        assertEquals("<!-- moe-generated: sha=2cf24dba5fb0 -->\n\nhello", stamped)
    }

    @Test
    fun `stampSkillFile leaves non-markdown assets untouched`() {
        val raw = "cmake_minimum_required(VERSION 3.20)\n"
        assertEquals(raw, MoeProjectInitializer.stampSkillFile("CMakeLists.txt", raw))
    }

    @Test
    fun `shouldUpgradeGeneratedDoc reads the frontmatter marker form too`() {
        val bundled = MoeProjectInitializer.stampSkillFile("SKILL.md", "---\nname: x\n---\n\nnew")
        val staleOnDisk = "---\n# moe-generated: sha=000000000000\nname: x\n---\n\nold"
        val unmarkedOnDisk = "---\nname: x\n---\n\nmy own edit"

        assertTrue(MoeProjectInitializer.shouldUpgradeGeneratedDoc(staleOnDisk, bundled))
        assertFalse(MoeProjectInitializer.shouldUpgradeGeneratedDoc(unmarkedOnDisk, bundled))
        assertFalse(MoeProjectInitializer.shouldUpgradeGeneratedDoc(bundled, bundled))
    }

    @Test
    fun `syncSkills upgrades a stale skill and preserves a customized one`() {
        val moeDir = File(tempDir(), ".moe").apply { mkdirs() }
        val bundledSkills = File(tempDir(), "docs/skills").apply { mkdirs() }
        File(bundledSkills, "moe-planning").mkdirs()
        File(bundledSkills, "moe-planning/SKILL.md").writeText("---\nname: moe-planning\n---\n\nNEW BODY")
        File(bundledSkills, "custom-skill").mkdirs()
        File(bundledSkills, "custom-skill/SKILL.md").writeText("---\nname: custom-skill\n---\n\nBUNDLED")

        // Pre-seed: one stale Moe-generated skill, one the user has edited.
        File(moeDir, "skills/moe-planning").mkdirs()
        File(moeDir, "skills/moe-planning/SKILL.md")
            .writeText("---\n# moe-generated: sha=000000000000\nname: moe-planning\n---\n\nOLD BODY")
        File(moeDir, "skills/custom-skill").mkdirs()
        val userEdited = "---\nname: custom-skill\n---\n\nMY OWN NOTES"
        File(moeDir, "skills/custom-skill/SKILL.md").writeText(userEdited)

        MoeProjectInitializer.syncSkills(moeDir, bundledSkills)

        assertTrue(File(moeDir, "skills/moe-planning/SKILL.md").readText().contains("NEW BODY"))
        assertEquals(userEdited, File(moeDir, "skills/custom-skill/SKILL.md").readText())
    }

    @Test
    fun `stampSkillFile injects a JSON marker key for manifest json`() {
        val raw = "{\n  \"version\": 1,\n  \"skills\": []\n}\n"
        val stamped = MoeProjectInitializer.stampSkillFile("manifest.json", raw)
        val sha = Regex("\"moeGeneratedSha\": \"([a-f0-9]{12})\"").find(stamped)?.groupValues?.get(1)
        assertTrue("expected a marker key: $stamped", sha != null)
        assertEquals(
            "{\n  \"moeGeneratedSha\": \"$sha\",\n  \"version\": 1,\n  \"skills\": []\n}",
            stamped
        )
    }

    // Regression: stamping JSON by extension would inject "moeGeneratedSha" into
    // a skill's vendored data payload (ros2-skill ships robot profiles). Only the
    // top-level skills manifest may carry the marker.
    @Test
    fun `stampSkillFile leaves skill-vendored json data untouched`() {
        val profile = "{\n  \"schema_version\": 1,\n  \"robot_name\": \"lekiwi\"\n}\n"
        assertEquals(profile, MoeProjectInitializer.stampSkillFile("lekiwi_profile.json", profile))
    }

    @Test
    fun `syncSkills upgrades a stale manifest and preserves an unmarked one`() {
        val bundledSkills = File(tempDir(), "docs/skills").apply { mkdirs() }
        File(bundledSkills, "manifest.json").writeText("{\n  \"version\": 2,\n  \"skills\": []\n}")

        val staleDir = File(tempDir(), ".moe").apply { mkdirs() }
        File(staleDir, "skills").mkdirs()
        File(staleDir, "skills/manifest.json")
            .writeText("{\n  \"moeGeneratedSha\": \"000000000000\",\n  \"version\": 1,\n  \"skills\": []\n}")
        MoeProjectInitializer.syncSkills(staleDir, bundledSkills)
        assertTrue(File(staleDir, "skills/manifest.json").readText().contains("\"version\": 2"))

        val customDir = File(tempDir(), ".moe").apply { mkdirs() }
        File(customDir, "skills").mkdirs()
        val custom = "{\n  \"version\": 1,\n  \"skills\": []\n}"
        File(customDir, "skills/manifest.json").writeText(custom)
        MoeProjectInitializer.syncSkills(customDir, bundledSkills)
        assertEquals(custom, File(customDir, "skills/manifest.json").readText())
    }

    @Test
    fun `syncSkills copies nested skill assets`() {
        val moeDir = File(tempDir(), ".moe").apply { mkdirs() }
        val bundledSkills = File(tempDir(), "docs/skills").apply { mkdirs() }
        File(bundledSkills, "cpp/templates").mkdirs()
        File(bundledSkills, "cpp/SKILL.md").writeText("---\nname: cpp\n---\n\nBody")
        File(bundledSkills, "cpp/templates/CMakeLists.txt").writeText("cmake_minimum_required(VERSION 3.20)")

        MoeProjectInitializer.syncSkills(moeDir, bundledSkills)

        assertTrue(File(moeDir, "skills/cpp/SKILL.md").exists())
        assertEquals(
            "cmake_minimum_required(VERSION 3.20)",
            File(moeDir, "skills/cpp/templates/CMakeLists.txt").readText()
        )
    }

    @Test
    fun `initializeProject does not clobber an existing project json`() {
        val root = tempDir()
        val moeDir = File(root, ".moe")
        moeDir.mkdirs()
        val projectFile = File(moeDir, "project.json")
        val existing = """{"id":"proj-keepme","name":"existing","settings":{"approvalMode":"TURBO"}}"""
        projectFile.writeText(existing)

        // Redirect user.home so registerProject writes its ~/.moe/projects.json
        // into a sandbox instead of the real user registry.
        val realHome = System.getProperty("user.home")
        System.setProperty("user.home", tempDir().absolutePath)
        try {
            MoeProjectInitializer.initializeProject(root.absolutePath, "renamed")
        } finally {
            System.setProperty("user.home", realHome)
        }

        assertEquals(existing, projectFile.readText())
    }
}
