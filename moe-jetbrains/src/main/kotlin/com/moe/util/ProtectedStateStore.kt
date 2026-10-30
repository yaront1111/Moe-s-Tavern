package com.moe.util

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.diagnostic.Logger
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.AclEntry
import java.nio.file.attribute.AclEntryPermission
import java.nio.file.attribute.AclEntryType
import java.nio.file.attribute.AclFileAttributeView
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileAttribute
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.PosixFilePermissions
import java.util.EnumSet

/**
 * Owner-only files for protected-profile state that has to outlive the IDE session yet must never live in
 * the repository, where any change could rewrite it. CQ-RF01 keeps daemon spawn provenance here, and the
 * CQ-RF02 persistent downgrade pin reuses this store rather than adding a second one.
 *
 * Only the IDE writes these files, so a read trusts nothing the IDE would not have written. The root and the
 * file must be owner-only: exactly rwx------ and rw-------, or an ACL whose every entry allows the owner. The
 * file must be a regular file reached without a link, at most [MAX_BYTES], and named by a sha-256 hex, so no
 * name is ever a path taken from input. Every failure throws; callers fall back to what they do without a store.
 */
class ProtectedStateStore internal constructor(val root: Path) {

    /** False for a root inside the project, such as a runIde sandbox under the repository it opens. */
    fun usableFor(basePath: String): Boolean = RuntimeSelectionPolicy.isOutsideProject(root.toString(), basePath)

    /**
     * The text stored under [name], or null only for a missing root below a directory or no file in an owner-only root.
     * Throws [Untrusted] for state the IDE would not have written.
     */
    fun read(name: String): String? {
        val file = fileFor(name)
        // Windows calls a lookup through a regular file missing, so an unchecked root could make a broken store read as empty.
        if (!present(root)) {
            requireDirectoryAbove(root)
            return null
        }
        requireOwnerOnly(root, directory = true)
        if (!present(file)) return null
        requireOwnerOnly(file, directory = false)
        // Opened without following links too, so a link swapped in after the checks is refused as well.
        val bytes = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS).use { it.readNBytes(MAX_BYTES + 1) }
        if (bytes.size > MAX_BYTES) throw Untrusted("a protected state file is larger than 64 KiB")
        return String(bytes, Charsets.UTF_8)
    }

    private fun present(path: Path): Boolean = try {
        Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        true
    } catch (_: NoSuchFileException) {
        false
    }

    private fun requireDirectoryAbove(path: Path) {
        val parent = generateSequence(path.parent) { it.parent }.firstOrNull(::present) ?: return
        // The IDE system directory may be behind a link; only the state root itself must be link-free.
        if (!Files.isDirectory(parent)) throw Untrusted("the protected state root is not under a directory")
    }

    /** Atomically replaces [name] with [text], creating the root; the new file is owner-only before any byte is written. */
    fun write(name: String, text: String) {
        val target = fileFor(name)
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_BYTES) throw Untrusted("protected state is larger than 64 KiB")
        Files.createDirectories(root, *ownerOnlyAttribute(DIRECTORY_MODE))
        restrict(root, directory = true)
        val temp = Files.createTempFile(root, "state-", ".tmp", *ownerOnlyAttribute(FILE_MODE))
        try {
            restrict(temp, directory = false)
            Files.write(temp, bytes)
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (ex: Exception) {
            try {
                Files.deleteIfExists(temp)
            } catch (cleanup: IOException) {
                ex.addSuppressed(cleanup)
            }
            throw ex
        }
    }

    fun delete(name: String) {
        Files.deleteIfExists(fileFor(name))
    }

    private fun fileFor(name: String): Path {
        require(NAME.matches(name)) { "a protected state file name must be 64 lowercase hex digits and .json" }
        return root.resolve(name)
    }

    private fun requireOwnerOnly(path: Path, directory: Boolean) {
        requireKind(path, directory)
        if (!isOwnerOnly(path, directory)) throw Untrusted("protected state is accessible to more than its owner")
    }

    // Read without following links: a link (or, on Windows, a junction) where the root or a file belongs is refused.
    private fun requireKind(path: Path, directory: Boolean) {
        val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (directory && (!attributes.isDirectory || attributes.isOther)) throw Untrusted("the protected state root is not a directory")
        if (!directory && !attributes.isRegularFile) throw Untrusted("a protected state file is not a regular file")
    }

    // Set explicitly, since the umask and inherited ACL entries say nothing, then confirmed: a host that keeps
    // other entries gets no file at all rather than a weaker one.
    private fun restrict(path: Path, directory: Boolean) {
        requireKind(path, directory)
        val posix = posixView(path)
        if (posix != null) {
            posix.setPermissions(if (directory) DIRECTORY_MODE else FILE_MODE)
        } else {
            val view = aclView(path)
            val owner = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(view.owner)
                .setPermissions(EnumSet.allOf(AclEntryPermission::class.java)).build()
            view.acl = listOf(owner)
        }
        if (!isOwnerOnly(path, directory)) throw Untrusted("protected state stayed accessible to more than its owner")
    }

    // POSIX: exactly rwx------ or rw-------. ACL: at least one entry, and every entry an ALLOW for the owner.
    private fun isOwnerOnly(path: Path, directory: Boolean): Boolean {
        posixView(path)?.let { return it.readAttributes().permissions() == if (directory) DIRECTORY_MODE else FILE_MODE }
        val view = aclView(path)
        val owner = view.owner
        val acl = view.acl
        return acl.isNotEmpty() && acl.all { it.type() == AclEntryType.ALLOW && it.principal() == owner }
    }

    private fun posixView(path: Path): PosixFileAttributeView? =
        Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)

    private fun aclView(path: Path): AclFileAttributeView =
        Files.getFileAttributeView(path, AclFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
            ?: throw Untrusted("this file system cannot keep protected state owner-only")

    private fun ownerOnlyAttribute(mode: Set<PosixFilePermission>): Array<FileAttribute<*>> =
        if ("posix" in root.fileSystem.supportedFileAttributeViews()) arrayOf(PosixFilePermissions.asFileAttribute(mode)) else emptyArray()

    /** State the IDE would not have written as it is; the message names the broken rule, never the contents. */
    class Untrusted(message: String) : IOException(message)

    companion object {
        internal const val MAX_BYTES = 64 * 1024
        private val NAME = Regex("[0-9a-f]{64}\\.json")
        private val DIRECTORY_MODE: Set<PosixFilePermission> = PosixFilePermissions.fromString("rwx------")
        private val FILE_MODE: Set<PosixFilePermission> = PosixFilePermissions.fromString("rw-------")
        private val log = Logger.getInstance(ProtectedStateStore::class.java)

        /** The store under the IDE system directory; null without a running IDE (plain JUnit) or when it cannot be named. */
        fun forIde(): ProtectedStateStore? = try {
            if (ApplicationManager.getApplication() == null) {
                null
            } else {
                ProtectedStateStore(Paths.get(PathManager.getSystemPath(), "moe", "protected-state"))
            }
        } catch (ex: Exception) {
            log.warn("Moe protected state cannot be persisted: ${ex.message}")
            null
        }
    }
}
