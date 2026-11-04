package com.moe.util

import com.moe.model.ExecutionReadiness
import com.moe.model.ReadinessFailure
import com.moe.model.ReadinessReply

/**
 * The pure Start Agent decision under verified-local (CQ-M07o). A worker or QA seat of a project that declares
 * verified-local, or whose declaration cannot be read strictly, starts only after the daemon reports verified-local
 * and ready; the wrapper's VM route then runs its agent. Every other answer refuses, and nothing falls back to the host.
 */
internal object VerifiedLocalLaunch {
    /** The agent CLIs a Moe VM runs: the guest JOBS table (AGENT_JOBS in scripts/local-runner/guest-bridge.mjs). */
    val VM_AGENT_COMMANDS = setOf("claude", "codex")

    private const val MAX_SHOWN_COMMAND = 200
    private const val MAX_SHOWN_ID = 64
    private const val MAX_SHOWN_IDS = 32
    private val UNSAFE_ID_CHAR = Regex("[^A-Za-z0-9._-]")
    private const val NOTHING_STARTED = "Nothing was started, and Moe never runs these agents on this machine instead."

    sealed interface Decision {
        object Launch : Decision
        data class Refused(val message: String) : Decision
    }

    /** UNTRUSTED counts on purpose: a project that might be verified-local never gets a host launch. */
    fun isVmSeat(role: String, declared: DeclaredProfile): Boolean =
        (role == "worker" || role == "qa") && declared != DeclaredProfile.LEGACY_LIKE

    /** A VM seat always takes the native PowerShell wrapper on Windows, whatever "Run Agents in WSL" says. */
    fun preferBash(vmSeat: Boolean, wslAgents: Boolean): Boolean = !vmSeat && wslAgents

    /** Null for an agent CLI a Moe VM can run; otherwise the refusal naming [command]. */
    fun agentRefusal(command: String): String? {
        val trimmed = command.trim()
        if (trimmed in VM_AGENT_COMMANDS) return null
        val shown = trimmed.take(MAX_SHOWN_COMMAND).map { if (Character.isISOControl(it)) '?' else it }.joinToString("")
        return "Verified-local runs worker and QA agents only in a Moe VM, which has claude and codex. " +
            "'$shown' cannot run there, so no agent was started. Pick Claude or Codex in the Agents menu."
    }

    /** [seats] is "worker", "QA" or "worker and QA". Never throws; only a ready verified-local answer launches. */
    fun decide(seats: String, reply: ReadinessReply): Decision {
        val lead = "Moe did not start the $seats ${if (" and " in seats) "agents" else "agent"}:"
        return when (reply) {
            is ReadinessReply.Answered -> answered(lead, reply.readiness)
            is ReadinessReply.Failed -> Decision.Refused("$lead ${failure(reply.reason)}.\n$NOTHING_STARTED")
        }
    }

    private fun answered(lead: String, readiness: ExecutionReadiness): Decision = when {
        readiness.profile != "verified-local" -> Decision.Refused(
            "$lead the daemon reports the '${shown(readiness.profile)}' execution profile, while .moe/project.json " +
                "asks for verified-local or could not be read strictly.\n$NOTHING_STARTED"
        )
        readiness.ready && readiness.missingCapabilities.isEmpty() -> Decision.Launch
        else -> Decision.Refused(
            (listOf("$lead verified-local is not ready on this machine.") +
                missingLines(readiness.missingCapabilities) + NOTHING_STARTED).joinToString("\n")
        )
    }

    private fun failure(reason: ReadinessFailure): String = when (reason) {
        ReadinessFailure.NOT_CONNECTED -> "the Moe daemon is not connected"
        ReadinessFailure.DISCONNECTED -> "the Moe daemon's connection closed before it answered"
        ReadinessFailure.TIMEOUT -> "the Moe daemon did not answer within 20 seconds"
        ReadinessFailure.DAEMON_ERROR -> "the Moe daemon could not report its readiness"
        ReadinessFailure.MALFORMED -> "the Moe daemon's readiness answer could not be read"
    }

    private fun missingLines(ids: List<String>): List<String> {
        val lines = ids.take(MAX_SHOWN_IDS).map { "- missing: ${shown(it)}" }
        return if (ids.size > MAX_SHOWN_IDS) lines + "…and ${ids.size - MAX_SHOWN_IDS} more" else lines
    }

    // Daemon text keeps only [A-Za-z0-9._-] and at most 64 characters, so it cannot inject markup or control characters.
    private fun shown(value: String): String = value.take(MAX_SHOWN_ID).replace(UNSAFE_ID_CHAR, "?")
}
