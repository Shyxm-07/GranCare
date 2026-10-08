package com.grancare.wear.ui

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.speech.tts.TextToSpeech
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.app.NotificationManagerCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Text
import com.grancare.wear.alarm.AlarmScheduler
import com.grancare.wear.data.Dose
import com.grancare.wear.data.DoseStore
import com.grancare.wear.data.WriteWorker
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.Locale

/** Full-screen dose alarm: rings, speaks, and records TAKEN / LATER back to Google Calendar. */
class AlarmActivity : ComponentActivity() {
    private var vibrator: Vibrator? = null
    private var tts: TextToSpeech? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true); setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val eventId = intent.getStringExtra(AlarmScheduler.EXTRA_EVENT)
        val dose = eventId?.let { DoseStore(this).find(it) }
        if (dose == null || dose.status == Dose.Status.TAKEN) { finish(); return }
        startRinging(dose)

        setContent {
            GranCareTheme {
                AlarmFlow(
                    dose = dose,
                    onTaken = { stopRinging(); dismissNotification(dose); WriteWorker.markTaken(this, dose.eventId) },
                    onLater = {
                        stopRinging(); dismissNotification(dose)
                        WriteWorker.markSnoozed(this, dose.eventId, SNOOZE_MIN)
                        AlarmScheduler.ringAgainIn(this, dose.eventId, SNOOZE_MIN)
                        finish()
                    },
                    onSos = { WriteWorker.sos(this) },
                    onDone = { finish() },
                )
            }
        }
    }

    private fun startRinging(dose: Dose) {
        vibrator = if (Build.VERSION.SDK_INT >= 31) getSystemService(VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400, 600, 1200), 0))
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.getDefault()
                val extra = if (dose.instructions.isNotBlank()) " ${dose.instructions}." else ""
                tts?.speak("It is time to take ${dose.displayName}.$extra", TextToSpeech.QUEUE_FLUSH, null, "gc-dose")
            }
        }
        // Never ring forever: stop after two minutes; the dose stays pending on the watch and calendar.
        window.decorView.postDelayed({ stopRinging() }, 120_000)
    }

    private fun stopRinging() { vibrator?.cancel(); tts?.stop() }

    private fun dismissNotification(dose: Dose) = NotificationManagerCompat.from(this).cancel(dose.eventId.hashCode())

    override fun onDestroy() { stopRinging(); tts?.shutdown(); super.onDestroy() }

    companion object { const val SNOOZE_MIN = 10L }
}

@Composable
private fun AlarmFlow(dose: Dose, onTaken: () -> Unit, onLater: () -> Unit, onSos: () -> Unit, onDone: () -> Unit) {
    var recorded by remember { mutableStateOf(false) }
    if (!recorded) AlarmScreen(dose, onTaken = { onTaken(); recorded = true }, onLater = onLater)
    else RecordedScreen(onSos = onSos, onDone = onDone)
}

/** Mirrors the Figma "Smartwatch Alarm" screen. */
@Composable
private fun AlarmScreen(dose: Dose, onTaken: () -> Unit, onLater: () -> Unit) {
    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize().background(GC.Face),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item { Text(Instant.now().clock(), color = GC.OnFace, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
        item {
            Box(Modifier.background(GC.Later, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp)) {
                Text("TIME FOR YOUR MEDICINE", color = GC.Mint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }
        item {
            Text(dose.displayName, color = androidx.compose.ui.graphics.Color.White, fontSize = 22.sp,
                fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        }
        if (dose.instructions.isNotBlank()) item {
            Box(Modifier.background(GC.Peach, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 6.dp)) {
                Text(dose.instructions, color = GC.PeachInk, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
            }
        }
        item {
            Chip(onClick = onTaken, modifier = Modifier.fillMaxWidth(),
                colors = ChipDefaults.chipColors(backgroundColor = GC.Taken, contentColor = androidx.compose.ui.graphics.Color.White),
                label = { Text("TAKEN", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) })
        }
        item {
            Chip(onClick = onLater, modifier = Modifier.fillMaxWidth(),
                colors = ChipDefaults.chipColors(backgroundColor = GC.Later, contentColor = GC.OnFace),
                label = { Text("LATER (10min)", fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth()) })
        }
    }
}

/** Mirrors the Figma "Smartwatch Dose Alert" (Dose Recorded) screen, incl. hold-3s caretaker alert. */
@Composable
private fun RecordedScreen(onSos: () -> Unit, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var holdLabel by remember { mutableStateOf("Hold 3s to Alert Caretaker") }
    LaunchedEffect(Unit) { delay(60_000); onDone() }
    Column(
        Modifier.fillMaxSize().background(GC.FaceRecorded).padding(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(44.dp).background(GC.Slate, CircleShape), contentAlignment = Alignment.Center) {
            Text("✓", color = androidx.compose.ui.graphics.Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        }
        Text("Dose Recorded", color = androidx.compose.ui.graphics.Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
        Text("Stop Vibration • Synced to Calendar", color = GC.SubBlue, fontSize = 11.sp, textAlign = TextAlign.Center)
        Chip(onClick = onDone, modifier = Modifier.padding(top = 8.dp),
            colors = ChipDefaults.chipColors(backgroundColor = GC.Slate, contentColor = androidx.compose.ui.graphics.Color.White),
            label = { Text("Done", fontSize = 13.sp, fontWeight = FontWeight.SemiBold) })
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.padding(top = 6.dp).fillMaxWidth().height(56.dp).pointerInput(Unit) {
                detectTapGestures(onPress = {
                    holdLabel = "Keep holding…"
                    val job = scope.launch { delay(3_000); onSos(); holdLabel = "Caretaker Alerted" }
                    tryAwaitRelease()
                    if (job.isActive) { job.cancel(); holdLabel = "Hold 3s to Alert Caretaker" }
                })
            },
        ) { Text(holdLabel, color = GC.Alert, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center) }
    }
}
