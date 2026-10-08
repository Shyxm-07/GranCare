# Gran Care

Medication reminders for elderly patients, with **alarms that escalate to the family** when a dose
is missed. It comes as an Android phone app, a Wear OS watch app, and a web version.

| | |
|---|---|
| **Phone app** | `android/`: Capacitor app wrapping the Gran Care UI, plus native alarms, SMS and calls |
| **Watch app** | `wear-os/`: Kotlin / Compose for Wear OS; rings on the wrist, TAKEN / LATER, hold-to-alert |
| **UI + logic** | `web/`: the seven screens recreated from the Figma design, plus the Profile screen |

## Download

Every push to `main` builds both APKs on GitHub Actions and attaches them to the newest
**[Release](../../releases/latest)**:

* `GranCare-phone.apk`: open it on the Android phone (Android 8 or newer) and allow
  *Install unknown apps* when asked.
* `GranCare-watch.apk`: install it on a Wear OS 3+ watch over Wi-Fi debugging:
  `adb connect <watch-ip>:<port>` then `adb install GranCare-watch.apk`.

## Missed-dose alerts

The same rules run on the phone, the watch and the web version:

1. At dose time the phone rings like an alarm clock, even when locked. Phone notifications also
   appear on any paired smartwatch, with **TAKEN** and **LATER** buttons.
2. **LATER** snoozes for **10 minutes**, at most **twice**. An unanswered alarm re-rings every
   10 minutes the same way.
3. On the **3rd alarm** the sons / daughters saved in **Profile** get a text:
   *"GRAN CARE ALERT: … has not taken … Reply YES if you are on it, or LATER."*
4. If nobody replies **YES** or **LATER** within **20 minutes**, it becomes an **emergency**:
   the phone calls the first son / daughter, and the family and the local guardian get a text.
5. Still no reply **10 minutes** later: the phone calls the **local guardian** and texts everyone.

Taking the dose, or any YES / LATER reply (by SMS or with the buttons on the caretaker
dashboard), stops the escalation, and everyone already alerted gets an update.

The phone app does all of this by itself: no server, no paid SMS service. Messages and calls
go out from the patient's phone and SIM, so normal carrier SMS charges apply.

### Permissions the phone app asks for

| Permission | Why |
|---|---|
| Notifications, alarms, full-screen | ring at dose time, including on the lock screen |
| SMS (send / receive) | text the family; read their YES / LATER replies |
| Phone | place the emergency alert call |
| Camera | photograph a prescription (optional) |

## Using the app

1. **Profile** (bottom bar): enter the patient's name, at least one son / daughter, and the local
   guardian. Tap **Send Test Alert** to check that the messages arrive.
2. **Rx**: add medicines. Type them in, or photograph the prescription after pasting an
   Anthropic API key in Profile (the key stays on the phone).
3. **Home** shows today's four time slots; **Alarms** is the reminder screen.
4. The **caretaker dashboard** shows adherence, the activity feed and open alerts with
   *Yes, I'm on it* / *Later*.

The app speaks English, Spanish, French, Hindi and Tamil (Role selection → Interface Language).

## Build it yourself

Requirements: Node 22, JDK 21, Android SDK (Android Studio Ladybug or newer).

```bash
npm ci && npm ci --prefix web
npm run build:app          # web/dist-app/index.html
npx cap sync android       # copy it into the Android project
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

Watch app: `cd wear-os && ./gradlew assembleDebug` (see `wear-os/README.md` for the
Google Calendar sign-in setup). Web version: `npm run build:web` → `web/dist/index.html`.

Tests: `python3 web/tests/app_flow.py` (Playwright) checks saving, restart persistence, the
profile, the snooze limit and all three escalation levels.

## How it fits together

```
web/screens/*.html ──build.js──▶ web/dist-app/index.html ──cap sync──▶ android/app/src/main/assets/public
        app.js          schedule model, dose logging, caretaker metrics
        escalation.js   snooze limit + 3-level escalation (web version runs the timers itself)
        profile.js      Profile screen
        standalone.js   on-phone data store (same API as the claude.ai runtime) + prescription reading
        native.js       bridge to the Android plugin below
android/app/src/main/java/com/grancare/app/
        EscalationEngine.java   alarms, snoozes, escalation, SMS, calls, notifications
        AlarmReceiver.java      alarm / timer / TAKEN / LATER broadcasts
        SmsReplyReceiver.java   YES / LATER replies from saved contacts
        BootReceiver.java       restores everything after a restart
        GranCareNativePlugin.java   JavaScript bridge
```

## Notes

* Google Play restricts apps that send SMS automatically, so the phone app is meant to be
  installed directly from the APK (sideloaded), not through the Play Store.
* Debug APKs are signed with a temporary key. To update an installed app without uninstalling,
  keep installing APKs from the same workflow. Add a release keystore before a public launch.
