package com.grancare.wear.data

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.grancare.wear.alarm.AlarmScheduler
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Pulls Gran Care doses from Google Calendar and (re)schedules the watch alarms. */
class SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val store = DoseStore(applicationContext)
        val token = Auth.token(applicationContext) ?: run {
            // Not signed in yet: keep ringing for doses we already know about.
            AlarmScheduler.reschedule(applicationContext, store.all()); return Result.success()
        }
        return try {
            val remote = CalendarApi(token).listDoses()
            // Keep local outcomes that have not reached the calendar yet.
            val local = store.all().associateBy { it.eventId }
            val merged = remote.map { r ->
                val l = local[r.eventId] ?: return@map r
                when {
                    l.status == Dose.Status.TAKEN && r.status != Dose.Status.TAKEN -> r.copy(status = Dose.Status.TAKEN)
                    l.status == Dose.Status.SNOOZED && r.status == Dose.Status.UPCOMING ->
                        r.copy(status = Dose.Status.SNOOZED, snoozedUntil = l.snoozedUntil)
                    else -> r
                }
            }
            store.saveAll(merged)
            AlarmScheduler.reschedule(applicationContext, merged)
            Result.success()
        } catch (e: CalendarApi.AuthExpired) {
            Result.retry()
        } catch (e: Exception) {
            AlarmScheduler.reschedule(applicationContext, store.all())
            Result.retry()
        }
    }

    companion object {
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedulePeriodic(context: Context) {
            val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("gc-sync", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun syncNow(context: Context) {
            val req = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniqueWork("gc-sync-now", ExistingWorkPolicy.REPLACE, req)
        }
    }
}

/** Writes an outcome (taken / snoozed) or an SOS to Google Calendar, retrying until online. */
class WriteWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val token = Auth.token(applicationContext) ?: return Result.retry()
        val api = CalendarApi(token)
        return try {
            when (inputData.getString(KEY_KIND)) {
                KIND_SOS -> api.createSos(Instant.parse(inputData.getString(KEY_AT)))
                else -> {
                    val id = inputData.getString(KEY_EVENT) ?: return Result.failure()
                    api.appendStatus(id, inputData.getString(KEY_LINE).orEmpty(), inputData.getBoolean(KEY_TAKEN, false))
                }
            }
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 20) Result.retry() else Result.failure()
        }
    }

    companion object {
        private const val KEY_KIND = "kind"; private const val KEY_EVENT = "event"; private const val KEY_LINE = "line"
        private const val KEY_TAKEN = "taken"; private const val KEY_AT = "at"; private const val KIND_SOS = "sos"

        private fun enqueue(context: Context, name: String, data: androidx.work.Data) {
            val req = OneTimeWorkRequestBuilder<WriteWorker>()
                .setInputData(data)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(name, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }

        fun markTaken(context: Context, eventId: String, at: Instant = Instant.now()) {
            DoseStore(context).update(eventId) { it.copy(status = Dose.Status.TAKEN) }
            enqueue(context, "gc-write-$eventId", workDataOf(KEY_EVENT to eventId, KEY_LINE to "${Dose.STATUS_MARKER} taken $at", KEY_TAKEN to true))
        }

        fun markSnoozed(context: Context, eventId: String, minutes: Long, at: Instant = Instant.now()) {
            DoseStore(context).update(eventId) { it.copy(status = Dose.Status.SNOOZED, snoozedUntil = at.plusSeconds(minutes * 60)) }
            enqueue(context, "gc-write-$eventId", workDataOf(KEY_EVENT to eventId, KEY_LINE to "${Dose.STATUS_MARKER} snoozed $at $minutes"))
        }

        fun sos(context: Context, at: Instant = Instant.now()) {
            enqueue(context, "gc-sos-$at", workDataOf(KEY_KIND to KIND_SOS, KEY_AT to at.toString()))
        }
    }
}
