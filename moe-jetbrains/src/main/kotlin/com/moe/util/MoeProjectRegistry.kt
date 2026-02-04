package com.moe.util

import com.google.gson.GsonBuilder
import com.google.gson.reflect.TypeToken
import java.io.File
import java.time.Instant

data class MoeProjectInfo(
    val path: String,
    val name: String,
    val lastOpenedAt: String
)

object MoeProjectRegistry {
    private val gson = GsonBuilder().setPrettyPrinting().create()

    private fun registryFile(): File {
        val home = System.getProperty("user.home")
        val dir = File(home, ".moe")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return File(dir, "projects.json")
    }

    fun listProjects(): List<MoeProjectInfo> {
        val file = registryFile()
        if (!file.exists()) return emptyList()
        return try {
            val type = object : TypeToken<List<MoeProjectInfo>>() {}.type
            val list = gson.fromJson<List<MoeProjectInfo>>(file.readText(), type) ?: emptyList()
            list
                .filter { File(it.path).exists() }
                .sortedByDescending { it.lastOpenedAt }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun registerProject(path: String, name: String) {
        val normalized = normalizePath(path)
        val now = Instant.now().toString()
        val existing = listProjects().filterNot { pathsEqual(it.path, normalized) }.toMutableList()
        existing.add(MoeProjectInfo(normalized, name, now))
        val file = registryFile()
        file.writeText(gson.toJson(existing.sortedByDescending { it.lastOpenedAt }))
    }

    private fun normalizePath(path: String): String {
        return File(path).absolutePath
    }

    private fun pathsEqual(a: String, b: String): Boolean {
        val normalizedA = normalizePath(a)
        val normalizedB = normalizePath(b)
        val isWindows = System.getProperty("os.name").lowercase().contains("win")
        return if (isWindows) {
            normalizedA.equals(normalizedB, ignoreCase = true)
        } else {
            normalizedA == normalizedB
        }
    }
}
