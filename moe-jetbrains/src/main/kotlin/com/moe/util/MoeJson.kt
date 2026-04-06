package com.moe.util

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.moe.model.ActivityEvent
import com.moe.model.ChatChannel
import com.moe.model.ChatMessage
import com.moe.model.Decision
import com.moe.model.PinEntry
import com.moe.model.Epic
import com.moe.model.ImplementationStep
import com.moe.model.MoeState
import com.moe.model.Project
import com.moe.model.RailProposal
import com.moe.model.Task
import com.moe.model.TaskComment
import com.moe.model.Team
import com.moe.model.Worker

object MoeJson {
    private fun JsonObject.getStringOrNull(key: String): String? {
        val element = get(key) ?: return null
        if (element.isJsonNull) return null
        return element.asString
    }

    private fun JsonObject.getStringOrDefault(key: String, default: String): String {
        val element = get(key)
        return if (element == null || element.isJsonNull) default else element.asString
    }

    private fun JsonObject.getDoubleOrDefault(key: String, default: Double): Double {
        val element = get(key)
        if (element == null || element.isJsonNull) return default
        return try {
            element.asDouble
        } catch (_: Exception) {
            default
        }
    }

    fun parseState(payload: JsonObject): MoeState {
        val projectJson = payload.get("project")
            ?.takeIf { it.isJsonObject }
            ?.asJsonObject
            ?: JsonObject()
        val project = Project(
            id = projectJson.getStringOrDefault("id", "unknown"),
            name = projectJson.getStringOrDefault("name", "Unknown"),
            rootPath = projectJson.getStringOrDefault("rootPath", "")
        )

        val epicsArray = payload.get("epics")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?: JsonArray()
        val tasksArray = payload.get("tasks")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?: JsonArray()
        val proposalsArray = payload.get("proposals")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?: JsonArray()
        val workersArray = payload.get("workers")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?: JsonArray()
        val teamsArray = payload.get("teams")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?: JsonArray()
        val channelsArray = payload.get("channels")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?: JsonArray()
        val epics = parseEpics(epicsArray)
        val tasks = parseTasks(tasksArray)
        val proposals = parseProposals(proposalsArray)
        val workers = parseWorkers(workersArray)
        val teams = parseTeams(teamsArray)
        val channels = parseChannels(channelsArray)

        return MoeState(project, epics, tasks, proposals, workers, teams, channels)
    }

    private fun parseEpics(array: JsonArray): List<Epic> {
        return array.mapNotNull { element ->
            val obj = element.asJsonObject
            val id = obj.getStringOrNull("id") ?: return@mapNotNull null
            val title = obj.getStringOrNull("title") ?: return@mapNotNull null
            val rails = obj.get("epicRails")
                ?.takeIf { it.isJsonArray }
                ?.asJsonArray
                ?.mapNotNull { if (it.isJsonNull) null else it.asString }
                ?: emptyList()
            Epic(
                id = id,
                title = title,
                description = obj.getStringOrDefault("description", ""),
                architectureNotes = obj.getStringOrDefault("architectureNotes", ""),
                epicRails = rails,
                status = obj.getStringOrDefault("status", "PLANNED"),
                order = obj.getDoubleOrDefault("order", 0.0),
                createdAt = obj.getStringOrDefault("createdAt", ""),
                updatedAt = obj.getStringOrDefault("updatedAt", "")
            )
        }
    }

    private fun parseComments(obj: JsonObject): List<TaskComment> {
        return obj.get("comments")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { element ->
                if (!element.isJsonObject) return@mapNotNull null
                val c = element.asJsonObject
                TaskComment(
                    id = c.getStringOrDefault("id", "unknown"),
                    author = c.getStringOrDefault("author", "unknown"),
                    content = c.getStringOrDefault("content", ""),
                    timestamp = c.getStringOrDefault("timestamp", "")
                )
            }
            ?: emptyList()
    }

    private fun getBooleanOrDefault(obj: JsonObject, key: String, default: Boolean): Boolean {
        val element = obj.get(key) ?: return default
        if (element.isJsonNull) return default
        return try { element.asBoolean } catch (_: Exception) { default }
    }

