/* Gran Care standalone runtime (Android app build).
   Provides the same `claude.use(name)` surface the app uses on claude.ai, backed by
   the phone itself, so app.js runs unchanged:
   - db:     Firestore-style documents in localStorage, with live onSnapshot listeners
   - user:   a stable per-install id
   - sample: prescription reading via the Anthropic Messages API, using the API key the
             user enters on the Profile screen (null when no key is set). */
(function () {
  'use strict';
  var KEY = 'gc.db.v1';
  var store = {};
  try { store = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { store = {}; }
  var listeners = [];
  var pending = false;

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }
  function notify() {
    if (pending) return; pending = true;
    setTimeout(function () { pending = false; listeners.slice().forEach(function (l) { try { l(); } catch (e) { console.error(e); } }); }, 0);
  }
  function write(path, data) { if (data === undefined) delete store[path]; else store[path] = JSON.parse(JSON.stringify(data)); persist(); notify(); }
  function deepFreeze(o) { if (o && typeof o === 'object') { Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); Object.freeze(o); } return o; }
  function snap(path) {
    var v = store[path];
    return { id: path.split('/').pop(), exists: v !== undefined, metadata: { fromCache: false, hasPendingWrites: false },
      data: function () { return v === undefined ? undefined : deepFreeze(JSON.parse(JSON.stringify(v))); } };
  }
  var uid = (function () {
    try { var id = localStorage.getItem('gc.uid'); if (!id) { id = 'u_' + Math.random().toString(36).slice(2, 12); localStorage.setItem('gc.uid', id); } return id; }
    catch (e) { return 'u_local'; }
  })();
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function cmp(a, op, b) {
    switch (op) {
      case '==': return a === b; case '!=': return a !== b;
      case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
      case 'in': return Array.isArray(b) && b.indexOf(a) >= 0;
      case 'not-in': return Array.isArray(b) && b.indexOf(a) < 0;
      case 'array-contains': return Array.isArray(a) && a.indexOf(b) >= 0;
    }
    return false;
  }
  function query(col, filters, order, lim) {
    var depth = col.split('/').length + 1;
    function run() {
      var docs = Object.keys(store).filter(function (k) { return k.indexOf(col + '/') === 0 && k.split('/').length === depth; })
        .sort().map(snap)
        .filter(function (d) { var x = d.data(); return filters.every(function (f) { return cmp(x[f[0]], f[1], f[2]); }); });
      if (order) docs.sort(function (a, b) { var x = a.data()[order[0]], y = b.data()[order[0]]; var r = x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : x < y ? -1 : 1; return order[1] === 'desc' ? -r : r; });
      if (lim) docs = docs.slice(0, lim);
      return { docs: docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: function () { return []; } };
    }
    return {
      where: function (f, op, v) { return query(col, filters.concat([[f, op, v]]), order, lim); },
      orderBy: function (f, dir) { return query(col, filters, [f, dir || 'asc'], lim); },
      limit: function (n) { return query(col, filters, order, n); },
      get: function () { return Promise.resolve(run()); },
      onSnapshot: function (next) {
        var last = null;
        var l = function () { var r = run(); var sig = JSON.stringify(r.docs.map(function (d) { return [d.id, store[col + '/' + d.id]]; })); if (sig !== last) { last = sig; next(r); } };
        listeners.push(l); setTimeout(l, 0);
        return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
      }
    };
  }
  var db = {
    collection: function (col) {
      var q = query(col, [], null, 0);
      q.path = col;
      q.doc = function (id) { return db.doc(col + '/' + (id || newId())); };
      q.add = function (data) { var ref = q.doc(); return ref.set(data).then(function () { return ref; }); };
      return q;
    },
    doc: function (path) {
      return {
        id: path.split('/').pop(), path: path,
        get: function () { return Promise.resolve(snap(path)); },
        set: function (d) { write(path, d); return Promise.resolve(); },
        update: function (d) {
          if (store[path] === undefined) return Promise.reject({ code: 'invalid_argument', message: 'Document does not exist' });
          write(path, Object.assign({}, store[path], d)); return Promise.resolve();
        },
        delete: function () { write(path, undefined); return Promise.resolve(); },
        acquire: function () { return Promise.resolve({ acquired: true }); },
        collection: function (sub) { return db.collection(path + '/' + sub); },
        onSnapshot: function (next) {
          var last;
          var l = function () { var sig = JSON.stringify(store[path]); if (sig !== last) { last = sig; next(snap(path)); } };
          listeners.push(l); setTimeout(l, 0);
          return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
        }
      };
    }
  };

  // ---------- Claude (prescription reading) ----------
  var MODEL = 'claude-sonnet-5-5';
  function apiKey() { try { return (localStorage.getItem('gc.apiKey') || '').trim(); } catch (e) { return ''; } }
  function toB64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function callClaude(text, images) {
    var key = apiKey();
    if (!key) return Promise.reject({ code: 'not_granted', message: 'No API key' });
    return Promise.all((images || []).map(function (b) {
      return toB64(b).then(function (data) {
        var type = b.type || 'image/jpeg';
        return type === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: type, data: data } }
          : { type: 'image', source: { type: 'base64', media_type: type, data: data } };
      });
    })).then(function (parts) {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: parts.concat([{ type: 'text', text: text }]) }] })
      });
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw { code: r.status === 429 ? 'rate_limited' : r.status === 401 ? 'not_granted' : 'error', message: (j.error && j.error.message) || ('HTTP ' + r.status) };
        return (j.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('');
      });
    });
  }
  function textOf(input) { return typeof input === 'string' ? input : (input || []).map(function (t) { return t.content; }).join('\n\n'); }
  var sample = function (input, opts) { return callClaude(textOf(input), opts && opts.images).then(function (t) { return { text: t, truncated: false }; }); };
  sample.json = function (input, opts) {
    return callClaude(textOf(input) + '\n\nRespond with JSON only.', opts && opts.images).then(function (t) {
      var m = t.match(/\{[\s\S]*\}/); if (!m) throw { code: 'error', message: 'No JSON in reply' };
      return JSON.parse(m[0]);
    });
  };
  sample.limits = function () { return Promise.resolve({ images: { maxCount: 4, maxInputBytes: 5e6, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] } }); };

  var user = {
    id: function () { return Promise.resolve(uid); },
    me: function () { return Promise.resolve({ id: uid, name: '' }); },
    isOwner: function () { return true; }, canEdit: function () { return true; }, can: function () { return true; },
    profiles: function () { return Promise.resolve({}); }
  };

  window.__gcStandalone = { store: store, setApiKey: function (k) { try { localStorage.setItem('gc.apiKey', k || ''); } catch (e) {} }, hasApiKey: function () { return !!apiKey(); } };
  window.claude = {
    use: function (name) {
      if (name === 'db') return Promise.resolve(db);
      if (name === 'user') return Promise.resolve(user);
      if (name === 'sample') return Promise.resolve(apiKey() ? sample : null);
      return Promise.resolve(null);
    }
  };
})();
