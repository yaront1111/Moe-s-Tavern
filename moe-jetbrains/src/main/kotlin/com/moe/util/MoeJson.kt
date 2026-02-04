package com.moe.util

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.moe.model.ActivityEvent
import com.moe.model.Epic
import com.moe.model.ImplementationStep
import com.moe.model.MoeState
import com.moe.model.Project
import com.moe.model.RailProposal
import com.moe.model.Task

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
            name = projectJson.getStringOrDefault("name", "Unknown")
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
        val epics = parseEpics(epicsArray)
        val tasks = parseTasks(tasksArray)
        val proposals = parseProposals(proposalsArray)

        return MoeState(project, epics, tasks, proposals)
    }

    private fun parseEpics(array: JsonArray): List<Epic> {
        return array.mapNotNull { element ->
            val obj = element.asJsonObject
            val id = obj.getStringOrNull("id") ?: return@mapNotNull null
            val title = obj.getStringOrNull("title") ?: return@mapNotNull null
            Epic(
                id = id,
                title = title,
                description = obj.getStringOrDefault("description", ""),
                status = obj.getStringOrDefault("status", "PLANNED"),
                order = obj.getDoubleOrDefault("order", 0.0)
            )
        }
    }

    private fun parseTasks(array: JsonArray): List<Task> {
        return array.mapNotNull { element ->
            val obj = element.asJsonObject
            val id = obj.getStringOrNull("id") ?: return@mapNotNull null
            val epicId = obj.getStringOrNull("epicId") ?: return@mapNotNull null
            val dod = obj.get("definitionOfDone")
                ?.takeIf { it.isJsonArray }
                ?.asJsonArray
                ?.map { it.asString }
                ?: emptyList()
            val plan = obj.get("implementationPlan")
                ?.takeIf { it.isJsonArray }
                ?.asJsonArray
                ?.mapNotNull { parseImplementationStep(it.asJsonObject) }
                ?: emptyList()
            Task(
                id = id,
                epicId = epicId,
                title = obj.getStringOrDefault("title", "Untitled task"),
                description = obj.getStringOrDefault("description", ""),
                status = obj.getStringOrDefault("status", "BACKLOG"),
                order = obj.getDoubleOrDefault("order", 0.0),
                definitionOfDone = dod,
                implementationPlan = plan,
                prLink = obj.getStringOrNull("prLink"),
                reopenReason = obj.getStringOrNull("reopenReason"),
                assignedWorkerId = obj.getStringOrNull("assignedWorkerId")
            )
        }
    }

    private fun parseImplementationStep(obj: JsonObject): ImplementationStep {
        val files = obj.get("affectedFiles")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.map { it.asString }
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
            ?.map { it.asString }
            ?: emptyList()
        val plan = obj.get("implementationPlan")
            ?.takeIf { it.isJsonArray }
            ?.asJsonArray
            ?.mapNotNull { parseImplementationStep(it.asJsonObject) }
            ?: emptyList()
        return Task(
            id = obj.getStringOrDefault("id", "unknown"),
            epicId = obj.getStringOrDefault("epicId", "unknown"),
            title = obj.getStringOrDefault("title", "Untitled task"),
            description = obj.getStringOrDefault("description", ""),
            status = obj.getStringOrDefault("status", "BACKLOG"),
            order = obj.getDoubleOrDefault("order", 0.0),
            definitionOfDone = dod,
            implementationPlan = plan,
            prLink = obj.getStringOrNull("prLink"),
            reopenReason = obj.getStringOrNull("reopenReason"),
            assignedWorkerId = obj.getStringOrNull("assignedWorkerId")
        )
    }

    fun parseEpic(obj: JsonObject): Epic {
        return Epic(
            id = obj.getStringOrDefault("id", "unknown"),
            title = obj.getStringOrDefault("title", "Untitled epic"),
            description = obj.getStringOrDefault("description", ""),
            status = obj.getStringOrDefault("status", "PLANNED"),
            order = obj.getDoubleOrDefault("order", 0.0)
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
