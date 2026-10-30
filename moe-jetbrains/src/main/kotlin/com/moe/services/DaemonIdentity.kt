package com.moe.services

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.Strictness
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import java.io.ByteArrayOutputStream
import java.io.StringReader
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
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

    /** The body cap plus room for the status line and headers. */
    private const val MAX_REPLY_BYTES = MAX_HEALTH_BODY_BYTES + 8 * 1024

    private val gson = Gson()
    private val STATUS_LINE = Regex("^HTTP/1\\.[01] (\\d{3})(?: .*)?$")
    private val DRIVE_ROOT = Regex("^([A-Za-z]):/(.*)$")
    private val MNT_DRIVE = Regex("^/mnt/([A-Za-z])(?:/(.*))?$")
    private val WSL_SHARE = Regex("^//(?:wsl\\$|wsl\\.localhost)/[^/]+(/.*)?$", RegexOption.IGNORE_CASE)
    private val ABSOLUTE = Regex("^(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/]|/)")

    /**
     * GETs http://127.0.0.1:[port]/health. Never throws. The whole exchange (connect, status line,
     * headers and body) ends by [connectTimeoutMs] + [readTimeoutMs], with no silence over
     * [readTimeoutMs] and at most the reply cap read, and the socket is closed on every path.
     * Blocking: never call it on the EDT.
     */
    fun probe(port: Int, projectPath: String, connectTimeoutMs: Int = 500, readTimeoutMs: Int = 1000): DaemonIdentity {
        if (port !in 1..65535) return DaemonIdentity.Unknown
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(connectTimeoutMs.toLong() + readTimeoutMs)
        return try {
            // NO_PROXY: no IDE proxy selector may route a loopback probe. A raw socket follows no redirect.
            Socket(Proxy.NO_PROXY).use { socket ->
                socket.connect(InetSocketAddress("127.0.0.1", port), connectTimeoutMs.coerceAtLeast(1))
                // HTTP/1.0: the daemon (Node) then neither chunks the body nor keeps the connection, so EOF ends it.
                socket.getOutputStream().write(
                    "GET /health HTTP/1.0\r\nHost: 127.0.0.1:$port\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII)
                )
                readReply(socket, deadline, readTimeoutMs)?.let { parseReply(it, projectPath) } ?: DaemonIdentity.Unknown
            }
        } catch (_: Exception) {
            DaemonIdentity.Unknown
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

    /**
     * The raw reply up to EOF; null past [deadline] or the cap. A read timeout alone restarts on every
     * byte, so trickled headers could hold the caller forever: each read waits at most the time left.
     */
    private fun readReply(socket: Socket, deadline: Long, readTimeoutMs: Int): ByteArray? {
        val input = socket.getInputStream()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (out.size() <= MAX_REPLY_BYTES) {
            val leftMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
            if (leftMs <= 0) return null
            socket.soTimeout = minOf(readTimeoutMs.toLong(), leftMs).toInt().coerceAtLeast(1)
            val n = input.read(buffer, 0, minOf(buffer.size, MAX_REPLY_BYTES + 1 - out.size()))
            if (n < 0) return out.toByteArray()
            out.write(buffer, 0, n)
        }
        return null
    }

    /** A status line and headers ending in a blank line, then a body within its cap; else Unknown. */
    private fun parseReply(reply: ByteArray, projectPath: String): DaemonIdentity {
        val text = String(reply, Charsets.ISO_8859_1) // one char per byte, so offsets are byte offsets
        val headEnd = text.indexOf("\r\n\r\n")
        val status = STATUS_LINE.matchEntire(text.substringBefore("\r\n"))?.groupValues?.get(1)?.toInt()
        if (headEnd < 0 || status == null) return DaemonIdentity.Unknown
        val body = reply.copyOfRange(headEnd + 4, reply.size)
        if (body.size > MAX_HEALTH_BODY_BYTES) return DaemonIdentity.Unknown
        return classify(status, String(body, Charsets.UTF_8), projectPath)
    }

    /** Strict, like the daemon's and the proxy's JSON.parse: JsonParser.parseString would be lenient. */
    private fun parseStrict(body: String): JsonElement? = try {
        val reader = JsonReader(StringReader(body)).apply { strictness = Strictness.STRICT }
        gson.getAdapter(JsonElement::class.java).read(reader).takeIf { reader.peek() == JsonToken.END_DOCUMENT }
    } catch (_: Exception) {
        null
    }
}
