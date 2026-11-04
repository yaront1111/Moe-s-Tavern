package com.moe.model

import com.google.gson.JsonElement
import com.google.gson.JsonObject

/** The daemon's held execution readiness, as sent in EXECUTION_READINESS (CQ-M07d wire). */
data class ExecutionReadiness(
    val profile: String,
    val ready: Boolean,
    val missingCapabilities: List<String>,
    val evaluatedAt: String?
)

/** Outcome of one readiness request. Only [Answered] carries a readiness; every failure is a [Failed]. */
sealed interface ReadinessReply {
    data class Answered(val readiness: ExecutionReadiness) : ReadinessReply
    data class Failed(val reason: ReadinessFailure) : ReadinessReply
}

enum class ReadinessFailure { NOT_CONNECTED, DISCONNECTED, TIMEOUT, DAEMON_ERROR, MALFORMED }

/**
 * Strict EXECUTION_READINESS payload parser. It reads exactly the four fields
 * and ignores (never retains) unknown keys, so an additive daemon field cannot
 * break the client. A missing, wrong-typed or contradictory field gives null,
 * so a bad payload is never read as ready. Never throws.
 */
object ExecutionReadinessJson {
    private val PROFILES = setOf("legacy", "observe", "verified-local", "unreadable")
    private const val MAX_MISSING = 64
    private const val MAX_ID_LENGTH = 128

    fun parse(payload: JsonObject): ExecutionReadiness? {
        val profile = payload.get("profile").strictString()?.takeIf { it in PROFILES } ?: return null
        val readyElement = payload.get("ready")
        if (readyElement == null || !readyElement.isJsonPrimitive || !readyElement.asJsonPrimitive.isBoolean) return null
        val ready = readyElement.asBoolean
        val missing = parseMissing(payload.get("missingCapabilities")) ?: return null
        if (ready && missing.isNotEmpty()) return null
        val evaluatedElement = payload.get("evaluatedAt") ?: return null
        val evaluatedAt = if (evaluatedElement.isJsonNull) null else evaluatedElement.strictString() ?: return null
        return ExecutionReadiness(profile, ready, missing, evaluatedAt)
    }

    private fun parseMissing(element: JsonElement?): List<String>? {
        if (element == null || !element.isJsonArray) return null
        val array = element.asJsonArray
        if (array.size() > MAX_MISSING) return null
        val ids = ArrayList<String>(array.size())
        for (item in array) {
            val id = item.strictString() ?: return null
            if (id.isEmpty() || id.length > MAX_ID_LENGTH) return null
            ids.add(id)
        }
        return ids
    }

    private fun JsonElement?.strictString(): String? =
        if (this != null && isJsonPrimitive && asJsonPrimitive.isString) asString else null
}
