/* Gran Care smartwatch link (Web Bluetooth).
   Uses standard Bluetooth GATT services that bands and watches commonly expose:
   - Immediate Alert (0x1802 / Alert Level 0x2A06): buzz at dose time, stop when taken
   - Battery Service (0x180F / Battery Level 0x2A19): live battery on the watch screens
   The link state is shared through the db (signals/watch) so the caretaker sees it. */
(function () {
  'use strict';
  var G = function () { return window.__gc; };
  var $ = function (s) { return document.querySelector(s); };
  var W = { status: 'idle', name: '', battery: null, device: null, alertChar: null, buzzing: false, retries: 0, shared: null, buzzed: {} };
  var LS = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  function supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
  function tr(t, v) { var g = G(); return g ? g.tr(t, v) : t; }
  function changed() { var g = G(); if (g) g.render(); share(); }

  // ---------- connection ----------
  function pair() {
    if (!supported()) { W.status = 'unsupported'; changed(); G().toast('Bluetooth is not available in this browser. Use Chrome on Android or a computer, or the Wear OS app.', 'warn'); return; }
    W.status = 'connecting'; changed();
    navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['immediate_alert', 'battery_service', 'device_information'] })
      .then(connect)
      .catch(function (e) {
        var name = e && e.name;
        W.status = name === 'SecurityError' ? 'blocked' : 'idle'; changed();
        if (name === 'SecurityError') G().toast('This page is not allowed to use Bluetooth here. Open the app in Chrome, or use the Wear OS app.', 'warn');
        else if (name !== 'NotFoundError') G().toast('Could not pair the watch. Make sure it is nearby and discoverable.', 'warn');
      });
  }
  function connect(device) {
    W.device = device; W.name = device.name || tr('Bluetooth Watch'); W.status = 'connecting'; changed();
    LS.set('gc.watch.id', device.id || ''); LS.set('gc.watch.name', W.name);
    if (!device.__gcBound) { device.__gcBound = true; device.addEventListener('gattserverdisconnected', onDrop); }
    return device.gatt.connect().then(function (server) {
      var jobs = [];
      jobs.push(server.getPrimaryService('immediate_alert').then(function (s) { return s.getCharacteristic('alert_level'); })
        .then(function (c) { W.alertChar = c; }).catch(function () { W.alertChar = null; }));
      jobs.push(server.getPrimaryService('battery_service').then(function (s) { return s.getCharacteristic('battery_level'); })
        .then(function (c) {
          c.addEventListener('characteristicvaluechanged', function (ev) { W.battery = ev.target.value.getUint8(0); changed(); });
          return c.readValue().then(function (v) { W.battery = v.getUint8(0); }).then(function () { return c.startNotifications().catch(function () {}); });
        }).catch(function () { W.battery = null; }));
      return Promise.all(jobs);
    }).then(function () {
      W.status = 'connected'; W.retries = 0; changed();
      G().toast(W.alertChar ? tr('{name} connected. It will buzz at dose time.', { name: W.name }) : tr('{name} connected, but it does not support vibration alerts.', { name: W.name }), W.alertChar ? 'ok' : 'warn');
    }).catch(function () { W.status = 'idle'; changed(); G().toast('Could not pair the watch. Make sure it is nearby and discoverable.', 'warn'); });
  }
  function onDrop() {
    W.alertChar = null; W.status = 'connecting'; changed();
    if (W.retries++ < 3) setTimeout(function () { if (W.device) connect(W.device); }, 2000 * W.retries);
    else { W.status = 'idle'; changed(); }
  }
  // Reconnect a watch this browser already has permission for (Chrome getDevices).
  function autoReconnect() {
    var id = LS.get('gc.watch.id');
    if (!id || !supported() || !navigator.bluetooth.getDevices) return;
    navigator.bluetooth.getDevices().then(function (ds) {
      var d = ds.filter(function (x) { return x.id === id; })[0];
      if (d) connect(d);
    }).catch(function () {});
  }

  // ---------- alerts ----------
  function buzz(level) {
    if (!W.alertChar) return Promise.resolve(false);
    var v = new Uint8Array([level]); W.buzzing = level > 0;
    var w = W.alertChar.writeValueWithoutResponse ? W.alertChar.writeValueWithoutResponse(v) : W.alertChar.writeValue(v);
    return w.then(function () { return true; }).catch(function () { return false; });
  }
  function alertedKey(d) { return 'gc.alerted.' + d.med.id + '.' + d.slot.key + '.' + new Date(d.time).toDateString() + '.' + d.snoozes; }
  // Called from render(): buzz once when a dose becomes due, stop once it is handled.
  function onRender(list) {
    var due = list.filter(function (d) { return d.status === 'due'; });
    due.forEach(function (d) {
      var k = alertedKey(d);
      if (W.alertChar && !W.buzzed[k]) { W.buzzed[k] = 1; buzz(2); }
      if (LS.get(k)) return; LS.set(k, '1');
      var g = G(), msg = tr('Time to take {med}.', { med: d.med.name + (d.med.dosage ? ' ' + d.med.dosage : '') });
      var vis = $('.screen:not([hidden])'), patientView = vis && /patient|medication|smartwatch/.test(vis.id);
      if (patientView) {
        try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) {}
        if (g.S.settings.audioGuidance !== false) g.speak(msg);
      }
      g.toast(msg);
    });
    if (W.buzzing && !due.length) buzz(0);
    renderUi();
  }

  // ---------- shared state (caretaker view) ----------
  var lastShared = '';
  function share() {
    var g = G(); if (!g || !g.S.db || !W.device) return;
    var data = { connected: W.status === 'connected', name: W.name, battery: W.battery, vibration: !!W.alertChar };
    var key = JSON.stringify(data); if (key === lastShared) return; lastShared = key;
    data.at = new Date().toISOString(); data.by = g.S.uid || '';
    g.S.db.doc('signals/watch').set(data).catch(function () {});
  }
  function heartbeat() { lastShared = ''; share(); }
  function subscribe(db) {
    db.doc('signals/watch').onSnapshot(function (d) { W.shared = d.exists ? Object.assign({}, d.data()) : null; renderUi(); }, function () {});
  }

  // ---------- UI ----------
  function setT(id, t) { var g = G(); if (g && document.getElementById(id)) g.setT(id, t); }
  function renderUi() {
    var g = G(); if (!g) return;
    var local = W.device ? W : null, sh = W.shared, fresh = sh && sh.at && Date.now() - new Date(sh.at).getTime() < 15 * 60000;
    var lbl = { connected: 'Connected (BLE)', connecting: 'Connecting…', unsupported: 'No Bluetooth', blocked: 'BLE Blocked', idle: 'Pair Watch' }[W.status];
    setT('da-link-label', lbl);
    var dot = $('#da-link [data-dot]'); if (dot) dot.style.background = W.status === 'connected' ? '#006a62' : W.status === 'connecting' ? '#ac6200' : '#7a8691';
    var name = local ? W.name : sh && sh.name ? sh.name : null;
    setT('da-device', name || 'No Watch Paired');
    var batt = local ? W.battery : sh ? sh.battery : null;
    setT('da-batt', batt == null ? '--%' : batt + '%'); setT('sa-batt', batt == null ? '--%' : batt + '%');
    setT('pd-watch', W.status === 'connected' ? 'Status: Connected' : W.status === 'connecting' ? 'Status: Connecting…' : 'Status: Not Paired');
    var shOn = sh && sh.connected && fresh;
    setT('ct-watch', shOn ? 'Smartwatch Paired' : sh ? 'Smartwatch Not Connected' : 'No Smartwatch Paired');
    setT('ct-device', fresh ? 'Patient Device Online' : sh && sh.at ? tr('Patient Device Last Seen {ago}', { ago: g.ago(sh.at) }) : 'Patient Device Not Linked');
  }

  window.__gcWatch = {
    onRender: onRender, buzz: buzz, pair: pair, subscribe: subscribe, state: W,
    init: function () {
      document.addEventListener('click', function (ev) { if (ev.target.closest('#da-link')) { ev.preventDefault(); if (W.status !== 'connected') pair(); else buzz(1).then(function (ok) { G().toast(ok ? tr('Test alert sent to {name}.', { name: W.name }) : 'This watch does not support vibration alerts.', ok ? 'ok' : 'warn'); }); } });
      if (!supported()) W.status = 'unsupported';
      autoReconnect();
      setInterval(heartbeat, 5 * 60000);
    }
  };
})();
