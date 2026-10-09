package com.grancare.app;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * The alarm page. Opens by itself at dose time (over the lock screen and other apps) and works
 * on its own, without the main app: big clock, the medicine to take, TAKEN and LATER (10 MIN).
 * The back button does not dismiss it; it closes when the dose is answered or the alarm times out.
 * Styled after the Gran Care "Medication Reminder Alarm" screen.
 */
public class AlarmActivity extends AppCompatActivity {
    private static WeakReference<AlarmActivity> current = new WeakReference<>(null);

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView clock, date, status, name, details, instructions, more;
    private LinearLayout card, instructionsBox, buttons;
    private TextView taken, later;
    private FrameLayout root;
    private boolean answered = false;

    // ------------------------------------------------------------------ static helpers

    static List<JSONObject> doses(Context c) {
        EscalationEngine e = new EscalationEngine(c);
        List<JSONObject> out = new ArrayList<>();
        for (String k : AlarmService.activeKeys()) if (!AlarmService.TEST_KEY.equals(k)) { JSONObject s = e.doseState(k); if (s.length() > 0) out.add(s); }
        return out;
    }

    static String label(JSONObject s) {
        String d = s.optString("dosage");
        return s.optString("medName") + (d.isEmpty() ? "" : " " + d);
    }

    static boolean snoozeAllowed(Context c) {
        List<JSONObject> ds = doses(c);
        if (ds.isEmpty()) return false;
        for (JSONObject s : ds) if (s.optInt("snoozes") >= EscalationEngine.MAX_SNOOZES || s.optInt("rings") >= EscalationEngine.ESCALATE_ON_RING) return false;
        return true;
    }

