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
