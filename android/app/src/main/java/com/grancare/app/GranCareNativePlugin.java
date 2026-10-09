package com.grancare.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/** JavaScript bridge (window.Capacitor plugin "GranCareNative") to the alarm and escalation engine. */
@CapacitorPlugin(
    name = "GranCareNative",
    permissions = {
        @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS }),
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class GranCareNativePlugin extends Plugin {
    private static WeakReference<GranCareNativePlugin> instance = new WeakReference<>(null);
    private String launchDose;
    private EscalationEngine engine;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        engine = new EscalationEngine(getContext());
        engine.ensureChannels();
        Intent i = getActivity() != null ? getActivity().getIntent() : null;
        if (i != null) launchDose = i.getStringExtra(EscalationEngine.EXTRA_KEY);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String key = intent.getStringExtra(EscalationEngine.EXTRA_KEY);
        if (key != null) {
            JSObject o = new JSObject(); o.put("key", key);
            notifyListeners("doseOpened", o, true);
        }
    }

    /** Called from receivers so an open app imports new events straight away. */
    static void ping() {
        GranCareNativePlugin p = instance.get();
        if (p != null) p.notifyListeners("nativeEvent", new JSObject(), false);
    }

    private static String key(PluginCall call) {
        return EscalationEngine.key(call.getString("medId", ""), call.getString("slot", ""), call.getString("day", ""));
    }

    @PluginMethod
    public void setSchedule(PluginCall call) {
        JSArray meds = call.getArray("meds", new JSArray());
        new Thread(() -> { engine.setSchedule(meds); call.resolve(); }).start();
    }

    @PluginMethod
    public void setContacts(PluginCall call) {
        engine.setContacts(call.getData());
        call.resolve();
    }

    @PluginMethod
    public void markTaken(PluginCall call) {
        String k = key(call);
        new Thread(() -> { engine.markTaken(k, true); call.resolve(); }).start();
    }

    @PluginMethod
    public void snooze(PluginCall call) {
        String k = key(call);
        new Thread(() -> {
            boolean ok = engine.snooze(k, true);
            JSObject r = new JSObject(); r.put("allowed", ok);
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        String type = "later".equals(call.getString("ackType")) ? "later" : "yes";
        new Thread(() -> {
            int n = engine.acknowledge(type, "", "");
            JSObject r = new JSObject(); r.put("closed", n);
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void testAlert(PluginCall call) {
        new Thread(() -> {
            int sent = engine.testAlert();
            if (sent == 0) { call.reject("No message was sent. Save at least one contact and allow SMS permission."); return; }
            JSObject r = new JSObject(); r.put("sent", sent);
            call.resolve(r);
        }).start();
    }

    @PluginMethod
    public void drainEvents(PluginCall call) {
        JSONArray q = engine.drainEvents();
        JSArray out = new JSArray();
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o == null) continue;
            try { out.put(JSObject.fromJSONObject(o)); } catch (JSONException ignored) { }
        }
        JSObject r = new JSObject(); r.put("events", out);
        call.resolve(r);
    }

    @PluginMethod
    public void setLanguage(PluginCall call) {
        engine.setLanguage(call.getString("language", "en"));
        call.resolve();
    }

    /** What Android still has to allow for the alarm to behave like a real alarm clock. */
    @PluginMethod
    public void alarmSetup(PluginCall call) {
        android.content.Context c = getContext();
        JSObject r = new JSObject();
        AlarmManager am = c.getSystemService(AlarmManager.class);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        PowerManager pm = c.getSystemService(PowerManager.class);
        r.put("notifications", nm.areNotificationsEnabled());
        r.put("exact", Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms());
        r.put("fullScreen", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
        r.put("overlay", Settings.canDrawOverlays(c));
        r.put("battery", pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        call.resolve(r);
    }

    /** Opens the system screen that grants one alarm permission. */
    @PluginMethod
    public void openAlarmSetting(PluginCall call) {
        String which = call.getString("which", "");
        android.content.Context c = getContext();
        Uri pkg = Uri.parse("package:" + c.getPackageName());
        Intent i;
        switch (which) {
            case "overlay": i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg); break;
            case "fullScreen": i = Build.VERSION.SDK_INT >= 34 ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) : null; break;
            case "exact": i = Build.VERSION.SDK_INT >= 31 ? new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg) : null; break;
            case "battery": i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg); break;
            case "notifications": i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName()); break;
            default: i = null;
        }
        if (i == null) { call.resolve(); return; }
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception e) {
            try { c.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    @PluginMethod
    public void testAlarm(PluginCall call) {
        engine.scheduleTestAlarm(call.getInt("seconds", 5));
        call.resolve();
    }

    @PluginMethod
    public void consumeLaunchDose(PluginCall call) {
        JSObject r = new JSObject();
        r.put("opened", launchDose != null);
        if (launchDose != null) r.put("key", launchDose);
        launchDose = null;
        call.resolve(r);
    }
}
