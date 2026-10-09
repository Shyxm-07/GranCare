"""Login / sign-up / family linking test for the Android build (web/dist-app).

Local (no network):   GC_FIREBASE_MOCK=1 npm run build:app && python3 tests/auth_flow.py --mock
Against emulators:    GC_FIREBASE_EMULATOR=1 npm run build:app
                      firebase emulators:exec --only auth,firestore "python3 web/tests/auth_flow.py"
The emulator run also checks firestore.rules (a stranger cannot read another family's data).
"""
import functools, http.server, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright

MOCK = '--mock' in sys.argv
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist-app'))
PORT = 5055
ok = True


def check(label, cond, extra=''):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + label, extra if not cond else '', flush=True)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    handler.log_message = lambda *a: None
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


URL = f'http://127.0.0.1:{PORT}/index.html'
stamp = str(int(time.time()))
PATIENT = {'email': f'lakshmi{stamp}@example.com', 'pass': 'secret123', 'name': 'Lakshmi Raman', 'phone': '+91 98765 43210'}
SON = {'email': f'shyam{stamp}@example.com', 'pass': 'secret456', 'name': 'Shyam', 'phone': '+91 91234 56789'}


def screen(pg):
    return pg.evaluate("(document.querySelector('.screen:not([hidden])')||{}).id")


def text(pg, i):
    return pg.evaluate(f"(document.getElementById('{i}')||{{}}).textContent||''").strip()


def wait_screen(pg, sid, timeout=15000):
    pg.wait_for_function(f"(document.querySelector('.screen:not([hidden])')||{{}}).id==='{sid}'", timeout=timeout)


def sign_up(pg, who, role, code=''):
    pg.evaluate("window.__showScreen('signup')"); wait_screen(pg, 'signup')
    pg.check(f'input[name=au-role][value={role}]')
    pg.fill('#su-name', who['name']); pg.fill('#su-phone', who['phone'])
    pg.fill('#su-email', who['email']); pg.fill('#su-pass', who['pass']); pg.fill('#su-pass2', who['pass'])
    if role != 'patient':
        pg.fill('#su-code', code)
    pg.click('#au-signup-btn')


def log_in(pg, who):
    pg.fill('#au-email', who['email']); pg.fill('#au-pass', who['pass']); pg.click('#au-login-btn')


