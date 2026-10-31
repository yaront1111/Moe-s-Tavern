package com.moe.util

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.module.Module
import com.intellij.openapi.module.ModuleManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.roots.ContentEntry
import com.intellij.openapi.roots.ModifiableRootModel
import com.intellij.openapi.roots.ModuleRootManager
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.vfs.VfsUtilCore
import java.util.concurrent.CancellationException

/**
 * Reserves `<project root>/.worktrees` as an excluded folder of the content root that contains it.
 *
 * Per-task git worktrees live there (docs/plans/2026-10-30-per-task-worktrees.md §7.5); without the
 * exclusion the IDE indexes every worktree as a copy of the repository and offers each one as an
 * unregistered VCS root. The decision below is pure string logic over IntelliJ URLs (`file://...`,
 * always `/`-separated): it never touches the filesystem, because the folder must be reserved before
 * the first worker creates it.
 */
object WorktreeExclusion {
    const val FOLDER_NAME = ".worktrees"

    /**
     * The URL to add as an excluded folder of [contentRootUrl], or null when there is nothing to add:
     * no project root, the content root does not contain `<project root>/.worktrees` (unrelated, nested
     * below the project root, or only a prefix lookalike), or an existing exclusion already covers it
     * (the folder itself or any ancestor). An ancestor content root yields the *project's* `.worktrees`,
     * never `<ancestor>/.worktrees`.
     */
    fun urlToExclude(
        projectRootUrl: String?,
        contentRootUrl: String,
        excludedUrls: Collection<String>,
        caseSensitive: Boolean,
    ): String? {
        val project = normalize(projectRootUrl) ?: return null
        val content = normalize(contentRootUrl) ?: return null
        val target = "$project/$FOLDER_NAME"
        if (!isStrictlyUnder(target, content, caseSensitive)) return null
        val covered = excludedUrls.any { excluded ->
            normalize(excluded)?.let { isSameOrUnder(target, it, caseSensitive) } == true
        }
        return if (covered) null else target
    }

    /** Drops trailing `/` without eating into the `scheme://` prefix, so `file:///` stays a usable root. */
    private fun normalize(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val schemeEnd = url.indexOf("://")
        val floor = if (schemeEnd < 0) 0 else schemeEnd + 3
        var end = url.length
        while (end > floor && url[end - 1] == '/') end--
        return url.substring(0, end)
    }

    private fun isSameOrUnder(child: String, parent: String, caseSensitive: Boolean): Boolean =
        child.equals(parent, ignoreCase = !caseSensitive) || isStrictlyUnder(child, parent, caseSensitive)

    /** Slash-boundary prefix test, so `/a/proj2` is not under `/a/proj`. */
    private fun isStrictlyUnder(child: String, parent: String, caseSensitive: Boolean): Boolean =
        child.length > parent.length &&
            child[parent.length] == '/' &&
            child.startsWith(parent, ignoreCase = !caseSensitive)

    /** Applies [urlToExclude] to one module: reads first, and only opens a model when something is missing. */
    internal fun excludeInModule(projectRootUrl: String?, module: ModuleRoots, caseSensitive: Boolean): Int {
        if (additions(projectRootUrl, module.entries(), caseSensitive).isEmpty()) return 0
        val editor = module.edit()
        var committed = false
        try {
            // Recheck on the model itself: the user may have excluded it since the read above.
            val missing = additions(projectRootUrl, editor.entries(), caseSensitive)
            if (missing.isEmpty()) return 0
            missing.forEach { (entryUrl, folderUrl) -> editor.exclude(entryUrl, folderUrl) }
            editor.commit()
            committed = true
            return missing.size
        } finally {
            if (!committed) editor.dispose()
        }
    }

