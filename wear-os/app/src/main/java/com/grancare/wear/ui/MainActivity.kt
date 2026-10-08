package com.grancare.wear.ui

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Text
import com.grancare.wear.alarm.AlarmScheduler
import com.grancare.wear.data.Auth
import com.grancare.wear.data.Dose
import com.grancare.wear.data.DoseStore
import com.grancare.wear.data.SyncWorker
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Home: connect Google Calendar, see today's doses, fix alarm permissions, sync. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AlarmScheduler.ensureChannel(this)
        SyncWorker.schedulePeriodic(this)
        setContent { GranCareTheme { Home() } }
    }

    override fun onResume() { super.onResume(); SyncWorker.syncNow(this) }
}

@Composable
private fun Home() {
    val ctx = LocalContext.current
    val store = remember { DoseStore(ctx) }
    val scope = rememberCoroutineScope()
    var doses by remember { mutableStateOf(store.all()) }
    var signedIn by remember { mutableStateOf(store.signedIn) }
    var message by remember { mutableStateOf<String?>(null) }

    // Refresh from the local store while visible (the sync worker updates it).
    LaunchedEffect(Unit) { while (true) { doses = store.all(); signedIn = store.signedIn; delay(5_000) } }

    val consent = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
        if (Auth.tokenFromConsent(ctx, res.data) != null) { store.signedIn = true; signedIn = true; SyncWorker.syncNow(ctx) }
        else message = "Calendar access was not granted."
    }
    val notifPerm = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) { if (Build.VERSION.SDK_INT >= 33) notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS) }

    val am = ctx.getSystemService(AlarmManager::class.java)
    val nm = ctx.getSystemService(NotificationManager::class.java)
    var tick by remember { mutableStateOf(0) }
    LaunchedEffect(Unit) { while (true) { delay(5_000); tick++ } } // re-check permissions after returning from Settings
    val needsExact = tick >= 0 && Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()
    val needsFullScreen = tick >= 0 && Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()

    val today = LocalDate.now()
    val todays = doses.filter { it.start.atZone(ZoneId.systemDefault()).toLocalDate() == today }
    val next = doses.firstOrNull { it.status != Dose.Status.TAKEN && it.start.isAfter(Instant.now().minusSeconds(3600)) }

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize().background(GC.Face),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item { Text("GRAN CARE", color = GC.Mint, fontSize = 14.sp, fontWeight = FontWeight.ExtraBold) }

        if (!signedIn) item {
            Chip(
                onClick = {
                    scope.launch {
                        when (val r = Auth.authorize(ctx)) {
                            is Auth.Outcome.Token -> { store.signedIn = true; signedIn = true; SyncWorker.syncNow(ctx) }
                            is Auth.Outcome.NeedsConsent -> consent.launch(IntentSenderRequest.Builder(r.intent.intentSender).build())
                            is Auth.Outcome.Failed -> message = "Could not reach Google. Check the watch is online."
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ChipDefaults.chipColors(backgroundColor = GC.Taken, contentColor = Color.White),
                label = { Text("Connect Google Calendar", fontWeight = FontWeight.SemiBold) },
                secondaryLabel = { Text("Get dose alarms on this watch", fontSize = 11.sp) },
            )
        }
        message?.let { m -> item { Text(m, color = GC.Alert, fontSize = 11.sp, textAlign = TextAlign.Center) } }

        if (needsExact) item {
            Chip(onClick = { openSettings(ctx, Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM) { message = it } },
                modifier = Modifier.fillMaxWidth(), colors = ChipDefaults.chipColors(backgroundColor = GC.Peach, contentColor = GC.PeachInk),
                label = { Text("Allow on-time alarms") })
        }
        if (needsFullScreen) item {
            Chip(onClick = { openSettings(ctx, Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT) { message = it } },
                modifier = Modifier.fillMaxWidth(), colors = ChipDefaults.chipColors(backgroundColor = GC.Peach, contentColor = GC.PeachInk),
                label = { Text("Allow full-screen alarms") })
        }

        item {
            Text(
                next?.let { "Next: ${it.displayName} at ${it.start.clock()}" } ?: if (signedIn) "No upcoming doses" else "Not connected",
                color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            )
        }
        todays.forEach { d ->
            item {
                val (label, bg) = when (d.status) {
                    Dose.Status.TAKEN -> "Taken" to GC.Slate
                    Dose.Status.SNOOZED -> "Snoozed" to GC.Later
                    Dose.Status.UPCOMING -> (if (d.start.isBefore(Instant.now().minusSeconds(3600))) "Missed" else "Upcoming") to GC.Later
                }
                Chip(
                    onClick = {
                        if (d.status != Dose.Status.TAKEN)
                            ctx.startActivity(Intent(ctx, AlarmActivity::class.java).putExtra(AlarmScheduler.EXTRA_EVENT, d.eventId))
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ChipDefaults.chipColors(backgroundColor = bg, contentColor = Color.White),
                    label = { Text(d.displayName, maxLines = 1) },
                    secondaryLabel = { Text("${d.start.clock()} • $label", fontSize = 11.sp, color = GC.OnFace) },
                )
            }
        }
        item {
            Chip(onClick = { SyncWorker.syncNow(ctx); message = null }, modifier = Modifier.fillMaxWidth(),
                colors = ChipDefaults.chipColors(backgroundColor = GC.Later, contentColor = GC.OnFace),
                label = { Text("Sync now") },
                secondaryLabel = { Text(store.lastSynced()?.let { "Last: ${it.clock()}" } ?: "Never synced", fontSize = 11.sp) })
        }
    }
}

/** Some watches have no screen for these settings; fall back to app info instead of crashing. */
private fun openSettings(ctx: android.content.Context, action: String, onError: (String) -> Unit) {
    val pkg = Uri.parse("package:${ctx.packageName}")
    runCatching { ctx.startActivity(Intent(action, pkg)) }
        .recoverCatching { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) }
        .onFailure { onError("Open Settings › Apps › Gran Care to allow alarms.") }
}
