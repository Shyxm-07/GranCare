/* Gran Care missed-dose escalation.
   Rules (same on phone, web and watch):
     1. A dose alarm can be snoozed at most twice, 10 minutes each (an unanswered alarm
        re-rings every 10 minutes the same way). After that the medication time window is
        exhausted.
     2. Then the son/daughter is alerted (level 1). Their message carries a "seen" link.
     3. The son/daughter does not reply; they only need to SEE it: opening the link, or the
        alert in Gran Care, marks it seen. If it stays unseen for 20 minutes it is treated as a
        medical emergency (level 2): the local guardian / nearby relative and the nearby
        clinic are alerted (they live close by; the children may not), and the children are told.
     Taking the dose ends the alert at any point.
   In the Android app the native layer runs these timers (and sends the SMS / calls) even
   when the app is closed; this module then only mirrors its state. Elsewhere (claude.ai)
   it runs the timers while the patient's screens are open and shows the alerts in-app. */
(function () {
  'use strict';
  var MIN = 60000;
  var RULES = { snoozeMinutes: 10, maxSnoozes: 2, unseenToEmergencyMin: 20 };
  var G = function () { return window.__gc; };
  var A = { alerts: {}, sub: null, checking: {}, lastCheck: {}, autoSeen: {} };
  function key(d) { return d.day + '_' + d.med.id + '_' + d.slot.key; }
  function linkKey(a) { return a.medId + '|' + a.slot + '|' + a.day; }
  function native() { return window.__gcNative; }
  function links() { return window.__gcLinks; }
  function acct() { return window.__gcAccount; }
  /** Family members' phones (son, daughter, guardian) never run the patient's timers. */
  function runsTimers() { var a = acct(); return !a || a.role === 'patient'; }

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
    g.toast(level === 1 ? 'Medication time window exhausted. Your son / daughter is being alerted.'
      : 'Medical emergency: your local guardian and the nearby clinic are being alerted.', 'alert');
  }

  function resolveSeen(k, via, by, at) {
    var a = A.alerts[k]; if (!a || a.resolved) return;
    save(k, { resolved: 'seen', ackType: 'seen', seenVia: via || 'app', ackBy: by || '', ackAt: at || new Date().toISOString() });
    G().logEvent({ type: 'ack', ackType: 'seen', medId: a.medId, medName: a.medName, slot: a.slot, ackName: by || '' }).catch(function () {});
  }

  /** Has the son/daughter opened the link? Resolves true/false; never throws. */
  function seenOnline(a) {
    var L = links(); if (!L) return Promise.resolve(false);
    return L.linkFor(linkKey(a)).then(function (t) { return L.status(t); })
      .then(function (s) { if (s.seenAt) { resolveSeen(a.id, s.seenVia || 'link', '', s.seenAt); return true; } return false; })
      .catch(function () { return false; });
  }

  /** Called on every render with today's dose list. */
  function onRender(list) {
    var g = G(); if (!g || !g.S.db) return;
    var now = Date.now(), n = native();
    list.forEach(function (d) {
      var k = key(d), a = A.alerts[k];
      if (d.status === 'taken') {
        if (a && a.level && (!a.resolved || a.resolved === 'seen')) save(k, { resolved: 'taken', resolvedAt: new Date(now).toISOString() });
        return;
      }
      if (n || !runsTimers()) return; // the Android native layer owns the timers and mirrors its state into alerts/
      if (a && a.resolved) return;
      var lvl = (a && a.level) || 0;
      if (lvl === 0 && now >= thirdRingAt(d)) { raise(d, 1, now); return; }
      if (lvl !== 1 || A.checking[k]) return;
      var due = now >= new Date(a.level1At).getTime() + RULES.unseenToEmergencyMin * MIN;
      // While waiting, look at the link every 30 s; at 20 minutes, check once more, then escalate.
      if (!due && now - (A.lastCheck[k] || 0) < 30000) return;
      A.lastCheck[k] = now; A.checking[k] = 1;
      seenOnline(a).then(function (seen) {
        delete A.checking[k];
        var cur = A.alerts[k] || {};
        if (!seen && due && !cur.resolved) raise(d, 2, Date.now());
      });
    });
    renderCaretaker();
  }

  /** The patient tried to snooze beyond the limit: start the family alert now. */
  function snoozeLimitReached(d) { if (!native() && runsTimers()) raise(d, 1, Date.now()); }

  function active() {
    return Object.keys(A.alerts).map(function (k) { return A.alerts[k]; })
      .filter(function (a) { return a.level && !a.resolved; })
      .sort(function (x, y) { return (y.level || 0) - (x.level || 0); });
  }
  /** Alerts already seen by the family whose dose is still not taken. */
  function seenOpen() {
    return Object.keys(A.alerts).map(function (k) { return A.alerts[k]; }).filter(function (a) { return a.resolved === 'seen'; });
  }

  /** The son / daughter has seen the alert (tapped "I've seen it", or opened it in the app). */
  function markSeen(a, via) {
    var g = G(); if (!a) return;
    var who = acct() ? acct().name : '';
    save(a.id, { resolved: 'seen', ackType: 'seen', seenVia: via || 'app', ackBy: who, ackAt: new Date().toISOString() });
    g.logEvent({ type: 'ack', ackType: 'seen', medId: a.medId, medName: a.medName, slot: a.slot, ackName: who }).catch(function () {});
    if (links()) links().markSeen(linkKey(a), 'app');
    if (native()) native().acknowledge({ medId: a.medId, slot: a.slot, day: a.day, ackType: 'seen' });
  }

  function renderCaretaker() {
    var g = G(), box = document.getElementById('ct-ack'); if (!box) return;
    var a = active()[0], s = !a && seenOpen()[0];
    box.style.display = a ? '' : 'none';
    var shown = a || s; if (!shown) return;
    var slot = g.tr({ morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', bedtime: 'Bedtime' }[shown.slot] || shown.slot);
    if (a) {
      g.setT('ct-alert-title', g.tr(a.level >= 2 ? 'MEDICAL EMERGENCY: {med} not taken' : 'Family Alert: {med} not taken', { med: a.medName }));
      g.setT('ct-alert-text', g.tr(a.level >= 2
        ? 'The alert was not seen for 20 minutes. The local guardian and the nearby clinic have been alerted.'
        : 'The {slot} dose was missed and its time window is over. Tap I’ve seen it, or the guardian and clinic are alerted after 20 minutes.', { slot: slot }));
      // Opening the alert in the app on a family member's own phone counts as seeing it.
      var me = acct(), screen = document.querySelector('.screen:not([hidden])');
      if (me && me.role !== 'patient' && screen && screen.id === 'caretaker-dashboard' && !document.hidden && !A.autoSeen[a.id]) {
        A.autoSeen[a.id] = 1; markSeen(a, 'app'); g.toast('Marked as seen. Please call the patient now.');
      }
    } else {
      g.setT('ct-alert-title', g.tr('Seen: {med} still not taken', { med: s.medName }));
      g.setT('ct-alert-text', g.tr('You have seen this alert, so no emergency was raised. Please call the patient to remind them.'));
    }
  }

  function all() { return Object.keys(A.alerts).map(function (k) { return A.alerts[k]; }); }
  window.__gcEsc = { RULES: RULES, all: all, subscribe: subscribe, onRender: onRender, snoozeLimitReached: snoozeLimitReached, active: active, key: key,
    init: function () {
      document.addEventListener('click', function (ev) {
        if (ev.target.closest('#ct-ack-seen')) { markSeen(active()[0], 'app'); G().toast('Thank you. The patient’s phone knows you have seen it.'); G().render(); }
      });
    } };
})();
