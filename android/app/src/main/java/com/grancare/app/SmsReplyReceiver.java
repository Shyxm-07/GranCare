package com.grancare.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import java.util.LinkedHashMap;
import java.util.Map;

/** Family members answer an alert by replying YES or LATER to the Gran Care text. */
public class SmsReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        SmsMessage[] msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (msgs == null) return;
        Map<String, StringBuilder> byFrom = new LinkedHashMap<>();
        for (SmsMessage m : msgs) {
            if (m == null || m.getOriginatingAddress() == null) continue;
            byFrom.computeIfAbsent(m.getOriginatingAddress(), k -> new StringBuilder()).append(m.getMessageBody());
        }
        if (byFrom.isEmpty()) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                EscalationEngine e = new EscalationEngine(context);
                for (Map.Entry<String, StringBuilder> en : byFrom.entrySet()) e.onSms(en.getKey(), en.getValue().toString());
            } finally {
                pending.finish();
            }
        }).start();
    }
}
