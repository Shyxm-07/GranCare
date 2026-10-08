# Gran Care — Wear OS watch app

A standalone Wear OS app (Wear OS 3+) that rings on the patient's wrist at dose time and
records **Taken** / **Later** back to the Gran Care web app. It talks to the web app through
the patient's **Google Calendar**:

```
Gran Care web app ──(Google Calendar connector)──▶ dose events in the patient's calendar
        ▲                                                   │
        │ imports outcomes / SOS                            ▼
        └──────────── outcome lines ◀── Wear OS app (syncs every 15 min, rings offline)
```

* **Sync** (every 15 min, and whenever the app opens): reads upcoming events whose description
  contains `[gran-care]`, caches them, and sets exact alarm-clock alarms.
* **Alarm**: full-screen screen matching the Figma *Smartwatch Alarm* design; vibrates, speaks the
  reminder, buttons **TAKEN** and **LATER (10min)**. Rings for at most 2 minutes.
* **Taken / Later**: appends `[gran-care-status] taken <time>` (or `snoozed <time> 10`) to the event
  and ticks the title (`✓ …`). Writes are queued and retried until the watch is online.
* **Hold 3 s to alert caretaker** (on the *Dose Recorded* screen): creates a `[gran-care-sos]`
  event that the web app turns into an SOS on the caretaker dashboard.

## One-time setup

1. **Google Cloud project**
   - Open <https://console.cloud.google.com/>, create (or pick) a project.
   - *APIs & Services → Library →* enable **Google Calendar API**.
   - *OAuth consent screen*: External, add scope `.../auth/calendar.events`, and add the patient's
     Google account as a **test user** (or publish the app).
   - *Credentials → Create credentials → OAuth client ID →* type **Android**,
     package name `com.grancare.wear`, and the **SHA-1** of your signing key
     (debug key: `./gradlew signingReport`).
     No client ID goes into the code — Google matches the package + signature.
2. **Build & install** (Android Studio Ladybug or newer)
   - *File → Open* this `wear-os` folder; let Gradle sync.
   - On the watch: *Settings → Developer options →* enable **ADB debugging** and **Debug over Wi-Fi**,
     then pair it in Android Studio (*Device Manager → Pair devices using Wi-Fi*) and press **Run**.
   - Or from a terminal: `./gradlew installDebug` with the watch connected via `adb connect <ip>:<port>`.
3. **On the watch**: open *Gran Care* → **Connect Google Calendar** → approve with the patient's
   Google account. Allow notifications, *on-time alarms* and *full-screen alarms* when prompted.
4. **In the web app** (patient's view): connect Google Calendar so dose events are created in the
   same Google account.

## Files

| File | Purpose |
|---|---|
| `data/Dose.kt` | Event ↔ dose model and the shared text markers |
| `data/Auth.kt` | Google authorization (`calendar.events`) via Identity Services |
| `data/CalendarApi.kt` | Calendar v3 REST: list doses, append outcome, create SOS |
| `data/DoseStore.kt` | Offline cache of doses and scheduled alarms |
| `data/Workers.kt` | WorkManager: periodic sync and retrying outcome writes |
| `alarm/Alarms.kt` | Exact alarms, full-screen alarm notification, reboot restore |
| `ui/AlarmActivity.kt` | Alarm + *Dose Recorded* screens (from the Figma watch screens) |
| `ui/MainActivity.kt` | Home: connect, permissions, today's doses, sync |

## Notes

* This project was written without access to the Android build tools. Every file parses and it was
  reviewed against the library APIs, but it has not been compiled. Expect at most small fixes on the
  first Gradle sync; library versions are pinned in `app/build.gradle.kts`.
* Test **Connect Google Calendar** first on a real Wear OS 4/5 watch. Google documents Credential
  Manager and phone-based OAuth for watches; the authorization API used here generally works where
  Google Play services is present, but some watches may not show its consent screen. If so, the
  fallback is OAuth via the phone with `RemoteAuthClient` (androidx.wear:wear-remote-interactions).
* Apple Watch is not covered by this app. It still gets dose alerts through the Google Calendar events
  (calendar notifications mirror from the iPhone).
