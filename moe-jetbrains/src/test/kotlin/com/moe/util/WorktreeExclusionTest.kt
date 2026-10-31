package com.moe.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Locale
import java.util.concurrent.CancellationException

class WorktreeExclusionTest {
    private fun decide(
        project: String?,
        content: String,
        excluded: List<String> = emptyList(),
        caseSensitive: Boolean = true,
    ): String? = WorktreeExclusion.urlToExclude(project, content, excluded, caseSensitive)

    @Test
    fun excludesTheProjectsWorktreesForAnEqualOrAncestorContentRootNeverTheAncestorsOwn() {
        val expected = "file:///home/u/proj/.worktrees"
        assertEquals(expected, decide("file:///home/u/proj", "file:///home/u/proj"))
        assertEquals(expected, decide("file:///home/u/proj", "file:///home/u"))
    }

    @Test
    fun secondApplicationAddsNothing() {
        val first = decide("file:///home/u/proj", "file:///home/u/proj")
        assertEquals("file:///home/u/proj/.worktrees", first)
        assertNull(decide("file:///home/u/proj", "file:///home/u/proj", listOf(first!!)))
    }

    @Test
    fun existingExclusionOfTheFolderOrAnAncestorIsRespected() {
        val project = "file:///home/u/proj"
        assertNull(decide(project, project, listOf("file:///home/u/proj/.worktrees")))
        assertNull(decide(project, project, listOf("file:///home/u/proj/.worktrees/")))
        assertNull(decide(project, "file:///home/u", listOf("file:///home/u/proj")))
    }

    @Test
    fun exclusionOfAChildOrSiblingDoesNotCoverTheFolder() {
        val project = "file:///home/u/proj"
        val expected = "file:///home/u/proj/.worktrees"
        assertEquals(expected, decide(project, project, listOf("file:///home/u/proj/.worktrees/task-1")))
        assertEquals(expected, decide(project, project, listOf("file:///home/u/proj/.worktrees2")))
        assertEquals(expected, decide(project, project, listOf("file:///home/u/proj/build")))
    }

    @Test
    fun contentRootsThatDoNotContainTheFolderAreNoOps() {
        val project = "file:///home/u/proj"
        assertNull(decide(null, project))
        assertNull(decide("", project))
        assertNull(decide("   ", project))
        assertNull(decide(project, ""))
        assertNull(decide(project, "file:///home/u/other"))
        assertNull(decide(project, "file:///home/u/proj/sub"))
        assertNull(decide(project, "file:///home/u/proj/.worktrees"))
        assertNull(decide(project, "file:///home/u/proj/.worktrees/task-1"))
    }

    @Test
    fun prefixLookalikesAreNotContainment() {
        assertNull(decide("file:///home/u/proj2", "file:///home/u/proj"))
        assertNull(decide("file:///home/u/proj", "file:///home/u/pro"))
        assertNull(decide("file:///home/u/proj", "file:///home/u/proj-copy"))
        assertEquals(
            "file:///home/u/proj2/.worktrees",
            decide("file:///home/u/proj2", "file:///home/u/proj2", listOf("file:///home/u/proj")),
        )
    }

    @Test
    fun trailingSeparatorsAreIgnored() {
        assertEquals(
            "file:///home/u/proj/.worktrees",
            decide("file:///home/u/proj/", "file:///home/u/proj//"),
        )
        assertNull(decide("file:///home/u/proj/", "file:///home/u/proj", listOf("file:///home/u/proj/.worktrees//")))
    }

    @Test
    fun spacesAndUnicodeSurviveVerbatim() {
        val project = "file:///home/üser/my proj/日本語"
        assertEquals("$project/.worktrees", decide(project, "file:///home/üser/my proj"))
        assertNull(decide(project, "file:///home/üser/my proj", listOf("$project/.worktrees")))
        assertNull(decide(project, "file:///home/üser/my  proj"))
    }

    @Test
    fun windowsDriveUrlsCompareCaseInsensitivelyAndKeepTheProjectSpelling() {
        val project = "file://D:/Work/Proj"
        assertEquals(
            "file://D:/Work/Proj/.worktrees",
            decide(project, "file://d:/work", caseSensitive = false),
        )
        assertNull(decide(project, "file://d:/work", listOf("file://d:/WORK/proj/.WorkTrees"), caseSensitive = false))
        assertNull(decide(project, "file://E:/Work", caseSensitive = false))
    }