    static void refreshIfOpen() { AlarmActivity a = current.get(); if (a != null) a.ui.post(a::render); }
    static void closeIfOpen() { AlarmActivity a = current.get(); if (a != null) a.ui.post(() -> { if (!a.answered) a.finish(); }); }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#0B84C9"));
        getWindow().setNavigationBarColor(Color.parseColor("#035E8F"));
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { /* an alarm is answered with TAKEN or LATER */ }
        });
        build();
        render();
        ui.post(tick);
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (current.get() == this) current = new WeakReference<>(null);
        super.onDestroy();
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            Locale loc = new AlarmText(AlarmActivity.this).locale();
            clock.setText(new SimpleDateFormat("hh:mm", Locale.US).format(new Date()) + " " + new SimpleDateFormat("a", Locale.US).format(new Date()));
            date.setText(new SimpleDateFormat("EEEE, d MMMM", loc).format(new Date()));
            ui.postDelayed(this, 15_000);
        }
    };

    // ------------------------------------------------------------------ layout

    private int dp(float v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }

    private GradientDrawable round(int color, float radiusDp) {
        GradientDrawable g = new GradientDrawable(); g.setColor(color); g.setCornerRadius(dp(radiusDp)); return g;
    }

    private TextView text(float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); t.setTextColor(color);
        t.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        t.setGravity(Gravity.CENTER_HORIZONTAL);
        return t;
    }

    private LinearLayout.LayoutParams lp(int w, int h, int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h); p.topMargin = dp(top); return p;
    }

    private void build() {
        root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[]{Color.parseColor("#0B84C9"), Color.parseColor("#0369A1"), Color.parseColor("#035E8F")}));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setPadding(dp(22), dp(28), dp(22), dp(28));
        scroll.addView(col, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll);

        clock = text(60, Color.WHITE, true);
        clock.setLetterSpacing(-0.02f);
        col.addView(clock);
        date = text(16, Color.parseColor("#DCEFFC"), false);
        col.addView(date);

        TextView pill = text(12, Color.WHITE, true);
        pill.setText(new AlarmText(this).get("MEDICATION ALARM DUE NOW"));
        pill.setLetterSpacing(0.08f);
        pill.setPadding(dp(14), dp(6), dp(14), dp(6));
        pill.setBackground(round(Color.argb(56, 255, 255, 255), 99));
        col.addView(pill, lp(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 18));

        TextView bell = text(46, Color.WHITE, false);
        bell.setText("🔔");
        bell.setGravity(Gravity.CENTER);
        GradientDrawable halo = new GradientDrawable(); halo.setShape(GradientDrawable.OVAL); halo.setColor(Color.argb(46, 255, 255, 255));
        bell.setBackground(halo);
        col.addView(bell, lp(dp(104), dp(104), 18));
        ObjectAnimator pulse = ObjectAnimator.ofPropertyValuesHolder(bell,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.12f), PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.12f));
        pulse.setDuration(600); pulse.setRepeatCount(ValueAnimator.INFINITE); pulse.setRepeatMode(ValueAnimator.REVERSE); pulse.start();
        ObjectAnimator ring = ObjectAnimator.ofFloat(bell, View.ROTATION, -12f, 12f);
        ring.setDuration(160); ring.setRepeatCount(ValueAnimator.INFINITE); ring.setRepeatMode(ValueAnimator.REVERSE); ring.start();

        card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(22), dp(20), dp(22), dp(22));
        card.setBackground(round(Color.WHITE, 28));
        card.setElevation(dp(6));
        col.addView(card, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 22));

        TextView eyebrow = text(13, Color.parseColor("#43617C"), true);
        eyebrow.setGravity(Gravity.START);
        eyebrow.setAllCaps(true); eyebrow.setLetterSpacing(0.06f);
        eyebrow.setText(new AlarmText(this).get("Time to take"));
        card.addView(eyebrow);
        name = text(30, Color.parseColor("#181C21"), true);
        name.setTypeface(Typeface.create("serif", Typeface.BOLD));
        name.setGravity(Gravity.START);
        card.addView(name, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 4));
        details = text(17, Color.parseColor("#3F4850"), false);
        details.setGravity(Gravity.START);
        card.addView(details, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 4));
        instructionsBox = new LinearLayout(this);
        instructionsBox.setPadding(dp(14), dp(12), dp(14), dp(12));
        instructionsBox.setBackground(round(Color.parseColor("#FEF3C7"), 14));
        instructions = text(16, Color.parseColor("#451A03"), false);
        instructions.setGravity(Gravity.START);
        instructionsBox.addView(instructions);
        card.addView(instructionsBox, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 14));
        more = text(16, Color.parseColor("#181C21"), true);
        more.setGravity(Gravity.START);
        card.addView(more, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 12));

        status = text(15, Color.WHITE, true);
        status.setPadding(dp(14), dp(8), dp(14), dp(8));
        col.addView(status, lp(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, 16));

        buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.VERTICAL);
        col.addView(buttons, lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 18));

        taken = text(26, Color.WHITE, true);
        taken.setGravity(Gravity.CENTER);
        taken.setBackground(round(Color.parseColor("#059669"), 24));
        taken.setElevation(dp(4));
        taken.setOnClickListener(v -> onTaken());
        buttons.addView(taken, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(80)));

        later = text(20, Color.parseColor("#451A03"), true);
        later.setGravity(Gravity.CENTER);
        later.setBackground(round(Color.parseColor("#F59E0B"), 22));
        later.setOnClickListener(v -> onLater());
        buttons.addView(later, lp(ViewGroup.LayoutParams.MATCH_PARENT, dp(66), 14));

        setContentView(root);
    }

    // ------------------------------------------------------------------ state

    private void render() {
        if (answered) return;
        AlarmText t = new AlarmText(this);
        List<String> keys = AlarmService.activeKeys();
        if (keys.isEmpty()) { finish(); return; }
        boolean test = keys.size() == 1 && AlarmService.TEST_KEY.equals(keys.get(0));
        if (test) {
            name.setText(t.get("Test alarm"));
            details.setText(t.get("This is how your medicine alarm will ring."));
            instructionsBox.setVisibility(View.GONE);
            more.setVisibility(View.GONE);
            status.setVisibility(View.GONE);
            taken.setText(t.get("STOP"));
            later.setVisibility(View.GONE);
            return;
        }
        List<JSONObject> ds = doses(this);
        if (ds.isEmpty()) { finish(); return; }
        JSONObject first = ds.get(0);
        name.setText(label(first));
        String slot = t.get(first.optString("slotLabel"));
        details.setText(TextUtils.isEmpty(slot) ? "" : slot);
        details.setVisibility(TextUtils.isEmpty(slot) ? View.GONE : View.VISIBLE);
        String ins = first.optString("instructions");
        instructionsBox.setVisibility(ins.isEmpty() ? View.GONE : View.VISIBLE);
        instructions.setText(ins);
        if (ds.size() > 1) {
            StringBuilder sb = new StringBuilder();
            for (int i = 1; i < ds.size(); i++) sb.append(i > 1 ? "\n" : "").append("+ ").append(label(ds.get(i)));
            more.setText(sb.toString()); more.setVisibility(View.VISIBLE);
        } else more.setVisibility(View.GONE);

        int snoozes = 0; boolean limit = false;
        for (JSONObject s : ds) {
            snoozes = Math.max(snoozes, s.optInt("snoozes"));
            if (s.optInt("snoozes") >= EscalationEngine.MAX_SNOOZES || s.optInt("rings") >= EscalationEngine.ESCALATE_ON_RING || s.optInt("level") > 0) limit = true;
        }
        if (limit) {
            status.setText(t.get("Medication time window exhausted. Your family has been alerted."));
            status.setBackground(round(Color.parseColor("#BA1A1A"), 99));
            status.setVisibility(View.VISIBLE);
        } else if (snoozes > 0) {
            status.setText(t.get("Snoozed {n} of 2 times").replace("{n}", String.valueOf(snoozes)));
            status.setBackground(round(Color.argb(56, 255, 255, 255), 99));
            status.setVisibility(View.VISIBLE);
        } else status.setVisibility(View.GONE);

        taken.setText("✓  " + t.get("TAKEN"));
        later.setText(t.get("LATER (10 MIN)"));
        later.setVisibility(snoozeAllowed(this) ? View.VISIBLE : View.GONE);
    }

    // ------------------------------------------------------------------ actions

    private void onTaken() {
        if (answered) return;
        answered = true;
        final List<String> keys = AlarmService.activeKeys();
        new Thread(() -> {
            EscalationEngine e = new EscalationEngine(this);
            for (String k : keys) if (!AlarmService.TEST_KEY.equals(k)) e.markTaken(k, false);
            AlarmService.stop(this, "*");
        }).start();
        boolean test = keys.size() == 1 && AlarmService.TEST_KEY.equals(keys.get(0));
        confirm(test ? null : new AlarmText(this).get("Dose recorded"));
    }

    private void onLater() {
        if (answered) return;
        answered = true;
        final List<String> keys = AlarmService.activeKeys();
        new Thread(() -> {
            EscalationEngine e = new EscalationEngine(this);
            for (String k : keys) if (!AlarmService.TEST_KEY.equals(k)) e.snooze(k, false);
            AlarmService.stop(this, "*");
        }).start();
        confirm(new AlarmText(this).get("Reminder in 10 minutes"));
    }

    /** Short confirmation, then close. */
    private void confirm(String message) {
        if (message == null) { finish(); return; }
        buttons.setVisibility(View.GONE);
        status.setVisibility(View.VISIBLE);
        status.setBackground(round(Color.parseColor("#059669"), 99));
        status.setText("✓  " + message);
        ui.postDelayed(this::finish, 1600);
    }
}
