package com.grancare.app;

import android.Manifest;
import android.content.Intent;

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
    public void consumeLaunchDose(PluginCall call) {
        JSObject r = new JSObject();
        r.put("opened", launchDose != null);
        if (launchDose != null) r.put("key", launchDose);
        launchDose = null;
        call.resolve(r);
    }
}