    @Test
    fun filesystemRootContentRootsContainTheFolder() {
        assertEquals("file://D:/.worktrees", decide("file://D:/", "file://D:/", caseSensitive = false))
        assertEquals("file://D:/Proj/.worktrees", decide("file://D:/Proj", "file://D:/", caseSensitive = false))
        assertEquals("file:///proj/.worktrees", decide("file:///proj", "file:///"))
        assertEquals("file:///.worktrees", decide("file:///", "file:///"))
    }

    @Test
    fun caseSensitiveFilesystemsDistinguishCasing() {
        val project = "file:///home/u/Proj"
        assertNull(decide(project, "file:///home/u/proj", caseSensitive = true))
        assertEquals(
            "file:///home/u/Proj/.worktrees",
            decide(project, "file:///home/u/Proj", listOf("file:///home/u/Proj/.WORKTREES"), caseSensitive = true),
        )
    }

    @Test
    fun uncUrlsRespectShareBoundaries() {
        val project = "file:////server/share/proj"
        assertEquals("$project/.worktrees", decide(project, "file:////server/share", caseSensitive = false))
        assertNull(decide(project, "file:////server/shar", caseSensitive = false))
        assertNull(decide(project, "file:////server2/share", caseSensitive = false))
        assertNull(decide(project, "file:////server/share", listOf("$project/.worktrees/"), caseSensitive = false))
    }

    @Test
    fun caseFoldingIgnoresTheDefaultLocale() {
        val saved = Locale.getDefault()
        Locale.setDefault(Locale.forLanguageTag("tr-TR"))
        try {
            assertNull(
                decide("file://D:/INFO/proj", "file://D:/info/proj", listOf("file://d:/info/PROJ/.WORKTREES"), caseSensitive = false),
            )
            assertEquals(
                "file://D:/INFO/proj/.worktrees",
                decide("file://D:/INFO/proj", "file://D:/info", caseSensitive = false),
            )
        } finally {
            Locale.setDefault(saved)
        }
    }

    // --- adapter: driven through fakes of the module-model seam ---

    private val projectUrl = "file:///home/u/proj"
    private val worktrees = "$projectUrl/.worktrees"

    /** A module whose committed state lives in [excluded]; counts how often a model is opened/committed/disposed. */
    private class FakeModule(
        roots: List<String>,
        excluded: Map<String, List<String>> = emptyMap(),
        private val failExclude: Throwable? = null,
        private val failCommit: Throwable? = null,
        private val editorSeesExcluded: String? = null,
    ) : ModuleRoots {
        val committed: MutableMap<String, MutableList<String>> =
            roots.associateWith { (excluded[it] ?: emptyList()).toMutableList() }.toMutableMap()
        var edits = 0
        var commits = 0
        var disposals = 0

        override fun entries() = committed.map { (url, ex) -> ExclusionEntry(url, ex.toList()) }

        override fun edit(): RootEditor {
            edits++
            val pending = committed.mapValues { it.value.toMutableList() }.toMutableMap()
            editorSeesExcluded?.let { url -> pending.values.forEach { it.add(url) } }
            return object : RootEditor {
                override fun entries() = pending.map { (url, ex) -> ExclusionEntry(url, ex.toList()) }
                override fun exclude(entryUrl: String, folderUrl: String) {
                    failExclude?.let { throw it }
                    pending.getValue(entryUrl).add(folderUrl)
                }
                override fun commit() {
                    failCommit?.let { throw it }
                    commits++
                    committed.clear()
                    committed.putAll(pending)
                }
                override fun dispose() { disposals++ }
            }
        }
    }

    private fun runOn(module: FakeModule, project: String? = projectUrl) =
        WorktreeExclusion.excludeInModule(project, module, caseSensitive = true)

    @Test
    fun adapterAddsExactlyOneExclusionKeepsUserOnesAndSkipsTheSecondRun() {
        val module = FakeModule(listOf(projectUrl), mapOf(projectUrl to listOf("$projectUrl/build")))
        val expected = listOf("$projectUrl/build", worktrees)
        assertEquals(1, runOn(module))
        assertEquals(expected, module.committed.getValue(projectUrl))
        assertEquals(1, module.commits)
        assertEquals(0, module.disposals)
        assertEquals(0, runOn(module))
        assertEquals(1, module.edits)
        assertEquals(expected, module.committed.getValue(projectUrl))
    }