    /**
     * Runs [excludeInModule] over every module. One broken module must not abort project open or
     * hide the others, so ordinary failures are counted and reported with a single warning;
     * cancellation propagates.
     */
    internal fun excludeInProject(
        projectRootUrl: String?,
        modules: List<ModuleRoots>,
        caseSensitive: Boolean,
        warn: (String, Throwable) -> Unit,
    ): Int {
        var added = 0
        var failures = 0
        var firstFailure: Throwable? = null
        for (module in modules) {
            try {
                added += excludeInModule(projectRootUrl, module, caseSensitive)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failures++
                if (firstFailure == null) firstFailure = e
            }
        }
        firstFailure?.let { warn("Could not exclude $FOLDER_NAME in $failures module(s); first failure follows", it) }
        return added
    }

    private fun additions(
        projectRootUrl: String?,
        entries: List<ExclusionEntry>,
        caseSensitive: Boolean,
    ): List<Pair<String, String>> = entries.mapNotNull { entry ->
        urlToExclude(projectRootUrl, entry.url, entry.excludedUrls, caseSensitive)?.let { entry.url to it }
    }
}

/** A content root and its excluded folder URLs, as the adapter reads them. */
internal class ExclusionEntry(val url: String, val excludedUrls: List<String>)

/** Mutable view of one module's root model; [dispose] must be safe after a failed [commit]. */
internal interface RootEditor {
    fun entries(): List<ExclusionEntry>
    fun exclude(entryUrl: String, folderUrl: String)
    fun commit()
    fun dispose()
}

/** The seam between the decision logic and IntelliJ's module model (faked in tests). */
internal interface ModuleRoots {
    fun entries(): List<ExclusionEntry>
    fun edit(): RootEditor
}

private fun ContentEntry.toExclusionEntry() = ExclusionEntry(url, excludeFolderUrls)

private class IdeaModuleRoots(private val module: Module) : ModuleRoots {
    override fun entries(): List<ExclusionEntry> =
        if (module.isDisposed) emptyList()
        else ModuleRootManager.getInstance(module).contentEntries.map { it.toExclusionEntry() }

    override fun edit(): RootEditor = IdeaRootEditor(ModuleRootManager.getInstance(module).modifiableModel)
}

private class IdeaRootEditor(private val model: ModifiableRootModel) : RootEditor {
    override fun entries(): List<ExclusionEntry> = model.contentEntries.map { it.toExclusionEntry() }

    override fun exclude(entryUrl: String, folderUrl: String) {
        val entry = model.contentEntries.firstOrNull { it.url == entryUrl }
            ?: error("Content root $entryUrl is no longer in the module")
        entry.addExcludeFolder(folderUrl)
    }

    override fun commit() = model.commit()

    override fun dispose() {
        if (!model.isDisposed) model.dispose()
    }
}

/**
 * On project open, excludes `<project>/.worktrees` from the project model in every Moe mode (the folder
 * is reserved). Independent of [com.moe.listeners.MoeProjectOpenListener] so it neither needs the
 * daemon nor shares its failure modes.
 */
class WorktreeExclusionListener : ProjectManagerListener {
    private val log = Logger.getInstance(WorktreeExclusionListener::class.java)

    override fun projectOpened(project: Project) {
        // Short EDT write action, queued so project open itself is never delayed by the root-model write lock.
        ApplicationManager.getApplication().invokeLater({ applyTo(project) }, ModalityState.nonModal())
    }

    private fun applyTo(project: Project) {
        if (project.isDisposed) return
        val projectUrl = project.basePath?.let { VfsUtilCore.pathToUrl(it) } ?: return
        try {
            WriteAction.run<RuntimeException> {
                if (project.isDisposed) return@run
                val modules = ModuleManager.getInstance(project).modules.map { IdeaModuleRoots(it) }
                val added = WorktreeExclusion.excludeInProject(
                    projectUrl, modules, SystemInfo.isFileSystemCaseSensitive,
                ) { message, cause -> log.warn(message, cause) }
                log.info("Excluded ${WorktreeExclusion.FOLDER_NAME} from $added of ${modules.size} module(s) of ${project.name}")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.warn("Could not exclude ${WorktreeExclusion.FOLDER_NAME} for project ${project.name}", e)
        }
    }
}