httpd = serve()
with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    def new_phone():
        # mock: pages of one context share the in-memory "server"; emulator: separate phones
        ctx = shared if MOCK else browser.new_context(viewport={'width': 412, 'height': 900})
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.goto(URL); pg.wait_for_timeout(800)
        return pg

    shared = browser.new_context(viewport={'width': 412, 'height': 900}) if MOCK else None

    # ---- patient phone ----
    a = new_phone()
    check('starts on Log In', screen(a) == 'login', screen(a))
    a.evaluate("window.__showScreen('patient-dashboard')"); a.wait_for_timeout(200)
    check('app screens are locked until signed in', screen(a) == 'login', screen(a))

    log_in(a, PATIENT); a.wait_for_timeout(1500)
    check('unknown account is refused', 'incorrect' in text(a, 'au-login-err'), text(a, 'au-login-err'))

    a.evaluate("window.__showScreen('signup')"); wait_screen(a, 'signup')
    a.fill('#su-name', 'X'); a.fill('#su-email', 'x@example.com'); a.fill('#su-pass', 'abc'); a.fill('#su-pass2', 'abc')
    a.click('#au-signup-btn'); a.wait_for_timeout(200)
    check('short password is refused', 'at least 6' in text(a, 'au-signup-err'), text(a, 'au-signup-err'))
    a.fill('#su-pass', 'abcdef'); a.fill('#su-pass2', 'abcdeg'); a.click('#au-signup-btn'); a.wait_for_timeout(200)
    check('mismatched passwords are refused', 'do not match' in text(a, 'au-signup-err'), text(a, 'au-signup-err'))

    sign_up(a, PATIENT, 'patient')
    wait_screen(a, 'patient-dashboard')
    check('patient sign-up opens the patient dashboard', True)
    a.evaluate("window.__showScreen('profile')"); a.wait_for_timeout(800)
    code = text(a, 'pf-invite')
    check('profile shows a 6-letter invite code', len(code) == 6 and code.isalnum(), code)
    check('profile shows the signed-in email', PATIENT['email'] in text(a, 'pf-acct-email'), text(a, 'pf-acct-email'))
    fid = a.evaluate('window.__gcAccount.familyId')

    a.evaluate("window.__showScreen('prescription-ocr')"); a.wait_for_timeout(300)
    a.fill('#f-name', 'Metformin'); a.fill('#f-dose', '500 mg'); a.fill('#f-freq', 'Morning / Night'); a.fill('#f-days', '30')
    a.click('#ocr-save'); a.wait_for_timeout(1500)
    check('patient adds a medicine', 'Metformin' in a.evaluate("document.querySelector('[data-slot-list=morning]').textContent"))

    # log out and back in
    a.evaluate("window.__showScreen('profile')"); a.wait_for_timeout(300)
    a.click('#pf-logout'); a.wait_for_timeout(1500)
    wait_screen(a, 'login')
    check('log out returns to Log In', True)
    log_in(a, PATIENT); wait_screen(a, 'patient-dashboard')
    a.wait_for_timeout(1500)
    check('log back in: medicine is still there', 'Metformin' in a.evaluate("document.querySelector('[data-slot-list=morning]').textContent"))

    # ---- son's phone ----
    b = new_phone()
    if MOCK:  # same browser context: make this page a signed-out phone
        b.evaluate("sessionStorage.clear()"); b.reload(); b.wait_for_timeout(800)
    sign_up(b, SON, 'son', 'ZZZZZZ'); b.wait_for_timeout(2500)
    check('wrong invite code is refused', 'not found' in text(b, 'au-signup-err'), text(b, 'au-signup-err'))
    SON2 = dict(SON); SON2['email'] = 'b' + SON['email']
    sign_up(b, SON2, 'son', code.lower())
    wait_screen(b, 'caretaker-dashboard')
    check('son sign-up with the code opens the caretaker dashboard', True)
    b.wait_for_timeout(2000)
    check('son sees the patient by name', PATIENT['name'] in text(b, 'ct-patient'), text(b, 'ct-patient'))
    check('son sees the patient\'s medicine', '[0 / 2]' in text(b, 'ct-taken') or '/ 2]' in text(b, 'ct-taken'), text(b, 'ct-taken'))

    a.evaluate("window.__showScreen('profile')"); a.wait_for_timeout(2000)
    kids = a.evaluate("window.__gc.S.profile.children||[]")
    check('son is added to the patient\'s alert contacts', any(k.get('phone') == SON['phone'] and k.get('relation') == 'Son' for k in kids), kids)

    # ---- security rules (real emulator only) ----
    if not MOCK:
        c = new_phone()
        stranger = {'email': f'stranger{stamp}@example.com', 'pass': 'secret789', 'name': 'Stranger', 'phone': '+1 555 0100'}
        sign_up(c, stranger, 'patient'); wait_screen(c, 'patient-dashboard')
        res = c.evaluate("""(fid) => window.__gcCloud.fs.collection('families/' + fid + '/meds').get()
              .then(() => 'read-allowed', e => e.code)""", fid)
        check('a stranger cannot read another family\'s medicines', res == 'permission-denied', res)
        res = c.evaluate("""(fid) => window.__gcCloud.fs.doc('families/' + fid).update({['members.' + window.__gcAccount.uid]: 'patient'})
              .then(() => 'write-allowed', e => e.code)""", fid)
        check('a stranger cannot make themselves the patient', res == 'permission-denied', res)
        res = c.evaluate("""() => window.__gcCloud.fs.collection('invites').get().then(() => 'list-allowed', e => e.code)""")
        check('invite codes cannot be listed', res == 'permission-denied', res)

    check('no page errors', not errors, errors)
    browser.close()
httpd.shutdown()
sys.exit(0 if ok else 1)