    private fun parseTasks(array: JsonArray): List<Task> {
        return array.mapNotNull { element ->
            val obj = element.asJsonObject
            val id = obj.getStringOrNull("id") ?: return@mapNotNull null
            val epicId = obj.getStringOrNull("epicId") ?: return@mapNotNull null
            val dod = obj.get("definitionOfDone")
                ?.takeIf { it.isJsonArray }
                ?.asJsonArray
                ?.mapNotNull { if (it.isJsonNull) null else it.asString }
                ?: emptyList()
            val plan = obj.get("implementationPlan")
                ?.takeIf { it.isJsonArray }
                ?.asJsonArray
                ?.mapNotNull { if (it.isJsonNull || !it.isJsonObject) null else parseImplementationStep(it.asJsonObject) }
                ?: emptyList()
            Task(
                id = id,
                epicId = epicId,
                title = obj.getStringOrDefault("title", "Untitled task"),
                description = obj.getStringOrDefault("description", ""),
                status = obj.getStringOrDefault("status", "BACKLOG"),
                priority = obj.getStringOrDefault("priority", "MEDIUM"),
                order = obj.getDoubleOrDefault("order", 0.0),
                definitionOfDone = dod,
                implementationPlan = plan,
                prLink = obj.getStringOrNull("prLink"),
                reopenReason = obj.getStringOrNull("reopenReason"),
                assignedWorkerId = obj.getStringOrNull("assignedWorkerId"),
                comments = parseComments(obj),
                hasPendingQuestion = getBooleanOrDefault(obj, "hasPendingQuestion", false)
            )
        }
    }

    private fun parseImplementationStep(obj: JsonObject): ImplementationStep {
        val files = obj.get("affectedFiles")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { if (it.isJsonNull) null else it.asString }
            ?: emptyList()
        return ImplementationStep(
            stepId = obj.getStringOrDefault("stepId", "unknown"),
            description = obj.getStringOrDefault("description", ""),
            status = obj.getStringOrDefault("status", "PENDING"),
            affectedFiles = files
        )
    }

    fun parseTask(obj: JsonObject): Task {
        val dod = obj.get("definitionOfDone")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { if (it.isJsonNull) null else it.asString }
            ?: emptyList()
        val plan = obj.get("implementationPlan")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { if (it.isJsonNull || !it.isJsonObject) null else parseImplementationStep(it.asJsonObject) }
            ?: emptyList()
        return Task(
            id = obj.getStringOrDefault("id", "unknown"),
            epicId = obj.getStringOrDefault("epicId", "unknown"),
            title = obj.getStringOrDefault("title", "Untitled task"),
            description = obj.getStringOrDefault("description", ""),
            status = obj.getStringOrDefault("status", "BACKLOG"),
            priority = obj.getStringOrDefault("priority", "MEDIUM"),
            order = obj.getDoubleOrDefault("order", 0.0),
            definitionOfDone = dod,
            implementationPlan = plan,
            prLink = obj.getStringOrNull("prLink"),
            reopenReason = obj.getStringOrNull("reopenReason"),
            assignedWorkerId = obj.getStringOrNull("assignedWorkerId"),
            comments = parseComments(obj),
            hasPendingQuestion = getBooleanOrDefault(obj, "hasPendingQuestion", false)
        )
    }

    fun parseEpic(obj: JsonObject): Epic {
        val rails = obj.get("epicRails")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { if (it.isJsonNull) null else it.asString }
            ?: emptyList()
        return Epic(
            id = obj.getStringOrDefault("id", "unknown"),
            title = obj.getStringOrDefault("title", "Untitled epic"),
            description = obj.getStringOrDefault("description", ""),
            architectureNotes = obj.getStringOrDefault("architectureNotes", ""),
            epicRails = rails,
            status = obj.getStringOrDefault("status", "PLANNED"),
            order = obj.getDoubleOrDefault("order", 0.0),
            createdAt = obj.getStringOrDefault("createdAt", ""),
            updatedAt = obj.getStringOrDefault("updatedAt", "")
        )
    }

    private fun parseProposals(array: JsonArray): List<RailProposal> {
        return array.mapNotNull { element ->
            if (!element.isJsonObject) return@mapNotNull null
            parseProposal(element.asJsonObject)
        }
    }

    fun parseProposal(obj: JsonObject): RailProposal {
        return RailProposal(
            id = obj.getStringOrDefault("id", "unknown"),
            workerId = obj.getStringOrDefault("workerId", ""),
            taskId = obj.getStringOrDefault("taskId", ""),
            proposalType = obj.getStringOrDefault("proposalType", "ADD_RAIL"),
            targetScope = obj.getStringOrDefault("targetScope", "TASK"),
            currentValue = obj.getStringOrNull("currentValue"),
            proposedValue = obj.getStringOrDefault("proposedValue", ""),
            reason = obj.getStringOrDefault("reason", ""),
            status = obj.getStringOrDefault("status", "PENDING"),
            createdAt = obj.getStringOrDefault("createdAt", "")
        )
    }

    private fun parseWorkers(array: JsonArray): List<Worker> {
        return array.mapNotNull { element ->
            if (!element.isJsonObject) return@mapNotNull null
            parseWorker(element.asJsonObject)
        }
    }

    fun parseWorker(obj: JsonObject): Worker {
        return Worker(
            id = obj.getStringOrDefault("id", "unknown"),
            type = obj.getStringOrDefault("type", "CLAUDE"),
            epicId = obj.getStringOrDefault("epicId", ""),
            currentTaskId = obj.getStringOrNull("currentTaskId"),
            status = obj.getStringOrDefault("status", "IDLE"),
            lastError = obj.getStringOrNull("lastError"),
            teamId = obj.getStringOrNull("teamId")
        )
    }

