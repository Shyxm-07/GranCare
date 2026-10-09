package com.grancare.app;

import android.content.Context;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Alarm-page wording in the app's languages (en, es, fr, hi, ta), following the language chosen in the app. */
final class AlarmText {
    private static final Map<String, String[]> T = new HashMap<>();
    static {
        //            English                                  Spanish                                 French                                   Hindi                              Tamil
        put("MEDICATION ALARM DUE NOW", "ALARMA DE MEDICACIÓN AHORA", "ALARME MÉDICAMENT MAINTENANT", "दवा का अलार्म अभी", "மருந்து அலாரம் இப்போது");
        put("Time to take", "Hora de tomar", "C’est l’heure de prendre", "लेने का समय:", "எடுக்கும் நேரம்:");
        put("Time to take your medicine", "Hora de su medicina", "L’heure de votre médicament", "दवा लेने का समय", "மருந்து எடுக்கும் நேரம்");
        put("It is time to take", "Es hora de tomar", "C’est l’heure de prendre", "अब लेने का समय है", "இப்போது எடுக்க வேண்டியது");
        put("your medicine", "su medicina", "votre médicament", "आपकी दवा", "உங்கள் மருந்து");
        put("TAKEN", "TOMADA", "PRIS", "ले ली", "எடுத்தேன்");
        put("LATER (10 MIN)", "MÁS TARDE (10 MIN)", "PLUS TARD (10 MIN)", "बाद में (10 मिनट)", "பிறகு (10 நிமி)");
        put("Snoozed {n} of 2 times", "Pospuesta {n} de 2 veces", "Reportée {n} fois sur 2", "{n} / 2 बार टाली गई", "2-இல் {n} முறை தள்ளிவைக்கப்பட்டது");
        put("Snooze limit reached. Your family has been alerted.", "Límite alcanzado. Se ha avisado a su familia.", "Limite atteinte. Votre famille a été prévenue.", "टालने की सीमा पूरी। परिवार को सूचित किया गया।", "வரம்பு முடிந்தது. குடும்பத்துக்குத் தெரிவிக்கப்பட்டது.");
        put("Dose recorded", "Dosis registrada", "Dose enregistrée", "खुराक दर्ज", "அளவு பதிவானது");
        put("Reminder in 10 minutes", "Recordatorio en 10 minutos", "Rappel dans 10 minutes", "10 मिनट में फिर याद दिलाएँगे", "10 நிமிடத்தில் மீண்டும் நினைவூட்டல்");
        put("Test alarm", "Alarma de prueba", "Alarme de test", "परीक्षण अलार्म", "சோதனை அலாரம்");
        put("This is how your medicine alarm will ring.", "Así sonará la alarma de su medicina.", "Voici comment sonnera l’alarme.", "दवा का अलार्म ऐसे बजेगा।", "உங்கள் மருந்து அலாரம் இப்படி ஒலிக்கும்.");
        put("STOP", "DETENER", "ARRÊTER", "बंद करें", "நிறுத்து");
        put("Morning", "Mañana", "Matin", "सुबह", "காலை");
        put("Afternoon", "Tarde", "Après-midi", "दोपहर", "மதியம்");
        put("Evening", "Noche", "Soir", "शाम", "மாலை");
        put("Bedtime", "Al dormir", "Coucher", "सोते समय", "உறங்கும் நேரம்");
    }
    private static void put(String en, String es, String fr, String hi, String ta) { T.put(en, new String[]{en, es, fr, hi, ta}); }

    private final String lang;
    AlarmText(Context c) { lang = new EscalationEngine(c).prefsLanguage(); }

    String get(String en) {
        String[] row = T.get(en); if (row == null) return en;
        switch (lang) { case "es": return row[1]; case "fr": return row[2]; case "hi": return row[3]; case "ta": return row[4]; default: return row[0]; }
    }
    Locale locale() {
        switch (lang) { case "es": return new Locale("es", "ES"); case "fr": return Locale.FRANCE; case "hi": return new Locale("hi", "IN"); case "ta": return new Locale("ta", "IN"); default: return Locale.US; }
    }
}
