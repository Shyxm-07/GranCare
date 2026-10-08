package com.grancare.wear.data

import android.content.Context
import org.json.JSONArray
import java.time.Instant

/** Local cache of synced doses so alarms and the UI work offline. */
class DoseStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("gran_care", Context.MODE_PRIVATE)

    fun all(): List<Dose> = runCatching {
        val arr = JSONArray(prefs.getString(KEY_DOSES, "[]"))
        (0 until arr.length()).map { Dose.fromJson(arr.getJSONObject(it)) }
    }.getOrDefault(emptyList()).sortedBy { it.start }

    fun saveAll(doses: List<Dose>) {
        val arr = JSONArray(); doses.forEach { arr.put(it.toJson()) }
        prefs.edit().putString(KEY_DOSES, arr.toString()).putString(KEY_SYNCED, Instant.now().toString()).apply()
    }

    fun find(eventId: String): Dose? = all().firstOrNull { it.eventId == eventId }

    /** Applies a local outcome immediately (the calendar write happens in the background). */
    fun update(eventId: String, transform: (Dose) -> Dose) {
        saveAll(all().map { if (it.eventId == eventId) transform(it) else it })
    }

    fun lastSynced(): Instant? = prefs.getString(KEY_SYNCED, null)?.let { runCatching { Instant.parse(it) }.getOrNull() }

    var scheduledIds: Set<String>
        get() = prefs.getStringSet(KEY_SCHEDULED, emptySet()) ?: emptySet()
        set(v) { prefs.edit().putStringSet(KEY_SCHEDULED, v).apply() }

    var signedIn: Boolean
        get() = prefs.getBoolean(KEY_SIGNED_IN, false)
        set(v) { prefs.edit().putBoolean(KEY_SIGNED_IN, v).apply() }

    private companion object {
        const val KEY_DOSES = "doses"
        const val KEY_SYNCED = "synced_at"
        const val KEY_SCHEDULED = "scheduled_ids"
        const val KEY_SIGNED_IN = "signed_in"
    }
}
