package com.grancare.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Dose alarms, escalation timers and the TAKEN / LATER notification buttons. */
public class AlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String key = intent.getStringExtra(EscalationEngine.EXTRA_KEY);
        String action = intent.getAction();
        if (key == null || action == null) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                EscalationEngine e = new EscalationEngine(context);
                // "*" = every dose that is ringing right now (buttons on the ringing notification / watch)
                java.util.List<String> keys = "*".equals(key) ? AlarmService.activeKeys() : java.util.Collections.singletonList(key);
                switch (action) {
                    case EscalationEngine.ACTION_RING: e.onRing(key); break;
                    case EscalationEngine.ACTION_CHECK: e.onCheck(key); break;
                    case EscalationEngine.ACTION_TEST_ALARM: AlarmService.test(context); break;
                    case EscalationEngine.ACTION_TAKEN:
                        for (String k : keys) if (!AlarmService.TEST_KEY.equals(k)) e.markTaken(k, false);
                        AlarmService.stop(context, "*");
                        break;
                    case EscalationEngine.ACTION_SNOOZE:
                        for (String k : keys) if (!AlarmService.TEST_KEY.equals(k)) e.snooze(k, false);
                        AlarmService.stop(context, "*");
                        break;
                    default: break;
                }
            } finally {
                pending.finish();
            }
        }).start();
    }
}
