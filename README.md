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
3. After that the **medication time window is exhausted** and the sons / daughters saved in
   **Profile** get a text with a "seen" link:
   *"GRAN CARE ALERT: … has not taken … Tap to confirm you have seen this: https://shyxm-07.github.io/GranCare/seen/#…"*
4. They do not have to reply. **Opening the link**, or opening the alert in their own Gran Care
   app, marks it **seen** and the patient's phone tells the patient they know.
5. If it stays **unseen for 20 minutes** it is treated as a **medical emergency**: the children may
   live far away, so the phone calls the **local guardian / nearby relative** and texts them the
   home address, texts the **nearby hospital / clinic** from Profile, and tells the children.

Taking the dose stops everything at any point, and everyone already alerted gets an update.

**Cost: free.** Messages and calls go out from the patient's phone and SIM (normal carrier SMS
charges, usually covered by the phone plan). The "seen" link uses Firebase's free Spark plan and
GitHub Pages; no paid server or SMS service is involved. SMS cannot report that a text was
read, so "seen" means the link or the app was opened. The patient's phone needs to be on with
signal for the alerts to go out.

### Permissions the phone app asks for

| Permission | Why |
|---|---|
| Notifications, alarms, full-screen | ring at dose time, including on the lock screen |
| SMS (send / receive) | text the family; a SEEN / YES reply also counts as seen |
| Phone | place the emergency alert call |
| Camera | photograph a prescription (optional) |

## Accounts (log in / sign up)

When `web/firebase-config.js` holds a Firebase web config, the app starts on **Log In**:

* **Create Account → I am the patient** creates the family and shows a **6-letter invite code**
  in *Profile*.
* Sons, daughters and the local guardian choose their role and enter that code. They are added
  to the patient's alert contacts automatically and land on the caretaker dashboard.
* Everyone in the family sees the same medicines, doses and alerts live. Only the
  patient's phone rings. When a son opens an alert on his own phone it is marked seen, which
  stops the emergency timer on the patient's phone.
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
   (Done for project `grancare-10030`.)
6. Stay on the free **Spark** plan; nothing here needs billing.

The website (demo and the "seen" page) is published free by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) to the `gh-pages` branch:
<https://shyxm-07.github.io/GranCare/>.

With an empty config the app works without accounts and keeps data on the phone.

## Using the app

1. **Profile** (bottom bar): enter the patient's name, at least one son / daughter, the local
   guardian, the home address and a nearby hospital / clinic. Tap **Send Test Alert** to check that the messages arrive.
2. **Rx**: add medicines. Type them in, or photograph the prescription after pasting an
   Anthropic API key in Profile (the key stays on the phone).
3. **Home** shows today's four time slots; **Alarms** is the reminder screen.
4. The **caretaker dashboard** shows adherence, the activity feed and open alerts with
   *I've seen it*.

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
  persistence, profile, the medication time window and all three escalation levels.
* `GC_FIREBASE_EMULATOR=1 npm run build:app && npx firebase-tools emulators:exec --only auth,firestore "python3 web/tests/auth_flow.py"`:
  log in, sign up, wrong password / code, invite code, log out and back in, the son's dashboard,
  contacts linking, and the security rules (a stranger cannot read or join a family).

## How it fits together

```
web/screens/*.html ──build.js──▶ web/dist-app/index.html ──cap sync──▶ android/app/src/main/assets/public
        app.js          schedule model, dose logging, caretaker metrics
        escalation.js   medication time window + escalation (web version runs the timers itself)
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
