"""End-to-end check of the Android build (web/dist-app) running on its on-phone backend.
Run: python3 tests/app_flow.py  (needs: pip install playwright)"""
import datetime, os, sys
from playwright.sync_api import sync_playwright
URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist-app', 'index.html'))
day = datetime.date.today().isoformat()
ok = True
def check(label, cond, extra=''):
    global ok; ok &= bool(cond); print(('PASS ' if cond else 'FAIL ') + label, extra)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 412, 'height': 900}, timezone_id='Asia/Kolkata')
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.clock.install(time=datetime.datetime.fromisoformat(f'{day}T07:00:00+05:30'))
    pg.goto(URL + '#prescription-ocr'); pg.wait_for_timeout(600)
    T = lambda i: pg.evaluate(f"(document.getElementById('{i}')||{{}}).textContent")
    # 1) add a medication through the verification form
    pg.fill('#f-name', 'Metformin'); pg.fill('#f-dose', '500 mg'); pg.fill('#f-freq', 'Morning'); pg.fill('#f-days', '30')
    pg.click('#ocr-save'); pg.wait_for_timeout(500)
    check('medication saved and shown', 'Metformin' in pg.evaluate("document.querySelector('[data-slot-list=morning]').textContent"))
    # 2) survives an app restart (localStorage)
    pg.reload(); pg.wait_for_timeout(600); pg.evaluate("window.__showScreen('patient-dashboard')"); pg.wait_for_timeout(300)
    check('medication persists after restart', 'Metformin' in pg.evaluate("document.querySelector('[data-slot-list=morning]').textContent"))
    # 3) profile with a son and a guardian
    pg.evaluate("window.__showScreen('profile')"); pg.wait_for_timeout(300)
    pg.fill('#pf-name', 'Lakshmi Raman')
    pg.fill('#pf-children [data-f=name]', 'Shyam'); pg.fill('#pf-children [data-f=phone]', '+91 98765 43210')
    pg.fill('#pf-g-name', 'Ravi'); pg.fill('#pf-g-phone', '+91 91234 56789')
    pg.click('#pf-save'); pg.wait_for_timeout(400)
    prof = pg.evaluate("JSON.parse(localStorage.getItem('gc.db.v1'))['profile/patient']")
    check('profile saved with contacts', prof and prof['children'][0]['phone'] == '+91 98765 43210' and prof['guardian']['name'] == 'Ravi')
    pg.reload(); pg.wait_for_timeout(500); pg.evaluate("window.__showScreen('profile')"); pg.wait_for_timeout(300)
    check('profile reloads into the form', pg.input_value('#pf-children [data-f=name]') == 'Shyam')
    # 4) snooze twice, third attempt escalates
    pg.clock.set_fixed_time(datetime.datetime.fromisoformat(f'{day}T08:01:00+05:30'))
    pg.evaluate("window.__showScreen('medication-reminder')"); pg.wait_for_timeout(200)
    for i in range(3):
        pg.click('#mr-snooze'); pg.wait_for_timeout(300); pg.evaluate("window.__showScreen('medication-reminder')"); pg.wait_for_timeout(200)
    alerts = pg.evaluate("Object.entries(JSON.parse(localStorage.getItem('gc.db.v1'))).filter(([k])=>k.startsWith('alerts/')).map(([k,v])=>v)")
    check('3rd snooze raises family alert (level 1)', alerts and alerts[0]['level'] == 1, alerts)
    check('snooze label shows the limit', T('mr-snooze-label') == 'SNOOZE LIMIT REACHED')
    # 5) 20 minutes without reply -> emergency; +10 -> guardian
    pg.clock.set_fixed_time(datetime.datetime.fromisoformat(f'{day}T08:22:00+05:30')); pg.evaluate("window.__granCareRender()"); pg.wait_for_timeout(300)
    lv = pg.evaluate("Object.entries(JSON.parse(localStorage.getItem('gc.db.v1'))).filter(([k])=>k.startsWith('alerts/'))[0][1].level")
    check('no reply in 20 min -> emergency (level 2)', lv == 2, lv)
    pg.clock.set_fixed_time(datetime.datetime.fromisoformat(f'{day}T08:33:00+05:30')); pg.evaluate("window.__granCareRender()"); pg.wait_for_timeout(300)
    lv = pg.evaluate("Object.entries(JSON.parse(localStorage.getItem('gc.db.v1'))).filter(([k])=>k.startsWith('alerts/'))[0][1].level")
    check('no reply 10 min later -> guardian (level 3)', lv == 3, lv)
    # 6) caretaker sees the alert and answers YES
    pg.evaluate("window.__showScreen('caretaker-dashboard')"); pg.wait_for_timeout(300)
    check('caretaker sees emergency', 'EMERGENCY' in T('ct-alert-title'), T('ct-alert-title'))
    pg.click('#ct-ack-yes'); pg.wait_for_timeout(300)
    a = pg.evaluate("Object.entries(JSON.parse(localStorage.getItem('gc.db.v1'))).filter(([k])=>k.startsWith('alerts/'))[0][1]")
    check('family YES closes the alert', a.get('resolved') == 'ack' and a.get('ackType') == 'yes')
    pg.locator('#profile').screenshot(path='/tmp/claude-0/al/app-profile.png') if False else None
    check('no page errors', not errs, errs)
    pg.evaluate("window.__showScreen('profile')"); pg.wait_for_timeout(300); pg.locator('#profile').screenshot(path='/tmp/gc-profile.png')
    b.close()
sys.exit(0 if ok else 1)
