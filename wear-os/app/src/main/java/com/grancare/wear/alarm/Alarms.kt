package com.grancare.wear.alarm

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.grancare.wear.R
import com.grancare.wear.data.Dose
import com.grancare.wear.data.DoseStore
import com.grancare.wear.data.SyncWorker
import com.grancare.wear.ui.AlarmActivity
import com.grancare.wear.ui.MainActivity
import java.time.Instant

/** Exact alarms for every pending dose, so the watch rings even when offline. */
object AlarmScheduler {
    const val EXTRA_EVENT = "event_id"

    private fun pending(context: Context, eventId: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, eventId.hashCode(),
            Intent(context, AlarmReceiver::class.java).putExtra(EXTRA_EVENT, eventId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    fun reschedule(context: Context, doses: List<Dose>) {
        val am = context.getSystemService(AlarmManager::class.java)
        val store = DoseStore(context)
        val now = Instant.now()
        val wanted = doses.mapNotNull { d -> d.nextRing(now)?.takeIf { it.isAfter(now) }?.let { d.eventId to it } }.toMap()
        // Cancel alarms for doses that were taken, removed or moved.
        (store.scheduledIds - wanted.keys).forEach { am.cancel(pending(context, it)) }
        wanted.forEach { (id, at) -> setExact(context, am, id, at) }
        store.scheduledIds = wanted.keys
    }

    fun ringAgainIn(context: Context, eventId: String, minutes: Long) {
        val am = context.getSystemService(AlarmManager::class.java)
        setExact(context, am, eventId, Instant.now().plusSeconds(minutes * 60))
        DoseStore(context).let { it.scheduledIds = it.scheduledIds + eventId }
    }

    private fun setExact(context: Context, am: AlarmManager, eventId: String, at: Instant) {
        val pi = pending(context, eventId)
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
        if (canExact) {
            val show = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            am.setAlarmClock(AlarmManager.AlarmClockInfo(at.toEpochMilli(), show), pi)
        } else {
            // Without the exact-alarm permission the system may delay this by a few minutes.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at.toEpochMilli(), pi)
        }
    }

    const val CHANNEL = "gc_alarm"
    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.channel_alarm), NotificationManager.IMPORTANCE_HIGH).apply {
                    enableVibration(true); vibrationPattern = longArrayOf(0, 600, 300, 600, 300, 600)
                }
            )
        }
    }
}

/** Fires at dose time: shows the full-screen alarm (or a high-priority notification). */
class AlarmReceiver : BroadcastReceiver() {
    @SuppressLint("MissingPermission") // checked via `granted` below
    override fun onReceive(context: Context, intent: Intent) {
        val eventId = intent.getStringExtra(AlarmScheduler.EXTRA_EVENT) ?: return
        val dose = DoseStore(context).find(eventId) ?: return
        if (dose.status == Dose.Status.TAKEN) return
        AlarmScheduler.ensureChannel(context)

        val open = Intent(context, AlarmActivity::class.java)
            .putExtra(AlarmScheduler.EXTRA_EVENT, eventId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val full = PendingIntent.getActivity(context, eventId.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(context, AlarmScheduler.CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Time for your medicine")
            .setContentText(dose.displayName)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setAutoCancel(true)
            .build()
        val granted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (granted) NotificationManagerCompat.from(context).notify(eventId.hashCode(), n)
        else runCatching { context.startActivity(open) }
    }
}

/** Restores alarms after a reboot or when the exact-alarm permission changes. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AlarmScheduler.reschedule(context, DoseStore(context).all())
        SyncWorker.schedulePeriodic(context)
        SyncWorker.syncNow(context)
    }
}
