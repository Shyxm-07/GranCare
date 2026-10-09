/* In-memory stand-in for the Firebase compat SDK (auth + firestore subset Gran Care uses).
   Used only by local UI tests (GC_FIREBASE_MOCK=1); CI runs the same tests against the real
   Firebase emulators, which also enforce firestore.rules. Data lives in localStorage so two
   pages of one browser context behave like two phones on the same project; the signed-in
   user is per page (sessionStorage). */
(function () {
  var DB = 'mockfs.db', USERS = 'mockfs.users';
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  var listeners = [];
  function changed() { setTimeout(function () { listeners.slice().forEach(function (f) { f(); }); }, 0); }
  window.addEventListener('storage', function (e) { if (e.key === DB) changed(); });
  function err(code) { var e = new Error(code); e.code = code; return Promise.reject(e); }
  var n = 0; function newId() { return 'id' + Date.now().toString(36) + (++n) + Math.random().toString(36).slice(2, 6); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function snap(path) { var v = load(DB)[path]; return { id: path.split('/').pop(), exists: v !== undefined, data: function () { return clone(v); } }; }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path: path,
      get: function () { return Promise.resolve(snap(path)); },
      set: function (d) { var db = load(DB); db[path] = clone(d); save(DB, db); changed(); return Promise.resolve(); },
      update: function (d) {
        var db = load(DB); if (!db[path]) return err('not-found');
        Object.keys(d).forEach(function (k) {
          var parts = k.split('.'), o = db[path];
          for (var i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
          o[parts[parts.length - 1]] = clone(d[k]);
        });
        save(DB, db); changed(); return Promise.resolve();
      },
      delete: function () { var db = load(DB); delete db[path]; save(DB, db); changed(); return Promise.resolve(); },
      collection: function (p) { return colRef(path + '/' + p); },
      onSnapshot: function (next) {
        var last; var f = function () { var s = JSON.stringify(load(DB)[path]); if (s !== last) { last = s; next(snap(path)); } };
        listeners.push(f); setTimeout(f, 0); return function () { listeners = listeners.filter(function (x) { return x !== f; }); };
      }
    };
  }
  function query(col, filters) {
    var depth = col.split('/').length + 1;
    function run() {
      var db = load(DB);
      var docs = Object.keys(db).filter(function (k) { return k.indexOf(col + '/') === 0 && k.split('/').length === depth; }).sort().map(snap)
        .filter(function (d) { return filters.every(function (f) { return d.data()[f[0]] === f[2]; }); });
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; } };
    }
    return {
      where: function (f, op, v) { return query(col, filters.concat([[f, op, v]])); },
      orderBy: function () { return this; }, limit: function () { return this; },
      get: function () { return Promise.resolve(run()); },
      onSnapshot: function (next) {
        var last; var f = function () { var r = run(); var s = JSON.stringify(r.docs.map(function (d) { return [d.id, d.data()]; })); if (s !== last) { last = s; next(r); } };
        listeners.push(f); setTimeout(f, 0); return function () { listeners = listeners.filter(function (x) { return x !== f; }); };
      }
    };
  }
  function colRef(col) {
    var q = query(col, []); q.path = col;
    q.doc = function (id) { return docRef(col + '/' + (id || newId())); };
    q.add = function (d) { var r = q.doc(); return r.set(d).then(function () { return r; }); };
    return q;
  }
  var firestore = { settings: function () {}, useEmulator: function () {}, enablePersistence: function () { return Promise.resolve(); },
    collection: colRef, doc: docRef };

  var authCbs = [], current = null;
  function mkUser(u) {
    return { uid: u.uid, email: u.email, displayName: u.name || null,
      updateProfile: function (p) { var us = load(USERS); us[u.email].name = p.displayName; save(USERS, us); return Promise.resolve(); },
      delete: function () { var us = load(USERS); delete us[u.email]; save(USERS, us); setUser(null); return Promise.resolve(); } };
  }
  function setUser(u) {
    current = u ? mkUser(u) : null;
    if (u) sessionStorage.setItem('mockfs.me', u.email); else sessionStorage.removeItem('mockfs.me');
    setTimeout(function () { authCbs.forEach(function (cb) { cb(current); }); }, 0);
  }
  var auth = {
    useEmulator: function () {},
    get currentUser() { return current; },
    onAuthStateChanged: function (cb) { authCbs.push(cb); setTimeout(function () { cb(current); }, 0); return function () {}; },
    createUserWithEmailAndPassword: function (email, pass) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('auth/invalid-email');
      if (pass.length < 6) return err('auth/weak-password');
      var us = load(USERS); if (us[email]) return err('auth/email-already-in-use');
      var u = { uid: 'u' + newId(), email: email, pass: pass }; us[email] = u; save(USERS, us);
      setUser(u); return Promise.resolve({ user: current });
    },
    signInWithEmailAndPassword: function (email, pass) {
      var u = load(USERS)[email]; if (!u || u.pass !== pass) return err('auth/invalid-credential');
      setUser(u); return Promise.resolve({ user: current });
    },
    signOut: function () { setUser(null); return Promise.resolve(); },
    sendPasswordResetEmail: function (email) { return load(USERS)[email] ? Promise.resolve() : err('auth/user-not-found'); }
  };
  var me = sessionStorage.getItem('mockfs.me'); if (me && load(USERS)[me]) current = mkUser(load(USERS)[me]);
  window.firebase = { initializeApp: function () {}, auth: function () { return auth; }, firestore: function () { return firestore; } };
})();
