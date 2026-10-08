package com.grancare.wear.data

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.Instant
import java.time.temporal.ChronoUnit

/** Minimal Google Calendar v3 client (primary calendar) over HttpURLConnection. */
class CalendarApi(private val token: String) {
    private val base = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

    class AuthExpired : IOException("Calendar access token expired")

    /** Gran Care doses from a little in the past to ~36 hours ahead. */
    fun listDoses(now: Instant = Instant.now()): List<Dose> {
        val q = mapOf(
            "timeMin" to now.minus(3, ChronoUnit.HOURS).toString(),
            "timeMax" to now.plus(36, ChronoUnit.HOURS).toString(),
            "singleEvents" to "true", "orderBy" to "startTime",
            "q" to "gran-care", "maxResults" to "100",
        ).entries.joinToString("&") { (k, v) -> k + "=" + URLEncoder.encode(v, "UTF-8") }
        val items = request("GET", "$base?$q").optJSONArray("items") ?: return emptyList()
        return (0 until items.length()).mapNotNull { Dose.fromEvent(items.getJSONObject(it)) }
    }

    /** Appends an outcome line to the event description (and ticks the title when taken). */
    fun appendStatus(eventId: String, line: String, taken: Boolean) {
        val ev = request("GET", "$base/${enc(eventId)}")
        val desc = ev.optString("description").trimEnd()
        val body = JSONObject().put("description", if (desc.isEmpty()) line else "$desc\n$line")
        val summary = ev.optString("summary")
        if (taken && !summary.startsWith("✓ ")) body.put("summary", "✓ $summary")
        // HttpURLConnection has no PATCH; Google APIs accept the method override header.
        request("POST", "$base/${enc(eventId)}", body, mapOf("X-HTTP-Method-Override" to "PATCH"))
    }

    /** Creates a short "help requested" event the web app imports as an SOS for the caretaker. */
    fun createSos(at: Instant = Instant.now()) {
        val body = JSONObject()
            .put("summary", "🆘 Gran Care: help requested")
            .put("description", "${Dose.SOS_MARKER} at=$at\nSent from the Gran Care watch app.")
            .put("start", JSONObject().put("dateTime", at.toString()))
            .put("end", JSONObject().put("dateTime", at.plus(15, ChronoUnit.MINUTES).toString()))
        request("POST", base, body)
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun request(method: String, url: String, body: JSONObject? = null, headers: Map<String, String> = emptyMap()): JSONObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000; readTimeout = 20_000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
            headers.forEach { (k, v) -> setRequestProperty(k, v) }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        try {
            val code = conn.responseCode
            if (code == 401) throw AuthExpired()
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw IOException("Calendar API $code: ${text.take(200)}")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }
}
