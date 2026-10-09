/* Gran Care accounts and shared family data (Firebase).
   Active only when web/firebase-config.js provides a config. Then:
   - nothing but Log In / Create Account is reachable until someone is signed in
   - the patient's sign-up creates a family with an invite code; sons, daughters and the
     local guardian join it with that code and are added to the patient's alert contacts
   - claude.use('db') resolves to the family's Firestore data (families/{id}/...), so
     app.js, escalation.js and profile.js work unchanged and every phone in the family
     sees the same medicines, doses and alerts live
   Without a config the app keeps its on-phone store (standalone.js). */
(function () {
  'use strict';
  var cfg = window.GC_FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || !window.firebase) return;

  firebase.initializeApp(cfg);
  var auth = firebase.auth();
  var fs = firebase.firestore();
  fs.settings({ ignoreUndefinedProperties: true });
  if (window.GC_FIREBASE_EMULATOR) {
    auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    fs.useEmulator('127.0.0.1', 8080);
  } else {
    fs.enablePersistence().catch(function () {});
  }

  var $ = function (s) { return document.querySelector(s); };
  var G = function () { return window.__gc; };
  var AUTH_SCREENS = { login: 1, signup: 1 };
  var account = null;           // { uid, email, name, role, familyId, inviteCode }
  var resolveReady;
  var ready = new Promise(function (r) { resolveReady = r; });
  var authKnown = false;
  var busy = false;

  window.__gcCloud = { auth: auth, fs: fs };
  window.__gcAccount = null;

  // ---------- claude.use(): family-scoped Firestore once signed in ----------
  function scopedDb(fid) {
    var base = 'families/' + fid + '/';
    return {
      collection: function (p) { return fs.collection(base + p); },
      doc: function (p) { return fs.doc(base + p); }
    };
  }
  var local = window.claude;
  window.claude = {
    use: function (name) {
      if (name === 'db') return ready.then(function (a) { return a.db; });
      if (name === 'user') return ready.then(function (a) { return a.user; });
      return local ? local.use(name) : Promise.resolve(null);
    }
  };

  // ---------- screen gating ----------
  document.documentElement.classList.add('gc-auth-pending');
  function homeFor(role) { return role === 'patient' ? 'patient-dashboard' : 'caretaker-dashboard'; }
  function installGate() {
    var show = window.__showScreen;
    window.__showScreen = function (slug) {
      if (!account && !AUTH_SCREENS[slug]) slug = 'login';
      if (account && AUTH_SCREENS[slug]) slug = homeFor(account.role);
      show(slug);
    };
  }
  function go(slug) { if (window.__showScreen) window.__showScreen(slug); }

  // ---------- helpers ----------
  function tr(t, v) { return G() ? G().tr(t, v) : t; }
  function setT(id, t) { var g = G(); if (g && document.getElementById(id)) g.setT(id, t); }
  function err(id, msg) { setT(id, msg || ' '); }
  var CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newCode() { var s = ''; var r = new Uint32Array(6); crypto.getRandomValues(r); for (var i = 0; i < 6; i++) s += CODE_ABC[r[i] % CODE_ABC.length]; return s; }
  var PHONE = /^[+\d][\d\s()-]{5,}$/;
  function authMessage(e) {
    var c = (e && e.code) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return 'Email or password is incorrect.';
    if (/email-already-in-use/.test(c)) return 'An account with this email already exists. Log in instead.';
    if (/invalid-email/.test(c)) return 'Enter a valid email address.';
    if (/weak-password/.test(c)) return 'Password must be at least 6 characters.';
    if (/too-many-requests/.test(c)) return 'Too many attempts. Wait a minute and try again.';
    if (/network-request-failed|unavailable/.test(c)) return 'No internet connection. Check your network and try again.';
    if (/permission-denied/.test(c)) return 'Access was refused. Check the Firestore security rules are published.';
    if (e && e.gcMessage) return e.gcMessage;
    return 'Something went wrong. Please try again.';
  }
  function fail(msg) { var e = new Error(msg); e.gcMessage = msg; return e; }
  function setBusy(btnLabelId, on, labelOn, labelOff) { busy = on; setT(btnLabelId, on ? labelOn : labelOff); }

  // ---------- sign in state ----------
  var userUnsub = null, famUnsub = null;
  auth.onAuthStateChanged(function (u) {
    authKnown = true;
    if (userUnsub) { userUnsub(); userUnsub = null; }
    if (!u) {
      account = null; window.__gcAccount = null;
      document.documentElement.classList.remove('gc-auth-pending');
      var cur = document.querySelector('.screen:not([hidden])');
      go(cur && AUTH_SCREENS[cur.id] ? cur.id : 'login');
      return;
    }
    // Wait for users/{uid}; during sign-up it is written right after the auth account.
    userUnsub = fs.doc('users/' + u.uid).onSnapshot(function (snap) {
      if (!snap.exists) return;
      var d = snap.data();
      if (!d.familyId) return;
      if (userUnsub) { userUnsub(); userUnsub = null; }
      signedIn(u, d);
    }, function (e) { document.documentElement.classList.remove('gc-auth-pending'); err('au-login-err', tr(authMessage(e))); });
  });

  function signedIn(u, d) {
    if (account) return;
    account = { uid: u.uid, email: u.email, name: d.name || '', role: d.role, relation: d.relation || '', familyId: d.familyId, inviteCode: '' };
    window.__gcAccount = account;
    try { localStorage.setItem('gc.home', homeFor(d.role)); } catch (e) {}
    famUnsub = fs.doc('families/' + d.familyId).onSnapshot(function (f) {
      if (f.exists) { account.inviteCode = f.data().inviteCode || ''; renderAccount(); }
    }, function () {});
    resolveReady({
      db: scopedDb(d.familyId),
      user: {
        id: function () { return Promise.resolve(u.uid); },
        me: function () { return Promise.resolve({ id: u.uid, name: account.name }); },
        isOwner: function () { return d.role === 'patient'; }, canEdit: function () { return true; }, can: function () { return true; },
        profiles: function () { return Promise.resolve({}); }
      }
    });
    document.documentElement.classList.remove('gc-auth-pending');
    var cur = document.querySelector('.screen:not([hidden])');
    if (!cur || AUTH_SCREENS[cur.id] || cur.id === 'role-selection') go(homeFor(d.role));
    renderAccount();
  }

  // ---------- log in ----------
  function logIn(ev) {
    ev.preventDefault(); if (busy) return;
    var email = $('#au-email').value.trim(), pass = $('#au-pass').value;
    if (!email || !pass) { err('au-login-err', tr('Enter your email and password.')); return; }
    err('au-login-err');
    setBusy('au-login-label', true, tr('Logging in…'), tr('Log In'));
    auth.signInWithEmailAndPassword(email, pass)
      .catch(function (e) { err('au-login-err', tr(authMessage(e))); })
      .then(function () { setBusy('au-login-label', false, '', tr('Log In')); });
  }
  function forgot() {
    var email = $('#au-email').value.trim();
    if (!email) { err('au-login-err', tr('Type your email above, then tap Forgot password.')); return; }
    auth.sendPasswordResetEmail(email)
      .then(function () { err('au-login-err'); G().toast(tr('Password reset email sent to {email}.', { email: email })); })
      .catch(function (e) { err('au-login-err', tr(authMessage(e))); });
  }

  // ---------- sign up ----------
  function role() { var r = document.querySelector('input[name=au-role]:checked'); return r ? r.value : 'patient'; }
  function onRoleChange() { var wrap = $('#su-code-wrap'); if (wrap) wrap.style.display = role() === 'patient' ? 'none' : ''; }

  function signUp(ev) {
    ev.preventDefault(); if (busy) return;
    var r = role();
    var f = { name: $('#su-name').value.trim(), phone: $('#su-phone').value.trim(), email: $('#su-email').value.trim(),
              pass: $('#su-pass').value, pass2: $('#su-pass2').value, code: ($('#su-code').value || '').trim().toUpperCase() };
    var problem = !f.name ? 'Enter your full name.'
      : f.phone && !PHONE.test(f.phone) ? 'Enter a valid phone number, e.g. +91 98765 43210.'
      : r !== 'patient' && !f.phone ? 'Enter your phone number so the alerts can reach you.'
      : !f.email ? 'Enter your email address.'
      : f.pass.length < 6 ? 'Password must be at least 6 characters.'
      : f.pass !== f.pass2 ? 'The two passwords do not match.'
      : r !== 'patient' && f.code.length < 6 ? 'Enter the 6-letter family invite code from the patient’s Profile screen.'
      : null;
    if (problem) { err('au-signup-err', tr(problem)); return; }
    err('au-signup-err');
    setBusy('au-signup-label', true, tr('Creating account…'), tr('Create Account'));
    var cred;
    auth.createUserWithEmailAndPassword(f.email, f.pass).then(function (c) {
      cred = c;
      return c.user.updateProfile({ displayName: f.name }).catch(function () {});
    }).then(function () {
      return r === 'patient' ? createFamily(cred.user, f) : joinFamily(cred.user, f, r);
    }).catch(function (e) {
      // Do not leave a half-made account behind (e.g. wrong invite code).
      if (cred && cred.user && !account) cred.user.delete().catch(function () { auth.signOut(); });
      err('au-signup-err', tr(authMessage(e)));
    }).then(function () { setBusy('au-signup-label', false, '', tr('Create Account')); });
  }

  function uniqueCode(tries) {
    var code = newCode();
    return fs.doc('invites/' + code).get().then(function (s) {
      if (!s.exists) return code;
      if (tries > 5) throw fail('Could not create an invite code. Try again.');
      return uniqueCode(tries + 1);
    });
  }

  function createFamily(user, f) {
    var fid = fs.collection('families').doc().id, code;
    var now = new Date().toISOString();
    return uniqueCode(0).then(function (c) {
      code = c;
      var members = {}; members[user.uid] = 'patient';
      return fs.doc('families/' + fid).set({ patientUid: user.uid, inviteCode: code, members: members, createdAt: now });
    }).then(function () {
      return fs.doc('invites/' + code).set({ familyId: fid, ownerUid: user.uid, createdAt: now });
    }).then(function () {
      return fs.doc('families/' + fid + '/members/' + user.uid).set({ name: f.name, phone: f.phone, email: f.email, role: 'patient', joinedAt: now });
    }).then(function () {
      return fs.doc('families/' + fid + '/profile/patient').set({ name: f.name, phone: f.phone, children: [], guardian: { name: '', phone: '' }, autoAlerts: true, updatedAt: now });
    }).then(function () {
      return fs.doc('users/' + user.uid).set({ name: f.name, phone: f.phone, email: f.email, role: 'patient', familyId: fid, createdAt: now });
    });
  }

  function joinFamily(user, f, r) {
    var fid, now = new Date().toISOString();
    var memberRole = r === 'guardian' ? 'guardian' : 'child';
    return fs.doc('invites/' + f.code).get().then(function (inv) {
      if (!inv.exists) throw fail('That invite code was not found. Check it on the patient’s Profile screen.');
      fid = inv.data().familyId;
      var patch = {}; patch['members.' + user.uid] = memberRole;
      return fs.doc('families/' + fid).update(patch);
    }).then(function () {
      return fs.doc('families/' + fid + '/members/' + user.uid).set({ name: f.name, phone: f.phone, email: f.email, role: memberRole, relation: r, joinedAt: now });
    }).then(function () {
      // Add the new member to the patient's alert contacts.
      var ref = fs.doc('families/' + fid + '/profile/patient');
      return ref.get().then(function (s) {
        var p = s.exists ? s.data() : {};
        var children = (p.children || []).filter(function (c) { return c.uid !== user.uid; });
        var guardian = p.guardian || { name: '', phone: '' };
        if (memberRole === 'child') children.push({ name: f.name, relation: r === 'daughter' ? 'Daughter' : 'Son', phone: f.phone, uid: user.uid });
        else guardian = { name: f.name, phone: f.phone, uid: user.uid };
        return ref.set(Object.assign({}, p, { children: children, guardian: guardian, updatedAt: now }));
      });
    }).then(function () {
      return fs.doc('users/' + user.uid).set({ name: f.name, phone: f.phone, email: f.email, role: memberRole, relation: r, familyId: fid, createdAt: now });
    });
  }

  // ---------- "seen" links for the alert SMS (free: Firestore Spark plan + GitHub Pages) ----------
  // The patient's phone makes one link per upcoming dose: alertLinks/{token}, a public-by-token
  // record, plus families/{fid}/linkTokens/{medId|slot|day} -> token so the family can find it.
  // The son's SMS carries GC_SEEN_BASE#token. Opening that page, or the alert in the app, sets
  // seenAt; the patient's phone checks it 20 minutes later before declaring an emergency.
  var tokenWait = {};
  function linkKey(medId, slot, day) { return medId + '|' + slot + '|' + day; }
  function newToken() {
    var a = new Uint8Array(18), s = ''; crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  function tokenRef(k) { return fs.doc('families/' + account.familyId + '/linkTokens/' + k.replace(/\//g, '_')); }
  /** Token for this dose; the patient creates it if missing. Resolves '' when there is none. */
  function linkFor(k, info) {
    if (!account) return Promise.resolve('');
    if (tokenWait[k]) return tokenWait[k];
    var p = tokenRef(k).get().then(function (s) {
      if (s.exists && s.data().token) return s.data().token;
      if (account.role !== 'patient' || !info) return '';
      var t = newToken(), now = new Date().toISOString();
      return fs.doc('alertLinks/' + t).set({ patientName: info.patientName || account.name || '', medName: info.medName || '',
        dueAt: info.dueAt || '', createdBy: account.uid, createdAt: now })
        .then(function () { return tokenRef(k).set({ token: t, createdAt: now }); })
        .then(function () { return t; });
    }).catch(function () { delete tokenWait[k]; return ''; });
    tokenWait[k] = p;
    return p.then(function (t) { if (!t) delete tokenWait[k]; return t; });
  }
  /** seenAt / seenVia of a link ('' when not seen or unknown). */
  function linkStatus(token) {
    if (!token) return Promise.resolve({});
    return fs.doc('alertLinks/' + token).get().then(function (s) { return s.exists ? s.data() : {}; }).catch(function () { return {}; });
  }
  function markSeen(k, via) {
    return linkFor(k).then(function (t) {
      if (!t) return false;
      return fs.doc('alertLinks/' + t).update({ seenAt: new Date().toISOString(), seenVia: via || 'app' })
        .then(function () { return true; }, function () { return false; }); // already seen: rules refuse a 2nd update
    });
  }
  window.__gcLinks = {
    key: linkKey, linkFor: linkFor, status: linkStatus, markSeen: markSeen,
    base: window.GC_SEEN_BASE || '',
    firestore: { projectId: cfg.projectId || '', apiKey: cfg.apiKey || '', host: window.GC_FIREBASE_EMULATOR ? '127.0.0.1:8080' : '' }
  };

  // ---------- account card on Profile ----------
  function renderAccount() {
    var card = document.getElementById('pf-account'); if (!card) return;
    card.style.display = account ? '' : 'none';
    if (!account) return;
    var roleName = { patient: 'Patient', child: account.relation === 'daughter' ? 'Daughter' : 'Son', guardian: 'Local Guardian' }[account.role] || account.role;
    setT('pf-acct-email', tr('Signed in as {email} ({role})', { email: account.email, role: tr(roleName) }));
    setT('pf-invite', account.inviteCode || '—');
  }
  function share() {
    if (!account || !account.inviteCode) return;
    var text = tr('Join me on Gran Care. Create an account and enter the family invite code: {code}', { code: account.inviteCode });
    if (navigator.share) navigator.share({ title: 'Gran Care', text: text }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(account.inviteCode).then(function () { G().toast(tr('Invite code copied.')); });
  }
  function logOut() {
    auth.signOut().then(function () {
      try { localStorage.removeItem('gc.home'); } catch (e) {}
      location.hash = ''; location.reload();
    });
  }

  function init() {
    installGate();
    var lf = $('#au-login-form'), sf = $('#au-signup-form');
    if (lf) lf.addEventListener('submit', logIn);
    if (sf) sf.addEventListener('submit', signUp);
    var fg = $('#au-forgot'); if (fg) fg.addEventListener('click', forgot);
    var sh = $('#au-show'); if (sh) sh.addEventListener('change', function () { $('#au-pass').type = sh.checked ? 'text' : 'password'; });
    [].slice.call(document.querySelectorAll('input[name=au-role]')).forEach(function (el) { el.addEventListener('change', onRoleChange); });
    onRoleChange();
    var lo = $('#pf-logout'); if (lo) lo.addEventListener('click', logOut);
    var sb = $('#pf-share'); if (sb) sb.addEventListener('click', share);
    if (!authKnown) go('login');
    // Never leave a blank screen if Firebase cannot be reached at start.
    setTimeout(function () { document.documentElement.classList.remove('gc-auth-pending'); }, 6000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
