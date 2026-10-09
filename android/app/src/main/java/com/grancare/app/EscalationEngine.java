package com.grancare.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.TelecomManager;
import android.telephony.SmsManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Gran Care alarms and missed-dose escalation, independent of the WebView so it keeps
 * working when the app is closed or the phone restarts.
 *
 * Rules (same as web/escalation.js):
 *  1. A dose alarm can be snoozed at most twice, 10 minutes each; an unanswered alarm
 *     re-rings every 10 minutes the same way.
 *  2. The 3rd alarm ("medication time window exhausted") texts the sons / daughters, with a
 *     link that records that they have seen the alert (level 1).
 *  3. If the alert is still unseen after 20 minutes (they often live far away), it is a medical
 *     emergency (level 2): the local guardian is called and texted with the home address, the
 *     nearby clinic is texted, and the sons / daughters get a notice.
 *  Taking the dose, or the alert being seen (link, Gran Care app, or a YES reply), stops it.
 */
public final class EscalationEngine {
    private static final String TAG = "GranCare";
    public static final long MIN = 60_000L;
    public static final long SNOOZE_MS = 10 * MIN;
    public static final int MAX_SNOOZES = 2;
    public static final int ESCALATE_ON_RING = 3;
    public static final long TO_EMERGENCY_MS = 20 * MIN;

    public static final String ACTION_RING = "com.grancare.app.RING";
    public static final String ACTION_CHECK = "com.grancare.app.CHECK";
    public static final String ACTION_TAKEN = "com.grancare.app.TAKEN";
    public static final String ACTION_SNOOZE = "com.grancare.app.SNOOZE";
    public static final String ACTION_TEST_ALARM = "com.grancare.app.TEST_ALARM";
    public static final String EXTRA_KEY = "doseKey";

    static final String CH_ALARM = "gc_alarm_v1";
    static final String CH_ALERT = "gc_alert_v1";

    private static final String PREFS = "gc_native";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("hh:mm a", Locale.US);

    private final Context ctx;
    private final SharedPreferences prefs;