    private fun parseTeams(array: JsonArray): List<Team> {
        return array.mapNotNull { element ->
            if (!element.isJsonObject) return@mapNotNull null
            parseTeam(element.asJsonObject)
        }
    }

    fun parseTeam(obj: JsonObject): Team {
        val memberIds = obj.get("memberIds")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { if (it.isJsonNull) null else it.asString }
            ?: emptyList()
        val maxSize = obj.get("maxSize")?.let {
            if (it.isJsonNull) 10 else try { it.asInt } catch (_: Exception) { 10 }
        } ?: 10
        return Team(
            id = obj.getStringOrDefault("id", "unknown"),
            name = obj.getStringOrDefault("name", ""),
            role = obj.getStringOrDefault("role", "worker"),
            memberIds = memberIds,
            maxSize = maxSize
        )
    }

    private fun parseChannels(array: JsonArray): List<ChatChannel> {
        return array.mapNotNull { element ->
            if (!element.isJsonObject) return@mapNotNull null
            parseChannel(element.asJsonObject)
        }
    }

    fun parseChannel(obj: JsonObject): ChatChannel {
        return ChatChannel(
            id = obj.getStringOrDefault("id", "unknown"),
            name = obj.getStringOrDefault("name", ""),
            type = obj.getStringOrDefault("type", "general"),
            linkedEntityId = obj.getStringOrNull("linkedEntityId"),
            createdAt = obj.getStringOrDefault("createdAt", "")
        )
    }

    fun parseChatMessage(obj: JsonObject): ChatMessage {
        val mentions = obj.get("mentions")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { if (it.isJsonNull) null else it.asString }
            ?: emptyList()
        return ChatMessage(
            id = obj.getStringOrDefault("id", "unknown"),
            channel = obj.getStringOrDefault("channel", ""),
            sender = obj.getStringOrDefault("sender", "unknown"),
            content = obj.getStringOrDefault("content", ""),
            replyTo = obj.getStringOrNull("replyTo"),
            mentions = mentions,
            timestamp = obj.getStringOrDefault("timestamp", ""),
            decisionId = obj.getStringOrNull("decisionId")
        )
    }

    fun parsePinEntry(obj: JsonObject): PinEntry {
        return PinEntry(
            messageId = obj.getStringOrDefault("messageId", "unknown"),
            pinnedBy = obj.getStringOrDefault("pinnedBy", "unknown"),
            pinnedAt = obj.getStringOrDefault("pinnedAt", ""),
            done = getBooleanOrDefault(obj, "done", false),
            doneAt = obj.getStringOrNull("doneAt")
        )
    }

    fun parseDecision(obj: JsonObject): Decision {
        return Decision(
            id = obj.getStringOrDefault("id", "unknown"),
            proposedBy = obj.getStringOrDefault("proposedBy", "unknown"),
            content = obj.getStringOrDefault("content", ""),
            status = obj.getStringOrDefault("status", "proposed"),
            approvedBy = obj.getStringOrNull("approvedBy"),
            channel = obj.getStringOrNull("channel"),
            messageId = obj.getStringOrNull("messageId"),
            createdAt = obj.getStringOrDefault("createdAt", ""),
            resolvedAt = obj.getStringOrNull("resolvedAt")
        )
    }

    fun parseActivityEvents(array: JsonArray): List<ActivityEvent> {
        return array.mapNotNull { element ->
            if (!element.isJsonObject) return@mapNotNull null
            parseActivityEvent(element.asJsonObject)
        }
    }

    fun parseActivityEvent(obj: JsonObject): ActivityEvent {
        val payloadObj = obj.get("payload")
            ?.takeIf { it.isJsonObject }
            ?.asJsonObject
        val payload = payloadObj?.entrySet()?.associate { (k, v) ->
            k to when {
                v.isJsonNull -> null
                v.isJsonPrimitive -> {
                    val prim = v.asJsonPrimitive
                    when {
                        prim.isBoolean -> prim.asBoolean
                        prim.isNumber -> prim.asNumber
                        else -> prim.asString
                    }
                }
                else -> v.toString()
            }
        } ?: emptyMap()

        return ActivityEvent(
            id = obj.getStringOrDefault("id", "unknown"),
            timestamp = obj.getStringOrDefault("timestamp", ""),
            projectId = obj.getStringOrDefault("projectId", ""),
            epicId = obj.getStringOrNull("epicId"),
            taskId = obj.getStringOrNull("taskId"),
            workerId = obj.getStringOrNull("workerId"),
            event = obj.getStringOrDefault("event", "UNKNOWN"),
            payload = payload
        )
    }
}
