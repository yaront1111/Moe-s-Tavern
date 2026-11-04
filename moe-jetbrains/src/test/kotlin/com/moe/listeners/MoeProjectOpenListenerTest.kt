package com.moe.listeners

import com.intellij.ide.lightEdit.LightEditCompatible
import com.intellij.openapi.project.Project
import com.moe.services.MoeProjectService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.Proxy
import java.nio.file.Files

class MoeProjectOpenListenerTest {
    @Test
    fun `LightEdit project is not registered, scaffolded or connected`() {
        withTempHome { home, base ->
            val lookups = mutableListOf<String>()
            val project = fakeProject(base.path, lightEdit = true) { lookups.add(it.name); null }

            MoeProjectOpenListener().projectOpened(project)

            assertEquals(emptyList<String>(), lookups)
            assertFalse(File(home, ".moe/projects.json").exists())
            assertFalse(File(base, ".moe").exists())
        }
    }

    @Test
    fun `normal project is still registered`() {
        withTempHome { home, base ->
            val serviceProject = fakeProject(null, lightEdit = false) { null }
            val service = MoeProjectService(serviceProject) { it() }
            try {
                val project = fakeProject(base.path, lightEdit = false) { cls ->
                    if (cls == MoeProjectService::class.java) service else null
                }

                MoeProjectOpenListener().projectOpened(project)

                val registry = File(home, ".moe/projects.json")
                assertTrue(registry.exists())
                assertTrue(registry.readText().contains(base.name))
                // connect() stops at ensureMoeInitialized (blank basePath): nothing scaffolded.
                assertFalse(File(base, ".moe").exists())
            } finally {
                service.dispose()
            }
        }
    }

    private fun withTempHome(block: (home: File, base: File) -> Unit) {
        val previousHome = System.getProperty("user.home")
        val home = Files.createTempDirectory("moe-home").toFile()
        val base = Files.createTempDirectory("moe-base").toFile()
        try {
            System.setProperty("user.home", home.path)
            block(home, base)
        } finally {
            System.setProperty("user.home", previousHome)
            home.deleteRecursively()
            base.deleteRecursively()
        }
    }

    private fun fakeProject(
        basePath: String?,
        lightEdit: Boolean,
        service: (Class<*>) -> Any?
    ): Project {
        val interfaces = if (lightEdit) {
            arrayOf(Project::class.java, LightEditCompatible::class.java)
        } else {
            arrayOf(Project::class.java)
        }
        return Proxy.newProxyInstance(Project::class.java.classLoader, interfaces) { proxy, method, args ->
            when (method.name) {
                "getName" -> "Test Project"
                "getBasePath" -> basePath
                "isDisposed" -> false
                "getService" -> service(args!![0] as Class<*>)
                "toString" -> "FakeProject"
                "hashCode" -> 1
                "equals" -> args?.firstOrNull() === proxy
                else -> when (method.returnType) {
                    java.lang.Boolean.TYPE -> false
                    java.lang.Integer.TYPE -> 0
                    java.lang.Long.TYPE -> 0L
                    else -> null
                }
            }
        } as Project
    }
}
