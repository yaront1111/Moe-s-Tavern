package com.moe.services

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.StringReader
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * Which project the daemon on a recorded port serves, by its /health `projectPath`.
 *
 * daemon.json only proves which project wrote it: after this project's daemon dies, Windows can
 * reuse its pid and another project's daemon can take its port. A false [Foreign] is destructive
 * (the caller deletes daemon.json and spawns a second daemon), so the rule errs toward [Same] or
 * [Unknown]: only an absolute served path that differs by [DaemonIdentityProbe.comparableProjectPath]
 * is Foreign. A relative one is Unknown, because /health reports the daemon's raw --project, relative
 * to a cwd the IDE cannot know. The twin is moe-proxy's packages/moe-proxy/src/daemonIdentity.ts,
 * over comparableProjectPath in packages/moe-proxy/src/utils.ts.
 */
sealed interface DaemonIdentity {
    data object Same : DaemonIdentity
    data class Foreign(val projectPath: String) : DaemonIdentity
    data object Unknown : DaemonIdentity
}

object DaemonIdentityProbe {
    /** Same cap as daemon.json and the proxy's probe. */
    const val MAX_HEALTH_BODY_BYTES = 64 * 1024

    private val gson = Gson()
    private val DRIVE_ROOT = Regex("^([A-Za-z]):/(.*)$")
    private val MNT_DRIVE = Regex("^/mnt/([A-Za-z])(?:/(.*))?$")
    private val WSL_SHARE = Regex("^//(?:wsl\\$|wsl\\.localhost)/[^/]+(/.*)?$", RegexOption.IGNORE_CASE)
    private val ABSOLUTE = Regex("^(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/]|/)")

    /**
     * GETs http://127.0.0.1:[port]/health. Never throws; bounded by the connect timeout, a total
     * read deadline of [connectTimeoutMs] + [readTimeoutMs] (a trickling body), and the byte cap.
     * Blocking: never call it on the EDT.
     */
    fun probe(port: Int, projectPath: String, connectTimeoutMs: Int = 500, readTimeoutMs: Int = 1000): DaemonIdentity {
        if (port !in 1..65535) return DaemonIdentity.Unknown
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(connectTimeoutMs.toLong() + readTimeoutMs)
        var connection: HttpURLConnection? = null
        return try {
            // NO_PROXY: the IDE's HTTP proxy settings must never route a loopback probe.
            connection = URI("http", null, "127.0.0.1", port, "/health", null, null).toURL()
                .openConnection(Proxy.NO_PROXY) as HttpURLConnection
            connection.requestMethod = "GET"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            val status = connection.responseCode
            val stream = when (status) {
                200 -> connection.inputStream
                503 -> connection.errorStream
                else -> null
            }
            classify(status, stream?.use { readCapped(it, deadline) }, projectPath)
        } catch (_: Exception) {
            DaemonIdentity.Unknown
        } finally {
            connection?.disconnect()
        }
    }

    /** 200 (healthy) or 503 (unhealthy) with a JSON object naming an absolute projectPath; else Unknown. */
    internal fun classify(status: Int, body: String?, projectPath: String): DaemonIdentity {
        if ((status != 200 && status != 503) || body == null) return DaemonIdentity.Unknown
        val served = (parseStrict(body) as? JsonObject)?.get("projectPath")
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
            ?: return DaemonIdentity.Unknown
        if (!isAbsoluteAnyOs(served) || !isAbsoluteAnyOs(projectPath)) return DaemonIdentity.Unknown
        return if (comparableProjectPath(served) == comparableProjectPath(projectPath)) {
            DaemonIdentity.Same
        } else {
            DaemonIdentity.Foreign(served)
        }
    }

    /**
     * A form of [path] comparable across Windows, WSL and UNC spellings, whatever OS the IDE runs on:
     * `D:\x`, `D:/x/` and `/mnt/d/x` give `d:/x`; `\\wsl$\<distro>\x` and `//wsl.localhost/<distro>/x`
     * give `/x`; '.', '..' and duplicate slashes collapse. Drive and UNC forms are lowercased, POSIX
     * case is kept.
     */
    fun comparableProjectPath(path: String): String {
        var p = path.trim().replace('\\', '/')
        WSL_SHARE.matchEntire(p)?.let { p = it.groupValues[1].ifEmpty { "/" } }
        DRIVE_ROOT.matchEntire(p)?.let { return driveForm(it.groupValues[1], it.groupValues[2]) }
        if (p.startsWith("//")) return "//" + collapse(p.substring(2), keep = 2).lowercase()
        if (!p.startsWith("/")) return collapse(p, keep = 0)
        val posix = "/" + collapse(p, keep = 0)
        MNT_DRIVE.matchEntire(posix)?.let { return driveForm(it.groupValues[1], it.groupValues[2]) }
        return posix
    }

    /** A drive-letter, UNC or POSIX absolute path, whatever OS the IDE runs on (the proxy's rule). */
    fun isAbsoluteAnyOs(path: String): Boolean = ABSOLUTE.containsMatchIn(path)

    private fun driveForm(letter: String, rest: String): String {
        val tail = collapse(rest, keep = 0)
        return (if (tail.isEmpty()) "$letter:" else "$letter:/$tail").lowercase()
    }

    /** Drops empty, '.' and '..' segments; '..' never climbs past the first [keep] (a UNC server/share). */
    private fun collapse(path: String, keep: Int): String {
        val segments = ArrayList<String>()
        for (segment in path.split('/')) {
            when (segment) {
                "", "." -> {}
                ".." -> if (segments.size > keep) segments.removeAt(segments.size - 1)
                else -> segments.add(segment)
            }
        }
        return segments.joinToString("/")
    }

    /** At most MAX + 1 bytes before [deadline]; null past the cap or the deadline. */
    private fun readCapped(input: InputStream, deadline: Long): String? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (out.size() <= MAX_HEALTH_BODY_BYTES) {
            if (System.nanoTime() > deadline) return null
            val n = input.read(buffer, 0, minOf(buffer.size, MAX_HEALTH_BODY_BYTES + 1 - out.size()))
            if (n < 0) return out.toString(Charsets.UTF_8)
            out.write(buffer, 0, n)
        }
        return null
    }

    /** Strict, like the daemon's and the proxy's JSON.parse: JsonParser.parseString would be lenient. */
    private fun parseStrict(body: String): JsonElement? = try {
        val reader = JsonReader(StringReader(body)).apply { strictness = Strictness.STRICT }
        gson.getAdapter(JsonElement::class.java).read(reader).takeIf { reader.peek() == JsonToken.END_DOCUMENT }
    } catch (_: Exception) {
        null
    }
}
