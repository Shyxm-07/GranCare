from playwright.sync_api import sync_playwright
import datetime
day=datetime.date.today().isoformat(); now=datetime.datetime.now()
seed=f"""
window.__seed=function(){{ const s=window.__store;
 s['meds/m1']={{name:'Metformin',dosage:'500 mg',frequency:'Morning / Night',durationDays:30,physician:'Dr. Rao',instructions:'Take after meals',slots:['morning','bedtime'],active:true,createdAt:'2026-10-01T08:00:00Z'}};
 s['meds/m2']={{name:'Atorvastatin',dosage:'10 mg',frequency:'Evening',durationDays:90,physician:'Dr. Rao',instructions:'',slots:['evening'],active:true,createdAt:'2026-10-01T08:00:00Z'}};
 s['meds/m3']={{name:'Amlodipine',dosage:'5 mg',frequency:'Afternoon',durationDays:60,physician:'',instructions:'',slots:['afternoon'],active:true,createdAt:'2026-10-01T08:00:00Z'}};
 s['events/e1']={{type:'taken',medId:'m1',medName:'Metformin',slot:'morning',at:'{day}T08:05:00',day:'{day}'}};
 s['events/e2']={{type:'snoozed',medId:'m3',medName:'Amlodipine',slot:'afternoon',minutes:15,until:'{day}T13:15:00',at:'{day}T13:00:00',day:'{day}'}};
 s['events/e3']={{type:'sos',at:'{day}T14:00:00',day:'{day}'}};
 s['profile/patient']={{name:'Lakshmi Raman',phone:'+91 98765 43210'}};
}};"""
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':520,'height':900})
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.add_init_script(path='mock.js'); pg.add_init_script(seed+"window.__seed();")
    for sl in ['patient-dashboard','medication-reminder','smartwatch-alarm','smartwatch-dose-alert','caretaker-dashboard','role-selection']:
        pg.goto('file://../dist/index.html#'+sl); pg.add_style_tag(content='.viewer-bar{display:none!important}'); pg.wait_for_timeout(400)
        pg.locator('#'+sl).screenshot(path=f'/tmp/claude-0/d-{sl}.png')
    print(errs)
    b.close()
