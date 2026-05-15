package com.moe.util

import java.time.Duration
import java.time.Instant

/**
 * Lightweight duration formatting helpers used by the budget badge and
 * metrics surfaces. Kept small and dependency-free so it can be called
 * from EDT-sensitive render paths without imposing locale-specific work.
 */
object MoeDuration {

    /**
     * Humanise a millisecond duration in compact form. Returns "-" for null.
     *
     * Examples: 45_000 -> "45s"; 120_000 -> "2m"; 5_400_000 -> "1h 30m";
     * 90_000_000 -> "1d 1h"; 0 -> "0s".
     */
    fun humanise(ms: Long?): String {
        if (ms == null) return "-"
        if (ms <= 0) return "0s"
        val totalSeconds = ms / 1000
        val days = totalSeconds / 86_400
        val hours = (totalSeconds % 86_400) / 3_600
        val minutes = (totalSeconds % 3_600) / 60
        val seconds = totalSeconds % 60
        return when {
            days > 0 -> if (hours > 0) "${days}d ${hours}h" else "${days}d"
            hours > 0 -> if (minutes > 0) "${hours}h ${minutes}m" else "${hours}h"
            minutes > 0 -> if (seconds > 0 && minutes < 5) "${minutes}m ${seconds}s" else "${minutes}m"
            else -> "${seconds}s"
        }
    }

    /**
     * Parse an ISO-8601 instant, returning null on any failure.
     */
    fun parseInstant(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return try { Instant.parse(iso) } catch (_: Exception) { null }
    }

    /**
     * Milliseconds elapsed between two instants, clamped to >= 0.
     * Returns null if either side is null.
     */
    fun elapsedMs(from: Instant?, to: Instant?): Long? {
        if (from == null || to == null) return null
        val diff = Duration.between(from, to).toMillis()
        return if (diff < 0) 0L else diff
    }
}