    public EscalationEngine(Context context) {
        this.ctx = context.getApplicationContext();
        this.prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------------ storage

    private JSONObject obj(String k) {
        try { return new JSONObject(prefs.getString(k, "{}")); } catch (JSONException e) { return new JSONObject(); }
    }
    private JSONArray arr(String k) {
        try { return new JSONArray(prefs.getString(k, "[]")); } catch (JSONException e) { return new JSONArray(); }
    }
    private void put(String k, Object v) { prefs.edit().putString(k, v.toString()).apply(); }

    public synchronized void setSchedule(JSONArray meds) { put("meds", meds); reschedule(); }
    public synchronized void setContacts(JSONObject contacts) { put("contacts", contacts); }
    public JSONObject contacts() { return obj("contacts"); }

    private JSONObject states() { return obj("states"); }
    /** Current state of one dose (empty when unknown). */
    JSONObject doseState(String key) { return state(key); }

    public String prefsLanguage() { String l = prefs.getString("language", "en"); return l == null ? "en" : l; }
    public void setLanguage(String lang) { prefs.edit().putString("language", lang == null ? "en" : lang.split("-")[0]).apply(); }

    private JSONObject state(String key) {
        JSONObject s = states().optJSONObject(key);
        return s != null ? s : new JSONObject();
    }
    private void saveState(String key, JSONObject s) {
        JSONObject all = states();
        try { all.put(key, s); } catch (JSONException ignored) { }
        put("states", all);
    }

    /** Queue an event for the app to import into its records, and wake the app if open. */
    private void emit(String type, JSONObject s, JSONObject extra) {
        try {
            JSONObject e = new JSONObject();
            e.put("type", type);
            e.put("at", Instant.now().toString());
            if (s != null) {
                e.put("medId", s.optString("medId")); e.put("medName", s.optString("medName"));
                e.put("slot", s.optString("slot")); e.put("day", s.optString("day"));
            }
            if (extra != null) { Iterator<String> it = extra.keys(); while (it.hasNext()) { String k = it.next(); e.put(k, extra.get(k)); } }
            JSONArray q = arr("events"); q.put(e);
            while (q.length() > 200) q.remove(0);
            put("events", q);
        } catch (JSONException ignored) { }
        GranCareNativePlugin.ping();
    }

    public synchronized JSONArray drainEvents() { JSONArray q = arr("events"); put("events", new JSONArray()); return q; }

    // ------------------------------------------------------------------ schedule

    static String key(String medId, String slot, String day) { return medId + "|" + slot + "|" + day; }

    /** Recomputes every pending alarm for today and tomorrow from the schedule and dose states. */
    public synchronized void reschedule() {
        ensureChannels();
        JSONArray meds = arr("meds");
        JSONObject all = states();
        ZoneId zone = ZoneId.systemDefault();
        long now = System.currentTimeMillis();
        LocalDate today = LocalDate.now(zone);
        Set<String> wanted = new HashSet<>();

        for (int i = 0; i < meds.length(); i++) {
            JSONObject m = meds.optJSONObject(i); if (m == null) continue;
            LocalDate start = today; long created = 0;
            try { Instant c = Instant.parse(m.optString("createdAt")); created = c.toEpochMilli(); start = c.atZone(zone).toLocalDate(); } catch (Exception ignored) { }
            int duration = m.optInt("durationDays", 0);
            JSONArray slots = m.optJSONArray("slots"); if (slots == null) continue;
            for (int d = 0; d <= 1; d++) {
                LocalDate day = today.plusDays(d);
                if (day.isBefore(start)) continue;
                if (duration > 0 && day.isAfter(start.plusDays(duration - 1))) continue;
                for (int j = 0; j < slots.length(); j++) {
                    JSONObject sl = slots.optJSONObject(j); if (sl == null) continue;
                    long slotAt = LocalDateTime.of(day, java.time.LocalTime.of(sl.optInt("hour"), sl.optInt("minute"))).atZone(zone).toInstant().toEpochMilli();
                    if (created > slotAt + 60 * MIN) continue; // added after this dose was already over
                    String k = key(m.optString("id"), sl.optString("key"), day.toString());
                    JSONObject s = all.optJSONObject(k);
                    if (s == null) {
                        s = new JSONObject();
                        try {
                            s.put("medId", m.optString("id")); s.put("medName", m.optString("name"));
                            s.put("dosage", m.optString("dosage")); s.put("instructions", m.optString("instructions"));
                            s.put("slot", sl.optString("key")); s.put("slotLabel", sl.optString("label"));
                            s.put("day", day.toString()); s.put("slotAt", slotAt);
                        } catch (JSONException ignored) { }
                    }
                    try { s.put("medName", m.optString("name")); s.put("dosage", m.optString("dosage")); s.put("instructions", m.optString("instructions")); } catch (JSONException ignored) { }
                    try { all.put(k, s); } catch (JSONException ignored) { }
                    if (s.optBoolean("taken") || s.has("resolved") && s.optInt("level") == 0) continue;

                    int rings = s.optInt("rings");
                    long next = s.optLong("nextRingAt", 0);
                    long ringAt = next > 0 ? next : (rings == 0 ? slotAt : 0);
                    if (ringAt > 0 && rings < ESCALATE_ON_RING && !(rings == 0 && ringAt < now - 60 * MIN)) {
                        setAlarm(ACTION_RING, k, Math.max(ringAt, now + 2000), true);
                        wanted.add(ACTION_RING + k);
                    }
                    int level = s.optInt("level");
                    if (level == 1 && !s.has("resolved")) {
                        long at = s.optLong("levelAt") + TO_EMERGENCY_MS;
                        setAlarm(ACTION_CHECK, k, Math.max(at, now + 2000), false);
                        wanted.add(ACTION_CHECK + k);
                    }
                }
            }
        }
        // drop states older than two days; cancel alarms that are no longer wanted
        Iterator<String> it = all.keys(); List<String> old = new ArrayList<>();
        while (it.hasNext()) { String k = it.next(); String day = k.substring(k.lastIndexOf('|') + 1); try { if (LocalDate.parse(day).isBefore(today.minusDays(2))) old.add(k); } catch (Exception e) { old.add(k); } }
        for (String k : old) all.remove(k);
        put("states", all);
        Set<String> before = new HashSet<>(prefs.getStringSet("scheduled", new HashSet<>()));
        for (String id : before) if (!wanted.contains(id)) {
            String action = id.startsWith(ACTION_RING) ? ACTION_RING : ACTION_CHECK;
            cancelAlarm(action, id.substring(action.length()));
        }
        prefs.edit().putStringSet("scheduled", wanted).apply();
    }

    private PendingIntent alarmPi(String action, String key) {
        Intent i = new Intent(ctx, AlarmReceiver.class).setAction(action).putExtra(EXTRA_KEY, key);
        return PendingIntent.getBroadcast(ctx, (action + key).hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void setAlarm(String action, String key, long at, boolean alarmClock) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        PendingIntent pi = alarmPi(action, key);
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        try {
            if (exact && alarmClock) {
                PendingIntent show = PendingIntent.getActivity(ctx, 1, new Intent(ctx, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
            } else if (exact) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    private void cancelAlarm(String action, String key) { ctx.getSystemService(AlarmManager.class).cancel(alarmPi(action, key)); }

    // ------------------------------------------------------------------ dose events

    /** The alarm for this dose goes off (first time, after a snooze, or unanswered re-ring). */
    public synchronized void onRing(String key) {
        JSONObject s = state(key);
        if (s.length() == 0 || s.optBoolean("taken")) return;
        int rings = s.optInt("rings") + 1;
        try {
            s.put("rings", rings);
            s.put("nextRingAt", rings >= ESCALATE_ON_RING ? 0 : System.currentTimeMillis() + SNOOZE_MS);
        } catch (JSONException ignored) { }
        saveState(key, s);
        AlarmService.ring(ctx, key);
        if (rings >= ESCALATE_ON_RING && s.optInt("level") == 0 && !s.has("resolved")) escalate(key, 1);
        reschedule();
    }

    /** Patient pressed snooze (notification or app). Returns false when the limit is reached. */
    public synchronized boolean snooze(String key, boolean fromApp) {
        JSONObject s = state(key);
        if (s.length() == 0 || s.optBoolean("taken")) return false;
        cancelNotification(key);
        AlarmService.stop(ctx, key);
        if (s.optInt("snoozes") >= MAX_SNOOZES || s.optInt("rings") >= ESCALATE_ON_RING) {
            if (s.optInt("level") == 0 && !s.has("resolved")) escalate(key, 1);
            return false;
        }
        long until = System.currentTimeMillis() + SNOOZE_MS;
        try { s.put("snoozes", s.optInt("snoozes") + 1); s.put("nextRingAt", until); if (s.optInt("rings") == 0) s.put("rings", 1); } catch (JSONException ignored) { }
        saveState(key, s);
        if (!fromApp) {
            JSONObject x = new JSONObject();
            try { x.put("minutes", 10); x.put("until", Instant.ofEpochMilli(until).toString()); } catch (JSONException ignored) { }
            emit("snoozed", s, x);
        }
        reschedule();
        return true;
    }

    /** The dose was taken (notification button, app, or watch). */
    public synchronized void markTaken(String key, boolean fromApp) {
        JSONObject s = state(key);
        if (s.length() == 0) return;
        try { s.put("taken", true); s.put("nextRingAt", 0); } catch (JSONException ignored) { }
        cancelNotification(key);
        AlarmService.stop(ctx, key);
        cancelAlarm(ACTION_RING, key); cancelAlarm(ACTION_CHECK, key);
        if (s.optInt("level") >= 1 && !s.has("resolved")) {
            try { s.put("resolved", "taken"); } catch (JSONException ignored) { }
            String msg = String.format(Locale.US, "Gran Care update: %s has now taken %s. Thank you.", patient(), s.optString("medName"));
            for (String p : jsonStrings(s.optJSONArray("alerted"))) sendSms(p, msg);
            JSONObject x = new JSONObject();
            try { x.put("reason", "taken"); } catch (JSONException ignored) { }
            emit("resolved", s, x);
        }
        saveState(key, s);
        if (!fromApp) emit("taken", s, null);
        reschedule();
    }

    /** Timer after an escalation level: move up if nobody has answered. */
    public synchronized void onCheck(String key) {
        JSONObject s = state(key);
        if (s.optBoolean("taken") || s.has("resolved")) return;
        int level = s.optInt("level");
        if (level == 1 && System.currentTimeMillis() >= s.optLong("levelAt") + TO_EMERGENCY_MS - 5000) {
            // Has a son / daughter opened the alert link (or the alert in their Gran Care app)?
            // One retry: the network can take a moment to come back when the phone wakes from sleep.
            boolean seen = seenOnline(key);
            if (!seen) { try { Thread.sleep(3000); } catch (InterruptedException ignored) { } seen = seenOnline(key); }
            if (seen) { acknowledge("seen", "", "", key); return; }
            escalate(key, 2);
        } else reschedule();
    }

    /** The alert was seen ("seen": link or app; "yes" / "later": SMS reply or in-app button). */
    public synchronized int acknowledge(String type, String byName, String byPhone) { return acknowledge(type, byName, byPhone, null); }

    /** Closes the open alert for {@code onlyKey}, or every open alert when it is null. */
    public synchronized int acknowledge(String type, String byName, String byPhone, String onlyKey) {
        JSONObject all = states(); int n = 0;
        Iterator<String> it = all.keys(); List<String> keys = new ArrayList<>();
        while (it.hasNext()) keys.add(it.next());
        for (String k : keys) {
            if (onlyKey != null && !onlyKey.equals(k)) continue;
            JSONObject s = all.optJSONObject(k);
            if (s == null || s.optInt("level") < 1 || s.has("resolved") || s.optBoolean("taken")) continue;
            n++;
            try { s.put("resolved", "ack"); s.put("ackType", type); s.put("ackBy", byName); } catch (JSONException ignored) { }
            cancelAlarm(ACTION_CHECK, k);
            if ("later".equals(type)) { try { s.put("nextRingAt", System.currentTimeMillis() + SNOOZE_MS); s.put("rings", ESCALATE_ON_RING - 1); } catch (JSONException ignored) { } }
            saveState(k, s);
            String who = byName.isEmpty() ? "A family member" : byName;
            if ("seen".equals(type)) {
                notifyPatient(k.hashCode() + 7, "Your son / daughter has seen the alert", "They know you have not taken " + s.optString("medName") + " yet.");
                JSONObject x = new JSONObject();
                try { x.put("ackType", "seen"); x.put("by", byName); } catch (JSONException ignored) { }
                emit("ack", s, x);
                continue;
            }
            String msg = "yes".equals(type)
                ? String.format(Locale.US, "Gran Care: %s replied YES and is checking on %s.", who, patient())
                : String.format(Locale.US, "Gran Care: %s replied LATER about %s's %s. The alarm will ring again.", who, patient(), s.optString("medName"));
            for (String p : jsonStrings(s.optJSONArray("alerted"))) if (!samePhone(p, byPhone)) sendSms(p, msg);
            notifyPatient(k.hashCode() + 7, "yes".equals(type) ? who + " is on the way to help" : who + " will check soon", "Your family received the alert about " + s.optString("medName") + ".");
            JSONObject x = new JSONObject();
            try { x.put("ackType", type); x.put("by", who); } catch (JSONException ignored) { }
            emit("ack", s, x);
        }
        reschedule();
        return n;
    }

    // ------------------------------------------------------------------ escalation

    private String patient() { String n = contacts().optString("patientName"); return n.isEmpty() ? "your parent" : n; }

    private List<JSONObject> children() {
        List<JSONObject> out = new ArrayList<>(); JSONArray a = contacts().optJSONArray("children");
        if (a != null) for (int i = 0; i < a.length(); i++) { JSONObject c = a.optJSONObject(i); if (c != null && !c.optString("phone").isEmpty()) out.add(c); }
        return out;
    }
    private JSONObject guardian() { JSONObject g = contacts().optJSONObject("guardian"); return g != null && !g.optString("phone").isEmpty() ? g : null; }

    private void escalate(String key, int level) {
        JSONObject s = state(key);
        if (s.optInt("level") >= level || s.optBoolean("taken") || s.has("resolved")) return;
        long now = System.currentTimeMillis();
        try { s.put("level", level); s.put("levelAt", now); } catch (JSONException ignored) { }

        String med = s.optString("medName") + (s.optString("dosage").isEmpty() ? "" : " " + s.optString("dosage"));
        String due = Instant.ofEpochMilli(s.optLong("slotAt")).atZone(ZoneId.systemDefault()).format(TIME);
        List<JSONObject> kids = children(); JSONObject g = guardian();
        List<String> to = new ArrayList<>(); String call = null; String msg; String patientNote;

        String address = contacts().optString("address");
        JSONObject clinic = contacts().optJSONObject("clinic");
        String clinicPhone = clinic != null ? clinic.optString("phone") : "";
        String clinicName = clinic != null && !clinic.optString("name").isEmpty() ? clinic.optString("name") : "the nearby clinic";
        String gName = g != null && !g.optString("name").isEmpty() ? g.optString("name") : "the local guardian";
        String extraMsg = null; List<String> extraTo = new ArrayList<>();

        if (level == 1) {
            String link = seenLink(key);
            msg = String.format(Locale.US, "GRAN CARE ALERT: %s has not taken %s (due %s); the time window is over. Please call them.%s If this stays unseen for 20 minutes, %s and %s will be alerted.",
                patient(), med, due, link.isEmpty() ? "" : " Tap to confirm you have seen this: " + link, gName, clinicName);
            for (JSONObject c : kids) to.add(c.optString("phone"));
            if (to.isEmpty() && g != null) to.add(g.optString("phone"));
            patientNote = "Your son / daughter has been alerted.";
        } else {
            // Medical emergency: the family has not seen the alert for 20 minutes.
            String where = address.isEmpty() ? "" : " at " + address;
            msg = String.format(Locale.US, "GRAN CARE MEDICAL EMERGENCY: %s%s has not taken %s since %s and the family has not seen the alert for 20 minutes. Please go and check on them now.", patient(), where, med, due);
            if (g != null) to.add(g.optString("phone"));
            if (!clinicPhone.isEmpty()) to.add(clinicPhone);
            call = g != null ? g.optString("phone") : null;
            extraMsg = String.format(Locale.US, "GRAN CARE: you have not seen the alert about %s for 20 minutes. %s and %s have now been alerted.", patient(), capital(gName), clinicName);
            for (JSONObject c : kids) extraTo.add(c.optString("phone"));
            if (to.isEmpty()) for (JSONObject c : kids) { to.add(c.optString("phone")); if (call == null) call = c.optString("phone"); }
            patientNote = "Medical emergency: " + gName + " and " + clinicName + " are being alerted.";
        }

        boolean auto = contacts().optBoolean("autoAlerts", true);
        int sent = 0;
        JSONArray alerted = s.optJSONArray("alerted"); if (alerted == null) alerted = new JSONArray();
        if (auto) {
            for (String p : to) if (sendSms(p, msg)) { sent++; if (!jsonStrings(alerted).contains(p)) alerted.put(p); }
            if (extraMsg != null) for (String p : extraTo) if (!to.contains(p) && sendSms(p, extraMsg) && !jsonStrings(alerted).contains(p)) alerted.put(p);
            if (call != null) placeCall(call);
        }
        try { s.put("alerted", alerted); } catch (JSONException ignored) { }
        saveState(key, s);

        notifyPatient(key.hashCode() + level, patientNote, med);
        JSONObject x = new JSONObject();
        try { x.put("level", level); x.put("sent", sent); if (call != null) x.put("called", call); } catch (JSONException ignored) { }
        emit("alert", s, x);
        if (auto && to.size() > 0 && sent == 0) {
            notifyPatient(key.hashCode() + 99, "Could not send the family alert", "Allow SMS and phone permission for Gran Care, and check the contacts in Profile.");
            emit("sms_failed", s, null);
        }
        if (to.isEmpty()) notifyPatient(key.hashCode() + 98, "No family contacts saved", "Add a son, daughter, guardian or clinic in Gran Care > Profile.");
        reschedule();
    }

    // ------------------------------------------------------------------ "seen" links

    private static String capital(String s) { return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1); }

    /** Link tokens per dose (created by the app in Firestore: alertLinks/{token}). */
    public synchronized void setLinks(JSONObject links, String base) {
        put("links", links); prefs.edit().putString("seenBase", base == null ? "" : base).apply();
    }
    private String token(String key) { return obj("links").optString(key); }
    private String seenLink(String key) {
        String t = token(key), base = prefs.getString("seenBase", "");
        return t.isEmpty() || base == null || base.isEmpty() ? "" : base + "#" + t;
    }

    /** Asks Firestore (public, by token) whether the alert link has been opened. Unknown counts as unseen. */
    private boolean seenOnline(String key) {
        String t = token(key);
        JSONObject fb = contacts().optJSONObject("firestore");
        if (t.isEmpty() || fb == null || fb.optString("projectId").isEmpty()) return false;
        java.net.HttpURLConnection c = null;
        try {
            String host = fb.optString("host").isEmpty() ? "https://firestore.googleapis.com" : "http://" + fb.optString("host");
            String url = host + "/v1/projects/" + fb.optString("projectId") + "/databases/(default)/documents/alertLinks/" + t
                + (fb.optString("apiKey").isEmpty() ? "" : "?key=" + fb.optString("apiKey"));
            c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            c.setConnectTimeout(5000); c.setReadTimeout(5000);
            if (c.getResponseCode() != 200) return false;
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096]; int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            JSONObject doc = new JSONObject(out.toString("UTF-8"));
            JSONObject fields = doc.optJSONObject("fields");
            return fields != null && fields.has("seenAt");
        } catch (Exception e) {
            Log.w(TAG, "seen check failed; treating the alert as unseen", e);
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------------ SMS replies

    /** Incoming SMS: a YES / LATER from a saved contact closes the open alerts. */
    public void onSms(String from, String body) {
        String t = body == null ? "" : body.trim().toUpperCase(Locale.ROOT);
        String type = t.startsWith("YES") || t.equals("Y") || t.startsWith("OK") || t.startsWith("SEEN") ? "seen" : t.startsWith("LATER") ? "later" : null;
        if (type == null) return;
        String name = null;
        for (JSONObject c : children()) if (samePhone(c.optString("phone"), from)) name = c.optString("name");
        JSONObject g = guardian();
        if (name == null && g != null && samePhone(g.optString("phone"), from)) name = g.optString("name");
        if (name == null) return; // not one of the saved contacts
        acknowledge(type, name, from);
    }

    static boolean samePhone(String a, String b) {
        if (a == null || b == null) return false;
        String x = a.replaceAll("\\D", ""), y = b.replaceAll("\\D", "");
        if (x.length() < 6 || y.length() < 6) return false;
        int n = Math.min(10, Math.min(x.length(), y.length()));
        return x.substring(x.length() - n).equals(y.substring(y.length() - n));
    }

    // ------------------------------------------------------------------ SMS, calls, notifications

    private boolean granted(String perm) { return ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED; }

    public boolean sendSms(String phone, String text) {
        if (phone == null || phone.isEmpty() || !granted(Manifest.permission.SEND_SMS)) return false;
        try {
            SmsManager sm = Build.VERSION.SDK_INT >= 31 ? ctx.getSystemService(SmsManager.class) : SmsManager.getDefault();
            ArrayList<String> parts = sm.divideMessage(text);
            sm.sendMultipartTextMessage(phone, null, parts, null, null);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "SMS failed", e);
            return false;
        }
    }

    public void placeCall(String phone) {
        Uri uri = Uri.fromParts("tel", phone, null);
        if (granted(Manifest.permission.CALL_PHONE)) {
            try {
                ctx.getSystemService(TelecomManager.class).placeCall(uri, new Bundle());
                return;
            } catch (Exception e) { Log.w(TAG, "placeCall failed", e); }
        }
        // Fallback: a heads-up notification that opens the dialer with the number filled in.
        Intent dial = new Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(ctx, phone.hashCode(), dial, PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Emergency call needed")
            .setContentText("Tap to call " + phone)
            .setPriority(NotificationCompat.PRIORITY_MAX).setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(pi).setFullScreenIntent(pi, true).setAutoCancel(true).build();
        notify(phone.hashCode(), n);
    }

    private void notify(int id, Notification n) {
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) return;
        ctx.getSystemService(NotificationManager.class).notify(id, n);
    }

    private void cancelNotification(String key) { ctx.getSystemService(NotificationManager.class).cancel(key.hashCode()); }

    private void notifyPatient(int id, String title, String text) {
        PendingIntent open = PendingIntent.getActivity(ctx, 2, new Intent(ctx, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        notify(id, new NotificationCompat.Builder(ctx, CH_ALERT)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title).setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH).setContentIntent(open).setAutoCancel(true).build());
    }

    void ensureChannels() {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH_ALARM) == null) {
            NotificationChannel c = new NotificationChannel(CH_ALARM, "Medication alarms", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Rings at dose time");
            c.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            c.enableVibration(true); c.setVibrationPattern(new long[]{0, 700, 400, 700, 400, 700});
            c.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CH_ALERT) == null) {
            NotificationChannel c = new NotificationChannel(CH_ALERT, "Family alerts", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Escalation and family replies");
            nm.createNotificationChannel(c);
        }
    }

    // ------------------------------------------------------------------ test

    /** Rings the real alarm page after a few seconds, so the patient can hear and see it. */
    public void scheduleTestAlarm(int seconds) {
        Intent i = new Intent(ctx, AlarmReceiver.class).setAction(ACTION_TEST_ALARM).putExtra(EXTRA_KEY, AlarmService.TEST_KEY);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 9901, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        setAlarmRaw(pi, System.currentTimeMillis() + Math.max(1, seconds) * 1000L);
    }

    private void setAlarmRaw(PendingIntent pi, long at) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        try {
            if (exact) {
                PendingIntent show = PendingIntent.getActivity(ctx, 1, new Intent(ctx, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
                am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
            } else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        } catch (SecurityException e) { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi); }
    }


    public int testAlert() {
        String msg = String.format(Locale.US, "Gran Care test: missed-dose alerts for %s are set up on this phone. If a dose is missed you will get a message here with a link; open it so Gran Care knows you have seen it.", patient());
        int sent = 0;
        for (JSONObject c : children()) if (sendSms(c.optString("phone"), msg)) sent++;
        JSONObject g = guardian(); if (g != null && sendSms(g.optString("phone"), msg)) sent++;
        return sent;
    }

    private static List<String> jsonStrings(JSONArray a) {
        List<String> out = new ArrayList<>();
        if (a != null) for (int i = 0; i < a.length(); i++) out.add(a.optString(i));
        return out;
    }
}
