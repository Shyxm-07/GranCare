/* Gran Care missed-dose escalation.
   Rules (same on phone, web and watch):
     1. A dose alarm can be snoozed at most twice, 10 minutes each (an unanswered alarm
        re-rings every 10 minutes the same way).
     2. On the 3rd alarm the son/daughter is alerted (level 1).
     3. If nobody answers YES or LATER within 20 minutes it becomes an emergency (level 2):
        alert call to the son/daughter, messages to them and to the local guardian.
     4. Still no answer 10 minutes later (level 3): alert call to the local guardian and
        messages to everyone.
     Taking the dose, or a family YES/LATER, stops the escalation.
   In the Android app the native layer runs these timers (and sends the SMS / calls) even
   when the app is closed; this module then only mirrors its state. Elsewhere (claude.ai)
   it runs the timers while a patient or family screen is open and shows the alerts in-app. */
(function () {
  'use strict';
  var MIN = 60000;
  var RULES = { snoozeMinutes: 10, maxSnoozes: 2, toEmergencyMin: 20, toGuardianMin: 10 };
  var G = function () { return window.__gc; };
  var A = { alerts: {}, sub: null };
  function key(d) { return d.day + '_' + d.med.id + '_' + d.slot.key; }
  function native() { return window.__gcNative; }

  function subscribe(db, day) {
    if (A.sub) { try { A.sub(); } catch (e) {} }
    A.alerts = {};
    A.sub = db.collection('alerts').where('day', '==', day).onSnapshot(function (q) {
      var m = {}; q.docs.forEach(function (d) { m[d.id] = Object.assign({}, d.data(), { id: d.id }); });
      A.alerts = m; G().render();
    }, function () {});
  }

  function save(k, data) {
    var g = G(); if (!g.S.db) return Promise.resolve();
    A.alerts[k] = Object.assign({}, A.alerts[k] || {}, data, { id: k });
    var body = Object.assign({}, A.alerts[k]); delete body.id;
    return g.S.db.doc('alerts/' + k).set(body).catch(function () {});
  }

  /** When the 3rd alarm for this dose rings (or rang). */
  function thirdRingAt(d) {
    if (d.snoozes >= RULES.maxSnoozes && d.lastSnoozeUntil) return new Date(d.lastSnoozeUntil).getTime();
    return d.time + RULES.maxSnoozes * RULES.snoozeMinutes * MIN;
  }

  function raise(d, level, now) {
    var g = G(), k = key(d), cur = A.alerts[k] || {};
    if ((cur.level || 0) >= level || cur.resolved) return;
    var data = { day: d.day, medId: d.med.id, medName: d.med.name, slot: d.slot.key, level: level };
    data['level' + level + 'At'] = new Date(now).toISOString();
    save(k, data);
    g.logEvent({ type: 'alert', level: level, medId: d.med.id, medName: d.med.name, slot: d.slot.key }).catch(function () {});
    var who = level === 1 ? 'Your son / daughter has been alerted.' : level === 2 ? 'Emergency: your family is being called.' : 'Emergency: your local guardian is being called.';
    g.toast(who, 'alert');
  }

  /** Called on every render with today's dose list. */
  function onRender(list) {
    var g = G(); if (!g || !g.S.db) return;
    var now = Date.now(), n = native();
    list.forEach(function (d) {
      var k = key(d), a = A.alerts[k];
      if (d.status === 'taken') {
        if (a && a.level && !a.resolved) save(k, { resolved: 'taken', resolvedAt: new Date(now).toISOString() });
        return;
      }
      if (n) return; // the Android native layer owns the timers and mirrors its state into alerts/
      if (a && a.resolved) return;
      var lvl = (a && a.level) || 0;
      if (lvl === 0 && now >= thirdRingAt(d)) raise(d, 1, now);
      else if (lvl === 1 && now >= new Date(a.level1At).getTime() + RULES.toEmergencyMin * MIN) raise(d, 2, now);
      else if (lvl === 2 && now >= new Date(a.level2At).getTime() + RULES.toGuardianMin * MIN) raise(d, 3, now);
    });
    renderCaretaker();
  }

  /** The patient tried to snooze beyond the limit: start the family alert now. */
  function snoozeLimitReached(d) { if (!native()) raise(d, 1, Date.now()); }

  function active() {
    return Object.keys(A.alerts).map(function (k) { return A.alerts[k]; })
      .filter(function (a) { return a.level && !a.resolved; })
      .sort(function (x, y) { return (y.level || 0) - (x.level || 0); });
  }

  function ack(type) {
    var g = G(), a = active()[0]; if (!a) return;
    var who = window.__gcAccount ? window.__gcAccount.name : (g.S.uid || '');
    save(a.id, { resolved: 'ack', ackType: type, ackBy: who, ackAt: new Date().toISOString() });
    g.logEvent({ type: 'ack', ackType: type, medId: a.medId, medName: a.medName, slot: a.slot }).catch(function () {});
    if (native()) native().acknowledge({ medId: a.medId, slot: a.slot, day: a.day, ackType: type });
    g.toast(type === 'yes' ? 'Thank you. The alert is closed.' : 'Noted. The patient will be reminded again.');
  }

  function renderCaretaker() {
    var g = G(), box = document.getElementById('ct-ack'); if (!box) return;
    var a = active()[0];
    box.style.display = a ? '' : 'none';
    if (!a) return;
    var slot = g.tr({ morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', bedtime: 'Bedtime' }[a.slot] || a.slot);
    var title = a.level >= 2 ? 'EMERGENCY: {med} not taken' : 'Family Alert: {med} not taken';
    g.setT('ct-alert-title', g.tr(title, { med: a.medName }));
    var lines = { 1: 'The {slot} dose was snoozed twice and is still not taken. Please check on the patient.',
                  2: 'No reply for 20 minutes. Alert calls are being made to the family.',
                  3: 'No reply for 30 minutes. The local guardian is being called.' };
    g.setT('ct-alert-text', g.tr(lines[a.level] || lines[1], { slot: slot }));
  }

  function all() { return Object.keys(A.alerts).map(function (k) { return A.alerts[k]; }); }
  window.__gcEsc = { RULES: RULES, all: all, subscribe: subscribe, onRender: onRender, snoozeLimitReached: snoozeLimitReached, active: active, key: key,
    init: function () {
      document.addEventListener('click', function (ev) {
        if (ev.target.closest('#ct-ack-yes')) ack('yes');
        else if (ev.target.closest('#ct-ack-later')) ack('later');
      });
    } };
})();
