/* Gran Care Profile screen: patient details, sons/daughters, local guardian, alert settings.
   Stored in profile/patient (same doc the caretaker dashboard uses). In the Android app the
   contacts are also handed to the native layer, which sends the alert messages and calls. */
(function () {
  'use strict';
  var G = function () { return window.__gc; };
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var dirty = false, loadedFrom = null;
  var PHONE = /^[+\d][\d\s()-]{5,}$/;
  function tr(t, v) { return G() ? G().tr(t, v) : t; }

  function childRow(c) {
    var row = document.createElement('div');
    row.className = 'bg-[#f0f4fa] flex flex-col gap-[8px] p-[12px] rounded-[12px] w-full';
    row.setAttribute('data-child', '');
    var input = 'fi font-normal text-[16px] leading-[normal] w-full min-w-0 h-[44px] px-[12px] rounded-[8px] border-0 bg-white outline-none text-[#181c21] placeholder:text-[#707881]';
    row.innerHTML =
      '<div class="flex gap-[8px] items-center w-full">' +
        '<input data-f="name" type="text" autocomplete="off" class="' + input + '">' +
        '<select data-f="relation" class="fi text-[16px] h-[44px] px-[8px] rounded-[8px] border-0 bg-white text-[#181c21] shrink-0"></select>' +
      '</div>' +
      '<div class="flex gap-[8px] items-center w-full">' +
        '<input data-f="phone" type="tel" autocomplete="off" class="' + input + '">' +
        '<button type="button" data-remove class="fi font-semibold text-[#ba1a1a] text-[14px] h-[44px] px-[12px] rounded-[8px] bg-white shrink-0"></button>' +
      '</div>';
    var sel = $('select', row);
    ['Son', 'Daughter', 'Other'].forEach(function (r) { var o = document.createElement('option'); o.value = r; o.textContent = tr(r); sel.appendChild(o); });
    $('[data-f=name]', row).value = c.name || ''; $('[data-f=name]', row).placeholder = tr('Name');
    $('[data-f=phone]', row).value = c.phone || ''; $('[data-f=phone]', row).placeholder = tr('Phone number');
    sel.value = c.relation || 'Son';
    $('[data-remove]', row).textContent = tr('Remove');
    $('[data-remove]', row).addEventListener('click', function () { row.remove(); dirty = true; });
    row.addEventListener('input', function () { dirty = true; });
    return row;
  }
  function readChildren() {
    return [].slice.call(document.querySelectorAll('#pf-children [data-child]')).map(function (r) {
      return { name: $('[data-f=name]', r).value.trim(), relation: $('[data-f=relation]', r).value, phone: $('[data-f=phone]', r).value.trim() };
    }).filter(function (c) { return c.name || c.phone; });
  }
  function fill(p) {
    $('#pf-name').value = p.name || ''; $('#pf-phone').value = p.phone || '';
    var g = p.guardian || {};
    $('#pf-g-name').value = g.name || ''; $('#pf-g-phone').value = g.phone || '';
    $('#pf-auto').checked = p.autoAlerts !== false;
    var list = $('#pf-children'); list.textContent = '';
    var kids = p.children && p.children.length ? p.children : [{}];
    kids.forEach(function (c) { list.appendChild(childRow(c)); });
    var sa = window.__gcStandalone;
    var card = $('#pf-scan-card'); if (card) card.style.display = sa ? '' : 'none';
    if (sa) $('#pf-key').value = sa.hasApiKey() ? '••••••••' : '';
    dirty = false;
  }
  function render() {
    var g = G(); if (!g || !$('#pf-root')) return;
    var p = g.S.profile || {}, sig = JSON.stringify(p);
    if (!dirty && sig !== loadedFrom) { loadedFrom = sig; fill(p); }
    var n = window.__gcNative;
    var perm = $('#pf-perm');
    if (perm) g.setT(perm, n ? (n.permissionsOk ? 'SMS and phone permission granted.' : 'Needs SMS and phone permission on this phone.') : 'Calls and messages are sent by the Android app. Here, alerts show in the app.');
  }
  function save() {
    var g = G();
    var children = readChildren();
    var data = {
      name: $('#pf-name').value.trim(), phone: $('#pf-phone').value.trim(), children: children,
      guardian: { name: $('#pf-g-name').value.trim(), phone: $('#pf-g-phone').value.trim() },
      autoAlerts: $('#pf-auto').checked, updatedAt: new Date().toISOString()
    };
    var bad = [];
    if (data.phone && !PHONE.test(data.phone)) bad.push(tr('Patient Phone'));
    children.forEach(function (c) { if (!c.name || !PHONE.test(c.phone)) bad.push(c.name || tr('Son / Daughter')); });
    if (data.guardian.phone && !PHONE.test(data.guardian.phone)) bad.push(tr('Guardian Phone'));
    if (bad.length) { g.toast(tr('Check the phone number for: {list}.', { list: bad.join(', ') }), 'warn'); return; }
    if (!children.length && !data.guardian.phone) g.toast('Add at least one son, daughter or guardian so someone can be alerted.', 'warn');
    var sa = window.__gcStandalone, key = $('#pf-key') ? $('#pf-key').value.trim() : '';
    if (sa && key && key.indexOf('•') < 0) sa.setApiKey(key);
    if (sa && !key) sa.setApiKey('');
    if (!g.S.db) { g.toast('Saving needs you to be signed in to claude.ai.', 'warn'); return; }
    g.setT('pf-save-label', 'Saving…');
    g.S.db.doc('profile/patient').set(data).then(function () {
      dirty = false; loadedFrom = null;
      if (window.__gcNative) window.__gcNative.setContacts(data);
      g.toast('Profile saved.');
    }).catch(function () { g.toast('Could not save. Try again.', 'warn'); })
      .then(function () { g.setT('pf-save-label', 'Save Profile'); });
  }
  function testAlert() {
    var g = G();
    if (window.__gcNative) { window.__gcNative.testAlert(); return; }
    var p = g.S.profile || {}, first = (p.children || [])[0] || p.guardian;
    if (!first || !first.phone) { g.toast('Add and save a contact first.', 'warn'); return; }
    // Browser fallback: open the SMS app with the message ready to send.
    var body = tr('Gran Care test alert from {name}. Alerts are set up.', { name: p.name || tr('Patient') });
    location.href = 'sms:' + first.phone.replace(/[^+\d]/g, '') + '?body=' + encodeURIComponent(body);
  }
  function init() {
    if (!$('#pf-root')) return;
    $('#pf-add-child').addEventListener('click', function () { $('#pf-children').appendChild(childRow({})); dirty = true; });
    $('#pf-save').addEventListener('click', save);
    $('#pf-test').addEventListener('click', testAlert);
    ['pf-name', 'pf-phone', 'pf-g-name', 'pf-g-phone', 'pf-key', 'pf-auto'].forEach(function (id) { var el = document.getElementById(id); if (el) el.addEventListener('input', function () { dirty = true; }); });
    $('#pf-auto').addEventListener('change', function () { dirty = true; });
    $('#pf-key').addEventListener('focus', function () { if (this.value.indexOf('•') >= 0) this.value = ''; });
  }
  window.__gcProfile = { render: render, init: init };
})();
