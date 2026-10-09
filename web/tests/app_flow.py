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
    pg.fill('#f-name', 'Metformin'); pg.fill('#f-dose', '500 mg'); pg.fill('#f-freq', 'Morning / Night'); pg.fill('#f-days', '30')
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
    pg.fill('#pf-address', '12 Gandhi St, Adyar'); pg.fill('#pf-c-name', 'Adyar Clinic'); pg.fill('#pf-c-phone', '+91 44 2441 0000')
    pg.click('#pf-save'); pg.wait_for_timeout(400)
    prof = pg.evaluate("JSON.parse(localStorage.getItem('gc.db.v1'))['profile/patient']")
    check('profile saved with contacts', prof and prof['children'][0]['phone'] == '+91 98765 43210' and prof['guardian']['name'] == 'Ravi')
    check('profile saved with address and clinic', prof.get('address') == '12 Gandhi St, Adyar' and prof.get('clinic', {}).get('phone') == '+91 44 2441 0000', prof)
    pg.reload(); pg.wait_for_timeout(500); pg.evaluate("window.__showScreen('profile')"); pg.wait_for_timeout(300)
    check('profile reloads into the form', pg.input_value('#pf-children [data-f=name]') == 'Shyam')
    ALERTS = "Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('gc.db.v1'))).filter(([k])=>k.startsWith('alerts/')).map(([k,v])=>[v.slot,v]))"
    def at(hhmm):
        pg.clock.set_fixed_time(datetime.datetime.fromisoformat(f'{day}T{hhmm}:00+05:30')); pg.evaluate("window.__granCareRender()"); pg.wait_for_timeout(300)
    def snooze3():
        pg.evaluate("window.__showScreen('medication-reminder')"); pg.wait_for_timeout(200)
        for i in range(3):
            pg.click('#mr-snooze'); pg.wait_for_timeout(300); pg.evaluate("window.__showScreen('medication-reminder')"); pg.wait_for_timeout(200)
    # 4) morning: snooze twice, 3rd attempt -> time window exhausted, son alerted
    at('08:01'); snooze3()
    al = pg.evaluate(ALERTS)
    check('3rd snooze raises family alert (level 1)', al.get('morning', {}).get('level') == 1, al)
    check('reminder shows the time window is exhausted', T('mr-snooze-label') == 'TIME WINDOW EXHAUSTED')
    # 5) the son sees it within 20 minutes -> no emergency
    at('08:10'); pg.evaluate("window.__showScreen('caretaker-dashboard')"); pg.wait_for_timeout(300)
    check('caretaker sees the family alert', 'Family Alert' in T('ct-alert-title'), T('ct-alert-title'))
    check('caretaker has no YES / LATER, only I\u2019ve seen it', pg.locator('#ct-ack-yes').count() == 0 and pg.is_visible('#ct-ack-seen'))
    pg.click('#ct-ack-seen'); pg.wait_for_timeout(300)
    a = pg.evaluate(ALERTS)['morning']
    check('I\u2019ve seen it marks the alert seen', a.get('resolved') == 'seen' and a.get('ackType') == 'seen', a)
    at('08:25')
    a = pg.evaluate(ALERTS)['morning']
    check('seen in time -> no emergency after 20 min', a.get('level') == 1 and a.get('resolved') == 'seen', a)
    check('caretaker shows it as seen', 'Seen' in T('ct-alert-title'), T('ct-alert-title'))
    pg.evaluate("window.__showScreen('medication-reminder')"); pg.wait_for_timeout(200)
    pg.click('#mr-taken'); pg.wait_for_timeout(400); at('08:30')
    check('patient takes the morning dose -> closed', pg.evaluate(ALERTS)['morning'].get('resolved') == 'taken', pg.evaluate(ALERTS)['morning'])
    # 6) bedtime: nobody sees it for 20 minutes -> medical emergency
    at('22:01'); snooze3()
    check('bedtime alert raised', pg.evaluate(ALERTS).get('bedtime', {}).get('level') == 1)
    at('22:15')
    check('still waiting at 14 minutes', pg.evaluate(ALERTS)['bedtime'].get('level') == 1)
    at('22:22')
    bt = pg.evaluate(ALERTS)['bedtime']
    check('unseen for 20 min -> medical emergency (level 2)', bt.get('level') == 2 and not bt.get('resolved'), bt)
    at('22:40')
    check('no third level any more', pg.evaluate(ALERTS)['bedtime'].get('level') == 2)
    pg.evaluate("window.__showScreen('caretaker-dashboard')"); pg.wait_for_timeout(300)
    check('caretaker sees the medical emergency', 'MEDICAL EMERGENCY' in T('ct-alert-title'), T('ct-alert-title'))
    # 7) taking the dose closes it
    pg.evaluate("window.__showScreen('medication-reminder')"); pg.wait_for_timeout(200)
    pg.click('#mr-taken'); pg.wait_for_timeout(400); at('22:41')
    check('taking the dose closes the emergency', pg.evaluate(ALERTS)['bedtime'].get('resolved') == 'taken', pg.evaluate(ALERTS)['bedtime'])
    pg.locator('#profile').screenshot(path='/tmp/claude-0/al/app-profile.png') if False else None
    check('no page errors', not errs, errs)
    pg.evaluate("window.__showScreen('profile')"); pg.wait_for_timeout(300); pg.locator('#profile').screenshot(path='/tmp/gc-profile.png')
    b.close()
sys.exit(0 if ok else 1)
