package com.grancare.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.MaterialTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Palette taken from the Figma smartwatch screens (Smartwatch Alarm / Smartwatch Dose Alert). */
object GC {
    val Face = Color(0xFF283044)        // alarm watch face
    val FaceRecorded = Color(0xFF2D3136) // dose-recorded watch face
    val Mint = Color(0xFF9BF2E8)        // "TIME FOR YOUR MEDICINE" pill, accents
    val OnFace = Color(0xFFDAE2FD)      // secondary text on face
    val Ink = Color(0xFF131B2E)
    val Taken = Color(0xFF0D766E)       // TAKEN button
    val Later = Color(0x26DAE2FD)       // LATER button (rgba(218,226,253,0.15))
    val Peach = Color(0xFFFFDCC3)       // instruction chip
    val PeachInk = Color(0xFF2F1500)
    val Slate = Color(0xFF43617C)       // recorded check / secondary button
    val SubBlue = Color(0xFFCDE5FF)
    val Alert = Color(0xFFFFB4AB)       // caretaker alert text (lightened #BA1A1A for contrast on dark)
}

private val colors = Colors(
    primary = GC.Mint, onPrimary = GC.Ink,
    secondary = GC.Taken, onSecondary = Color.White,
    background = GC.Face, onBackground = Color.White,
    surface = GC.Later, onSurface = GC.OnFace,
    error = GC.Alert, onError = GC.Ink,
)

@Composable
fun GranCareTheme(content: @Composable () -> Unit) = MaterialTheme(colors = colors, content = content)

private val timeFmt = DateTimeFormatter.ofPattern("hh:mm a").withZone(ZoneId.systemDefault())
fun Instant.clock(): String = timeFmt.format(this)
