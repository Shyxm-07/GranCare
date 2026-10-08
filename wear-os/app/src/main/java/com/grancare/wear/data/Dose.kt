package com.grancare.wear.data

import org.json.JSONObject
import java.time.Instant

/**
 * One scheduled dose, read from a Google Calendar event created by the Gran Care web app.
 *
 * Shared contract with the web app (keep both sides in step):
 *  - summary:      "💊 <medication> <dosage>"
 *  - description:  contains a line  "[gran-care] med=<medId> slot=<slotKey> day=<YYYY-MM-DD>"
 *                  and optionally   "Instructions: <text>"
 *  - outcomes are appended as lines "[gran-care-status] taken <ISO-8601>"
 *                                   "[gran-care-status] snoozed <ISO-8601> <minutes>"
 *  - help requests are separate events whose description contains "[gran-care-sos] at=<ISO-8601>"
 */
data class Dose(
    val eventId: String,
    val title: String,
    val instructions: String,
    val medId: String,
    val slot: String,
    val day: String,
    val start: Instant,
    val status: Status,
    val snoozedUntil: Instant? = null,
) {
    enum class Status { UPCOMING, TAKEN, SNOOZED }

    /** Medication name without the leading pill emoji or a "✓ " taken prefix. */
    val displayName: String get() = title.removePrefix("✓ ").removePrefix("💊").trim()

    /** When the watch should ring next for this dose, or null if nothing is pending. */
    fun nextRing(now: Instant = Instant.now()): Instant? = when (status) {
        Status.TAKEN -> null
        Status.SNOOZED -> snoozedUntil?.takeIf { it.isAfter(now) } ?: start.takeIf { it.isAfter(now) }
        Status.UPCOMING -> start
    }

    fun toJson(): JSONObject = JSONObject()
        .put("eventId", eventId).put("title", title).put("instructions", instructions)
        .put("medId", medId).put("slot", slot).put("day", day)
        .put("start", start.toString()).put("status", status.name)
        .put("snoozedUntil", snoozedUntil?.toString() ?: JSONObject.NULL)

    companion object {
        const val MARKER = "[gran-care]"
        const val STATUS_MARKER = "[gran-care-status]"
        const val SOS_MARKER = "[gran-care-sos]"

        fun fromJson(o: JSONObject) = Dose(
            eventId = o.getString("eventId"), title = o.getString("title"),
            instructions = o.optString("instructions"), medId = o.optString("medId"),
            slot = o.optString("slot"), day = o.optString("day"),
            start = Instant.parse(o.getString("start")),
            status = runCatching { Status.valueOf(o.getString("status")) }.getOrDefault(Status.UPCOMING),
            snoozedUntil = o.optString("snoozedUntil").takeIf { it.isNotEmpty() && it != "null" }?.let { Instant.parse(it) },
        )

        /** Parses a Calendar API event; returns null when it is not a Gran Care dose. */
        fun fromEvent(e: JSONObject): Dose? {
            val desc = e.optString("description")
            val markerLine = desc.lines().firstOrNull { it.trim().startsWith(MARKER) } ?: return null
            val fields = markerLine.trim().removePrefix(MARKER).trim().split(Regex("\\s+"))
                .mapNotNull { kv -> kv.split("=", limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
            val startObj = e.optJSONObject("start") ?: return null
            val startStr = startObj.optString("dateTime").ifEmpty { return null }
            val start = runCatching { java.time.OffsetDateTime.parse(startStr).toInstant() }.getOrNull() ?: return null

            var status = Status.UPCOMING
            var snoozedUntil: Instant? = null
            desc.lines().map { it.trim() }.filter { it.startsWith(STATUS_MARKER) }.forEach { line ->
                val parts = line.removePrefix(STATUS_MARKER).trim().split(Regex("\\s+"))
                when (parts.getOrNull(0)) {
                    "taken" -> status = Status.TAKEN
                    "snoozed" -> if (status != Status.TAKEN) {
                        status = Status.SNOOZED
                        val at = parts.getOrNull(1)?.let { runCatching { Instant.parse(it) }.getOrNull() }
                        val mins = parts.getOrNull(2)?.toLongOrNull() ?: 10L
                        snoozedUntil = at?.plusSeconds(mins * 60)
                    }
                }
            }
            val instructions = desc.lines().firstOrNull { it.trim().startsWith("Instructions:") }
                ?.substringAfter("Instructions:")?.trim().orEmpty()
            return Dose(
                eventId = e.getString("id"), title = e.optString("summary", "Medication"),
                instructions = instructions, medId = fields["med"].orEmpty(), slot = fields["slot"].orEmpty(),
                day = fields["day"].orEmpty(), start = start, status = status, snoozedUntil = snoozedUntil,
            )
        }
    }
}
