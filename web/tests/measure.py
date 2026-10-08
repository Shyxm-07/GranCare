from playwright.sync_api import sync_playwright
EXP = {
 'patient-dashboard': [("Welcome",142),("Schedule Clear",416),("Today's Medication",824),("Quick Actions",1480),("Audio Guidance",1876)],
 'role-selection': [("ENTER CARETAKER",772),("System Synchronization Active",894),("Interface",1162)],
 'caretaker-dashboard': [("--%",688),("No Medication Events Recorded",1102),("Quick Caretaker Action Bar",1334)],
 'prescription-ocr': [("Optical Character",677),("Medication Name",993),("Save to My Medications",1637)],
 'medication-reminder': [("MEDICATION DETAILS",345),("TAKEN",820),("Need Help? Call Caretaker",1034)],
 'smartwatch-dose-alert': [("Dose Recorded",221),("Phone Link Status",460)],
 'smartwatch-alarm': [("Metformin",342),("TAKEN",635),("Wrist Haptics Live",972)],
}
JS = """([txt]) => { const sec=document.querySelector('.screen:not([hidden])'); const r0=sec.getBoundingClientRect();
 const ps=[...sec.querySelectorAll('p')].filter(p=>p.textContent.trim()===txt); if(!ps.length) return null;
 const r=ps[0].getBoundingClientRect(); return Math.round((r.top-r0.top)*10)/10; }"""
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':520,'height':900})
    for s,items in EXP.items():
        pg.goto('file://../dist/index.html#'+s); pg.wait_for_timeout(200)
        out=[]
        for t,e in items:
            y=pg.evaluate(JS,[t]); out.append(f"{t[:22]!r}: {y} vs {e} ({'' if y is None else round(y-e,1)})")
        print(s, ' | '.join(out))
    b.close()
