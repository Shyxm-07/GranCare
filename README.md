# Gran Care

Medication reminders for elderly patients, with **alarms that escalate to the family** when a dose
is missed. It comes as an Android phone app, a Wear OS watch app, and a web version.

| | |
|---|---|
| **Phone app** | `android/`: Capacitor app wrapping the Gran Care UI, plus native alarms, SMS and calls |
| **Watch app** | `wear-os/`: Kotlin / Compose for Wear OS; rings on the wrist, TAKEN / LATER, hold-to-alert |
| **UI + logic** | `web/`: the seven screens recreated from the Figma design, plus the Profile screen |

## Demo

[`demo/index.html`](demo/index.html) is a self-contained simulation of the whole alert sequence for presentations: the patient's phone and watch, the son's phone and the local guardian's phone side by side, with a fast demo clock, scripted scenarios (patient takes it, son sees the alert, son is busy and it becomes a medical emergency) and a live timeline. Open it in any browser; nothing is sent.

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

## Accounts (log in / sign up)

When `web/firebase-config.js` holds a Firebase web config, the app starts on **Log In**:

* **Create Account → I am the patient** creates the family and shows a **6-letter invite code**
  in *Profile*.
* Sons, daughters and the local guardian choose their role and enter that code. They are added
  to the patient's alert contacts automatically and land on the caretaker dashboard.
* Everyone in the family sees the same medicines, doses and alerts live. Only the
  patient's phone rings, and a son's *"Yes, I'm on it"* on his own phone stops the escalation on
  the patient's phone.
* *Forgot password?* sends a reset email; *Profile → Log Out* signs out.

### Firebase setup (one time)

1. Create a project at <https://console.firebase.google.com>.
2. **Authentication → Sign-in method → Email/Password → Enable.**
3. **Firestore Database → Create database** (production mode).
4. **Firestore Database → Rules**: replace everything with the contents of
   [`firestore.rules`](firestore.rules) and click **Publish**. Without this every request is
   refused.
5. **Project settings → Your apps → Web app**: copy the `firebaseConfig` values into
   [`web/firebase-config.js`](web/firebase-config.js) and push. The next build includes accounts.

With an empty config the app works without accounts and keeps data on the phone.

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

Tests (also run on every push):

* `GC_FIREBASE_DISABLE=1 npm run build:app && python3 web/tests/app_flow.py`: saving, restart
  persistence, profile, snooze limit and all three escalation levels.
* `GC_FIREBASE_EMULATOR=1 npm run build:app && npx firebase-tools emulators:exec --only auth,firestore "python3 web/tests/auth_flow.py"`:
  log in, sign up, wrong password / code, invite code, log out and back in, the son's dashboard,
  contacts linking, and the security rules (a stranger cannot read or join a family).

## How it fits together

```
web/screens/*.html ──build.js──▶ web/dist-app/index.html ──cap sync──▶ android/app/src/main/assets/public
        app.js          schedule model, dose logging, caretaker metrics
        escalation.js   snooze limit + 3-level escalation (web version runs the timers itself)
        profile.js      Profile screen
        standalone.js   on-phone data store (same API as the claude.ai runtime) + prescription reading
        cloud.js        Firebase accounts: log in, sign up, invite codes, family-scoped Firestore data
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
