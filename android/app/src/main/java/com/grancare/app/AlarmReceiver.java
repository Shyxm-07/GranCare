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
                switch (action) {
                    case EscalationEngine.ACTION_RING: e.onRing(key); break;
                    case EscalationEngine.ACTION_CHECK: e.onCheck(key); break;
                    case EscalationEngine.ACTION_TAKEN: e.markTaken(key, false); break;
                    case EscalationEngine.ACTION_SNOOZE: e.snooze(key, false); break;
                    default: break;
                }
            } finally {
                pending.finish();
            }
        }).start();
    }
}