    @Test
    fun adapterNeverOpensAModelWithoutAMatchingContentRoot() {
        listOf(
            FakeModule(emptyList()),
            FakeModule(listOf("file:///home/u/other")),
            FakeModule(listOf("$projectUrl/sub")),
            FakeModule(listOf("file:///home/u/proj2")),
            FakeModule(listOf(projectUrl), mapOf(projectUrl to listOf(worktrees))),
        ).forEach { module ->
            assertEquals(0, runOn(module))
            assertEquals(0, module.edits)
        }
        val matching = FakeModule(listOf(projectUrl))
        assertEquals(0, runOn(matching, project = null))
        assertEquals(0, matching.edits)
    }

    @Test
    fun adapterDisposesWithoutCommitWhenTheModelAlreadyHasTheExclusion() {
        val module = FakeModule(listOf(projectUrl), editorSeesExcluded = worktrees)
        assertEquals(0, runOn(module))
        assertEquals(1, module.edits)
        assertEquals(0, module.commits)
        assertEquals(1, module.disposals)
    }

    @Test
    fun adapterDisposesWithoutCommitWhenTheEditOrTheCommitFails() {
        listOf(
            FakeModule(listOf(projectUrl), failExclude = IllegalStateException("boom")),
            FakeModule(listOf(projectUrl), failCommit = IllegalStateException("boom")),
        ).forEach { module ->
            assertThrows(IllegalStateException::class.java) { runOn(module) }
            assertEquals(0, module.commits)
            assertEquals(1, module.disposals)
            assertTrue(module.committed.getValue(projectUrl).isEmpty())
        }
    }

    @Test
    fun oneBrokenModuleDoesNotStopTheOthersAndWarnsOnce() {
        val broken = FakeModule(listOf(projectUrl), failExclude = IllegalStateException("boom"))
        val brokenToo = FakeModule(listOf(projectUrl), failCommit = IllegalStateException("boom 2"))
        val healthy = FakeModule(listOf(projectUrl))
        val warnings = mutableListOf<Pair<String, Throwable>>()
        val added = WorktreeExclusion.excludeInProject(
            projectUrl, listOf(broken, brokenToo, healthy), caseSensitive = true,
        ) { message, cause -> warnings.add(message to cause) }
        assertEquals(1, added)
        assertEquals(listOf(worktrees), healthy.committed.getValue(projectUrl))
        assertEquals(1, broken.disposals)
        assertEquals(1, brokenToo.disposals)
        assertEquals(1, warnings.size)
        assertTrue(warnings.single().first.contains("2 module(s)"))
        assertEquals("boom", warnings.single().second.message)
    }

    @Test
    fun cancellationPropagatesAfterTheModelIsDisposed() {
        val cancelled = FakeModule(listOf(projectUrl), failExclude = CancellationException("cancelled"))
        val untouched = FakeModule(listOf(projectUrl))
        val warnings = mutableListOf<String>()
        assertThrows(CancellationException::class.java) {
            WorktreeExclusion.excludeInProject(
                projectUrl, listOf(cancelled, untouched), caseSensitive = true,
            ) { message, _ -> warnings.add(message) }
        }
        assertEquals(1, cancelled.disposals)
        assertEquals(0, untouched.edits)
        assertTrue(warnings.isEmpty())
    }

    @Test
    fun overlappingModuleRootsEachGetTheProjectsFolderExactlyOnce() {
        val ancestor = FakeModule(listOf("file:///home/u"))
        val project = FakeModule(listOf(projectUrl))
        val nested = FakeModule(listOf("$projectUrl/sub"))
        val added = WorktreeExclusion.excludeInProject(
            projectUrl, listOf(ancestor, project, nested), caseSensitive = true,
        ) { _, _ -> }
        assertEquals(2, added)
        assertEquals(listOf(worktrees), ancestor.committed.getValue("file:///home/u"))
        assertEquals(listOf(worktrees), project.committed.getValue(projectUrl))
        assertTrue(nested.committed.getValue("$projectUrl/sub").isEmpty())
        assertEquals(0, nested.edits)
    }

    @Test
    fun pluginXmlRegistersTheListenerOnceOnTheProjectManagerTopic() {
        val xml = File(System.getProperty("user.dir"), "src/main/resources/META-INF/plugin.xml").readText()
        val registration = Regex("""<listener\s+class="com\.moe\.util\.WorktreeExclusionListener"\s+topic="([^"]+)"\s*/>""")
        val matches = registration.findAll(xml).toList()
        assertEquals(1, matches.size)
        assertEquals("com.intellij.openapi.project.ProjectManagerListener", matches.single().groupValues[1])
    }
}
