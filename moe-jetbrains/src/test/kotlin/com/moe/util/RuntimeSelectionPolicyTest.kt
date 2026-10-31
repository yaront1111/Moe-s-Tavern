package com.moe.util

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.project.Project as IdeaProject
import com.moe.model.DaemonInfo
import com.moe.model.MoeState
import com.moe.services.MoeDaemonSupervisor
import com.moe.services.MoeProjectService
import com.moe.services.MoeStateListener
import com.moe.util.RuntimeSelectionPolicy.ProcessFacts
import com.moe.util.RuntimeSelectionPolicy.SpawnRecord
import com.moe.util.TerminalAgentLauncher.ProtectedAgentRuntime
import com.moe.util.TerminalAgentLauncher.ResolvedScript
import com.moe.util.TerminalAgentLauncher.ScriptKind
import com.moe.util.TerminalAgentLauncher.ScriptSource
import com.sun.jna.Memory
import com.sun.jna.platform.win32.Kernel32
import com.sun.jna.platform.win32.WinBase
import com.sun.jna.platform.win32.WinNT
import com.sun.jna.platform.win32.WinioctlUtil
import com.sun.jna.ptr.IntByReference
import org.junit.After
import org.junit.AssumptionViolatedException
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOError
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Proxy
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.AclEntry
import java.nio.file.attribute.AclEntryPermission
import java.nio.file.attribute.AclEntryType
import java.nio.file.attribute.AclFileAttributeView
import java.nio.file.attribute.PosixFileAttributeView
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.time.Instant
import java.util.HexFormat
import java.util.Optional
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RuntimeSelectionPolicyTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Before
    fun resetBefore() = RuntimeSelectionPolicy.resetForTest()

    @After
    fun resetAfter() = RuntimeSelectionPolicy.resetForTest()

    @Test
    fun `D1 a downgrade needs confirmation across restarts and stays pinned until the next restart`() = withProfileStore { store, dir, asks ->
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        assertEquals(valid, store.read(name))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(store.root.toString(), dir.path))
        assertOwnerOnly(store.root.resolve(name), directory = false)
        RuntimeSelectionPolicy.remember(dir.path, SpawnRecord(100, T0, true, daemonKey(installedDaemon())), LIVE::get)
        assertEquals("separate profile and provenance records", 2, storeFiles(store).size)
        assertTrue(asks.paths.isEmpty())
        writeProfile(dir, "legacy")
        RuntimeSelectionPolicy.forgetSessionForTest()
        val calls = (1..8).map { CompletableFuture.supplyAsync { profileOf(dir) } }
        calls.forEach { assertEquals(RuntimeProfile.PROTECTED, it.get(5, TimeUnit.SECONDS)) }
        assertEquals(listOf(dir.path), asks.paths)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        RuntimeSelectionPolicy.forgetSessionForTest() // No answer is a dismissal.
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(2, asks.paths.size)
        asks.answers.last()(false)
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(3, asks.paths.size)
        assertEquals(valid, store.read(name))
        asks.answers.last()(true)
        assertEquals(profileJson(dir, "legacy"), store.read(name))
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.LEGACY, profileOf(dir))
        assertEquals(3, asks.paths.size)
        listOf("""{"settings":{"executionProfile":"observe"}}""", """{"settings":{}}""", null).forEach { weaker ->
            val other = project("""{"settings":{"executionProfile":"verified-local"}}""")
            assertEquals(RuntimeProfile.PROTECTED, profileOf(other))
            if (weaker == null) assertTrue(File(other, ".moe/project.json").delete()) else writeProjectJson(other, weaker)
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.PROTECTED, profileOf(other))
            assertEquals(other.path, asks.paths.last())
        }
        assertEquals(6, asks.paths.size)
    }

    @Test
    fun `D6 a delayed reader honors a concurrent session pin after confirmation`() = withProfileStore { store, dir, asks ->
        store.write(RuntimeSelectionPolicy.profileRecordName(dir.path), profileJson(dir, "protected"))
        writeProfile(dir, "legacy")
        val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        RuntimeSelectionPolicy.store = {
            if (entered.count > 0) { entered.countDown(); assertTrue(resume.await(5, TimeUnit.SECONDS)) }
            store
        }
        val delayed = CompletableFuture.supplyAsync { profileOf(dir) }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            asks.answers.single()(true)
        } finally { resume.countDown() }
        assertEquals(RuntimeProfile.PROTECTED, delayed.get(5, TimeUnit.SECONDS))
    }
    @Test
    fun `D2 upgrades need no confirmation and unavailable stores preserve session-only behavior`() = withProfileStore { store, dir, asks ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        store.write(name, profileJson(dir, "legacy"))
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(profileJson(dir, "protected"), store.read(name))
        val fresh = project("""{"settings":{"executionProfile":"legacy"}}""")
        assertEquals(RuntimeProfile.LEGACY, profileOf(fresh))
        assertNull(store.read(RuntimeSelectionPolicy.profileRecordName(fresh.path)))
        listOf(null, ProtectedStateStore(File(dir, "state").toPath())).forEach { unavailable ->
            RuntimeSelectionPolicy.store = { unavailable }
            RuntimeSelectionPolicy.forgetSessionForTest()
            writeProfile(dir, "verified-local")
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            writeProfile(dir, "legacy")
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.LEGACY, profileOf(dir))
            assertFalse(File(dir, "state").exists())
        }
        assertTrue(asks.paths.isEmpty())
    }

    @Test
    fun `D9 a protected pin survives a restart on which no drive mapping can be read`() = withProfileStore { store, dir, asks ->
        assumeTrue("Windows drive mappings", RuntimeSelectionPolicy.windowsHost)
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        writeProfile(dir, "legacy")
        val fresh = project("""{"settings":{"executionProfile":"legacy"}}""")
        listOf<(String) -> String?>({ null }, { throw UnsatisfiedLinkError("jnidispatch") }).forEachIndexed { i, unreadable ->
            withDriveTargets(unreadable) {
                // Unprovable is not absent: a store this host cannot place is never written, yet its pin still holds.
                assertFalse("$i", store.usableFor(dir.path))
                RuntimeSelectionPolicy.forgetSessionForTest()
                assertEquals("$i", RuntimeProfile.PROTECTED, profileOf(dir))
                assertEquals("$i", List(i + 1) { dir.path }, asks.paths)
                asks.answers.last()(true)
                assertEquals("$i", profileJson(dir, "protected"), store.read(name))
                assertEquals("$i", RuntimeProfile.LEGACY, profileOf(fresh))
            }
        }
        assertEquals("a fresh legacy project is never asked", 2, asks.paths.size)
        // Either side is enough: a store, or a project, behind a drive whose mapping cannot be read still keeps its pin.
        withSubst(dir.parentFile) { d ->
            val native = RuntimeSelectionPolicy.windowsDriveTarget
            listOf(dir.path to ProtectedStateStore(Paths.get("$d\\stores")), "$d\\${dir.name}" to store).forEach { (base, side) ->
                RuntimeSelectionPolicy.store = { side }
                RuntimeSelectionPolicy.forgetSessionForTest()
                writeProfile(dir, "verified-local")
                assertEquals(base, RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
                writeProfile(dir, "legacy")
                withDriveTargets({ if (it == d) null else native(it) }) {
                    RuntimeSelectionPolicy.forgetSessionForTest()
                    assertEquals(base, RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
                    assertEquals(base, base, asks.paths.last())
                }
            }
        }
    }

    @Test
    fun `D10 a protected pin survives a restart on which a junction leads the store or the project onto a drive no mapping can place`() = withProfileStore { _, dir, asks ->
        assumeTrue("Windows drive mappings", RuntimeSelectionPolicy.windowsHost)
        val stores = temporaryFolder.newFolder("stores")
        val link = File(temporaryFolder.root, "system-link")
        assertTrue("a junction to $stores", junction(link.toPath(), stores.toPath()))
        val far = File(stores, "proj").also { writeProfile(it, "verified-local") }
        temporaryFolder.newFolder("state")
        val fresh = project("""{"settings":{"executionProfile":"legacy"}}""")
        val physical = realFile(stores).path.substring(0, 2).uppercase()
        val native = RuntimeSelectionPolicy.windowsDriveTarget
        // y's root IS the junction, so toRealPath keeps y: and only drive expansion reaches the junction.
        withSubst(temporaryFolder.root) { z -> withSubst(link) { y ->
            val near = "$z\\${dir.name}"
            val cases = listOf(
                Triple("store through a junction", near, ProtectedStateStore(Paths.get("$z\\system-link\\moe\\protected-state"))),
                Triple("store on a drive rooted at a junction", near, ProtectedStateStore(Paths.get("$y\\moe\\protected-state"))),
                Triple("project on a drive rooted at a junction", "$y\\proj", ProtectedStateStore(Paths.get("$z\\state\\moe\\protected-state"))))
            cases.forEach { (label, base, store) ->
                RuntimeSelectionPolicy.store = { store }
                RuntimeSelectionPolicy.forgetSessionForTest()
                assertEquals(label, RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
                assertTrue(label, store.usableFor(base))
                assertEquals(label, profileJson(File(base), "protected"), store.read(RuntimeSelectionPolicy.profileRecordName(base)))
            }
            val sandbox = ProtectedStateStore(Paths.get("$near\\build\\idea-sandbox\\system\\moe\\protected-state"))
            sandbox.write(RuntimeSelectionPolicy.profileRecordName(near), profileJson(File(near), "protected"))
            writeProfile(dir, "legacy")
            writeProfile(far, "legacy")
            listOf<(String) -> String?>({ "\\Device\\ImDisk0" }, { null }, { throw IllegalStateException("native") },
                { throw UnsatisfiedLinkError("jnidispatch") }).forEachIndexed { i, unplaceable ->
                // z stands for a drive the lookup places, physical for one it cannot; y expands through z to the folder it names natively.
                withDriveTargets({
                    when (it) { z -> "\\Device\\HarddiskVolume1"; y -> "\\??\\$z\\system-link"; physical -> unplaceable(it); else -> native(it) }
                }) {
                    cases.forEach { (label, base, store) ->
                        val name = RuntimeSelectionPolicy.profileRecordName(base)
                        assertFalse("$label $i", store.usableFor(base))
                        RuntimeSelectionPolicy.store = { store }
                        RuntimeSelectionPolicy.forgetSessionForTest()
                        val asked = asks.paths.size
                        assertEquals("$label $i", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
                        assertEquals("$label $i", listOf(base), asks.paths.drop(asked))
                        asks.answers.last()(true)
                        assertEquals("$label $i", profileJson(File(base), "protected"), store.read(name))
                        assertEquals("$label $i", listOf(name), storeFiles(store))
                    }
                    RuntimeSelectionPolicy.store = { cases[0].third }
                    assertEquals("fresh $i", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile("$z\\${fresh.name}"))
                    // On a placed drive a sandbox under the project is provably inside it (D2): its record is never read.
                    RuntimeSelectionPolicy.store = { sandbox }
                    RuntimeSelectionPolicy.forgetSessionForTest()
                    assertEquals("sandbox $i", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile(near))
                }
            }
            assertEquals("a fresh legacy project and a sandbox store are never asked", 12, asks.paths.size)
        } }
    }

    @Test
    fun `D11 a protected pin survives a restart on which the store is spelled without a drive`() = withProfileStore { store, dir, asks ->
        assumeTrue("Windows drive mappings", RuntimeSelectionPolicy.windowsHost)
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        val device = volumeSpelling(store.root.toFile()) ?: throw AssumptionViolatedException("mountvol names the volume")
        val deviceStore = ProtectedStateStore(Paths.get(device))
        writeProfile(dir, "legacy")
        assertFalse(device, deviceStore.usableFor(dir.path))
        RuntimeSelectionPolicy.store = { deviceStore }
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(device, RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(listOf(dir.path), asks.paths)
        asks.answers.last()(true)
        assertEquals(profileJson(dir, "protected"), store.read(name))
        assertEquals(listOf(name), storeFiles(store))
        assertEquals("a fresh legacy project", RuntimeProfile.LEGACY, profileOf(project("""{"settings":{"executionProfile":"legacy"}}""")))
        assertEquals(1, asks.paths.size)
    }

    @Test
    fun `D12 a protected pin survives a restart on which the store or the project has no real path`() = withProfileStore { store, dir, asks ->
        assumeTrue("Windows drive mappings", RuntimeSelectionPolicy.windowsHost)
        val lockedStore = temporaryFolder.newFolder("locked-store")
        val lockedProject = temporaryFolder.newFolder("locked-project")
        val proj = File(lockedProject, "proj").also { writeProfile(it, "legacy") }
        writeProfile(dir, "legacy")
        listOf(
            "store below an unlistable folder" to Triple(lockedStore, dir.path, ProtectedStateStore(lockedStore.toPath().resolve("moe/protected-state"))),
            // The real spelling: with no real path projectKey falls back to the spelling, which must still name the record.
            "project below an unlistable folder" to Triple(lockedProject, realFile(proj).path, store)
        ).forEach { (shape, fixture) ->
            val (locked, base, side) = fixture
            val name = RuntimeSelectionPolicy.profileRecordName(base)
            val record = profileJson(File(base), "protected")
            side.write(name, record)
            RuntimeSelectionPolicy.store = { side }
            withUnlistable(locked) {
                assertFalse(shape, side.usableFor(base))
                RuntimeSelectionPolicy.forgetSessionForTest()
                assertEquals(shape, RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
                assertEquals(shape, base, asks.paths.last())
                asks.answers.last()(true)
                assertEquals(shape, record, side.read(name))
                assertEquals(shape, listOf(name), storeFiles(side))
            }
        }
        assertEquals("one ask per case", 2, asks.paths.size)
    }

    @Test
    fun `D7 on Windows a protected record stored under the local spelling also pins its subst and device spellings`() = withProfileStore { store, dir, asks ->
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        assertEquals(profileJson(dir, "protected"), store.read(name))
        writeProfile(dir, "legacy")
        val stranger = project("""{"settings":{"executionProfile":"legacy"}}""")
        val twin = File(temporaryFolder.newFolder(), dir.name).also { writeProfile(it, "legacy") }
        withSubst(dir) { root -> withSubst(dir.parentFile) { parent ->
            // The volume GUID spelling is the local, no-network stand-in for a share base.
            val aliases = listOfNotNull("$root\\", "$parent\\${dir.name}", volumeSpelling(dir))
            aliases.forEach { alias ->
                RuntimeSelectionPolicy.forgetSessionForTest()
                assertEquals(alias, RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(alias))
                assertEquals(alias, asks.paths.last())
            }
            assertEquals("a stranger", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile("$parent\\${stranger.name}"))
            assertEquals("a same-named twin", RuntimeProfile.LEGACY, profileOf(twin))
            assertEquals(aliases, asks.paths)
            asks.answers.last()(true)
            assertEquals("a downgrade through an alias", profileJson(dir, "legacy"), store.read(name))
            RuntimeSelectionPolicy.forgetSessionForTest()
            (aliases + dir.path).forEach { assertEquals(it, RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile(it)) }
            assertEquals("no new ask", aliases.size, asks.paths.size)
        } }
    }

    @Test
    fun `D8 another spelling matches only a protected, plain, same-named record of the same folder, and only on Windows`() = withProfileStore { store, _, asks ->
        val base = File(temporaryFolder.newFolder("b"), "proj").also { writeProfile(it, "legacy") }
        // Stands in for the folder a share or mapped spelling of base reaches.
        val local = File(temporaryFolder.newFolder("a"), "proj").also { writeProfile(it, "legacy") }
        val elsewhere = File(temporaryFolder.newFolder("c"), "other").also { writeProfile(it, "legacy") }
        val localName = recordName(key(local))
        assertEquals(RuntimeSelectionPolicy.profileRecordName(local.path), localName)
        val asked = CopyOnWriteArrayList<Path>()
        var identity: (Path) -> Boolean = { it == Paths.get(key(local)) }
        RuntimeSelectionPolicy.sameDirectory = { stored, _ -> asked.add(stored); identity(stored) }
        store.write(localName, profileJson(local, "legacy"))
        store.write(NAME_A, profileJson(local, "protected"))
        store.write(recordName(key(elsewhere)), profileJson(elsewhere, "protected"))
        listOf("//srv/sh/proj", "volume{00000000-0000-0000-0000-000000000000}/b/proj").forEach {
            store.write(recordName(it), Gson().toJson(linkedMapOf("version" to 1, "project" to it, "profile" to "protected")))
        }
        assertEquals(RuntimeProfile.LEGACY, profileOf(base))
        assertEquals("nothing was opened, no share was touched", emptyList<Path>(), asked)
        store.write(localName, profileJson(local, "protected"))
        RuntimeSelectionPolicy.forgetSessionForTest()
        if (!RuntimeSelectionPolicy.windowsHost) {
            assertEquals(RuntimeProfile.LEGACY, profileOf(base))
            assertEquals(emptyList<Path>(), asked)
            assertTrue(asks.paths.isEmpty())
            return@withProfileStore
        }
        assertEquals(RuntimeProfile.PROTECTED, profileOf(base))
        assertEquals(listOf(Paths.get(key(local))), asked)
        assertEquals(listOf(base.path), asks.paths)
        asks.answers.single()(true)
        assertEquals(profileJson(local, "legacy"), store.read(localName))
        assertEquals(profileJson(base, "legacy"), store.read(RuntimeSelectionPolicy.profileRecordName(base.path)))
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.LEGACY, profileOf(base))
        store.write(localName, profileJson(local, "protected"))
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals("a legacy record does not hide another spelling's", RuntimeProfile.PROTECTED, profileOf(base))
        assertEquals(2, asks.paths.size)
        listOf(IOException("gone"), IllegalStateException("native"), IOError(null)).forEach { failure ->
            identity = { throw failure }
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals("$failure", RuntimeProfile.LEGACY, profileOf(base))
        }
        // The profile read skips a store inside the project, so only the lookup lists this regular-file root.
        val unlistable = File(base, "state").apply { writeText("not a directory") }
        RuntimeSelectionPolicy.store = { ProtectedStateStore(unlistable.toPath()) }
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals("an unlistable store", RuntimeProfile.LEGACY, profileOf(base))
        assertEquals("no new ask", 2, asks.paths.size)
    }

    @Test
    fun `D3 untrusted profile documents fail closed and explicit confirmation repairs them`() = withProfileStore { store, dir, asks ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        writeProfile(dir, "legacy")
        val bad = listOf("not JSON", valid.replace("\"version\":", "version:"), "\uFEFF$valid", "[]",
            valid.replace("\"version\":1", "\"version\":1,\"extra\":true"), valid.replace("\"version\":1,", ""),
            valid.replace("\"version\":1", "\"version\":2"), valid.replace("\"version\":1", "\"version\":\"1\""),
            valid.replace("\"version\":1", "\"version\":1.0"), profileJson(temporaryFolder.newFolder(), "protected"),
            valid.replace("\"protected\"", "\"verified-local\""), valid.replace("\"protected\"", "\"PROTECTED\""),
            valid.replace("\"protected\"", "null"))
        bad.forEachIndexed { index, text ->
            store.write(name, text)
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals("case $index", RuntimeProfile.PROTECTED, profileOf(dir))
            assertEquals(index + 1, asks.paths.size)
            if (index == 0) {
                asks.answers.last()(true)
                assertEquals(profileJson(dir, "legacy"), store.read(name))
                assertOwnerOnly(store.root.resolve(name), directory = false)
                RuntimeSelectionPolicy.forgetSessionForTest()
                assertEquals(RuntimeProfile.LEGACY, profileOf(dir))
            }
        }
    }

    @Test
    fun `D3 a directory or loosened profile record fails closed`() = withProfileStore { store, dir, asks ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        store.write(name, valid)
        writeProfile(dir, "legacy")
        val file = store.root.resolve(name)
        Files.delete(file)
        Files.createDirectory(file)
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(listOf(dir.path), asks.paths)
        Files.delete(file)
        store.write(name, valid)
        try {
            assumeTrue("no permission view or Everyone principal", loosen(file, directory = false))
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            assertEquals(2, asks.paths.size)
        } finally {
            store.write(name, valid) // Atomic replacement restores owner-only access, even after an assertion fails.
        }
    }

    @Test
    fun `D4 confirmer failures do not downgrade and only the first answer counts`() = withProfileStore { store, dir, _ ->
        val name = RuntimeSelectionPolicy.profileRecordName(dir.path)
        val valid = profileJson(dir, "protected")
        writeProfile(dir, "legacy")
        listOf<Boolean?>(null, true, false).forEach { first ->
            store.write(name, valid)
            RuntimeSelectionPolicy.forgetSessionForTest()
            RuntimeSelectionPolicy.confirmer = DowngradeConfirmer { _, answer ->
                if (first == null) throw IllegalStateException("confirmer unavailable")
                answer(first)
                answer(!first)
            }
            assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
            assertEquals(profileJson(dir, if (first == true) "legacy" else "protected"), store.read(name))
        }
    }

    @Test
    fun `D4 store failures and malformed project reads never escape`() = withProfileStore { store, dir, asks ->
        writeProjectJson(dir, "{")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertTrue(storeFiles(store).isEmpty())
        assertTrue(asks.paths.isEmpty())
        writeProfile(dir, "legacy")
        assertEquals("malformed read did not pin", RuntimeProfile.LEGACY, profileOf(dir))
        Files.createDirectories(store.root.parent)
        Files.writeString(store.root, "not a directory")
        writeProfile(dir, "verified-local")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        writeProfile(dir, "legacy")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertTrue(asks.paths.isEmpty())
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
        assertEquals(listOf(dir.path), asks.paths)
        asks.answers.single()(true) // Failed persistence never escapes the answer callback either.
        assertEquals("not a directory", Files.readString(store.root))
    }

    @Test
    fun `D5 only Allow Downgrade confirms and a missing application declines without UI`() {
        listOf(-1, 0, 1, 2).forEach { assertEquals(it == 1, ProfileDowngradeDialog.confirmed(it)) }
        val answers = mutableListOf<Boolean>()
        ProfileDowngradeDialog.ask("/project") { answers += it }
        assertEquals(listOf(false), answers)
    }

    private class RecordingConfirmer : DowngradeConfirmer {
        val paths = CopyOnWriteArrayList<String>()
        val answers = CopyOnWriteArrayList<(Boolean) -> Unit>()
        override fun ask(basePath: String, answer: (Boolean) -> Unit) { paths += basePath; answers += answer }
    }

    private fun withProfileStore(test: (ProtectedStateStore, File, RecordingConfirmer) -> Unit) {
        try {
            val store = useStore()
            val asks = RecordingConfirmer().also { RuntimeSelectionPolicy.confirmer = it }
            test(store, project("""{"settings":{"executionProfile":"verified-local"}}"""), asks)
        } finally {
            RuntimeSelectionPolicy.resetForTest()
        }
    }

    private fun writeProfile(dir: File, value: String) = writeProjectJson(dir, """{"settings":{"executionProfile":"$value"}}""")

    private fun profileJson(dir: File, value: String): String = Gson().toJson(linkedMapOf(
        "version" to 1, "project" to comparable(realFile(dir).path, RuntimeSelectionPolicy.defaultFoldCase), "profile" to value))

    /** How a profile record keys [dir]: its comparable real path. */
    private fun key(dir: File): String = comparable(realFile(dir).path, RuntimeSelectionPolicy.defaultFoldCase)

    /** The file a profile record for [key] is stored under, computed independently of the policy. */
    private fun recordName(key: String): String =
        HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest("profile:$key".toByteArray(Charsets.UTF_8))) + ".json"

    @Test
    fun `P1 absent, legacy and observe settings keep the legacy selection`() {
        assertEquals("no .moe", RuntimeProfile.LEGACY, profileOf(temporaryFolder.newFolder()))
        val noFile = temporaryFolder.newFolder().also { File(it, ".moe").mkdirs() }
        assertEquals("no project.json", RuntimeProfile.LEGACY, profileOf(noFile))
        mapOf(
            "empty object" to "{}",
            "empty settings" to """{"settings":{}}""",
            "legacy" to """{"settings":{"executionProfile":"legacy"}}""",
            "observe" to """{"settings":{"executionProfile":"observe"}}""",
            "exactly 1 MiB" to padded("""{"settings":{"executionProfile":"legacy"}}""", MIB)
        ).forEach { (label, json) -> assertEquals(label, RuntimeProfile.LEGACY, profileOf(project(json))) }
        assertEquals("blank basePath", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile(""))
        assertEquals("whitespace basePath", RuntimeProfile.LEGACY, RuntimeSelectionPolicy.profile("  "))
    }

    @Test
    fun `P2 every other setting and every untrusted file fail closed to protected`() {
        listOf(
            "\"verified-local\"", "null", "\"\"", "\"Verified-Local\"", "\"bogus\"", "\" legacy\"",
            "0", "true", "[\"legacy\"]", "{}"
        ).forEach { value ->
            val json = """{"settings":{"executionProfile":$value}}"""
            assertEquals(value, RuntimeProfile.PROTECTED, profileOf(project(json)))
        }
        mapOf(
            "settings null" to """{"settings":null}""",
            "settings string" to """{"settings":"legacy"}""",
            "settings array" to """{"settings":[]}""",
            "root array" to "[]",
            "root string" to "\"legacy\"",
            "empty file" to "",
            "truncated" to """{"settings":""",
            "lenient" to "{settings:{executionProfile:'legacy'}}",
            "comment" to """{"settings":{}} // legacy""",
            "trailing content" to """{"settings":{}} x""",
            "second document" to """{"settings":{}} {}""",
            "byte order mark" to "﻿{\"settings\":{}}",
            "duplicate key, verified-local last" to
                """{"settings":{"executionProfile":"legacy","executionProfile":"verified-local"}}""",
            "over 1 MiB" to padded("""{"settings":{}}""", MIB + 1)
        ).forEach { (label, json) -> assertEquals(label, RuntimeProfile.PROTECTED, profileOf(project(json))) }
        val directory = temporaryFolder.newFolder().also { File(it, ".moe/project.json").mkdirs() }
        assertEquals("project.json is a directory", RuntimeProfile.PROTECTED, profileOf(directory))
    }

    @Test
    fun `P2 a dangling project json link fails closed`() {
        val dir = temporaryFolder.newFolder()
        val link = File(dir, ".moe").apply { mkdirs() }.toPath().resolve("project.json")
        assumeTrue("links unavailable on this host", symlink(link, dir.toPath().resolve("missing.json")))

        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))
    }

    @Test
    fun `P3 an explicit verified-local read pins protected selection for the session`() {
        val dir = project("""{"settings":{"executionProfile":"verified-local"}}""")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(dir))

        writeProjectJson(dir, """{"settings":{"executionProfile":"legacy"}}""")
        assertEquals("rewritten to legacy", RuntimeProfile.PROTECTED, profileOf(dir))
        assertTrue(File(dir, ".moe/project.json").delete())
        assertEquals("file deleted", RuntimeProfile.PROTECTED, profileOf(dir))
        File(dir, "sub").mkdirs()
        val dotDot = listOf(dir.path, "sub", "..").joinToString(File.separator)
        assertEquals("sub/.. alias", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(dotDot))
        assertEquals("trailing separator", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(dir.path + File.separator))
        val other = project("""{"settings":{"executionProfile":"legacy"}}""")
        assertEquals("another project", RuntimeProfile.LEGACY, profileOf(other))
        val alias = File(temporaryFolder.root, "alias").toPath()
        assumeTrue("links unavailable on this host", symlink(alias, dir.toPath()))
        assertEquals("link alias", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(alias.toString()))
    }

    @Test
    fun `P4 a fail-closed read never pins`() {
        val malformed = project("""{"settings":""")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(malformed))
        writeProjectJson(malformed, """{"settings":{"executionProfile":"legacy"}}""")
        assertEquals("malformed then legacy", RuntimeProfile.LEGACY, profileOf(malformed))

        val unknown = project("""{"settings":{"executionProfile":"bogus"}}""")
        assertEquals(RuntimeProfile.PROTECTED, profileOf(unknown))
        writeProjectJson(unknown, """{"settings":{"executionProfile":"observe"}}""")
        assertEquals("unknown then observe", RuntimeProfile.LEGACY, profileOf(unknown))
    }

    @Test
    fun `N1 comparablePath normalizes Windows, UNC and POSIX forms`() {
        assertEquals("c:/users/me/proj", RuntimeSelectionPolicy.comparablePath("C:\\Users\\Me\\Proj\\", true))
        assertEquals("c:/users/me/proj", RuntimeSelectionPolicy.comparablePath("\\\\?\\C:\\Users\\Me\\Proj", true))
        assertEquals("//server/share/p", RuntimeSelectionPolicy.comparablePath("\\\\?\\UNC\\server\\share\\p", false))
        assertEquals("//server/share/p", RuntimeSelectionPolicy.comparablePath("\\\\?\\unc\\server\\share\\p", false))
        assertEquals("c:/users/me", RuntimeSelectionPolicy.comparablePath("\\\\.\\C:\\Users\\Me", true))
        assertEquals("//server/share", RuntimeSelectionPolicy.comparablePath("\\\\.\\UNC\\server\\share", false))
        assertEquals("//server/share", RuntimeSelectionPolicy.comparablePath("\\\\server\\share\\", false))
        assertEquals("c:/", RuntimeSelectionPolicy.comparablePath("C:\\", true))
        assertEquals("C:/Users", RuntimeSelectionPolicy.comparablePath("C:\\Users", false))
        assertEquals("/A/b", RuntimeSelectionPolicy.comparablePath("/A/b/", false))
        assertEquals("/", RuntimeSelectionPolicy.comparablePath("/", false))
        // NTFS equates dotless i (U+0131) with I, so folding upper-cases before lower-casing.
        assertEquals("c:/prij", RuntimeSelectionPolicy.comparablePath("C:\\Pr\u0131j", true))
    }

    @Test
    fun `N2 isWithin compares whole path segments`() {
        assertTrue(RuntimeSelectionPolicy.isWithin("/w/proj", "/w/proj"))
        assertTrue(RuntimeSelectionPolicy.isWithin("/w/proj/a/b", "/w/proj"))
        assertFalse(RuntimeSelectionPolicy.isWithin("/w/proj-evil", "/w/proj"))
        assertFalse(RuntimeSelectionPolicy.isWithin("/w/pro", "/w/proj"))
        assertTrue(RuntimeSelectionPolicy.isWithin("/etc", "/"))
        assertTrue(RuntimeSelectionPolicy.isWithin("c:/users", "c:/"))
        assertTrue(RuntimeSelectionPolicy.isWithin("//server/share/p", "//server/share"))
        assertFalse(RuntimeSelectionPolicy.isWithin("//server/shared", "//server/share"))
        val child = "C:\\Users\\ME\\Proj\\x"
        val parent = "c:\\users\\me\\proj"
        assertTrue(RuntimeSelectionPolicy.isWithin(comparable(child, true), comparable(parent, true)))
        assertFalse(RuntimeSelectionPolicy.isWithin(comparable(child, false), comparable(parent, false)))
    }

    @Test
    fun `N3 installedArtifact accepts only real files inside the root and outside the project`() {
        val project = temporaryFolder.newFolder("project")
        val root = installedLayout(temporaryFolder.newFolder("installed"))

        assertEquals(
            RuntimeSelection.Accepted(realFile(File(root, "daemon/index.js"))),
            RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", project.path)
        )
        File(temporaryFolder.root, "outside.js").writeText("outside")
        val sandbox = installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains"))
        val missingProject = File(temporaryFolder.root, "gone").path
        mapOf(
            "missing file" to listOf(root, "daemon/missing.js", project.path, "installed daemon/missing.js not found"),
            "directory" to listOf(root, "daemon", project.path, "installed daemon is not a regular file"),
            "null root" to listOf(null, "daemon/index.js", project.path, "installed Moe runtime not found"),
            "missing root" to listOf(File(temporaryFolder.root, "nowhere"), "daemon/index.js", project.path, "installed Moe runtime not found"),
            "root inside the project" to listOf(sandbox, "daemon/index.js", project.path, "installed daemon/index.js resolves inside the project"),
            "dot-dot escape" to listOf(root, "../outside.js", project.path, "installed ../outside.js resolves outside the installed Moe runtime"),
            "missing project" to listOf(root, "daemon/index.js", missingProject, "the project directory cannot be resolved")
        ).forEach { (label, row) ->
            val selection = RuntimeSelectionPolicy.installedArtifact(row[0] as File?, row[1] as String, row[2] as String)
            assertEquals(label, row[3], assertRejected(label, selection))
        }
        // Headless, the plugin is not loaded: the root is null or an existing directory, never a throw.
        RuntimeSelectionPolicy.installedRoot()?.let { assertTrue("installed root $it", it.isDirectory) }
    }

    @Test
    fun `N3 links into the project are rejected wherever they sit`() {
        val project = temporaryFolder.newFolder("project")
        val planted = installedLayout(File(project, "planted"))
        val root = temporaryFolder.newFolder("installed")
        assumeTrue("links unavailable on this host", symlink(File(root, "daemon").toPath(), File(planted, "daemon").toPath()))
        assertEquals(
            "installed daemon/index.js resolves outside the installed Moe runtime",
            assertRejected("link under the root", RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", project.path))
        )

        val linkedRoot = File(temporaryFolder.newFolder("plugins"), "moe-jetbrains")
        assumeTrue("links unavailable on this host", symlink(linkedRoot.toPath(), planted.toPath()))
        assertEquals(
            "installed daemon/index.js resolves inside the project",
            assertRejected("root linked into the project", RuntimeSelectionPolicy.installedArtifact(linkedRoot, "daemon/index.js", project.path))
        )
    }

    @Test
    fun `N4 installedExecutable requires an absolute regular file outside the project`() {
        val project = temporaryFolder.newFolder("project")
        val inProject = File(project, "node").apply { writeText("node") }
        val outside = File(temporaryFolder.newFolder("runtime"), "node").apply { writeText("node") }
        listOf(
            null to "node executable not found",
            "" to "node executable not found",
            "  " to "node executable not found",
            "node" to "node executable is not an absolute path",
            "./node" to "node executable is not an absolute path",
            temporaryFolder.root.path to "node executable is not a regular file",
            inProject.path to "node executable resolves inside the project",
            File(project, "absent").path to "node executable not found"
        ).forEach { (path, reason) ->
            assertEquals("node $path", reason, assertRejected("node $path", RuntimeSelectionPolicy.installedExecutable(path, project.path)))
        }

        assertEquals(RuntimeSelection.Accepted(realFile(outside)), RuntimeSelectionPolicy.installedExecutable(outside.path, project.path))
        val linkedDir = File(temporaryFolder.root, "linked-runtime")
        assumeTrue("links unavailable on this host", symlink(linkedDir.toPath(), project.toPath()))
        val linked = RuntimeSelectionPolicy.installedExecutable(File(linkedDir, "node").path, project.path)
        assertEquals("node executable resolves inside the project", assertRejected("node through a link into the project", linked))
    }

    @Test
    fun `N5 on Windows only drive-qualified forms are plainly local`() {
        listOf(
            "\\\\srv\\sh\\x", "//srv/sh/x", "\\\\?\\UNC\\srv\\sh\\x", "\\\\.\\UNC\\srv\\sh\\x", "\\\\localhost\\C$\\proj",
            "\\\\127.0.0.1\\C$\\proj", "\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\proj",
            "\\\\.\\GLOBALROOT\\Device\\Mup\\localhost\\C$\\proj", "C:", "\\proj", "proj"
        ).forEach { assertFalse(it, RuntimeSelectionPolicy.isPlainLocalPath(it, windows = true)) }
        listOf("C:\\proj", "c:/proj", "C:\\", "\\\\?\\C:\\proj", "\\\\.\\C:\\proj")
            .forEach { assertTrue(it, RuntimeSelectionPolicy.isPlainLocalPath(it, windows = true)) }
        listOf("//srv/sh/x", "\\\\srv\\sh\\x", "/w/proj")
            .forEach { assertTrue("POSIX $it", RuntimeSelectionPolicy.isPlainLocalPath(it, windows = false)) }
    }

    @Test
    fun `N6 on Windows a UNC or device path is never provably outside the project and never looked up`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val project = temporaryFolder.newFolder("project")
        val outside = temporaryFolder.newFolder("outside")
        // An Error, so isOutsideProject's error handling cannot swallow it: any lookup fails the test.
        val untouched: (String) -> Path? = { throw AssertionError("looked up $it") }
        // The outside folder through the loopback share is refused too: the accepted cost.
        (nonLocalSpellings(project) + share("localhost", outside)).forEach { spelling ->
            assertFalse("$spelling without a lookup", RuntimeSelectionPolicy.isOutsideProject(spelling, project.path, resolve = untouched))
            assertFalse(spelling, RuntimeSelectionPolicy.isOutsideProject(spelling, project.path))
        }
        // A plain spelling whose real path is UNC; Paths.get of a UNC string does no I/O.
        listOf(share("localhost", outside), "\\\\srv\\sh\\outside").forEach { real ->
            assertFalse("real path $real", RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, resolve = { Paths.get(real) }))
        }
        // Controls: the same folder, plainly spelled and resolved locally, is outside.
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, resolve = { Paths.get(it).toRealPath() }))
    }

    @Test
    fun `N7 legacy PATH keeps alias forms but still enforces containment and lookup failures`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val project = temporaryFolder.newFolder("project")
        val outside = temporaryFolder.newFolder("outside")
        val legacy = RuntimeProfile.LEGACY
        val alias = share("localhost", outside)
        // Inject paths, not SMB lookups: both the spelling and real-path branches must preserve legacy.
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(alias, project.path, legacy, resolve = { Paths.get(it) }))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, legacy, resolve = { Paths.get(alias) }))
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(project.path, project.path, legacy, resolve = { outside.toPath() }))
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, legacy, resolve = { project.toPath() }))
        assertFalse(RuntimeSelectionPolicy.isOutsideProject("relative", project.path, legacy, resolve = { outside.toPath() }))
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, legacy, resolve = { throw IOException("denied") }))
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, legacy, resolve = { throw java.io.IOError(IOException("denied")) }))
    }

    @Test
    fun `N8 on Windows a subst drive that reaches the project is inside it by file identity`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val work = temporaryFolder.newFolder("work")
        val project = File(work, "proj").apply { File(this, "bin").mkdirs() }
        File(work, "other").mkdirs()
        val outsideA = temporaryFolder.newFolder("path-a")
        // Controls: plain spellings keep their answers, so each refusal below comes from identity alone.
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outsideA.path, project.path))
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(project.path, project.path))
        withSubst(project) { d ->
            listOf("$d\\", "$d\\bin", "$d\\missing").forEach { assertFalse(it, RuntimeSelectionPolicy.isOutsideProject(it, project.path)) }
        }
        val gone = withSubst(work) { d ->
            listOf("$d\\proj", "$d\\proj\\bin").forEach { assertFalse(it, RuntimeSelectionPolicy.isOutsideProject(it, project.path)) }
            assertTrue("an unrelated folder on the same drive", RuntimeSelectionPolicy.isOutsideProject("$d\\other", project.path))
            assertFalse("a project opened through the drive", RuntimeSelectionPolicy.isOutsideProject(File(project, "bin").path, "$d\\proj"))
            val env = mutableMapOf("PATH" to listOf(outsideA.path, "$d\\proj", "$d\\proj\\bin", "$d\\other").joinToString(File.pathSeparator))
            supervisorFor(project, { null }, { null }).protectedDaemonEnvironment(env, project.path)
            assertEquals(mapOf("PATH" to listOf(outsideA.path, "$d\\other").joinToString(File.pathSeparator)), env)
            d
        }
        // A drive that no longer exists proves nothing, so a later subst cannot turn a kept entry into the project.
        assertFalse("$gone\\bin on a removed drive", RuntimeSelectionPolicy.isOutsideProject("$gone\\bin", project.path))
    }

    @Test
    fun `N9 on Windows a subst drive rooted below the project, directly or through a junction, is inside it`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        val bin = File(project, "bin").apply { mkdirs() }
        File(bin, "node").writeText("planted")
        installedLayout(File(bin, "plugin"))
        val link = File(temporaryFolder.newFolder("links"), "bin-link")
        assertTrue("a junction outside the project to its bin", junction(link.toPath(), bin.toPath()))
        val outsideA = temporaryFolder.newFolder("path-a").path
        val reason = "node executable resolves inside the project"
        val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
        listOf("descendant root" to bin, "junction root" to link).forEach { (shape, target) ->
            withSubst(target) { d ->
                listOf("$d\\", "$d\\missing\\leaf").forEach { assertFalse("$shape $it", RuntimeSelectionPolicy.isOutsideProject(it, project.path)) }
                assertEquals(shape, reason, assertRejected("$shape node", RuntimeSelectionPolicy.installedExecutable("$d\\node", project.path)))
                assertEquals(shape, "installed daemon/index.js resolves inside the project", assertRejected("$shape root",
                    RuntimeSelectionPolicy.installedArtifact(File("$d\\plugin"), "daemon/index.js", project.path)))
                val started = mutableListOf<List<String>>()
                val statuses = mutableListOf<Pair<Boolean, String>>()
                val supervisor = supervisorFor(project, { root }, { "$d\\node" }, started = started, statuses = statuses)
                val env = mutableMapOf("PATH" to listOf(outsideA, "$d\\").joinToString(File.pathSeparator))
                supervisor.protectedDaemonEnvironment(env, project.path)
                assertEquals(shape, mapOf("PATH" to outsideA), env)
                assertFalse(shape, supervisor.ensureDaemonRunning())
                assertEquals(shape, emptyList<List<String>>(), started)
                assertEquals(shape, listOf(false to message), statuses)
            }
        }
        // The reverse: a project opened through a drive is proved, not merely refused: it owns its files, not an outside node.
        withSubst(project.parentFile) { d ->
            assertEquals(reason, assertRejected("project via $d", RuntimeSelectionPolicy.installedExecutable(File(bin, "node").path, "$d\\${project.name}")))
            assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, "$d\\${project.name}"))
        }
        // Controls: an ordinary local file and a store root not created yet, both outside, stay usable.
        assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, project.path))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(node.path, project.path))
        assertTrue("a missing store root outside the project", newStore().usableFor(project.path))
    }

    @Test
    fun `N10 drive expansion follows only current local mappings, within bounds`() {
        val maps = mutableMapOf("C:" to "\\Device\\HarddiskVolume3", "D:" to "\\Device\\CdRom0", "E:" to "\\Device\\Floppy1",
            "F:" to "\\Device\\Ramdisk", "P:" to "\\??\\C:\\work\\proj\\bin", "W:" to "\\??\\C:\\work", "Y:" to "\\??\\W:\\proj", "R:" to "\\??\\c:\\")
        val asked = mutableListOf<String>()
        fun expand(path: String): String? = run { asked.clear(); RuntimeSelectionPolicy.resolveWindowsDrivePath(path) { asked += it; maps[it] } }
        mapOf("C:\\x\\y" to "C:\\x\\y", "c:/x/y" to "c:\\x\\y", "D:\\a" to "D:\\a", "E:\\a" to "E:\\a", "F:\\a" to "F:\\a",
            "P:\\" to "C:\\work\\proj\\bin\\", "p:\\node" to "C:\\work\\proj\\bin\\node", "W:\\proj\\bin" to "C:\\work\\proj\\bin",
            "W:\\other" to "C:\\work\\other", "R:\\x" to "c:\\x", "y:\\bin" to "C:\\work\\proj\\bin"
        ).forEach { (path, expanded) -> assertEquals(path, expanded, expand(path)) }
        assertEquals("a chain asks each drive once", listOf("Y:", "W:", "C:"), asked)
        listOf("\\\\srv\\sh\\x", "//srv/sh/x", "Z:", "Z:x", "\\x", "x", "C:\\" + "a".repeat(32765)).forEach {
            assertNull(it.take(20), expand(it))
            assertEquals("${it.take(20)} is never looked up", emptyList<String>(), asked)
        }
        // Remote, unknown, malformed and missing mappings are unprovable: nothing is inferred from a \Device prefix.
        listOf("\\Device\\LanmanRedirector\\;Z:0000000000012345\\srv\\sh", "\\Device\\Mup\\srv\\sh", "\\??\\UNC\\srv\\sh",
            "\\Device\\WebDavRedirector\\srv\\DavWWWRoot", "\\Device\\HarddiskVolume1\\dir", "\\Device\\HarddiskVolumeShadowCopy1",
            "\\Device\\HarddiskVolume", "\\Device\\ImDisk0", "\\??\\Volume{00000000-0000-0000-0000-000000000000}\\", "\\??\\C:\\a\\..\\b",
            "\\??\\C:\\dot.\\b", "\\??\\C:\\a\\\\b", "\\??\\C:x", "C:\\work", "", "\\??\\C:\\" + "a".repeat(32763)
        ).forEach { mapping ->
            maps["Z:"] = mapping
            assertNull(mapping.take(60), expand("Z:\\x"))
        }
        maps.remove("Z:")
        assertNull("no mapping", expand("Z:\\x"))
        // Depth is no limit of its own: a deep mapping is checked segment by segment, and only the expansion's length is capped.
        val deep = "\\??\\C:\\" + "a b.c\\".repeat(4000) + "last"
        maps["Z:"] = deep
        assertEquals("C:\\" + "a b.c\\".repeat(4000) + "last\\x", expand("Z:\\x"))
        val malformed = listOf("$deep.", "$deep ", "$deep\\\\x", deep + Char(31), "\\\\?\\" + deep.substring(4)) + "/:*?\"<>|".map { deep + it }
        malformed.forEach { maps["Z:"] = it; assertNull(it.take(4) + it.takeLast(2), expand("Z:\\x")) }
        maps["Z:"] = "\\??\\C:" + "\\a".repeat(16380)
        val longest = "C:" + "\\a".repeat(16380) + "\\xxxx"
        assertEquals(32767, longest.length)
        assertEquals(longest, expand("Z:\\xxxx"))
        assertNull("one character past the longest path", expand("Z:\\xxxxx"))
        maps += mapOf("A:" to "\\??\\B:\\x", "B:" to "\\??\\a:\\y", "S:" to "\\??\\S:\\x")
        assertNull(expand("A:\\z"))
        assertEquals("a cycle stops at its first repeated drive", listOf("A:", "B:"), asked)
        assertNull(expand("S:\\z"))
        assertEquals(listOf("S:"), asked)
        maps.clear()
        ('A'..'Z').forEach { maps["$it:"] = "\\??\\${if (it == 'Z') 'A' else it + 1}:\\$it" }
        assertNull(expand("A:\\z"))
        assertEquals("26 queries at most", 26, asked.size)
        listOf(IllegalStateException("native"), UnsatisfiedLinkError("jnidispatch"), java.io.IOError(IOException("device"))).forEach { failure ->
            assertNull("$failure", RuntimeSelectionPolicy.resolveWindowsDrivePath("C:\\x") { throw failure })
        }
        // QueryDosDevice's buffer: the first NUL-terminated string within the count is the current mapping, later ones are history.
        fun current(text: String, count: Int = text.length) = RuntimeSelectionPolicy.currentDosMapping(text.toCharArray(), count)
        val history = "\\Device\\LanmanRedirector\\;Z:0\\srv\\sh\u0000\\??\\C:\\proj\u0000\u0000"
        assertEquals("\\??\\C:\\x", current("\\??\\C:\\x\u0000\u0000"))
        assertEquals("\\Device\\LanmanRedirector\\;Z:0\\srv\\sh", current(history))
        assertNull(RuntimeSelectionPolicy.resolveWindowsDrivePath("Z:\\x") { if (it == "Z:") current(history) else "\\Device\\HarddiskVolume3" })
        listOf(current("\\??\\C:\\x\u0000", 8), current("x\u0000", 3), current("x\u0000", 0), current("x\u0000", -1), current("\u0000\u0000"))
            .forEach { assertNull(it) }
        // On Windows the SDK's JNA answers in plain JUnit: the system drive is a local volume.
        System.getenv("SystemRoot")?.takeIf { RuntimeSelectionPolicy.windowsHost }?.let { assertEquals(it, RuntimeSelectionPolicy.resolveWindowsDrivePath(it)) }
    }

    @Test
    fun `N11 on Windows a drive mapping that cannot be proved local refuses before any lookup and never falls back`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        val native = RuntimeSelectionPolicy.windowsDriveTarget
        // An Error, so isOutsideProject's error handling cannot swallow it: any lookup fails the test.
        val untouched: (String) -> Path? = { throw AssertionError("looked up $it") }
        fun assertSpawnRefused(label: String, nodePath: String, reason: String) {
            val started = mutableListOf<List<String>>()
            val statuses = mutableListOf<Pair<Boolean, String>>()
            assertFalse(label, supervisorFor(project, { root }, { nodePath }, started = started, statuses = statuses).ensureDaemonRunning())
            assertEquals(label, emptyList<List<String>>(), started)
            val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
            assertEquals(label, listOf(false to message), statuses)
        }
        // A share, a device family nothing proves local, a native library that does not load: nothing on the drive is
        // opened, and nothing falls back to the ancestor walk, which the controls show accepting these paths.
        listOf<(String) -> String?>({ "\\Device\\LanmanRedirector\\;${it}0\\srv\\sh" }, { "\\Device\\ImDisk0" },
            { throw UnsatisfiedLinkError("jnidispatch") }).forEachIndexed { i, provider ->
            withDriveTargets(provider) {
                assertFalse("$i node", RuntimeSelectionPolicy.isOutsideProject(node.path, project.path, resolve = untouched))
                assertEquals("$i", "node executable is not a plain local Windows path",
                    assertRejected("$i node", RuntimeSelectionPolicy.installedExecutable(node.path, project.path)))
                assertSpawnRefused("$i", node.path, "installed daemon/index.js is not a plain local Windows path")
            }
        }
        // One remote letter: a node or a project on it is refused unopened, while the native drive still selects.
        val remote = ('Z' downTo 'D').map { "$it:" }.first { !realFile(node).path.startsWith(it, ignoreCase = true) }
        withDriveTargets({ if (it == remote) "\\Device\\LanmanRedirector\\;${it}0\\srv\\sh" else native(it) }) {
            assertFalse("remote PATH entry", RuntimeSelectionPolicy.isOutsideProject("$remote\\bin", project.path, resolve = untouched))
            assertSpawnRefused("remote node", "$remote\\node", "node executable is not a plain local Windows path")
            assertFalse("remote project", RuntimeSelectionPolicy.isOutsideProject(node.path, "$remote\\proj", resolve = untouched))
            // task-52fb6178: a project base whose drive cannot be proved local is not a plain local base.
            assertEquals(BASE_NOT_PLAIN, assertRejected("remote project", RuntimeSelectionPolicy.installedExecutable(node.path, "$remote\\proj")))
            assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, project.path))
        }
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(node.path, project.path))
    }

    @Test
    fun `N12 legacy selection, and protected selection off Windows, never asks for a drive mapping`() {
        val (project, root, node) = protectedFixture()
        val outside = node.parentFile.path
        val asked = mutableListOf<String>()
        val profiles = if (RuntimeSelectionPolicy.windowsHost) listOf(RuntimeProfile.LEGACY) else RuntimeProfile.entries
        withDriveTargets({ asked += it; throw UnsatisfiedLinkError("jnidispatch") }) {
            profiles.forEach { profile ->
                val supervisor = supervisorFor(project, { root }, { node.path }, profile = { profile })
                val stop = listOf(realFile(node).path, realFile(File(root, "daemon/index.js")).path, "stop", "--project", project.path)
                assertEquals("$profile stop", stop, supervisor.stopCommandOrNull(project.path))
                val env = mutableMapOf("PATH" to listOf(outside, project.path).joinToString(File.pathSeparator))
                supervisor.protectedDaemonEnvironment(env, project.path, profile)
                assertEquals("$profile PATH", mapOf("PATH" to outside), env)
            }
        }
        assertEquals(emptyList<String>(), asked)
    }

    @Test
    fun `N13 on Windows no segment of a plainly local path ends in a dot or a space`() {
        listOf(
            "C:\\x\\project.", "C:\\x\\project.\\bin", "C:\\x\\project ", "C:\\x\\project \\bin", "C:\\x\\..\\proj", "C:\\x\\.\\proj",
            "C:\\x\\...", "\\\\?\\C:\\x\\project.", "c:/x/project./bin"
        ).forEach { assertFalse(it, RuntimeSelectionPolicy.isPlainLocalPath(it, windows = true)) }
        listOf("C:\\x\\project.d\\bin", "C:\\x\\.hidden\\bin", "C:\\x\\a b\\c", "C:\\x\\v1.2.3")
            .forEach { assertTrue(it, RuntimeSelectionPolicy.isPlainLocalPath(it, windows = true)) }
        listOf("/w/project.", "/w/x/../y").forEach { assertTrue("POSIX $it", RuntimeSelectionPolicy.isPlainLocalPath(it, windows = false)) }
    }

    @Test
    fun `N14 on Windows nothing is provably outside a project base that is not plainly local`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val project = temporaryFolder.newFolder("project")
        val bin = File(project, "bin").apply { mkdirs() }
        val outside = temporaryFolder.newFolder("outside")
        val store = ProtectedStateStore(temporaryFolder.root.toPath().resolve("system/moe/protected-state"))
        // An Error, so isOutsideProject's error handling cannot swallow it: any lookup fails the test.
        val untouched: (String) -> Path? = { throw AssertionError("looked up $it") }
        val volumeBase = volumeSpelling(project)
        withDriveTargets({ throw AssertionError("drive mapping of $it") }) {
            nonLocalBases(project).forEach { base ->
                listOf(project.path, bin.path, File(project, "missing").path, outside.path).forEach { path ->
                    assertFalse("$path, $base, no lookup", RuntimeSelectionPolicy.isOutsideProject(path, base, resolve = untouched))
                    assertFalse("$path, $base", RuntimeSelectionPolicy.isOutsideProject(path, base))
                }
                // The accepted cost: such a base persists nothing new, so a verified-local pin, daemon provenance and a
                // confirmed downgrade all stay session-only. A PROTECTED pin stored earlier is still read (unprovable is not absent).
                assertFalse(base, store.usableFor(base))
            }
            // Legacy never asks for a drive mapping, and keeps a device base.
            if (volumeBase != null) assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, volumeBase, RuntimeProfile.LEGACY))
        }
        // A real path with a dot segment: Win32 reads `nodejs.` as `nodejs`, so identity alone would keep it.
        val dotted = outside.toPath().resolve("nodejs.").resolve("bin")
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path, resolve = { dotted }))
        // A PROTECTED pin stored earlier holds after every restart: a legacy declaration asks for the downgrade again each
        // time, and even an allowed one writes nothing. The dot aliases key as the project itself, so theirs is the project's own pin.
        val asks = RecordingConfirmer().also { RuntimeSelectionPolicy.confirmer = it }
        RuntimeSelectionPolicy.store = { store }
        writeProfile(project, "legacy")
        val real = realFile(project).path
        assertEquals(RuntimeSelectionPolicy.profileRecordName(project.path), RuntimeSelectionPolicy.profileRecordName("$real."))
        (listOf("$real\\..\\${project.name}", "$real\\.", "$real.") + listOfNotNull(volumeBase)).forEach { base ->
            val name = RuntimeSelectionPolicy.profileRecordName(base)
            val pin = profileJson(File(base), "protected").also { store.write(name, it) }
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(base, RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
            assertEquals(base, base, asks.paths.last())
            asks.answers.last()(true)
            assertEquals(base, pin, store.read(name))
        }
        // Controls: the plain base proves both answers, and its store is usable.
        assertFalse(RuntimeSelectionPolicy.isOutsideProject(bin.path, project.path))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(outside.path, project.path))
        assertTrue(store.usableFor(project.path))
    }

    @Test
    fun `N15 on Windows a missing PATH leaf answers as its nearest existing ancestor`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val work = temporaryFolder.newFolder("work")
        val project = File(work, "proj")
        val sub = File(project, "sub").apply { mkdirs() }
        val (outside, home, mapped) = listOf("outside", "home", "mapped").map { File(work, it).apply { mkdirs() } }
        val (toSub, link, dangling, toHome) = listOf("to-sub", "link", "dangling", "to-home").map { File(outside, it) }
        val later = File(project, "later").apply { mkdirs() }
        assumeTrue("a junction to the project's sub folder", junction(toSub.toPath(), sub.toPath()))
        assumeTrue("a link to the project", symlink(link.toPath(), project.toPath()))
        assumeTrue("a junction into the project, left dangling", junction(dangling.toPath(), later.toPath()) && later.delete())
        assumeTrue("a junction to an outside folder", junction(toHome.toPath(), home.toPath()))
        // cmd's %~sI gives the 8.3 spelling, and needs no quoting while the path has no space.
        val short = if (' ' in work.path) null else try {
            val process = ProcessBuilder("cmd", "/d", "/c", "for", "%I", "in", "(${work.path})", "do", "@echo", "%~sI")
                .redirectErrorStream(true).start()
            String(process.inputStream.readBytes()).trim().takeIf { process.waitFor() == 0 && it != work.path }
        } catch (_: Exception) {
            null
        }
        if (short == null) println("N15 leaves its 8.3 entries out: $work has a space or no short spelling")
        val shortDirs = { name: String -> listOfNotNull(short?.let { "$it\\$name" }) }
        val leaf = { dir: String -> if (dir.endsWith("\\")) "${dir}later" else "$dir\\later" }
        val outsideOf = { entry: String -> RuntimeSelectionPolicy.isOutsideProject(entry, project.path) }
        // A mapped network drive without a network: an existing outside folder whose real path is the project's admin share.
        val shared = Paths.get(share("localhost", project))
        val resolve = { p: String -> if (p == mapped.path) shared else runCatching { Paths.get(p).toRealPath() }.getOrNull() }
        val viaShare = "${leaf(mapped.path)} through its share"
        withSubst(sub) { s -> withSubst(outside) { t ->
            val inside = listOf("$toSub\\later\\bin", leaf(link.path), dangling.path, "$dangling\\bin") +
                shortDirs("proj").map(leaf) + leaf("$s\\")
            val kept = listOf(leaf(outside.path), leaf(toHome.path)) + shortDirs("outside").map(leaf) + leaf("$t\\")
            assertEquals("each entry's answer", inside.associateWith { false } + kept.associateWith { true } + (viaShare to false),
                (inside + kept).associateWith(outsideOf) +
                    (viaShare to RuntimeSelectionPolicy.isOutsideProject(leaf(mapped.path), project.path, resolve = resolve)))
            // Every missing leaf answers exactly as the existing folder it would be created in.
            val ancestors = listOf(toSub.path, link.path, dangling.path, "$s\\", outside.path, toHome.path, "$t\\") +
                shortDirs("proj") + shortDirs("outside")
            assertEquals("each leaf answers as its ancestor", ancestors.associateWith(outsideOf), ancestors.associateWith { outsideOf(leaf(it)) })
            val env = mutableMapOf("PATH" to (inside + kept).joinToString(File.pathSeparator))
            supervisorFor(project, { null }, { null }).protectedDaemonEnvironment(env, project.path)
            assertEquals("protected PATH keeps exactly the outside entries", mapOf("PATH" to kept.joinToString(File.pathSeparator)), env)
        } }
        assertTrue("the mapped stand-in's leaf by the default lookup", outsideOf(leaf(mapped.path)))
        assertTrue("LEGACY", RuntimeSelectionPolicy.isOutsideProject("$toSub\\later\\bin", project.path, RuntimeProfile.LEGACY))
    }

    @Test
    fun `V1 a recorded supervisor verifies its daemon, which stays verified after the supervisor exits`() {
        val dir = temporaryFolder.newFolder("a").path
        val live = mutableMapOf(100L to ProcessFacts(100, T0, 1), 200L to ProcessFacts(200, T1, 100))
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true), live::get)
        assertNull("child of the recorded supervisor", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get))
        live.remove(100L)
        assertNull("supervisor gone", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get))
    }

    @Test
    fun `V2 reused pids, missing facts, unrelated processes and other projects are refused`() {
        val dir = temporaryFolder.newFolder("a").path
        val other = temporaryFolder.newFolder("b").path
        listOf(dir to 100L, dir to 300L, dir to 600L, dir to 800L, other to 400L).forEach { (project, pid) ->
            RuntimeSelectionPolicy.remember(project, SpawnRecord(pid, T0, supervisor = true)) { ProcessFacts(it, T0, 1) }
        }
        // 800 is pruned while its pid is gone, so it never verifies again.
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(801, T0, supervisor = true)) { if (it == 800L) null else ProcessFacts(it, T0, 1) }
        val live = mapOf(
            100L to ProcessFacts(100, T0, 1),
            300L to ProcessFacts(300, T1, 1), // pid 300 now belongs to a later process
            301L to ProcessFacts(301, null, 100), // no start instant
            303L to ProcessFacts(303, T1, 999), 999L to ProcessFacts(999, T0, 1), // an unrelated parent
            400L to ProcessFacts(400, T0, 1), // recorded for another project
            500L to ProcessFacts(500, T1, 600), 600L to ProcessFacts(600, T1, 1), // the parent's pid was reused
            800L to ProcessFacts(800, T0, 1),
            200L to ProcessFacts(200, T1, 100), 700L to ProcessFacts(700, T1, 200) // 700 is a child of the daemon 200
        )
        mapOf(
            "reused pid" to 300L, "no start" to 301L, "unknown pid" to 302L, "unrelated process" to 303L,
            "another project" to 400L, "reused parent pid" to 500L, "pruned record" to 800L
        ).forEach { (label, pid) -> assertEquals(label, refusal(pid), RuntimeSelectionPolicy.verifyProvenance(dir, pid, live::get)) }
        assertNull("daemon of a recorded supervisor", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get))
        assertEquals("a daemon's own child", refusal(700), RuntimeSelectionPolicy.verifyProvenance(dir, 700, live::get))
        val self = ProcessHandle.current().pid()
        assertEquals("the IDE's own pid", refusal(self), RuntimeSelectionPolicy.verifyProvenance(dir, self))
    }

    @Test
    fun `V3 a real spawn record verifies only for its own project`() {
        val a = temporaryFolder.newFolder("a").path
        val b = temporaryFolder.newFolder("b").path
        val self = ProcessHandle.current()
        RuntimeSelectionPolicy.recordProtectedSpawn(a, self)
        assertNull(RuntimeSelectionPolicy.verifyProvenance(a, self.pid()))
        assertEquals(refusal(self.pid()), RuntimeSelectionPolicy.verifyProvenance(b, self.pid()))
        // `sort` waits on stdin on every OS: a live child of the recorded process verifies through its parent.
        val child = ProcessBuilder("sort").start()
        try {
            assertNull("child of a recorded process", RuntimeSelectionPolicy.verifyProvenance(a, child.pid()))
            assertEquals(refusal(child.pid()), RuntimeSelectionPolicy.verifyProvenance(b, child.pid()))
        } finally {
            child.destroyForcibly().waitFor()
        }

        // A handle without a start instant is not recorded; one whose info fails never throws.
        val noStart = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ProcessHandle.Info::class.java)) { _, _, _ ->
            Optional.empty<Any>()
        } as ProcessHandle.Info
        RuntimeSelectionPolicy.recordProtectedSpawn(b, fakeHandle(42) { noStart })
        RuntimeSelectionPolicy.recordProtectedSpawn(b, fakeHandle(43) { throw UnsupportedOperationException("info") })
        listOf(T0, Instant.EPOCH).forEach { start ->
            assertEquals("start $start", refusal(42), RuntimeSelectionPolicy.verifyProvenance(b, 42, facts = { ProcessFacts(42, start, null) }))
        }
        RuntimeSelectionPolicy.resetForTest()
        assertEquals("after reset", refusal(self.pid()), RuntimeSelectionPolicy.verifyProvenance(a, self.pid()))
    }

    @Test
    fun `PS1 a state write leaves the root and the file owner-only and reads back`() {
        val store = newStore()
        store.write(NAME_A, """{"version":1}""")
        assertOwnerOnly(store.root, directory = true)
        assertOwnerOnly(store.root.resolve(NAME_A), directory = false)
        assertEquals("""{"version":1}""", store.read(NAME_A))

        store.write(NAME_A, "replaced")
        assertEquals("replaced", store.read(NAME_A))
        assertOwnerOnly(store.root.resolve(NAME_A), directory = false)
        assertEquals("no temporary file is left behind", listOf(NAME_A), store.root.toFile().list()?.toList())
        store.delete(NAME_A)
        assertNull("deleted", store.read(NAME_A))
        store.delete(NAME_A)
    }

    @Test
    fun `PS2 a loosened state file or root reads as untrusted until the next write`() {
        listOf(false, true).forEach { loosenRoot ->
            val store = newStore().apply { write(NAME_A, "text") }
            val target = if (loosenRoot) store.root else store.root.resolve(NAME_A)
            assumeTrue("cannot grant another principal access on this host", loosen(target, directory = loosenRoot))
            assertThrows("root=$loosenRoot", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_A) }
            store.write(NAME_A, "rewritten")
            assertEquals("root=$loosenRoot rewritten", "rewritten", store.read(NAME_A))
            assertOwnerOnly(store.root, directory = true)
        }
    }

    @Test
    fun `PS3 absent, oversize, linked and badly named state files`() {
        val store = newStore()
        assertNull("no root yet", store.read(NAME_A))
        store.write(NAME_B, "other")
        assertNull("absent file", store.read(NAME_A))
        val cap = ProtectedStateStore.MAX_BYTES
        store.write(NAME_A, "x".repeat(cap))
        assertEquals("exactly the cap", cap, store.read(NAME_A)?.length)
        Files.write(store.root.resolve(NAME_A), byteArrayOf(' '.code.toByte()), StandardOpenOption.APPEND)
        assertThrows("one byte over the cap", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_A) }
        assertThrows("a write over the cap", ProtectedStateStore.Untrusted::class.java) { store.write(NAME_B, "x".repeat(cap + 1)) }
        assertEquals("a refused write keeps the old bytes", "other", store.read(NAME_B))

        val hex = "a".repeat(64)
        listOf("", "x.json", "../$NAME_A", "sub/$NAME_A", File.separator + NAME_A, hex, "A".repeat(64) + ".json", "a".repeat(63) + ".json", "$NAME_A.tmp")
            .forEach { bad ->
                assertThrows("read '$bad'", IllegalArgumentException::class.java) { store.read(bad) }
                assertThrows("write '$bad'", IllegalArgumentException::class.java) { store.write(bad, "x") }
                assertThrows("delete '$bad'", IllegalArgumentException::class.java) { store.delete(bad) }
            }
        assertEquals("bad names wrote nothing", listOf(NAME_A, NAME_B), store.root.toFile().list()?.sorted())

        // An owner-only file the IDE wrote elsewhere is still refused through a link, as is a linked root.
        val elsewhere = newStore().apply { write(NAME_C, "elsewhere") }
        assumeTrue("links unavailable on this host", symlink(store.root.resolve(NAME_C), elsewhere.root.resolve(NAME_C)))
        assertThrows("linked file", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_C) }
        val linkedRoot = ProtectedStateStore(temporaryFolder.root.toPath().resolve("linked-root"))
        assumeTrue("links unavailable on this host", symlink(linkedRoot.root, elsewhere.root))
        assertThrows("linked root read", ProtectedStateStore.Untrusted::class.java) { linkedRoot.read(NAME_C) }
        assertThrows("linked root write", ProtectedStateStore.Untrusted::class.java) { linkedRoot.write(NAME_C, "planted") }
        assertEquals("elsewhere", elsewhere.read(NAME_C))
    }

    @Test
    fun `PS4 a state root inside the project is not usable for it`() {
        val project = temporaryFolder.newFolder("project")
        val sandbox = ProtectedStateStore(File(project, "build/idea-sandbox/system/moe/protected-state").toPath())
        assertFalse("sandbox under the project", sandbox.usableFor(project.path))
        assertFalse("the project itself", ProtectedStateStore(project.toPath()).usableFor(project.path))
        val outside = ProtectedStateStore(temporaryFolder.root.toPath().resolve("system/moe/protected-state"))
        assertTrue("outside the project", outside.usableFor(project.path))
    }

    @Test
    fun `PS5 plain JUnit has no IDE state store`() {
        assertNull(ProtectedStateStore.forIde())
    }

    @Test
    fun `PS6 absence requires a directory above the state root`() {
        val store = newStore()
        assertNull("fresh root below a directory", store.read(NAME_A))
        Files.createDirectories(store.root.parent)
        Files.writeString(store.root, "not a directory")
        assertThrows("regular-file root", ProtectedStateStore.Untrusted::class.java) { store.read(NAME_A) }
        assertEquals("read leaves the root unchanged", "not a directory", Files.readString(store.root))

        val blockedParent = newStore()
        Files.writeString(blockedParent.root.parent, "not a directory")
        // Windows throws Untrusted; POSIX throws the lookup's own 'Not a directory' FileSystemException.
        assertThrows("regular-file parent", IOException::class.java) { blockedParent.read(NAME_A) }
    }

    @Test
    fun `PS7 absence requires an owner-only link-free root but permits linked parents`() {
        val loosened = newStore().apply { write(NAME_B, "other") }
        assumeTrue("cannot grant another principal access on this host", loosen(loosened.root, directory = true))
        assertThrows("absent file under a loosened root", ProtectedStateStore.Untrusted::class.java) { loosened.read(NAME_A) }

        val elsewhere = newStore().apply { write(NAME_B, "other") }
        val linkedRoot = ProtectedStateStore(temporaryFolder.root.toPath().resolve("linked-root"))
        assumeTrue("links unavailable on this host", symlink(linkedRoot.root, elsewhere.root))
        assertThrows("absent file under a linked root", ProtectedStateStore.Untrusted::class.java) { linkedRoot.read(NAME_A) }

        val system = temporaryFolder.root.toPath().resolve("linked-system")
        assumeTrue("links unavailable on this host", symlink(system, temporaryFolder.newFolder().toPath()))
        val linkedParent = ProtectedStateStore(system.resolve("moe/protected-state"))
        assertNull("fresh root below a linked directory", linkedParent.read(NAME_A))
        linkedParent.write(NAME_A, "round trip")
        assertEquals("round trip", linkedParent.read(NAME_A))
    }

    @Test
    fun `PS8 names lists only valid record names, sorted, under the read rules`() {
        val store = newStore()
        assertEquals("no root yet", emptyList<String>(), store.names())
        assertFalse("listing never creates the root", Files.exists(store.root, LinkOption.NOFOLLOW_LINKS))
        store.write(NAME_B, "b")
        store.write(NAME_A, "a")
        // NAME_C is never written, so its upper-case form cannot fold onto a valid file on Windows.
        listOf("notes.txt", "state-1.tmp", NAME_C.uppercase()).forEach { Files.writeString(store.root.resolve(it), "stray") }
        assertEquals(listOf(NAME_A, NAME_B), store.names())
        val file = temporaryFolder.newFile("not-a-root").toPath()
        assertThrows("regular-file root", ProtectedStateStore.Untrusted::class.java) { ProtectedStateStore(file).names() }
        assumeTrue("cannot grant another principal access on this host", loosen(store.root, directory = true))
        assertThrows("loosened root", ProtectedStateStore.Untrusted::class.java) { store.names() }
    }

    @Test
    fun `PP1 a persisted supervisor verifies its daemon after a restart, which then stays verified without it`() {
        val store = useStore()
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        val live = mutableMapOf(100L to ProcessFacts(100, T0, 1), 200L to ProcessFacts(200, T1, 100))
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon)), live::get)
        assertEquals("the supervisor is persisted", listOf(100L), storedPids(store))
        RuntimeSelectionPolicy.forgetSessionForTest()

        assertNull("child after a restart", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get, daemon))
        assertEquals("the child is persisted", listOf(100L, 200L), storedPids(store))
        RuntimeSelectionPolicy.forgetSessionForTest()
        live.remove(100L)
        assertNull("supervisor gone", RuntimeSelectionPolicy.verifyProvenance(dir, 200, live::get, daemon))
        assertEquals("the dead supervisor is pruned", listOf(200L), storedPids(store))

        // The usual order: the spawning session verifies the child through its supervisor, and that persists the child too.
        val second = temporaryFolder.newFolder("second").path
        val session = mutableMapOf(110L to ProcessFacts(110, T0, 1), 210L to ProcessFacts(210, T1, 110))
        RuntimeSelectionPolicy.remember(second, SpawnRecord(110, T0, supervisor = true, daemon = daemonKey(daemon)), session::get)
        assertNull("child in the spawning session", RuntimeSelectionPolicy.verifyProvenance(second, 210, session::get))
        RuntimeSelectionPolicy.forgetSessionForTest()
        session.remove(110L)
        assertNull("that child after a restart", RuntimeSelectionPolicy.verifyProvenance(second, 210, session::get, daemon))

        // A store that cannot be written never throws, and the session keeps its record in memory.
        val blocked = File(temporaryFolder.root, "not-a-directory").apply { writeText("file") }
        RuntimeSelectionPolicy.store = { ProtectedStateStore(blocked.toPath().resolve("protected-state")) }
        val third = temporaryFolder.newFolder("third").path
        RuntimeSelectionPolicy.remember(third, SpawnRecord(120, T0, supervisor = true, daemon = daemonKey(daemon))) { ProcessFacts(it, T0, 1) }
        assertNull("in memory", RuntimeSelectionPolicy.verifyProvenance(third, 120, { ProcessFacts(it, T0, 1) }, daemon))
    }

    @Test
    fun `PP2a persisted records verify nothing for another daemon, project or pid, the daemon's child, or from inside the project`() {
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        // The stored supervisor verifies itself and its child, so each refusal below comes from the one thing it changes.
        persistedSession(dir, daemon)
        assertVerified("baseline", dir, daemon)
        // That persisted the child too, yet only a supervisor vouches: the daemon's own child stays unverified.
        RuntimeSelectionPolicy.forgetSessionForTest()
        val grandchild = LIVE + (300L to ProcessFacts(300, T1, 200))
        assertEquals("the daemon's child", refusal(300), RuntimeSelectionPolicy.verifyProvenance(dir, 300, grandchild::get, daemon))

        persistedSession(dir, daemon)
        assertRefused("another installed daemon", dir, installedDaemon())
        assertRefused("no installed daemon", dir, null)
        assertRefused("an installed daemon that does not resolve", dir, File(temporaryFolder.root, "missing/daemon/index.js"))
        assertRefused("another project", temporaryFolder.newFolder("b").path, daemon)
        assertRefused("a reused pid", dir, daemon, mapOf(100L to ProcessFacts(100, T1, 1), 200L to ProcessFacts(200, T1, 100)))

        val foreign = persistedSession(temporaryFolder.newFolder("c").path, daemon).let { it.read(storeFiles(it).single())!! }
        persistedSession(dir, daemon).let { it.write(storeFiles(it).single(), foreign) }
        assertRefused("a file under this project's name for another project", dir, daemon)

        val (name, valid) = persistedSession(dir, daemon).let { store -> storeFiles(store).single().let { it to store.read(it)!! } }
        val inProject = ProtectedStateStore(File(dir, "state").toPath())
        RuntimeSelectionPolicy.store = { inProject }
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon))) { ProcessFacts(it, T0, 1) }
        assertFalse("nothing is written inside the project", inProject.root.toFile().exists())
        inProject.write(name, valid)
        assertRefused("a valid file in a store inside the project", dir, daemon)
    }

    @Test
    fun `PP2b a persisted file the IDE would not have written verifies nothing`() {
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        val valid = persistedSession(dir, daemon).let { it.read(storeFiles(it).single())!! }
        fun rewrite(text: String) = persistedSession(dir, daemon).let { it.write(storeFiles(it).single(), text) }
        rewrite(valid)
        assertVerified("the valid file, rewritten", dir, daemon)
        mapOf(
            "truncated JSON" to valid.dropLast(1),
            "a byte order mark" to "\uFEFF" + valid,
            "trailing content" to "$valid {}",
            "lenient JSON" to valid.replace("\"version\":", "version:"),
            "version 2" to valid.replace("\"version\":1", "\"version\":2"),
            "version 1.0" to valid.replace("\"version\":1", "\"version\":1.0"),
            "a missing project" to valid.replace(Regex("\"project\":\"[^\"]*\","), ""),
            "a missing record field" to valid.replace(",\"supervisor\":true", ""),
            "an extra record field" to valid.replace("\"supervisor\":true", "\"supervisor\":true,\"extra\":true"),
            "an extra top-level field" to valid.replace("\"version\":1", "\"version\":1,\"extra\":1"),
            "a string pid" to valid.replace("\"pid\":100", "\"pid\":\"100\""),
            "a string supervisor" to valid.replace("\"supervisor\":true", "\"supervisor\":\"true\""),
            "records as an object" to valid.replace(Regex("\"records\":\\[(.*)]}$"), "\"records\":$1}")
        ).forEach { (label, text) ->
            assertTrue("$label changes the file", text != valid)
            rewrite(text)
            assertRefused(label, dir, daemon)
        }

        rewrite(valid + " ".repeat(ProtectedStateStore.MAX_BYTES - valid.toByteArray(Charsets.UTF_8).size))
        // The supervisor's own record adds no child, so this verify leaves the file exactly 64 KiB.
        assertNull("exactly 64 KiB", RuntimeSelectionPolicy.verifyProvenance(dir, 100, LIVE::get, daemon))
        RuntimeSelectionPolicy.store()!!.let { Files.write(it.root.resolve(storeFiles(it).single()), byteArrayOf(' '.code.toByte()), StandardOpenOption.APPEND) }
        assertRefused("over 64 KiB", dir, daemon)

        persistedSession(dir, daemon).let { store ->
            assumeTrue("cannot grant another principal access on this host", loosen(store.root.resolve(storeFiles(store).single()), directory = false))
        }
        assertRefused("a loosened file", dir, daemon)
    }

    @Test
    fun `PP3 a verify or a new record prunes persisted records whose process is gone or whose pid was reused`() {
        val store = useStore()
        val dir = temporaryFolder.newFolder("a").path
        val daemon = installedDaemon()
        listOf(100L, 300L, 500L).forEach {
            RuntimeSelectionPolicy.remember(dir, SpawnRecord(it, T0, supervisor = true, daemon = daemonKey(daemon))) { pid -> ProcessFacts(pid, T0, 1) }
        }
        assertEquals(listOf(100L, 300L, 500L), storedPids(store))
        RuntimeSelectionPolicy.forgetSessionForTest()

        // 300 is gone and 500 now names a later process; 100 still runs, and 900 was never recorded.
        val live = mapOf(100L to ProcessFacts(100, T0, 1), 500L to ProcessFacts(500, T1, 1), 900L to ProcessFacts(900, T1, 1))
        assertEquals(refusal(900), RuntimeSelectionPolicy.verifyProvenance(dir, 900, live::get, daemon))
        assertEquals(listOf(100L), storedPids(store))
        assertEquals(refusal(900), RuntimeSelectionPolicy.verifyProvenance(dir, 900, (live - 100L)::get, daemon))
        assertEquals("the file goes with its last record", emptyList<String>(), storeFiles(store))

        listOf(300L, 500L).forEach {
            RuntimeSelectionPolicy.remember(dir, SpawnRecord(it, T0, supervisor = true, daemon = daemonKey(daemon))) { pid -> ProcessFacts(pid, T0, 1) }
        }
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon)), live::get)
        assertEquals("a new record prunes the same way", listOf(100L), storedPids(store))
    }

    @Test
    fun `S1 protected selection runs only the installed node and daemon`() {
        val (project, root, node) = protectedFixture()
        listOf(false to emptyList(), true to listOf("--host", "wsl")).forEach { (wsl, host) ->
            val started = mutableListOf<List<String>>()
            val dirs = mutableListOf<File?>()
            val supervisor = supervisorFor(project, root = { root }, node = { node.path }, wsl = wsl, started = started, dirs = dirs)
            assertTrue("wsl=$wsl", supervisor.ensureDaemonRunning())
            val expected = listOf(realFile(node).path, realFile(File(root, "daemon/index.js")).path, "start", "--project", project.path) + host
            assertEquals("wsl=$wsl", listOf(expected), started)
            // An IDE started inside a repository must not lend the daemon that working directory.
            assertEquals("wsl=$wsl", listOf(realFile(File(root, "daemon"))), dirs)
            assertNull(supervisor.selectionRefusal())
        }
        // The spawn is recorded: a process whose handle is this JVM then passes activation.
        RuntimeSelectionPolicy.resetForTest()
        val self = ProcessHandle.current()
        val recorded = MoeDaemonSupervisor(project.path, "Test Project", processStarter = { IdleProcess(self) },
            profile = { RuntimeProfile.PROTECTED }, installedRoot = { root }, nodeExecutable = { node.path })
        assertTrue(recorded.ensureDaemonRunning())
        assertNull("recorded spawn", recorded.activationRefusal(DaemonInfo(9876, self.pid().toInt(), "now", project.path)))
    }

    @Test
    fun `S2 a protected refusal starts nothing and stays visible`() {
        val (project, root, node) = protectedFixture()
        val inProjectNode = File(project, "node").apply { writeText("node") }
        val sandbox = installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains"))
        mapOf(
            "installed Moe runtime not found" to Pair<File?, String?>(null, node.path),
            "installed daemon/index.js not found" to Pair<File?, String?>(temporaryFolder.newFolder("empty-root"), node.path),
            "installed daemon/index.js resolves inside the project" to Pair<File?, String?>(sandbox, node.path),
            "node executable not found" to Pair<File?, String?>(root, null),
            "node executable resolves inside the project" to Pair<File?, String?>(root, inProjectNode.path)
        ).forEach { (reason, setup) ->
            val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
            val started = mutableListOf<List<String>>()
            val statuses = mutableListOf<Pair<Boolean, String>>()
            var profile = RuntimeProfile.PROTECTED
            val supervisor = supervisorFor(project, { setup.first }, { setup.second }, profile = { profile }, started = started, statuses = statuses)
            assertFalse(reason, supervisor.ensureDaemonRunning())
            assertEquals(reason, emptyList<List<String>>(), started)
            assertEquals(reason, listOf(false to message), statuses)
            assertEquals(reason, message, supervisor.selectionRefusal())
            profile = RuntimeProfile.LEGACY
            assertNull("$reason under legacy", supervisor.selectionRefusal())
        }
        var nodePath: String? = null
        val recovering = supervisorFor(project, { root }, { nodePath })
        assertFalse(recovering.ensureDaemonRunning())
        nodePath = node.path
        recovering.resetSpawnBackoff()
        assertTrue("a later accepted selection", recovering.ensureDaemonRunning())
        assertNull("an accepted selection clears the refusal", recovering.selectionRefusal())
    }

    @Test
    fun `S3 legacy selection still prefers the project daemon`() {
        val (project, root, node) = protectedFixture()
        val started = mutableListOf<List<String>>()
        val dirs = mutableListOf<File?>()
        val supervisor = supervisorFor(project, { root }, { node.path }, profile = { RuntimeProfile.LEGACY }, started = started, dirs = dirs)
        assertTrue(supervisor.ensureDaemonRunning())
        assertEquals(File(project, "packages/moe-daemon/dist/index.js").absolutePath, started.single()[1])
        assertEquals("legacy keeps the IDE's working directory", listOf<File?>(null), dirs)
        assertNull(supervisor.selectionRefusal())
    }

    @Test
    fun `S4 the protected daemon environment cannot reach repository code`() {
        val (project, _, node) = protectedFixture()
        val supervisor = supervisorFor(project, { null }, { null })
        val outsideA = temporaryFolder.newFolder("path-a").path
        val outsideB = node.parentFile.path
        val spaced = temporaryFolder.newFolder("path c").path
        val padded = temporaryFolder.newFolder("path-d").path
        val alias = File(temporaryFolder.root, "path-alias")
        val unbuilt = File(project, "node_modules/.bin").path
        // Edge-quoted spellings: libuv's Windows PATH search strips one leading or trailing ' or ", so they must never be kept.
        val edgeQuoted = listOf("${project.path}'", "'${project.path}", "$outsideA'", "$outsideA\"")
        val entries = mutableListOf(outsideA, "", "bin", ".", unbuilt, project.path, "\"${File(project, "tools").path}\"", "  ",
            "/bad\u0000path", "  $padded  ", *edgeQuoted.toTypedArray(), "\"$spaced\"", outsideB)
        val linked = symlink(alias.toPath(), project.toPath())
        if (linked) entries += alias.path
        // Unbuilt project dirs have no real path, so only the folded comparison catches a case variant.
        if (RuntimeSelectionPolicy.defaultFoldCase) entries += unbuilt.uppercase()
        val env = mutableMapOf("NODE_OPTIONS" to "--require ./evil.js", "NODE_PATH" to project.path, "HOME" to "home",
            "PATH" to entries.joinToString(File.pathSeparator))
        supervisor.protectedDaemonEnvironment(env, project.path)
        // Each kept entry is exactly the spelling that was validated: trimmed and unquoted.
        val kept = listOf(outsideA, padded, spaced, outsideB).joinToString(File.pathSeparator)
        assertEquals(mapOf("HOME" to "home", "PATH" to kept), env)
        if (linked) {
            val throughAlias = mutableMapOf("PATH" to listOf(project.path, outsideA).joinToString(File.pathSeparator))
            supervisor.protectedDaemonEnvironment(throughAlias, alias.path)
            assertEquals("project addressed through a link", mapOf("PATH" to outsideA), throughAlias)
        }

        val windows = System.getProperty("os.name").startsWith("Windows")
        val nodeName = if (windows) "node.exe" else "node"
        File(project, "bin").mkdirs()
        File(project, "bin/$nodeName").writeText("planted")
        File(outsideB, nodeName).writeText("node")
        val path = listOf(File(project, "bin").path, "bin", "\"$outsideB\"").joinToString(File.pathSeparator)
        assertEquals(File(outsideB, nodeName).absolutePath, supervisor.nodeOnProtectedPath(path, project.path, windows))
    }

    @Test
    fun `S7 on Windows the protected daemon PATH keeps only plain local entries outside the project`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, _, node) = protectedFixture()
        val supervisor = supervisorFor(project, { null }, { null })
        val outsideA = temporaryFolder.newFolder("path-a").path
        val outsideB = node.parentFile.path
        val entries = listOf(outsideA) + nonLocalSpellings(project) + share("localhost", File(outsideA)) + outsideB
        val env = mutableMapOf("PATH" to entries.joinToString(File.pathSeparator))
        supervisor.protectedDaemonEnvironment(env, project.path)
        assertEquals(mapOf("PATH" to listOf(outsideA, outsideB).joinToString(File.pathSeparator)), env)
    }

    @Test
    fun `S8 on Windows a node whose real path is not plain local spawns nothing`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        val volumeNode = volumeSpelling(node)
        val volumeRoot = volumeSpelling(root)
        assumeTrue("no volume GUID path on this host", volumeNode != null && volumeRoot != null)
        val reason = "node executable is not a plain local Windows path"
        assertEquals(reason, assertRejected("volume node", RuntimeSelectionPolicy.installedExecutable(volumeNode, project.path)))
        assertEquals(
            "installed daemon/index.js is not a plain local Windows path",
            assertRejected("volume root", RuntimeSelectionPolicy.installedArtifact(File(volumeRoot!!), "daemon/index.js", project.path))
        )

        val started = mutableListOf<List<String>>()
        val statuses = mutableListOf<Pair<Boolean, String>>()
        val supervisor = supervisorFor(project, { root }, { volumeNode }, started = started, statuses = statuses)
        val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
        assertFalse(supervisor.ensureDaemonRunning())
        assertEquals(emptyList<List<String>>(), started)
        assertEquals(listOf(false to message), statuses)
        assertEquals(message, supervisor.selectionRefusal())

        // Through the loopback share the real path is UNC; whether the share is reachable varies, the refusal never does.
        val shared = share("localhost", node)
        val viaShare = assertRejected("node through the loopback share", RuntimeSelectionPolicy.installedExecutable(shared, project.path))
        if (Files.isRegularFile(Paths.get(shared))) assertEquals("node through the loopback share", reason, viaShare)

        assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, project.path))
    }

    @Test
    fun `S9 on Windows a node under a subst drive that reaches the project spawns nothing`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        File(project, "node").writeText("planted")
        installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains"))
        val reason = "node executable resolves inside the project"
        withSubst(project) { d ->
            assertEquals(reason, assertRejected("node through subst", RuntimeSelectionPolicy.installedExecutable("$d\\node", project.path)))
            val sandbox = File("$d\\build\\idea-sandbox\\plugins\\moe-jetbrains")
            assertEquals(
                "installed daemon/index.js resolves inside the project",
                assertRejected("root through subst", RuntimeSelectionPolicy.installedArtifact(sandbox, "daemon/index.js", project.path))
            )
            val started = mutableListOf<List<String>>()
            val statuses = mutableListOf<Pair<Boolean, String>>()
            val supervisor = supervisorFor(project, { root }, { "$d\\node" }, started = started, statuses = statuses)
            val message = "Protected execution profile: $reason. Project and PATH copies of the Moe daemon are not used."
            assertFalse(supervisor.ensureDaemonRunning())
            assertEquals(emptyList<List<String>>(), started)
            assertEquals(listOf(false to message), statuses)
            assertEquals(message, supervisor.selectionRefusal())
        }
        // Control: identity also proves a node on a subst drive outside the project is outside.
        withSubst(node.parentFile) { d ->
            assertEquals(
                RuntimeSelection.Accepted(Paths.get("$d\\node").toRealPath().toFile()),
                RuntimeSelectionPolicy.installedExecutable("$d\\node", project.path)
            )
        }
    }

    @Test
    fun `S10 on Windows a project base that is not plainly local selects and spawns nothing`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        val planted = File(project, "node").apply { writeText("planted") }
        val sandbox = installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains"))
        val volumeBase = volumeSpelling(project)
        assumeTrue("no volume GUID path on this host", volumeBase != null)
        val message = "Protected execution profile: $BASE_NOT_PLAIN. Project and PATH copies of the Moe daemon are not used."
        nonLocalBases(project).forEach { base ->
            // The node and root outside the project are refused too: the base check refuses, not identity.
            listOf(
                RuntimeSelectionPolicy.installedExecutable(planted.path, base), RuntimeSelectionPolicy.installedExecutable(node.path, base),
                RuntimeSelectionPolicy.installedArtifact(sandbox, "daemon/index.js", base),
                RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", base)
            ).forEachIndexed { i, selection -> assertEquals("$base $i", BASE_NOT_PLAIN, assertRejected("$base $i", selection)) }
            val env = mutableMapOf("PATH" to listOf(node.parentFile.path, project.path, File(project, "bin").path).joinToString(File.pathSeparator))
            supervisorFor(project, { null }, { null }).protectedDaemonEnvironment(env, base)
            assertEquals(base, mapOf("PATH" to ""), env)
        }
        // A project opened through its volume path: local, so no share is contacted.
        assertNull(refusedSpawn("volume", volumeBase!!, root, node, message).stopCommandOrNull(volumeBase))
        assertLegacyStop(volumeBase, root, node)
        assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, project.path))
    }

    @Test
    fun `S11 on Windows a junction to a literal dot-ending folder is neither a plain node nor a plain project`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (_, root, node) = protectedFixture()
        val project = temporaryFolder.newFolder("project").apply { File(this, "node").writeText("planted") }
        val store = ProtectedStateStore(temporaryFolder.root.toPath().resolve("system/moe/protected-state"))
        withDottedJunction("project") { link, dotted ->
            File(link, "node").writeText("node")
            // The hazard: toRealPath returns the junction's target as written, and read back that path opens the project's file.
            assertEquals("planted", File(dotted, "node").readText())
            assertEquals("node executable is not a plain local Windows path",
                assertRejected("node through the junction", RuntimeSelectionPolicy.installedExecutable(File(link, "node").path, project.path)))
            assertFalse(RuntimeSelectionPolicy.isOutsideProject(link.path, project.path))
            // The junction as the project base: plain as written, not as its real path.
            assertEquals(BASE_NOT_PLAIN, assertRejected("node", RuntimeSelectionPolicy.installedExecutable(node.path, link.path)))
            assertEquals(BASE_NOT_PLAIN, assertRejected("root", RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", link.path)))
            assertFalse(RuntimeSelectionPolicy.isOutsideProject(node.parentFile.path, link.path))
            assertFalse(store.usableFor(link.path))
            // Its pin still holds after a restart: a legacy declaration asks first, and even an allowed downgrade writes nothing.
            val asks = RecordingConfirmer().also { RuntimeSelectionPolicy.confirmer = it }
            RuntimeSelectionPolicy.store = { store }
            val name = RuntimeSelectionPolicy.profileRecordName(link.path)
            val pin = profileJson(link, "protected").also { store.write(name, it) }
            writeProfile(link, "legacy")
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals(RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(link.path))
            assertEquals(listOf(link.path), asks.paths)
            asks.answers.single()(true)
            assertEquals(pin, store.read(name))
        }
        // Controls: the project itself is a plain base, with the node outside it.
        assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, project.path))
        assertTrue(RuntimeSelectionPolicy.isOutsideProject(node.parentFile.path, project.path))
    }

    @Test
    fun `S12 on Windows a project on a drive letter that cannot be proved local selects and spawns nothing`() {
        assumeTrue("Windows path forms", RuntimeSelectionPolicy.windowsHost)
        val (project, root, node) = protectedFixture()
        val native = RuntimeSelectionPolicy.windowsDriveTarget
        // An Error, so isOutsideProject's error handling cannot swallow it: any lookup fails the test.
        val untouched: (String) -> Path? = { throw AssertionError("looked up $it") }
        val asked = mutableListOf<String>()
        val store = useStore()
        val asks = RecordingConfirmer().also { RuntimeSelectionPolicy.confirmer = it }
        val message = "Protected execution profile: $BASE_NOT_PLAIN. Project and PATH copies of the Moe daemon are not used."
        writeProfile(project, "legacy")
        withSubst(project) { d ->
            val base = "$d\\"
            val name = RuntimeSelectionPolicy.profileRecordName(base)
            val pin = profileJson(File(base), "protected").also { store.write(name, it) }
            listOf<(String) -> String?>({ "\\Device\\LanmanRedirector\\;${it}0000000000012345\\srv\\sh" }, { "\\Device\\Mup\\srv\\sh" },
                { "\\Device\\ImDisk0" }, { null }, { throw IllegalStateException("native") }, { throw UnsatisfiedLinkError("jnidispatch") }
            ).forEachIndexed { i, fake ->
                withDriveTargets({ asked += it; if (it.equals(d, ignoreCase = true)) fake(it) else native(it) }) {
                    assertFalse("$i", RuntimeSelectionPolicy.isOutsideProject(node.parentFile.path, base, resolve = untouched))
                    assertFalse("$i", store.usableFor(base))
                    // The node and root sit on a native drive, so their own preflights pass.
                    assertEquals("$i", BASE_NOT_PLAIN, assertRejected("$i node", RuntimeSelectionPolicy.installedExecutable(node.path, base)))
                    assertEquals("$i", BASE_NOT_PLAIN, assertRejected("$i root",
                        RuntimeSelectionPolicy.installedArtifact(root, "daemon/index.js", base)))
                    val env = mutableMapOf("PATH" to node.parentFile.path)
                    supervisorFor(project, { null }, { null }).protectedDaemonEnvironment(env, base)
                    assertEquals("$i", mapOf("PATH" to ""), env)
                    refusedSpawn("$i", base, root, node, message)
                    // Unprovable is not absent: the pin holds after a restart, and even an allowed downgrade writes nothing.
                    RuntimeSelectionPolicy.forgetSessionForTest()
                    assertEquals("$i", RuntimeProfile.PROTECTED, RuntimeSelectionPolicy.profile(base))
                    assertEquals("$i", base, asks.paths.last())
                    asks.answers.last()(true)
                    assertEquals("$i", pin, store.read(name))
                }
            }
            assertLegacyStop(base, root, node)
            withDriveTargets({ throw AssertionError("drive mapping of $it") }) {
                assertTrue(RuntimeSelectionPolicy.isOutsideProject(node.parentFile.path, base, RuntimeProfile.LEGACY))
            }
            // Controls: with the native lookup, 1c2bfeca's subst expansion proves the same base local.
            assertEquals(RuntimeSelection.Accepted(realFile(node)), RuntimeSelectionPolicy.installedExecutable(node.path, base))
            assertTrue(RuntimeSelectionPolicy.isOutsideProject(node.parentFile.path, base))
        }
        // The lookup only ever gets a drive designator, never a UNC or a full path.
        assertTrue(asked.isNotEmpty())
        asked.forEach { assertTrue(it, Regex("^[A-Za-z]:$").matches(it)) }
    }

    @Test
    fun `S5 activation requires provenance only under the protected profile`() {
        val (project, root, node) = protectedFixture()
        var profile = RuntimeProfile.LEGACY
        val supervisor = supervisorFor(project, { root }, { node.path }, profile = { profile })
        val pid = ProcessHandle.current().pid()
        val info = DaemonInfo(9876, pid.toInt(), "now", project.path)
        assertNull("legacy", supervisor.activationRefusal(info))
        profile = RuntimeProfile.PROTECTED
        assertEquals("unrecorded", refusal(pid), supervisor.activationRefusal(info))
        RuntimeSelectionPolicy.recordProtectedSpawn(project.path, ProcessHandle.current())
        assertNull("recorded", supervisor.activationRefusal(info))
    }

    @Test
    fun `S6 after an IDE restart the daemon a protected supervisor started activates only for its project and installed daemon`() {
        val store = useStore()
        val (project, root, node) = protectedFixture()
        val self = ProcessHandle.current()
        val spawning = MoeDaemonSupervisor(project.path, "Test Project", processStarter = { IdleProcess(self) },
            profile = { RuntimeProfile.PROTECTED }, installedRoot = { root }, nodeExecutable = { node.path })
        assertTrue(spawning.ensureDaemonRunning())
        // The IDE restarts: a new supervisor serves the project, and nothing of the earlier session is remembered.
        fun afterRestart(dir: File, installed: File): String? {
            RuntimeSelectionPolicy.forgetSessionForTest()
            return MoeDaemonSupervisor(dir.path, "Test Project", profile = { RuntimeProfile.PROTECTED }, installedRoot = { installed },
                nodeExecutable = { node.path }).activationRefusal(DaemonInfo(9876, self.pid().toInt(), "now", dir.path))
        }
        assertNull("its project and installed daemon", afterRestart(project, root))
        assertEquals("another installed daemon", refusal(self.pid()), afterRestart(project, installedLayout(temporaryFolder.newFolder("other-installed"))))
        assertEquals("another project", refusal(self.pid()), afterRestart(temporaryFolder.newFolder("other-project"), root))
        Files.delete(store.root.resolve(storeFiles(store).single()))
        assertEquals("no persisted record", refusal(self.pid()), afterRestart(project, root))
    }

    @Test
    fun `L1 protected agents use the installed wrapper, daemon and proxy in the legacy order`() {
        val project = temporaryFolder.newFolder("project")
        listOf("scripts/moe-agent.sh", "scripts/moe-agent.ps1").forEach {
            File(project, it).apply { parentFile.mkdirs() }.writeText("repo $it")
        }
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val env = mapOf(
            "MOE_DAEMON_PATH" to realFile(File(root, "daemon/index.js")).path,
            "MOE_PROXY_PATH" to realFile(File(root, "proxy/index.js")).path,
            "MOE_RUNTIME_PROTECTED" to "1"
        )
        val ps1 = ResolvedScript(realFile(File(root, "scripts/moe-agent.ps1")), ScriptSource.BUNDLED, ScriptKind.POWERSHELL)
        val sh = ResolvedScript(realFile(File(root, "scripts/moe-agent.sh")), ScriptSource.BUNDLED, ScriptKind.BASH)
        val inProject = comparable(realFile(project).path, true)
        listOf(Triple(true, false, ps1), Triple(true, true, sh), Triple(false, false, sh), Triple(false, true, sh))
            .forEach { (windows, preferBash, script) ->
                val label = "windows=$windows preferBash=$preferBash"
                val selection = TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, preferBash, root, windows)
                assertEquals(label, ProtectedAgentRuntime.Selected(script, env), selection)
                (listOf(env.getValue("MOE_DAEMON_PATH"), env.getValue("MOE_PROXY_PATH")) + script.file.path).forEach {
                    assertFalse("$label $it", RuntimeSelectionPolicy.isWithin(comparable(it, true), inProject))
                }
            }
        // A missing preferred wrapper falls back to the other installed one, never to the project's copy.
        File(root, "scripts/moe-agent.ps1").delete()
        assertEquals(ProtectedAgentRuntime.Selected(sh, env), TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, root, true))
        installedLayout(root)
        File(root, "scripts/moe-agent.sh").delete()
        assertEquals(ProtectedAgentRuntime.Selected(ps1, env), TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, root, false))

        // A root reached through a link still yields the real installed files.
        installedLayout(root)
        val linkedRoot = File(temporaryFolder.newFolder("plugins"), "moe-jetbrains")
        assumeTrue("links unavailable on this host", symlink(linkedRoot.toPath(), root.toPath()))
        assertEquals(ProtectedAgentRuntime.Selected(ps1, env), TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, linkedRoot, true))
    }

    @Test
    fun `L2 a protected agent launch without the whole installed runtime is refused`() {
        // The repository carries a complete runtime of its own; none of it may stand in for the installed one.
        val project = installedLayout(temporaryFolder.newFolder("project"))
        fun installedWithout(vararg missing: String) =
            installedLayout(temporaryFolder.newFolder()).also { root -> missing.forEach { assertTrue(File(root, it).delete()) } }
        mapOf(
            "null root" to (null to "installed Moe runtime not found"),
            "missing wrapper" to (installedWithout("scripts/moe-agent.ps1", "scripts/moe-agent.sh") to "installed scripts/moe-agent.ps1 not found"),
            "missing daemon" to (installedWithout("daemon/index.js") to "installed daemon/index.js not found"),
            "missing proxy" to (installedWithout("proxy/index.js") to "installed proxy/index.js not found"),
            "root inside the project" to (installedLayout(File(project, "build/idea-sandbox/plugins/moe-jetbrains")) to
                "installed scripts/moe-agent.ps1 resolves inside the project")
        ).forEach { (label, row) ->
            val selection = TerminalAgentLauncher.selectProtectedAgentRuntime(project.path, false, row.first, true)
            assertEquals(label, ProtectedAgentRuntime.Refused(row.second), selection)
            assertFalse(label, selection is ProtectedAgentRuntime.Selected)
        }
    }

    @Test
    fun `L3 only the protected profile replaces the legacy agent resolution`() {
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val untouched: () -> File? = { throw AssertionError("legacy resolution must not look up the installed root") }
        listOf(temporaryFolder.newFolder("unconfigured"), project("""{"settings":{"executionProfile":"legacy"}}""")).forEach {
            assertNull(it.path, TerminalAgentLauncher.protectedAgentRuntime(it.path, false, untouched))
        }

        val strong = project("""{"settings":{"executionProfile":"verified-local"}}""")
        val selected = TerminalAgentLauncher.protectedAgentRuntime(strong.path, false) { root }
        assertTrue("$selected", selected is ProtectedAgentRuntime.Selected)
        assertEquals(TerminalAgentLauncher.selectProtectedAgentRuntime(strong.path, false, root), selected)
        assertEquals("1", (selected as ProtectedAgentRuntime.Selected).env["MOE_RUNTIME_PROTECTED"])
        assertEquals(setOf("MOE_DAEMON_PATH", "MOE_PROXY_PATH", "MOE_RUNTIME_PROTECTED"), selected.env.keys)
        val refused = TerminalAgentLauncher.protectedAgentRuntime(strong.path, false) { null }
        assertEquals(ProtectedAgentRuntime.Refused("installed Moe runtime not found"), refused)
        assertEquals(
            "Protected execution profile: installed Moe runtime not found. " +
                "Agents only use the wrapper, daemon and proxy installed with the Moe plugin.",
            (refused as ProtectedAgentRuntime.Refused).message
        )
    }

    @Test
    fun `G1 an unverified daemon is refused before activation`() {
        val dir = project("""{"settings":{"executionProfile":"verified-local"}}""")
        val pid = ProcessHandle.current().pid()
        withService(dir) { service, port, statuses ->
            doConnect(service, DaemonInfo(port, pid.toInt(), "now", dir.path))
            assertNull(service.field("wsClient"))
            assertFalse(service.isConnected())
            assertEquals(false, service.field("connecting"))
            assertNull(service.field("reconnectFuture"))
            assertEquals(0, MoeProjectRegistry.daemonRefCountForTest(pid.toInt()))
            assertEquals(false to refusal(pid), statuses.last())
        }
    }

    @Test
    fun `G2 a daemon this IDE started from the installed runtime activates`() {
        val dir = project("""{"settings":{"executionProfile":"verified-local"}}""")
        RuntimeSelectionPolicy.recordProtectedSpawn(dir.path, ProcessHandle.current())
        withService(dir) { service, port, statuses ->
            doConnect(service, DaemonInfo(port, ProcessHandle.current().pid().toInt(), "now", dir.path))
            assertTrue("wsClient", service.field("wsClient") != null)
            assertTrue("connected", awaitConnected(service))
            assertEquals(true to "Connected", statuses.last())
        }
    }

    @Test
    fun `G3 legacy activation never asks for provenance`() {
        val dir = temporaryFolder.newFolder("legacy")
        withService(dir) { service, port, statuses ->
            doConnect(service, DaemonInfo(port, ProcessHandle.current().pid().toInt(), "now", dir.path))
            assertTrue("connected", awaitConnected(service))
            assertEquals(true to "Connected", statuses.last())
        }
    }

    @Test
    fun `G4 a protected selection refusal stays visible and is not retried`() {
        val (project, _, node) = protectedFixture()
        val started = mutableListOf<List<String>>()
        withService(project) { service, _, statuses ->
            val supervisor = supervisorFor(project, { null }, { node.path }, started = started)
            MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(service, supervisor)
            service.connect()
            assertEquals(emptyList<List<String>>(), started)
            val message = "Protected execution profile: installed Moe runtime not found. Project and PATH copies of the Moe daemon are not used."
            assertEquals(listOf(false to message), statuses.toList())
            assertNull(service.field("reconnectFuture"))
            assertEquals(false, service.field("connecting"))
            assertNull(service.field("wsClient"))
        }
    }

    @Test
    fun `R1 a protected restart signals no process this IDE did not start for the project`() {
        val (project, root, node) = protectedFixture()
        val self = ProcessHandle.current()
        val noStart = Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ProcessHandle.Info::class.java)) { _, _, _ ->
            Optional.empty<Any>()
        } as ProcessHandle.Info
        val refused = restartRefusal(self.pid(), NOT_STARTED_HERE)
        val spy = SignalSpy()
        mapOf<String, () -> Unit>(
            "unrecorded" to {},
            "pid reused since it was recorded" to {
                RuntimeSelectionPolicy.remember(project.path, SpawnRecord(self.pid(), T0, supervisor = true)) { ProcessFacts(it, T0, null) }
            },
            "recorded for another project" to { RuntimeSelectionPolicy.recordProtectedSpawn(temporaryFolder.newFolder().path, self) },
            "spawned without a start instant" to { RuntimeSelectionPolicy.recordProtectedSpawn(project.path, fakeHandle(self.pid()) { noStart }) }
        ).forEach { (label, setup) ->
            RuntimeSelectionPolicy.resetForTest()
            setup()
            restart(project, root, node, self.pid(), spy::handle).assertRefused(label, refused)
        }
        // Discovery skips its project check for a blank projectPath; provenance still decides.
        restart(project, root, node, self.pid(), spy::handle, projectPath = "").assertRefused("blank projectPath", refused)
        writeProjectJson(project, """{"settings":""")
        restart(project, root, node, self.pid(), spy::handle, profile = { RuntimeSelectionPolicy.profile(project.path) })
            .assertRefused("unreadable project.json", refused)
        assertEquals(emptyList<Long>(), spy.destroyed)
    }

    @Test
    fun `R2 restart stops a recorded protected daemon, or a legacy one, exactly once and starts a fresh one`() {
        val (project, root, node) = protectedFixture()
        val self = ProcessHandle.current()
        val legacy = SignalSpy()
        restart(project, root, node, self.pid(), legacy::handle, profile = { RuntimeProfile.LEGACY }).assertProceeded("legacy, unrecorded")
        assertEquals("legacy still signals the live pid daemon.json names", listOf(self.pid()), legacy.destroyed)

        RuntimeSelectionPolicy.recordProtectedSpawn(project.path, self)
        val supervisor = SignalSpy()
        restart(project, root, node, self.pid(), supervisor::handle).assertProceeded("recorded supervisor")
        // One lookup: the captured handle is the one destroyed, never a second resolution of the pid.
        assertEquals(listOf(self.pid()), supervisor.lookedUp)
        assertEquals(listOf(self.pid()), supervisor.destroyed)
        // `sort` waits on stdin: daemon.json names the `_run` child of the recorded `start` supervisor.
        val child = ProcessBuilder("sort").start()
        try {
            val daemon = SignalSpy()
            restart(project, root, node, child.pid(), daemon::handle).assertProceeded("child of the recorded supervisor")
            assertEquals(listOf(child.pid()), daemon.lookedUp)
            assertEquals(listOf(child.pid()), daemon.destroyed)
        } finally {
            child.destroyForcibly().waitFor()
        }
    }

    @Test
    fun `R3 a dead, vanished or non-positive pid is never signaled and its daemon json is cleaned up`() {
        val (project, root, node) = protectedFixture()
        val pid = ProcessHandle.current().pid()
        val spy = SignalSpy()
        restart(project, root, node, pid, spy::handle, alive = false).assertProceeded("dead")
        val vanished = mutableListOf<Long>()
        restart(project, root, node, pid, { vanished += it; null }).assertProceeded("vanished before its handle was taken")
        assertEquals(listOf(pid), vanished)
        // A daemon.json without a pid reads as 0, and kill(2) takes 0 and -1 as process groups: neither is a daemon.
        listOf(RuntimeProfile.PROTECTED, RuntimeProfile.LEGACY).forEach { profile ->
            listOf(0L, -1L).forEach { restart(project, root, node, it, spy::handle, profile = { profile }).assertProceeded("$profile pid $it") }
        }
        assertEquals(emptyList<Long>(), spy.lookedUp)
        assertEquals(emptyList<Long>(), spy.destroyed)
    }

    @Test
    fun `R4 lookup and signal failures stop a protected restart and are ignored by a legacy one`() {
        val (project, root, node) = protectedFixture()
        val pid = ProcessHandle.current().pid()
        RuntimeSelectionPolicy.recordProtectedSpawn(project.path, ProcessHandle.current())
        listOf(RuntimeProfile.PROTECTED, RuntimeProfile.LEGACY).forEach { profile ->
            val check: Restart.(String) -> Unit = {
                if (profile == RuntimeProfile.PROTECTED) assertRefused(it, restartRefusal(pid, STOP_FAILED)) else assertProceeded(it)
            }
            restart(project, root, node, pid, { throw SecurityException("lookup") }, { profile }).check("$profile lookup throws")
            listOf<Pair<String, () -> Boolean>>(
                "destroy throws" to { throw SecurityException("signal") },
                "destroy returns false" to { false }
            ).forEach { (label, destroy) ->
                val spy = SignalSpy(destroy)
                restart(project, root, node, pid, spy::handle, { profile }).check("$profile $label")
                assertEquals("$profile $label", listOf(pid), spy.destroyed)
            }
        }
    }

    /** What one Restart Daemon left: daemon.json before and after, starts, statuses, spawn attempts and retry timer. */
    private data class Restart(
        val before: String, val after: String?, val started: List<List<String>>,
        val statuses: List<Pair<Boolean, String>>, val spawnAttempts: Int, val reconnect: Any?
    )

    /**
     * The real Restart Daemon on [project] while daemon.json names [pid], through a supervisor that looks
     * processes up with [lookup] and has spent its spawn attempts, so only a backoff reset starts a daemon.
     */
    private fun restart(
        project: File, root: File, node: File, pid: Long, lookup: (Long) -> ProcessHandle?,
        profile: () -> RuntimeProfile = { RuntimeProfile.PROTECTED }, alive: Boolean = true, projectPath: String = project.path
    ): Restart {
        val metadata = File(project, ".moe/daemon.json").apply { writeText(Gson().toJson(DaemonInfo(1, pid.toInt(), "now", projectPath))) }
        val before = metadata.readText()
        val started = mutableListOf<List<String>>()
        val supervisor = supervisorFor(project, { root }, { node.path }, profile = profile, started = started, alive = { alive }, lookup = lookup)
        SPAWN_ATTEMPTS.setInt(supervisor, Int.MAX_VALUE)
        lateinit var outcome: Restart
        withService(project) { service, _, statuses ->
            MoeProjectService::class.java.getDeclaredField("daemonSupervisor").apply { isAccessible = true }.set(service, supervisor)
            service.restartDaemon()
            outcome = Restart(before, metadata.takeIf { it.exists() }?.readText(), started.toList(), statuses.toList(),
                SPAWN_ATTEMPTS.getInt(supervisor), service.field("reconnectFuture"))
        }
        return outcome
    }

    /** Nothing after a refusal: daemon.json byte for byte, no start, no backoff reset, no retry. */
    private fun Restart.assertRefused(label: String, message: String) {
        assertEquals(label, before, after)
        assertEquals(label, emptyList<List<String>>(), started)
        assertEquals(label, listOf(false to "Disconnected", false to message), statuses)
        assertEquals(label, Int.MAX_VALUE, spawnAttempts)
        assertNull(label, reconnect)
    }

    /** A restart that went on: daemon.json deleted, the backoff reset and exactly one daemon started. */
    private fun Restart.assertProceeded(label: String) {
        assertNull(label, after)
        assertEquals(label, 1, started.size)
        assertEquals(label, 1, spawnAttempts)
        assertEquals(label, listOf(false to "Disconnected", false to "Starting daemon..."), statuses.take(2))
    }

    /** Inert stand-ins for the processes daemon.json names: lookups and destroys are recorded, and reach no process. */
    private class SignalSpy(private val destroy: () -> Boolean = { true }) {
        val lookedUp = CopyOnWriteArrayList<Long>()
        val destroyed = CopyOnWriteArrayList<Long>()

        fun handle(pid: Long): ProcessHandle {
            lookedUp += pid
            return Proxy.newProxyInstance(SignalSpy::class.java.classLoader, arrayOf(ProcessHandle::class.java)) { proxy, method, args ->
                when (method.name) {
                    "destroy" -> {
                        destroyed += pid
                        destroy()
                    }
                    "pid" -> pid
                    "isAlive" -> true
                    "hashCode" -> System.identityHashCode(proxy)
                    "equals" -> proxy === args?.firstOrNull()
                    "toString" -> "SignalSpy($pid)"
                    else -> throw UnsupportedOperationException(method.name)
                }
            } as ProcessHandle
        }
    }

    private fun restartRefusal(pid: Long, reason: String) =
        "Protected execution profile: Restart Daemon did not stop pid $pid, which .moe/daemon.json names: $reason. " +
            "Check what that process is and stop it yourself if it is a Moe daemon, then use Restart Daemon."

    /** A loopback daemon endpoint and a service on a project rooted at [dir], both torn down after [test]. */
    private fun withService(dir: File, test: (MoeProjectService, Int, List<Pair<Boolean, String>>) -> Unit) {
        MoeProjectRegistry.clearDaemonRefCountsForTest()
        val listening = CountDownLatch(1)
        val server = object : WebSocketServer(InetSocketAddress("127.0.0.1", 0), 1) {
            override fun onStart() = listening.countDown()
            override fun onOpen(conn: WebSocket?, handshake: ClientHandshake?) {}
            override fun onMessage(conn: WebSocket?, message: String?) {}
            override fun onClose(conn: WebSocket?, code: Int, reason: String?, remote: Boolean) {}
            override fun onError(conn: WebSocket?, ex: Exception?) {}
        }
        server.start()
        val service = MoeProjectService(ideaProject(dir)) { it() }
        val statuses = CopyOnWriteArrayList<Pair<Boolean, String>>()
        service.addListener(object : MoeStateListener {
            override fun onState(state: MoeState) {}
            override fun onStatus(connected: Boolean, message: String) {
                statuses += connected to message
            }
        })
        try {
            assertTrue("loopback server did not start", listening.await(5, TimeUnit.SECONDS))
            test(service, server.port, statuses)
        } finally {
            service.dispose()
            server.stop(1000)
            MoeProjectRegistry.clearDaemonRefCountsForTest()
        }
    }

    private fun doConnect(service: MoeProjectService, info: DaemonInfo) {
        MoeProjectService::class.java.getDeclaredMethod("doConnect", DaemonInfo::class.java)
            .apply { isAccessible = true }.invoke(service, info)
    }

    /** Waits until the open callback has finished, as MoeProjectConnectionTest does. */
    private fun awaitConnected(service: MoeProjectService): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while ((!service.isConnected() || service.field("refreshFuture") == null) && System.nanoTime() < deadline) {
            Thread.sleep(10)
        }
        return service.isConnected()
    }

    private fun MoeProjectService.field(name: String): Any? =
        MoeProjectService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(this)

    private fun ideaProject(dir: File): IdeaProject = Proxy.newProxyInstance(
        IdeaProject::class.java.classLoader,
        arrayOf(IdeaProject::class.java)
    ) { proxy, method, args ->
        when (method.name) {
            "getName" -> "Gate Test"
            "getBasePath" -> dir.path
            "isDisposed" -> false
            "toString" -> "GateTestProject"
            "hashCode" -> System.identityHashCode(proxy)
            "equals" -> proxy === args?.firstOrNull()
            else -> null
        }
    } as IdeaProject

    /** A project whose tree and parent both carry a daemon, an installed root and a node outside both. */
    private fun protectedFixture(): Triple<File, File, File> {
        val parent = temporaryFolder.newFolder("work")
        val project = File(parent, "proj").apply { File(this, ".moe").mkdirs() }
        listOf(parent, project).forEach { File(it, "packages/moe-daemon/dist/index.js").apply { parentFile.mkdirs() }.writeText("repo") }
        val root = installedLayout(temporaryFolder.newFolder("installed"))
        val node = File(temporaryFolder.newFolder("runtime"), "node").apply { writeText("node") }
        return Triple(project, root, node)
    }

    private fun supervisorFor(
        project: File,
        root: () -> File?,
        node: () -> String?,
        wsl: Boolean = false,
        profile: () -> RuntimeProfile = { RuntimeProfile.PROTECTED },
        started: MutableList<List<String>> = mutableListOf(),
        statuses: MutableList<Pair<Boolean, String>> = mutableListOf(),
        dirs: MutableList<File?> = mutableListOf(),
        alive: (Int) -> Boolean = { false },
        lookup: (Long) -> ProcessHandle? = { null }
    ) = MoeDaemonSupervisor(
        project.path, "Test Project", { connected, message -> statuses += connected to message }, { _, _ -> false }, alive,
        { pb -> started += pb.command().toList(); dirs += pb.directory(); IdleProcess() }, { wsl }, profile, root, node, lookup,
        // R1-R4 pin the cross-platform restart; the Windows tree stop has its own rows in MoeDaemonSupervisorTest.
        windowsRestart = { false }
    )

    /** A protected supervisor for the project opened as [base] starts nothing and keeps [message] visible; returned for more checks. */
    private fun refusedSpawn(label: String, base: String, root: File, node: File, message: String): MoeDaemonSupervisor {
        val started = mutableListOf<List<String>>()
        val statuses = mutableListOf<Pair<Boolean, String>>()
        val supervisor = supervisorFor(File(base), { root }, { node.path }, started = started, statuses = statuses)
        assertFalse(label, supervisor.ensureDaemonRunning())
        assertEquals(label, emptyList<List<String>>(), started)
        assertEquals(label, listOf(false to message), statuses)
        assertEquals(label, message, supervisor.selectionRefusal())
        return supervisor
    }

    /** Restart Daemon's legacy stop for the project opened as [base]: the installed node and daemon, with no drive mapping asked. */
    private fun assertLegacyStop(base: String, root: File, node: File) = withDriveTargets({ throw AssertionError("drive mapping of $it") }) {
        val stop = listOf(realFile(node).path, realFile(File(root, "daemon/index.js")).path, "stop", "--project", base)
        assertEquals(base, stop, supervisorFor(File(base), { root }, { node.path }, profile = { RuntimeProfile.LEGACY }).stopCommandOrNull(base))
    }

    /** A started process that never runs; without [handle] it has none, so it is never recorded. */
    private class IdleProcess(private val handle: ProcessHandle? = null) : Process() {
        override fun toHandle(): ProcessHandle = handle ?: super.toHandle()
        override fun getOutputStream(): OutputStream = OutputStream.nullOutputStream()
        override fun getInputStream(): InputStream = InputStream.nullInputStream()
        override fun getErrorStream(): InputStream = InputStream.nullInputStream()
        override fun waitFor(): Int = 0
        override fun exitValue(): Int = 0
        override fun destroy() {}
        override fun isAlive(): Boolean = false
    }

    private fun refusal(pid: Long) = "Protected execution profile: the running Moe daemon (pid $pid) was not started by this IDE " +
        "from the installed Moe runtime. Stop it, then use Restart Daemon."

    private fun fakeHandle(pid: Long, info: () -> ProcessHandle.Info): ProcessHandle =
        Proxy.newProxyInstance(javaClass.classLoader, arrayOf(ProcessHandle::class.java)) { _, method, _ ->
            when (method.name) {
                "pid" -> pid
                "info" -> info()
                else -> throw UnsupportedOperationException(method.name)
            }
        } as ProcessHandle

    private fun project(json: String): File = temporaryFolder.newFolder().also { writeProjectJson(it, json) }

    private fun writeProjectJson(dir: File, json: String) {
        File(dir, ".moe").mkdirs()
        File(dir, ".moe/project.json").writeBytes(json.toByteArray(Charsets.UTF_8))
    }

    private fun comparable(path: String, fold: Boolean) = RuntimeSelectionPolicy.comparablePath(path, fold)

    private fun realFile(file: File): File = file.toPath().toRealPath().toFile()

    /** Every installed artifact a protected selection may use, laid out as the plugin zip ships them. */
    private fun installedLayout(root: File): File {
        listOf("daemon/index.js", "proxy/index.js", "scripts/moe-agent.sh", "scripts/moe-agent.ps1").forEach {
            File(root, it).apply { parentFile.mkdirs() }.writeText("installed $it")
        }
        return root
    }

    /** The reason of a rejection; never an absolute path (those go to the log only). */
    private fun assertRejected(label: String, selection: RuntimeSelection): String {
        assertTrue("$label: $selection", selection is RuntimeSelection.Rejected)
        val reason = (selection as RuntimeSelection.Rejected).reason
        assertTrue("$label reason is blank", reason.isNotBlank())
        assertFalse("$label reason leaks a path: $reason", reason.contains(temporaryFolder.root.path))
        return reason
    }

    private fun profileOf(dir: File): RuntimeProfile = RuntimeSelectionPolicy.profile(dir.path)

    private fun padded(json: String, size: Int): String = json + " ".repeat(size - json.toByteArray(Charsets.UTF_8).size)

    // A symbolic link, else (Windows without the symlink privilege) a directory junction,
    // which needs no privilege and which Java also reads without following under NOFOLLOW_LINKS.
    private fun symlink(link: Path, target: Path): Boolean = try {
        Files.createSymbolicLink(link, target)
        true
    } catch (_: Exception) {
        System.getProperty("os.name").startsWith("Windows") && junction(link, target)
    }

    private fun junction(link: Path, target: Path): Boolean = try {
        val process = ProcessBuilder("cmd", "/c", "mklink", "/J", link.toString(), target.toString())
            .redirectErrorStream(true).start()
        process.inputStream.readBytes()
        process.waitFor() == 0 && Files.exists(link, LinkOption.NOFOLLOW_LINKS)
    } catch (_: Exception) {
        false
    }

    /**
     * Runs [body] with a fresh subst drive (`L:`) for [target], then removes that drive in a finally block; a drive
     * this helper did not create is never touched. Skips only when every letter from Z to D is taken: a subst that
     * fails on every free letter fails the test.
     */
    private fun <T> withSubst(target: File, body: (String) -> T): T {
        val subst = File(System.getenv("SystemRoot"), "System32\\subst.exe")
        assertTrue("$subst exists", subst.isFile)
        val failures = mutableListOf<String>()
        for (letter in 'Z' downTo 'D') {
            val drive = "$letter:"
            if (File("$drive\\").exists()) continue
            // A free-looking letter may still be held, by a remembered network mapping: try the next one.
            val exit = exitOf(subst.path, drive, target.path)
            if (exit != 0 && failures.add("$drive exit $exit")) continue
            var passed = false
            try {
                return body(drive).also { passed = true }
            } finally {
                // exitOf never throws, and a failed body keeps its own failure.
                val removed = exitOf(subst.path, drive, "/D")
                if (passed) assertEquals("subst $drive /D", 0, removed)
            }
        }
        if (failures.isNotEmpty()) throw AssertionError("subst $target failed on every free letter: $failures")
        throw AssumptionViolatedException("no free drive letter for subst")
    }

    /** Runs [body] with [provider] answering every drive mapping, then restores the lookup it replaced. */
    private fun <T> withDriveTargets(provider: (String) -> String?, body: () -> T): T {
        val previous = RuntimeSelectionPolicy.windowsDriveTarget
        RuntimeSelectionPolicy.windowsDriveTarget = provider
        try {
            return body()
        } finally {
            RuntimeSelectionPolicy.windowsDriveTarget = previous
        }
    }

    /**
     * Runs [body] while [dir]'s owner may not list it, then restores its ACL in a finally block. toRealPath lists each folder
     * on the way, so it fails below [dir], while opening a known path still works, because traverse checking is bypassed.
     * That is what a junction onto a volume Windows cannot name (an ImDisk RAM disk outside the mount manager) does to it.
     */
    private fun <T> withUnlistable(dir: File, body: () -> T): T {
        val view = Files.getFileAttributeView(dir.toPath(), AclFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
            ?: throw AssumptionViolatedException("no ACL view for $dir")
        val previous = view.acl
        view.acl = listOf(AclEntry.newBuilder().setType(AclEntryType.DENY).setPrincipal(view.owner)
            .setPermissions(AclEntryPermission.LIST_DIRECTORY).build()) + previous
        try {
            return body()
        } finally {
            view.acl = previous
        }
    }

    private fun exitOf(vararg command: String): Int = try {
        val process = ProcessBuilder(*command).redirectErrorStream(true).start()
        process.inputStream.readBytes()
        process.waitFor()
    } catch (_: Exception) {
        -1
    }

    /** [dir] through the [host] admin share of its drive: `\\<host>\<d>$\<rest>`. */
    private fun share(host: String, dir: File): String {
        val real = realFile(dir).path
        assumeTrue("drive-qualified real path $real", DRIVE_PATH.containsMatchIn(real))
        return "\\\\$host\\${real[0]}\$\\${real.substring(3)}"
    }

    /** Every Windows form of [project] or elsewhere that is not drive-qualified, UNC and device alike. */
    private fun nonLocalSpellings(project: File): List<String> = listOf(
        "\\\\srv\\sh\\x", "//srv/sh/x", "\\\\?\\UNC\\srv\\sh\\x", "\\\\.\\UNC\\srv\\sh\\x",
        "\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\x",
        "\\\\.\\GLOBALROOT\\Device\\Mup\\" + share("localhost", project).removePrefix("\\\\"),
        share("localhost", project), share("127.0.0.1", project), share("localhost", project) + "\\bin"
    )

    /**
     * Every project base for [project] that is not a plain local base: [nonLocalSpellings], IntelliJ's `//localhost/X$/rest`,
     * WSL and missing shares, the rooted and drive-relative forms, the dot and space segments Win32 resolves away (JDK 17's
     * Paths.get throws on the last), and the volume GUID path. The base rule must refuse every one before any lookup.
     */
    private fun nonLocalBases(project: File): List<String> {
        val real = realFile(project).path
        return nonLocalSpellings(project) + listOf(
            share("localhost", project).replace('\\', '/'), "\\\\wsl\$\\moe-no-such-distro\\proj",
            "\\\\wsl.localhost\\moe-no-such-distro\\proj", "\\\\localhost\\moe-no-such-share\$\\proj",
            real.substring(2), real.substring(0, 2) + real.substring(3), "$real\\..\\${project.name}", "$real\\.", "$real.", "$real "
        ) + listOfNotNull(volumeSpelling(project))
    }

    /**
     * A mount point on the new empty folder [link] whose substitute name is exactly `\??\` + [target]; false on any failure.
     * mklink /J and New-Item -ItemType Junction drop a trailing '.' from the target, so the reparse point is written
     * directly. A mount point on an empty folder you own needs no privilege.
     */
    private fun rawJunction(link: File, target: String): Boolean = try {
        link.mkdir() && Kernel32.INSTANCE.let { kernel ->
            val handle = kernel.CreateFile(link.path, WinNT.GENERIC_WRITE, 0, null, WinNT.OPEN_EXISTING,
                WinNT.FILE_FLAG_BACKUP_SEMANTICS or WinNT.FILE_FLAG_OPEN_REPARSE_POINT, null)
            if (WinBase.INVALID_HANDLE_VALUE == handle) return@let false
            try {
                val substitute = "\\??\\$target".toByteArray(Charsets.UTF_16LE)
                val print = target.toByteArray(Charsets.UTF_16LE)
                // REPARSE_DATA_BUFFER: tag, data length, reserved, both names' offsets and lengths, then each name NUL-terminated.
                val dataLength = 8 + substitute.size + 2 + print.size + 2
                val buffer = Memory(8L + dataLength).apply {
                    clear()
                    setInt(0, WinNT.IO_REPARSE_TAG_MOUNT_POINT)
                    setShort(4, dataLength.toShort())
                    setShort(10, substitute.size.toShort())
                    setShort(12, (substitute.size + 2).toShort())
                    setShort(14, print.size.toShort())
                    write(16, substitute, 0, substitute.size)
                    write(16L + substitute.size + 2, print, 0, print.size)
                }
                kernel.DeviceIoControl(handle, WinioctlUtil.FSCTL_SET_REPARSE_POINT, buffer, 8 + dataLength, null, 0, IntByReference(), null)
            } finally {
                kernel.CloseHandle(handle)
            }
        }
    } catch (_: Exception) {
        false
    } catch (_: LinkageError) {
        false
    }

    /**
     * Runs [body] with `<tmp>\<name>-link`, a junction to the literal folder `<tmp>\<name>.` (dotted), which Win32 reads as
     * `<tmp>\<name>`, then removes both in a finally block. cmd creates and removes the dotted folder: Java's Paths.get
     * rejects the `\\?\` form, Win32 would drop the dot, and TemporaryFolder cannot delete it.
     */
    private fun <T> withDottedJunction(name: String, body: (link: File, dotted: String) -> T): T {
        val dotted = realFile(temporaryFolder.root).path + "\\" + name + "."
        assertEquals("mkdir $dotted", 0, exitOf("cmd", "/c", "mkdir", "\\\\?\\$dotted"))
        val link = File(temporaryFolder.root, "$name-link")
        try {
            assertTrue("a junction to $dotted", rawJunction(link, dotted))
            return body(link, dotted)
        } finally {
            // File.delete removes only the reparse point; exitOf never throws, so a failed body keeps its own failure.
            link.delete()
            exitOf("cmd", "/c", "rd", "/s", "/q", "\\\\?\\$dotted")
        }
    }

    /** [file] through its volume GUID device path, `\\.\Volume{…}\<rest>`: local, drive-less, no network; null when mountvol cannot say. */
    private fun volumeSpelling(file: File): String? = try {
        val real = realFile(file).path
        val mountvol = File(System.getenv("SystemRoot"), "System32\\mountvol.exe").path
        val process = ProcessBuilder(mountvol, real.substring(0, 2), "/L").redirectErrorStream(true).start()
        val output = process.inputStream.readBytes().toString(Charsets.UTF_8).trim()
        val volume = VOLUME_LINE.matchEntire(output)?.groupValues?.get(1)
        if (process.waitFor() == 0 && volume != null && DRIVE_PATH.containsMatchIn(real)) "\\\\.\\$volume\\${real.substring(3)}" else null
    } catch (_: Exception) {
        null
    }

    /** A store whose root does not exist yet, under a fresh folder outside every test project. */
    private fun newStore(): ProtectedStateStore = ProtectedStateStore(temporaryFolder.newFolder().toPath().resolve("moe/protected-state"))

    /** A fresh store, installed as the one the policy persists to; resetForTest restores the default. */
    private fun useStore(): ProtectedStateStore = newStore().also { store -> RuntimeSelectionPolicy.store = { store } }

    /** A fresh store holding what an earlier session left for [dir]: supervisor (100, T0) started from [daemon]. */
    private fun persistedSession(dir: String, daemon: File): ProtectedStateStore {
        val store = useStore()
        RuntimeSelectionPolicy.remember(dir, SpawnRecord(100, T0, supervisor = true, daemon = daemonKey(daemon))) { ProcessFacts(it, T0, 1) }
        RuntimeSelectionPolicy.forgetSessionForTest()
        return store
    }

    private fun installedDaemon(): File = File(installedLayout(temporaryFolder.newFolder()), "daemon/index.js")

    /** Daemons 100 and 200 each verify from the store alone: nothing is remembered in this session. */
    private fun assertVerified(label: String, project: String, installed: File?) = listOf(100L, 200L).forEach { pid ->
        RuntimeSelectionPolicy.forgetSessionForTest()
        assertNull("$label, pid $pid", RuntimeSelectionPolicy.verifyProvenance(project, pid, LIVE::get, installed))
    }

    private fun assertRefused(label: String, project: String, installed: File?, facts: Map<Long, ProcessFacts> = LIVE) =
        listOf(100L, 200L).forEach { pid ->
            RuntimeSelectionPolicy.forgetSessionForTest()
            assertEquals("$label, pid $pid", refusal(pid), RuntimeSelectionPolicy.verifyProvenance(project, pid, facts::get, installed))
        }

    private fun daemonKey(daemon: File): String = RuntimeSelectionPolicy.installedDaemonKey(daemon) ?: throw AssertionError("$daemon")

    private fun storeFiles(store: ProtectedStateStore): List<String> = store.root.toFile().list()?.sorted().orEmpty()

    /** The pids, in file order, of the records in the one provenance file [store] holds. */
    private fun storedPids(store: ProtectedStateStore): List<Long> =
        Gson().fromJson(store.read(storeFiles(store).single()), JsonObject::class.java).getAsJsonArray("records")
            .map { it.asJsonObject.get("pid").asLong }

    /** The owner-only definition, checked independently of the store: exact POSIX modes, else one ACL entry allowing the owner. */
    private fun assertOwnerOnly(path: Path, directory: Boolean) {
        val posix = Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
        if (posix != null) {
            assertEquals("$path", if (directory) "rwx------" else "rw-------", PosixFilePermissions.toString(posix.readAttributes().permissions()))
            return
        }
        val view = Files.getFileAttributeView(path, AclFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
            ?: throw AssertionError("$path has neither a POSIX nor an ACL view")
        assertEquals("$path", listOf(AclEntryType.ALLOW to view.owner), view.acl.map { it.type() to it.principal() })
    }

    /** Grants group and world read (POSIX) or adds an Everyone entry (ACL); false when this host cannot. */
    private fun loosen(path: Path, directory: Boolean): Boolean {
        val posix = Files.getFileAttributeView(path, PosixFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS)
        if (posix != null) {
            posix.setPermissions(PosixFilePermissions.fromString(if (directory) "rwxr-xr-x" else "rw-r--r--"))
            return true
        }
        val view = Files.getFileAttributeView(path, AclFileAttributeView::class.java, LinkOption.NOFOLLOW_LINKS) ?: return false
        val everyone = try {
            path.fileSystem.userPrincipalLookupService.lookupPrincipalByGroupName("Everyone")
        } catch (_: Exception) {
            return false
        }
        val entry = AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(everyone).setPermissions(AclEntryPermission.READ_DATA).build()
        view.acl = view.acl + entry
        return true
    }

    companion object {
        private val NAME_A = "a".repeat(64) + ".json"
        private val NAME_B = "b".repeat(64) + ".json"
        private val NAME_C = "c".repeat(64) + ".json"
        private const val MIB = 1 shl 20
        private val T0: Instant = Instant.parse("2026-01-01T00:00:00Z")
        private val T1: Instant = T0.plusSeconds(60)
        // Supervisor 100 and the daemon 200 it started, both still running.
        private val LIVE = mapOf(100L to ProcessFacts(100, T0, 1), 200L to ProcessFacts(200, T1, 100))
        private const val NOT_STARTED_HERE = "this IDE did not start it from the installed Moe runtime"
        private const val STOP_FAILED = "the stop request failed"
        private const val BASE_NOT_PLAIN = "the project directory is not a plain local Windows path"
        private val DRIVE_PATH = Regex("""^[A-Za-z]:\\""")
        // mountvol <X:> /L prints exactly one `\\?\Volume{GUID}\` line.
        private val VOLUME_LINE = Regex("""\\\\\?\\(Volume\{[0-9A-Fa-f-]{36}\})\\""")
        private val SPAWN_ATTEMPTS =MoeDaemonSupervisor::class.java.getDeclaredField("daemonSpawnAttempts").apply { isAccessible = true }
    }
}
