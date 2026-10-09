/* Gran Care Android bridge (Capacitor). Loaded only in the app build.
   - Hands the medication schedule and family contacts to the native GranCareNative plugin,
     which owns the alarms, snoozes and escalation (SMS / alert calls) even when the app is closed.
   - Imports what happened natively (taken from the notification, snoozes, alerts, family replies)
   into the app's records.
   - Native text-to-speech, Android back button, phone-width scaling, remembered home screen. */
(function () {
  'use strict';
  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  var reg = Cap.registerPlugin || (window.capacitorExports && window.capacitorExports.registerPlugin);
  function plugin(name) { return reg ? reg(name) : (Cap.Plugins && Cap.Plugins[name]); }
  var P = plugin('GranCareNative'), App = plugin('App'), TTS = plugin('TextToSpeech');
  var G = function () { return window.__gc; };
  var lastSchedule = '', lastContacts = '', relayed = {};

  // ---------- layout: scale the 390px design to the phone width ----------
  function scale() { document.documentElement.style.setProperty('--gc-scale', String(Math.min(window.innerWidth / 390, 1.25))); }
  scale(); window.addEventListener('resize', scale);

  // ---------- speech ----------
  window.__gcSpeak = function (text, lang) {
    if (!TTS) return;
    TTS.stop().catch(function () {}).then(function () { return TTS.speak({ text: text, lang: lang || 'en-US', rate: 0.9, pitch: 1.0, volume: 1.0, category: 'playback' }); }).catch(function () {});
  };

  // ---------- remember which side (patient / caretaker) this phone uses ----------
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-go]'); if (!t) return;
    var cur = document.querySelector('.screen:not([hidden])');
    if (cur && cur.id === 'role-selection' && /dashboard/.test(t.getAttribute('data-go'))) {
      try { localStorage.setItem('gc.home', t.getAttribute('data-go')); } catch (e) {}
    }
  }, true);

  // ---------- back button ----------
  var history = [];
  var origShow = window.__showScreen;
  window.__showScreen = function (slug) {
    var cur = document.querySelector('.screen:not([hidden])');
    if (cur && cur.id !== slug) history.push(cur.id);
    if (history.length > 20) history.shift();
    origShow(slug);
  };
  if (App) App.addListener('backButton', function () {
    var prev = history.pop();
    if (prev) origShow(prev); else App.exitApp();
  });

  // ---------- schedule + contacts -> native ----------
  function scheduleFromMeds(S) {
    var g = G();
    return S.meds.map(function (m) {
      return {
        id: m.id, name: m.name, dosage: m.dosage || '', instructions: m.instructions || '',
        slots: (m.slots || []).filter(function (k) { return g.SLOT[k]; }).map(function (k) { var s = g.SLOT[k]; return { key: k, hour: s.h, minute: s.m, label: s.label }; }),
        createdAt: m.createdAt || '', durationDays: m.durationDays || 0
      };
    });
  }
  function contactsFromProfile(p) {
    return {
      patientName: p.name || '', patientPhone: p.phone || '',
      children: (p.children || []).filter(function (c) { return c.phone; }),
      guardian: p.guardian && p.guardian.phone ? p.guardian : null,
      autoAlerts: p.autoAlerts !== false
    };
  }
  var api = {
    permissionsOk: false,
    onRender: function () {
      var g = G(); if (!g) return;
      var acct = window.__gcAccount;
      var isPatient = !acct || acct.role === 'patient';
      // Family members' phones show the caretaker view but never ring for the patient's doses.
      var sched = JSON.stringify(isPatient ? scheduleFromMeds(g.S) : []);
      if (isPatient && window.__gcEsc) {
        window.__gcEsc.all().forEach(function (a) {
          if (a.resolved === 'ack' && !relayed[a.id] && a.ackBy !== 'device') {
            relayed[a.id] = 1;
            P.acknowledge({ medId: a.medId, slot: a.slot, day: a.day, ackType: a.ackType || 'yes' }).catch(function () {});
          }
        });
      }
      if (sched !== lastSchedule) { lastSchedule = sched; P.setSchedule({ meds: JSON.parse(sched) }).catch(function (e) { console.warn('setSchedule', e); }); }
      var c = JSON.stringify(contactsFromProfile(isPatient ? (g.S.profile || {}) : {}));
      if (c !== lastContacts) { lastContacts = c; P.setContacts(JSON.parse(c)).catch(function () {}); }
    },
    setContacts: function (p) { lastContacts = JSON.stringify(contactsFromProfile(p)); return P.setContacts(JSON.parse(lastContacts)).catch(function () {}); },
    markTaken: function (d) { P.markTaken({ medId: d.med.id, slot: d.slot.key, day: d.day }).catch(function () {}); },
    snooze: function (d) { P.snooze({ medId: d.med.id, slot: d.slot.key, day: d.day }).catch(function () {}); },
    acknowledge: function (a) { P.acknowledge(a).catch(function () {}); },
    testAlert: function () {
      ensurePermissions(true).then(function () { return P.testAlert(); })
        .then(function (r) { G().toast(G().tr('Test alert sent to {n} contact(s).', { n: (r && r.sent) || 0 })); })
        .catch(function (e) { G().toast((e && e.message) || 'Could not send the test alert.', 'warn'); });
    }
  };
  window.__gcNative = api;

  // ---------- permissions ----------
  function ensurePermissions(ask) {
    return P.checkPermissions().then(function (s) {
      var ok = s.sms === 'granted' && s.phone === 'granted';
      if (ok || !ask) return s;
      return P.requestPermissions({ permissions: ['sms', 'phone', 'notifications'] });
    }).then(function (s) {
      api.permissionsOk = s.sms === 'granted' && s.phone === 'granted';
      if (G()) G().render();
      return s;
    });
  }

  // ---------- native -> app records ----------
  function importEvents() {
    var g = G(); if (!g || !g.S.db) return Promise.resolve();
    return P.drainEvents().then(function (r) {
      (r.events || []).forEach(function (e) {
        var day = e.day, base = { medId: e.medId || '', medName: e.medName || '', slot: e.slot || '', at: e.at, day: day, by: 'device' };
        if (e.type === 'taken' || e.type === 'snoozed' || e.type === 'call' || e.type === 'sms_failed') {
          var ev = Object.assign({ type: e.type }, base);
          if (e.type === 'snoozed') { ev.minutes = e.minutes || 10; ev.until = e.until; }
          g.S.db.collection('events').add(ev).catch(function () {});
        }
        if (e.type === 'alert' || e.type === 'ack' || e.type === 'resolved') {
          var k = day + '_' + e.medId + '_' + e.slot, data = { day: day, medId: e.medId, medName: e.medName, slot: e.slot };
          if (e.type === 'alert') { data.level = e.level; data['level' + e.level + 'At'] = e.at; g.S.db.collection('events').add(Object.assign({ type: 'alert', level: e.level }, base)).catch(function () {}); }
          if (e.type === 'ack') { data.resolved = 'ack'; data.ackType = e.ackType; data.ackBy = e.by || ''; data.ackAt = e.at; g.S.db.collection('events').add(Object.assign({ type: 'ack', ackType: e.ackType, ackName: e.by || '' }, base)).catch(function () {}); }
          if (e.type === 'resolved') { data.resolved = e.reason || 'taken'; data.resolvedAt = e.at; }
          var ref = g.S.db.doc('alerts/' + k);
          ref.get().then(function (s) { return ref.set(Object.assign({}, s.exists ? s.data() : {}, data)); }).catch(function () {});
        }
      });
    }).catch(function () {});
  }

  P.addListener('nativeEvent', function () { importEvents(); });
  P.addListener('doseOpened', function () { var g = G(); if (g) g.go('medication-reminder'); });
  if (App) App.addListener('resume', function () { importEvents(); ensurePermissions(false); if (G()) G().render(); });

  function start() {
    importEvents();
    ensurePermissions(true).catch(function () {});
    P.consumeLaunchDose().then(function (r) { if (r && r.opened && G()) G().go('medication-reminder'); }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 300); });
  else setTimeout(start, 300);
})();
