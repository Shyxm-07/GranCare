package com.grancare.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores alarms and escalation timers after a restart, app update or time-zone change. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult pending = goAsync();
        new Thread(() -> {
            try { new EscalationEngine(context).reschedule(); } finally { pending.finish(); }
        }).start();
    }
}
