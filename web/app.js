/* Gran Care runtime: wires the Figma screens to the artifact's shared database
   (meds, events, profile, settings, signals) and to Claude for prescription OCR. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };

  // ---------- constants ----------
  var SLOTS = [
    { key: 'morning', label: 'Morning', h: 8, m: 0, when: 'Take after breakfast' },
    { key: 'afternoon', label: 'Afternoon', h: 13, m: 0, when: 'Take after lunch' },
    { key: 'evening', label: 'Evening', h: 18, m: 0, when: 'Take after dinner' },
    { key: 'bedtime', label: 'Bedtime', h: 22, m: 0, when: 'Take before bed' }
  ];
  var SLOT = {}; SLOTS.forEach(function (s) { SLOT[s.key] = s; });
  var MISSED_AFTER_MIN = 60, DUE_BEFORE_MIN = 30;
  var COLORS = { call: '#007bb6', taken: '#43617c', snoozed: '#ac6200', missed: '#ba1a1a', sos: '#ba1a1a', help: '#007bb6', voice_reminder: '#007bb6' };

  // ---------- state ----------
  var S = { db: null, uid: null, meds: [], events: [], profile: {}, settings: { fontSize: 'standard', audioGuidance: true }, lastVoice: null, ready: false, preset: null };

  // ---------- helpers ----------
  function tr(text, vars) { return window.GC_I18N ? window.GC_I18N(text, S.settings.language, vars) : text; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function slotDate(slot) { var d = new Date(); d.setHours(slot.h, slot.m, 0, 0); return d; }
  function fmtTime(d, secs) {
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return pad(h) + ':' + pad(d.getMinutes()) + (secs ? ':' + pad(d.getSeconds()) : '') + ' ' + ap;
  }
  function ago(iso) {
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return tr('Just now'); if (m < 60) return tr('{n} min ago', { n: m });
    return tr('{n} hr ago', { n: Math.floor(m / 60) });
  }
  // Rewrite a Figma text node (div > p per line) keeping its line style.
  function setT(id, lines) {
    var el = typeof id === 'string' ? document.getElementById(id) : id; if (!el) return;
    if (!Array.isArray(lines)) lines = [lines];
    var ps = $$('p', el), cls = (ps[0] ? ps[0].className : '').replace(/\bmb-0\b/, '').trim();
    el.textContent = '';
    lines.forEach(function (t, i) { var p = document.createElement('p'); p.className = cls + (i < lines.length - 1 ? ' mb-0' : ''); p.dataset.en = t; p.textContent = tr(t); el.appendChild(p); });
  }
  // Static copy: remember the English source once, then render it in the chosen language.
  function markStatic() {
    $$('.screen .gct > p').forEach(function (p) { if (!p.dataset.en) p.dataset.en = p.textContent.replace(/\s+/g, ' ').trim(); });
    $$('.screen [placeholder]').forEach(function (e) { if (!e.dataset.enPh) e.dataset.enPh = e.getAttribute('placeholder'); });
  }
  function applyLang() {
    $$('.screen p[data-en]').forEach(function (p) { var t = tr(p.dataset.en); if (p.textContent !== t) p.textContent = t; });
    $$('.screen [data-en-ph]').forEach(function (e) { e.setAttribute('placeholder', tr(e.dataset.enPh)); });
  }
  // Placeholder text keeps Figma's fixed box; real data gets a fluid, wrapping box.
  function flex(id, fluid) {
    var el = document.getElementById(id); if (!el) return;
    el.classList.toggle('gc-fluid', !!fluid);
    if (id === 'mr-instr') el.style.maxWidth = fluid ? '260px' : '';
  }
  // Shrink a heading until its longest word fits its column (never mid-word breaks).
  function fit(id, max, min) {
    var el = document.getElementById(id); if (!el) return;
    el.style.fontSize = ''; $$('p', el).forEach(function (p) { p.style.lineHeight = ''; });
    var size = max;
    var over = function () { return $$('p', el).some(function (p) { return p.scrollWidth > p.clientWidth + 0.5; }) || el.scrollWidth > el.clientWidth + 0.5; };
    while (size > min && over()) { size -= 1; el.style.fontSize = size + 'px'; }
    $$('p', el).forEach(function (p) { p.style.lineHeight = size < max ? (size * 1.25) + 'px' : ''; });
  }
  // Layout fitting for content longer than Figma's copy (real data, translations).
  // Text that already fits is left untouched, so the Figma layout is unchanged.
  function px(v) { return parseFloat(v) || 0; }
  function contentBox(el) {
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { l: r.left + px(cs.paddingLeft) + px(cs.borderLeftWidth), r: r.right - px(cs.paddingRight) - px(cs.borderRightWidth) };
  }
  function flowKids(el) { return [].slice.call(el.children).filter(function (k) { var cs = getComputedStyle(k); return cs.position !== 'absolute' && cs.position !== 'fixed' && cs.display !== 'none'; }); }
  // Width a text box can use inside ancestor A once padding and row neighbours are taken out.
  function availWidth(d, A) {
    var cb = contentBox(A), w = cb.r - cb.l, node = d;
    while (node && node !== A) {
      var par = node.parentElement, cs = getComputedStyle(par);
      if (/flex/.test(cs.display) && !/column/.test(cs.flexDirection)) {
        var kids = flowKids(par);
        kids.forEach(function (k) { if (k !== node) w -= k.getBoundingClientRect().width; });
        w -= (px(cs.columnGap) || 0) * Math.max(0, kids.length - 1);
      }
      if (par !== A) w -= px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
      node = par;
    }
    return Math.floor(w);
  }
  function autofit() {
    var sec = document.querySelector('.screen:not([hidden])'); if (!sec) return;
    $$('[data-fitted]', sec).forEach(function (el) {
      el.style.maxWidth = el.style.minWidth = el.style.whiteSpace = el.style.overflowWrap = el.style.height = el.style.minHeight = el.style.flexWrap = el.style.rowGap = '';
      var p = el.querySelector(':scope > p'); if (p && el.classList.contains('gct')) p.style.fontSize = '';
      delete el.dataset.fitted;
    });
    // 1) horizontal: wrap labels that overflow their real container
    $$('.gct', sec).forEach(function (d) {
      if (d.id === 'mr-name' || d.closest('.overflow-clip:not(.gct)') && d.closest('[class*="h-[26px]"]')) return;
      var p = d.firstElementChild; if (!p || !d.offsetParent) return;
      var pr = p.getBoundingClientRect(), A = null;
      for (var n = d.parentElement; n && n !== sec.parentElement; n = n.parentElement) {
        var cb = contentBox(n);
        if (pr.right > cb.r + 0.5 || pr.left < cb.l - 0.5) { A = n; break; }
      }
      var selfOver = p.scrollWidth > p.clientWidth + 1;
      if (!A && !selfOver) return;
      var w = A ? availWidth(d, A) : d.clientWidth; if (w < 24) return;
      d.dataset.fitted = '1';
      if (!A) {
        // Fixed-width slot (e.g. a header title): a slight shrink keeps it on one line.
        var b0 = parseFloat(getComputedStyle(p).fontSize), s0 = b0;
        while (s0 > b0 * 0.85 && p.scrollWidth > p.clientWidth + 1) { s0 -= 0.5; p.style.fontSize = s0 + 'px'; }
        if (p.scrollWidth <= p.clientWidth + 1) return;
        p.style.fontSize = '';
      }
      d.style.maxWidth = w + 'px'; d.style.minWidth = '0'; d.style.whiteSpace = 'normal';
      if (p.scrollWidth > p.clientWidth + 1) {
        var base = parseFloat(getComputedStyle(p).fontSize), s = base;
        while (s > base * 0.75 && p.scrollWidth > p.clientWidth + 1) { s -= 0.5; p.style.fontSize = s + 'px'; }
        if (p.scrollWidth > p.clientWidth + 1 && !A) d.style.overflowWrap = 'anywhere';
        else if (p.scrollWidth > p.clientWidth + 1) {
          // A single word still cannot fit beside its neighbours: wrap the row instead.
          p.style.fontSize = '';
          var row = d.parentElement;
          while (row && row !== A && !(/flex/.test(getComputedStyle(row).display) && !/column/.test(getComputedStyle(row).flexDirection) && flowKids(row).length > 1)) row = row.parentElement;
          if (row && row !== sec) { row.dataset.fitted = 'row'; row.style.flexWrap = 'wrap'; row.style.rowGap = '4px'; d.style.maxWidth = ''; d.style.whiteSpace = ''; }
          else d.style.overflowWrap = 'anywhere';
        }
      }
    });
    fit('mr-name', 30, 18);
    // Absolutely positioned header subtitle: keep it within Figma's two lines.
    var sub = document.getElementById('rs-sub');
    if (sub && sub.offsetParent) {
      var sp = sub.firstElementChild; sp.style.fontSize = ''; sp.style.lineHeight = '';
      var sz = 16.8;
      while (sz > 12 && sub.getBoundingClientRect().height > 49) { sz -= 0.4; sp.style.fontSize = sz + 'px'; sp.style.lineHeight = Math.round(sz * 1.43) + 'px'; }
    }
    // 2) vertical: fixed-height boxes grow when their text now needs more lines
    for (var pass = 0; pass < 3; pass++) {
      $$('*', sec).reverse().forEach(function (el) {
        if (!/(^|\s)h-\[/.test(el.getAttribute('class') || '') || el.dataset.fitted === 'h') return;
        var r = el.getBoundingClientRect(), over = false;
        $$('.gct', el).some(function (g) { if (!g.offsetParent || g.closest('[class*="h-[26px]"]')) return false; var gr = g.getBoundingClientRect(); return (over = gr.bottom > r.bottom + 1 || gr.top < r.top - 1); });
        if (!over && el.parentElement && el.parentElement.classList.contains('screen')) over = flowKids(el).some(function (k) { return k.getBoundingClientRect().bottom > r.bottom + 1; });
        if (over) { el.dataset.fitted = 'h'; el.style.minHeight = r.height + 'px'; el.style.height = 'auto'; }
      });
    }
  }
  window.__granCareFit = autofit;
  window.addEventListener('resize', function () { autofit(); });
  try { document.fonts.ready.then(autofit); } catch (e) {}
  function snapshotT(id) { var el = document.getElementById(id); return el ? $$('p', el).map(function (p) { return p.dataset.en || p.textContent; }) : null; }
  var ORIG = {};
  function orig(id) { if (!(id in ORIG)) ORIG[id] = snapshotT(id); return ORIG[id]; }

  var toastEl;
  function toast(msg, tone) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'app-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = tr(msg); toastEl.dataset.tone = tone || 'ok'; toastEl.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }
  function speak(text) {
    if (window.__gcSpeak) { window.__gcSpeak(text, S.settings.language || 'en-US'); return; }
    try { if (!('speechSynthesis' in window)) return; window.speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(text); u.rate = 0.92; u.lang = S.settings.language || 'en-US'; window.speechSynthesis.speak(u); } catch (e) {}
  }
  function go(slug) { if (window.__showScreen) window.__showScreen(slug); }

  // ---------- schedule model ----------
  function doseInstances() {
    var out = [], now = Date.now(), day = today();
    S.meds.forEach(function (m) {
      var created = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      if (m.durationDays && created && now > created + m.durationDays * 86400000) return;
      (m.slots || []).forEach(function (k) {
        var sl = SLOT[k]; if (!sl) return;
        var t = slotDate(sl).getTime();
        if (created && today(new Date(created)) === day && created > t + MISSED_AFTER_MIN * 60000) return;
        var evs = S.events.filter(function (e) { return e.day === day && e.medId === m.id && e.slot === k; });
        var taken = evs.filter(function (e) { return e.type === 'taken'; })[0];
        var snz = evs.filter(function (e) { return e.type === 'snoozed'; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; })[0];
        var status = 'upcoming';
        if (taken) status = 'taken';
        else if (snz && new Date(snz.until).getTime() > now) status = 'snoozed';
        else if (now > t + MISSED_AFTER_MIN * 60000) status = 'missed';
        else if (now >= t - DUE_BEFORE_MIN * 60000) status = 'due';
        out.push({ med: m, slot: sl, day: day, time: t, status: status, takenAt: taken && taken.at, lastSnoozeUntil: snz && snz.until, snoozes: evs.filter(function (e) { return e.type === 'snoozed'; }).length });
      });
    });
    return out.sort(function (a, b) { return a.time - b.time; });
  }
  function currentDose(list) {
    list = list || doseInstances();
    return list.filter(function (d) { return d.status === 'due' || d.status === 'missed'; })[0] ||
      list.filter(function (d) { return d.status === 'snoozed'; })[0] ||
      list.filter(function (d) { return d.status === 'upcoming'; })[0] || null;
  }
  function slotsFromFrequency(text, fallback) {
    var t = (text || '').toLowerCase(), s = [];
    if (/morning|breakfast|\bam\b/.test(t)) s.push('morning');
    if (/afternoon|noon|lunch/.test(t)) s.push('afternoon');
    if (/evening|dinner|supper/.test(t)) s.push('evening');
    if (/night|bed/.test(t)) s.push('bedtime');
    if (!s.length) {
      if (/three|3x|thrice|tid/.test(t)) s = ['morning', 'afternoon', 'evening'];
      else if (/twice|two|2x|bid|12 ?h/.test(t)) s = ['morning', 'evening'];
      else if (/four|4x|qid/.test(t)) s = ['morning', 'afternoon', 'evening', 'bedtime'];
    }
    if (!s.length && fallback) s = [fallback];
    if (!s.length) s = ['morning'];
    return s;
  }

  // ---------- writes ----------
  function requireDb() { if (!S.db) { toast('Saving needs you to be signed in to claude.ai.', 'warn'); return false; } return true; }
  function logEvent(data) {
    if (!requireDb()) return Promise.reject(new Error('no db'));
    var now = new Date();
    data.at = now.toISOString(); data.day = today(now); if (S.uid) data.by = S.uid;
    return S.db.collection('events').add(data).catch(function (e) { toast(e && e.code === 'not_granted' ? 'You can view this page but not record changes.' : 'Could not save. Check your connection and try again.', 'warn'); throw e; });
  }
  function takeDose(d) {
    if (!d) { toast('No medication is due right now.', 'warn'); return; }
    if (d.status === 'taken') { toast(tr('{name} is already recorded for this slot.', { name: d.med.name }), 'warn'); return; }
    if (window.__gcNative) window.__gcNative.markTaken(d);
    logEvent({ type: 'taken', medId: d.med.id, medName: d.med.name, dosage: d.med.dosage || '', slot: d.slot.key }).then(function () { toast(tr('{name} recorded as taken.', { name: d.med.name })); go('smartwatch-dose-alert'); }).catch(function () {});
  }
  function snoozeDose(d, mins) {
    if (!d) { toast('No medication is scheduled yet.', 'warn'); return; }
    var esc = window.__gcEsc, max = esc ? esc.RULES.maxSnoozes : 2;
    mins = esc ? esc.RULES.snoozeMinutes : 10;
    if (d.snoozes >= max) {
      toast('Snooze limit reached. Your son / daughter is being alerted.', 'warn');
      if (esc) esc.snoozeLimitReached(d);
      if (window.__gcNative) window.__gcNative.snooze(d);
      return;
    }
    if (window.__gcNative) window.__gcNative.snooze(d);
    var until = new Date(Date.now() + mins * 60000).toISOString();
    logEvent({ type: 'snoozed', medId: d.med.id, medName: d.med.name, slot: d.slot.key, minutes: mins, until: until }).then(function () {
      toast(tr('Reminder snoozed until {t}.', { t: fmtTime(new Date(until)) }));
      go('patient-dashboard');
    }).catch(function () {});
  }
  function sos(kind) {
    logEvent({ type: kind || 'sos' }).then(function () { toast(kind === 'help' ? 'Your caretaker has been asked to call you.' : 'Emergency alert sent to your caretaker.', 'alert'); }).catch(function () {});
  }

  // ---------- render ----------
  function render() {
    var list = doseInstances(), cur = currentDose(list), now = new Date(), day = today();
    var evToday = S.events.filter(function (e) { return e.day === day; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; });

    // Role selection: sync status + font profile
    if (S.ready) {
      setT('rs-sync', S.db ? 'System Synchronization Active' : 'Sync Unavailable');
    }
    $$('[data-font]').forEach(function (b) {
      var on = b.dataset.font === S.settings.fontSize, txt = b.firstElementChild;
      b.classList.toggle('bg-white', on); b.classList.toggle('drop-shadow-[0px_1px_1px_rgba(0,0,0,0.05)]', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (txt) { txt.classList.toggle('text-[#006191]', on); txt.classList.toggle('text-[#3f4850]', !on); }
    });
    var LANG = { 'en-US': ['English', '(US)'], 'en-GB': ['English', '(UK)'], 'es-ES': ['Espa\u00f1ol'], 'fr-FR': ['Fran\u00e7ais'], 'hi-IN': ['\u0939\u093f\u0928\u094d\u0926\u0940'], 'ta-IN': ['\u0ba4\u0bae\u0bbf\u0bb4\u0bcd'] };
    var lang = S.settings.language || 'en-US';
    applyLang();
    setT('rs-lang-label', LANG[lang] || LANG['en-US']);
    var lsel = $('#rs-lang-select'); if (lsel && lsel.value !== lang) lsel.value = lang;
    document.documentElement.lang = lang.split('-')[0];
    var z = { standard: 1, large: 1.1, extra: 1.2 }[S.settings.fontSize] || 1;
    ['patient-dashboard', 'medication-reminder', 'smartwatch-alarm'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.zoom = z === 1 ? '' : z; });

    // Patient dashboard
    if (S.profile.name) setT('pd-name', [S.profile.name]); else setT('pd-name', orig('pd-name'));
    if (cur) {
      setT('pd-next-title', cur.med.name);
      var st = tr({ due: 'Due now', missed: 'Overdue', snoozed: 'Snoozed', upcoming: 'Upcoming' }[cur.status]);
      setT('pd-next-sub', [(cur.med.dosage || tr('Dose')) + ' \u2022 ' + tr(cur.slot.label) + ' ' + fmtTime(new Date(cur.time)), st + (cur.med.instructions ? ' \u2022 ' + cur.med.instructions : '')]);
    } else { setT('pd-next-title', orig('pd-next-title')); setT('pd-next-sub', orig('pd-next-sub')); }
    $$('[data-slot-list]').forEach(function (el) {
      var k = el.getAttribute('data-slot-list'), items = list.filter(function (d) { return d.slot.key === k; });
      var lab = { taken: 'Taken', snoozed: 'Snoozed', missed: 'Missed', due: 'Due', upcoming: '' };
      var rows = items.map(function (d) { return (lab[d.status] ? tr(lab[d.status]) + ' \u00b7 ' : '') + d.med.name + (d.med.dosage ? ' ' + d.med.dosage : ''); });
      setT(el, rows.length ? rows : 'No medication records added to this slot.');
      el.classList.toggle('gc-ellipsis', rows.length > 0);
      el.title = rows.join('\n');
    });
    var take = $('#pd-take'), dueNow = cur && (cur.status === 'due' || cur.status === 'missed' || cur.status === 'snoozed');
    if (take) { take.classList.toggle('opacity-70', !dueNow); take.setAttribute('aria-disabled', dueNow ? 'false' : 'true'); }
    setT('pd-take-sub', dueNow ? cur.med.name + ' \u2022 ' + tr('{slot} dose', { slot: tr(cur.slot.label) }) : cur ? tr('Next at {t}', { t: fmtTime(new Date(cur.time)) }) : orig('pd-take-sub')[0]);
    var audio = $('#pd-audio');
    if (audio) {
      var on = S.settings.audioGuidance !== false;
      audio.setAttribute('aria-checked', on ? 'true' : 'false');
      var trk = $('[data-track]', audio), kn = $('[data-knob]', audio);
      trk.classList.toggle('bg-[#006191]', on); trk.classList.toggle('bg-[#bfc8d0]', !on);
      kn.style.left = on ? '' : '4px';
      setT('pd-audio-sub', on ? 'Voice assistance is enabled for all medication alerts.' : 'Voice assistance is off for medication alerts.');
    }

    // Medication reminder + smartwatch alarm (current dose)
    flex('mr-name', !!cur); flex('mr-instr', !!cur);
    if (cur) {
      setT('mr-name', [cur.med.name]);
      setT('mr-dose', [(cur.med.dosage || tr('Dose')) + ' \u2022 ' + tr(cur.slot.label), (cur.med.durationDays ? tr('{n}-day course', { n: cur.med.durationDays }) : tr('Ongoing'))]);
      setT('mr-time', fmtTime(new Date(cur.time)));
      setT('mr-instr', [cur.med.instructions || (cur.med.physician ? tr('Take as prescribed by {doc}.', { doc: cur.med.physician }) : tr('Take as prescribed.'))]);
      setT('sa-name', cur.med.name); setT('sa-dose', cur.med.dosage || 'As prescribed');
      setT('sa-when', cur.slot.when);
      var en = !/^(es|fr|hi|ta)/.test(S.settings.language || '');
      setT('sa-quote', tr('\u201cIt is time to take {med}, {when}.\u201d', { med: cur.med.name + (cur.med.dosage ? ' ' + cur.med.dosage : ''), when: en ? cur.slot.when.toLowerCase() : tr(cur.slot.when) }));
    } else {
      ['mr-name', 'mr-dose', 'mr-time', 'mr-instr', 'sa-name', 'sa-dose', 'sa-when', 'sa-quote'].forEach(function (id) { setT(id, orig(id)); });
    }
    var t12 = fmtTime(now).split(' ');
    setT('sa-clock', t12[0]); setT('sa-ampm', t12[1]);
    setT('da-clock', pad(now.getHours()) + ':' + pad(now.getMinutes()));

    // Smartwatch dose alert
    var lastTaken = evToday.filter(function (e) { return e.type === 'taken'; })[0];
    var lastAny = evToday.filter(function (e) { return e.type === 'taken' || e.type === 'snoozed'; })[0];
    if (S.ready) {
      setT('da-last', lastTaken ? tr('{t} (Taken Logged)', { t: fmtTime(new Date(lastTaken.at), true) }) : 'No dose logged today');
      if (lastAny && lastAny.type === 'snoozed') { setT('da-title', 'Dose Snoozed'); setT('da-sub', tr('Reminder at {t}', { t: fmtTime(new Date(lastAny.until)) })); }
      else { setT('da-title', orig('da-title')); setT('da-sub', orig('da-sub')); }
    }

    // Caretaker dashboard
    if (S.profile.name) setT('ct-patient', tr('Monitoring: {name}', { name: S.profile.name })); else setT('ct-patient', orig('ct-patient'));
    var callL = $('#ct-call-label'); if (callL && S.profile.phone !== undefined) setT(callL, S.profile.phone ? 'Direct Call Patient Phone' : 'Add Patient Phone Number');
    if (evToday[0]) setT('ct-ping', tr('Last ping: {ago}', { ago: ago(evToday[0].at) }));
    var taken = list.filter(function (d) { return d.status === 'taken'; }).length;
    var missed = list.filter(function (d) { return d.status === 'missed'; });
    var dueSoFar = list.filter(function (d) { return d.time <= now.getTime() || d.status === 'taken'; }).length;
    var snoozedN = evToday.filter(function (e) { return e.type === 'snoozed'; }).length;
    var urgent = evToday.filter(function (e) { return e.type === 'sos' || e.type === 'help'; });
    if (list.length) {
      setT('ct-adh', dueSoFar ? Math.round(100 * Math.min(taken, dueSoFar) / dueSoFar) + '%' : '--%');
      setT('ct-adh-sub', dueSoFar ? tr('{n} of {d} due doses', { n: taken, d: dueSoFar }) : 'No doses due yet');
      setT('ct-taken', '[' + taken + ' / ' + list.length + ']');
    } else { setT('ct-adh', orig('ct-adh')); setT('ct-adh-sub', orig('ct-adh-sub')); setT('ct-taken', orig('ct-taken')); }
    setT('ct-snoozed', '[' + snoozedN + ']'); setT('ct-missed', '[' + missed.length + ']');
    var pending = missed.length + urgent.length;
    setT('ct-pending', pending + ' ' + tr('Pending'));
    if (pending) {
      setT('ct-alert-title', tr(pending === 1 ? '{n} Alert Needs Action' : '{n} Alerts Need Action', { n: pending }));
      var lines = urgent.slice(0, 2).map(function (e) { return tr(e.type === 'sos' ? 'Emergency SOS at {t}.' : 'Call request at {t}.', { t: fmtTime(new Date(e.at)) }); })
        .concat(missed.slice(0, 3).map(function (d) { return tr('{med} missed ({slot}).', { med: d.med.name, slot: tr(d.slot.label) }); }));
      setT('ct-alert-text', lines.join(' '));
    } else { setT('ct-alert-title', orig('ct-alert-title')); setT('ct-alert-text', orig('ct-alert-text')); }
    renderFeed(evToday);
    if (window.__gcWatch) window.__gcWatch.onRender(list);
    if (window.__gcEsc) window.__gcEsc.onRender(list);
    if (window.__gcProfile) window.__gcProfile.render();
    if (window.__gcNative) window.__gcNative.onRender(list);
    var limit = cur && cur.snoozes >= 2 && cur.status !== 'taken';
    setT('mr-snooze-label', limit ? 'SNOOZE LIMIT REACHED' : 'LATER (SNOOZE 10M)');
    setT('mr-snooze-sub', limit ? 'Your family has been alerted' : 'Postpones alert by 10 mins (up to 2 times), then alerts your family');
    autofit();
  }

  function renderFeed(evs) {
    var sk = $('#ct-skeleton'); if (!sk) return;
    $$('[data-feed-row]').forEach(function (r) { r.remove(); });
    if (!evs.length) { sk.style.display = ''; setT('ct-feed-title', orig('ct-feed-title')); setT('ct-feed-text', orig('ct-feed-text')); return; }
    sk.style.display = 'none';
    setT('ct-feed-title', tr(evs.length === 1 ? '{n} Medication Event Today' : '{n} Medication Events Today', { n: evs.length }));
    setT('ct-feed-text', 'Timeline updates in real time upon patient response.');
    var names = { taken: 'Dose taken', snoozed: 'Dose snoozed', sos: 'Emergency SOS', help: 'Call request', voice_reminder: 'Voice reminder sent', call: 'Caretaker called' };
    evs.slice(0, 8).forEach(function (e) {
      var row = document.createElement('div');
      row.setAttribute('data-feed-row', '');
      row.className = 'bg-white flex gap-[12px] items-center max-w-[384px] p-[12px] relative rounded-[8px] shrink-0 w-full mb-[8px] last:mb-0';
      var dot = document.createElement('div'); dot.className = 'relative rounded-[9999px] shrink-0 size-[14px]'; dot.style.background = COLORS[e.type] || '#d7dae1';
      var col = document.createElement('div'); col.className = 'flex flex-[1_0_0] flex-col items-start min-w-px relative';
      var a = document.createElement('p'); a.className = 'fi font-semibold text-[#181c21] text-[14px] leading-[20px] truncate w-full'; a.textContent = tr(names[e.type] || e.type);
      var b = document.createElement('p'); b.className = 'fi font-normal text-[#3f4850] text-[12px] leading-[18px] truncate w-full';
      b.textContent = e.medName ? e.medName + (e.slot && SLOT[e.slot] ? ' \u2022 ' + tr(SLOT[e.slot].label) : '') + (e.type === 'snoozed' ? ' \u2022 ' + e.minutes + ' min' : '') : tr(e.reason === 'repeat_snooze' ? 'Repeated snooze' : 'Patient device');
      col.appendChild(a); col.appendChild(b);
      var t = document.createElement('p'); t.className = 'fi font-semibold text-[#3f4850] text-[12px] leading-[16px] whitespace-nowrap'; t.textContent = fmtTime(new Date(e.at));
      row.appendChild(dot); row.appendChild(col); row.appendChild(t);
      sk.parentNode.insertBefore(row, sk);
    });
  }

  // ---------- OCR (Claude) ----------
  var ocrStart = 0, ocrTimer = null, ocrBusy = false;
  function setStep(n) {
    $$('[data-step]').forEach(function (el) {
      var i = +el.dataset.step, on = i <= n;
      el.classList.toggle('bg-[#006191]', on); el.classList.toggle('bg-[#ebeef5]', !on);
      var svg = el.querySelector('svg'); if (svg) svg.style.filter = on && i > 1 ? 'brightness(0) invert(1)' : '';
      var lbl = el.parentNode.querySelector('p');
      if (lbl) { lbl.classList.toggle('text-[#006191]', on); lbl.classList.toggle('font-bold', on); lbl.classList.toggle('text-[#3f4850]', !on); lbl.classList.toggle('font-normal', !on); }
    });
    var pr = $('#ocr-progress'); if (pr) pr.style.right = ['84.31%', '84.31%', '56.5%', '28.5%', '7.36%'][n] || '';
  }
  function ocrState(status, title, desc, fill) {
    setT('ocr-status', status); if (title) setT('ocr-title', title); if (desc) setT('ocr-desc', desc);
    var f = $('#ocr-bar [data-fill]'); if (f) f.style.width = fill + '%';
  }
  function handleImage(file) {
    if (!file || ocrBusy) return;
    claude.use('sample').then(function (sample) {
      if (!sample) { ocrState('OCR OFF', 'Scanning Is Not Available', 'Type the prescription details into the verification fields below.', 0); setStep(3); return; }
      ocrBusy = true; setStep(2); ocrStart = Date.now();
      ocrState('SCANNING', 'Reading Your Prescription Slip', 'Extracting medication name, dosage, frequency and physician details.', 35);
      clearInterval(ocrTimer); ocrTimer = setInterval(function () { setT('ocr-time', ((Date.now() - ocrStart) / 1000).toFixed(1) + 's'); }, 100);
      var prompt = 'You are reading a photo of a medical prescription or medicine label for an elderly patient\'s medication app. ' +
        'Extract the single main medication. Respond with JSON only, shaped {"name":string,"dosage":string,"frequency":string,"durationDays":number|null,"physician":string,"instructions":string}. ' +
        'dosage like "500 mg" or "5 ml"; frequency in plain words such as "Morning / Night" or "Twice daily"; instructions short, e.g. "Take after meals". Use "" or null for anything not visible. If the image is not a prescription, return {"name":""}.';
      return sample.json(prompt, { images: [file], modelTier: 'default', cache: false }).then(function (r) {
        r = r || {};
        if (!r.name) { ocrState('NO TEXT FOUND', 'No Prescription Detected', 'Retake the photo flat and well-lit, or type the fields below.', 0); setStep(1); return; }
        $('#f-name').value = r.name || ''; $('#f-dose').value = r.dosage || ''; $('#f-freq').value = r.frequency || '';
        $('#f-days').value = r.durationDays || ''; $('#f-doc').value = r.physician || '';
        $('#f-name').dataset.instructions = r.instructions || '';
        ocrState('OCR COMPLETE', 'Prescription Read Successfully', 'Check every field against your physical prescription bottle.', 100);
        setStep(3);
      });
    }).catch(function (e) {
      var msg = e && e.code === 'not_granted' ? 'Claude access was declined. Type the fields below instead.' : e && e.code === 'rate_limited' ? 'Too many scans right now. Wait a minute and try again.' : 'The photo could not be read. Try again or type the fields below.';
      ocrState('SCAN FAILED', 'Scan Did Not Complete', msg, 0); setStep(1);
    }).then(function () { ocrBusy = false; clearInterval(ocrTimer); });
  }
  function saveMed() {
    var f = { name: $('#f-name').value.trim(), dosage: $('#f-dose').value.trim(), frequency: $('#f-freq').value.trim(), durationDays: parseInt($('#f-days').value, 10) || null, physician: $('#f-doc').value.trim() };
    var missing = [];
    if (!f.name) missing.push('Medication Name'); if (!f.dosage) missing.push('Dosage'); if (!f.frequency) missing.push('Frequency'); if (!f.durationDays) missing.push('Duration');
    var notice = $('#ocr-notice');
    if (missing.length) { setT('ocr-notice', tr('Fill in the required fields: {list}.', { list: missing.map(function (m) { return tr(m); }).join(', ') })); if (notice) notice.classList.add('text-[#ba1a1a]'); return; }
    if (notice) notice.classList.remove('text-[#ba1a1a]'); setT('ocr-notice', orig('ocr-notice'));
    if (!requireDb()) return;
    var med = { name: f.name, dosage: f.dosage, frequency: f.frequency, durationDays: f.durationDays, physician: f.physician, instructions: $('#f-name').dataset.instructions || '', slots: slotsFromFrequency(f.frequency, S.preset), active: true, createdAt: new Date().toISOString() };
    if (S.uid) med.addedBy = S.uid;
    setT('ocr-save-label', 'Saving\u2026');
    S.db.collection('meds').add(med).then(function () {
      setStep(4); setTimeout(resetOcr, 600);
      toast(tr('{med} added to {slots}.', { med: med.name, slots: med.slots.map(function (k) { return tr(SLOT[k].label); }).join(', ') }));
      go('patient-dashboard');
    }).catch(function (e) { toast(e && e.code === 'not_granted' ? 'You can view this page but not add medications.' : 'Could not save. Try again.', 'warn'); }).then(function () { setT('ocr-save-label', 'Save to My Medications'); });
  }
  function resetOcr() {
    ['f-name', 'f-dose', 'f-freq', 'f-days', 'f-doc'].forEach(function (id) { var el = $('#' + id); if (el) { el.value = ''; delete el.dataset.instructions; } });
    setStep(1); ocrState(orig('ocr-status')[0], orig('ocr-title'), orig('ocr-desc'), 0); setT('ocr-time', '0.0s'); S.preset = null;
  }

  // ---------- events ----------
  function bind() {
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-go],[data-back],[data-sos],[data-help],[data-font],[data-textsize],#ct-target-label,#ct-call,#pd-take,#pd-voice,#pd-contact,#pd-audio,#mr-taken,#mr-snooze,#sa-taken,#sa-later,#sa-speak,#ct-voice,#ct-patient-box,#ocr-save');
      if (!t) return;
      if (t.hasAttribute('data-add-slot')) { S.preset = t.getAttribute('data-add-slot'); var fq = $('#f-freq'); if (fq && !fq.value) fq.value = SLOT[S.preset].label; }
      if (t.hasAttribute('data-go')) {
        ev.preventDefault(); go(t.getAttribute('data-go'));
        if (t.hasAttribute('data-meds')) setTimeout(function () { var sec = document.getElementById('pd-schedule'); if (sec) window.scrollTo(0, sec.getBoundingClientRect().top + window.scrollY - 60); }, 0);
        return;
      }
      if (t.hasAttribute('data-textsize')) { var order = ['standard', 'large', 'extra']; saveSettings({ fontSize: order[(order.indexOf(S.settings.fontSize) + 1) % 3] }); toast(tr('Text size: {s}.', { s: tr({ standard: 'Standard', large: 'Large', extra: 'Extra' }[S.settings.fontSize]) })); return; }
      if (t.id === 'ct-target-label') { ev.preventDefault(); editPatient(); return; }
      if (t.id === 'ct-call') { callPatient(); return; }
      if (t.hasAttribute('data-back')) { go(window.__prevScreen || 'role-selection'); return; }
      if (t.hasAttribute('data-sos')) { sos('sos'); return; }
      if (t.hasAttribute('data-help')) { sos('help'); return; }
      if (t.hasAttribute('data-font')) { saveSettings({ fontSize: t.dataset.font }); return; }
      var cur = currentDose();
      switch (t.id) {
        case 'pd-take': if (t.getAttribute('aria-disabled') !== 'true') go('medication-reminder'); break;
        case 'pd-voice': speak(cur ? tr('It is time to take {med}.', { med: cur.med.name }) : tr('This is your Gran Care voice alarm. Your speaker is working.')); break;
        case 'pd-contact': sos('help'); break;
        case 'pd-audio': saveSettings({ audioGuidance: S.settings.audioGuidance === false }); break;
        case 'mr-taken': case 'sa-taken': takeDose(cur); break;
        case 'mr-snooze': snoozeDose(cur, 10); break;
        case 'sa-later': snoozeDose(cur, 10); break;
        case 'sa-speak': speak(($('#sa-quote') || {}).textContent.replace(/[\u201c\u201d\u00ab\u00bb]/g, '').trim()); break;
        case 'ct-voice': sendVoice(cur, t); break;
        case 'ct-patient-box': editPatient(); break;
        case 'ocr-save': saveMed(); break;
      }
    });
    document.addEventListener('keydown', function (ev) { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"],[role="switch"]')) { ev.preventDefault(); ev.target.click(); } });
    var ls = $('#rs-lang-select');
    if (ls) ls.addEventListener('change', function () { saveSettings({ language: ls.value }); });
    ['ocr-camera', 'ocr-file'].forEach(function (id) { var el = $('#' + id); if (el) el.addEventListener('change', function () { handleImage(el.files && el.files[0]); el.value = ''; }); });
    // Hold 3s to alert caretaker
    var hold = $('#da-hold'), ht = null;
    if (hold) {
      var start = function (e) { e.preventDefault(); setT('da-hold-label', 'Keep holding\u2026'); ht = setTimeout(function () { ht = null; sos('sos'); setT('da-hold-label', 'Caretaker Alerted'); setTimeout(function () { setT('da-hold-label', 'Hold 3s to Alert Caretaker'); }, 4000); }, 3000); };
      var stop = function () { if (ht) { clearTimeout(ht); ht = null; setT('da-hold-label', 'Hold 3s to Alert Caretaker'); } };
      hold.addEventListener('pointerdown', start); ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (n) { hold.addEventListener(n, stop); });
    }
  }
  function saveSettings(patch) {
    Object.keys(patch).forEach(function (k) { S.settings[k] = patch[k]; }); render();
    if (S.db) S.db.doc('settings/app').set(S.settings).catch(function () { toast('Setting applies on this device only; it could not be saved.', 'warn'); });
  }
  function sendVoice(cur, btn) {
    if (!requireDb()) return;
    var text = cur ? tr('Reminder from your caretaker. Please take {med}.', { med: cur.med.name + (cur.med.dosage ? ' ' + cur.med.dosage : '') }) : tr('Reminder from your caretaker. Please check your medication schedule.');
    S.db.doc('signals/voice').set({ text: text, at: new Date().toISOString(), by: S.uid || '' }).then(function () {
      logEvent({ type: 'voice_reminder', medName: cur ? cur.med.name : '' }).catch(function () {});
      var lbl = btn.querySelector('p'); if (lbl) { var o = lbl.textContent; lbl.textContent = tr('Voice Reminder Sent'); setTimeout(function () { lbl.textContent = o; }, 3000); }
    }).catch(function () { toast('Could not send the reminder.', 'warn'); });
  }
  function callPatient() {
    var ph = S.profile.phone;
    if (!ph) { editPhone(); return; }
    try { navigator.clipboard.writeText(ph).then(function () { toast(tr('Patient phone {ph} copied. Dial it from your phone.', { ph: ph })); }, function () { toast(tr('Patient phone: {ph}', { ph: ph })); }); } catch (e) { toast(tr('Patient phone: {ph}', { ph: ph })); }
    var a = document.createElement('a'); a.href = 'tel:' + ph.replace(/[^+\d]/g, ''); a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    logEvent({ type: 'call', medName: '' }).catch(function () {});
  }
  function editPhone() {
    var lbl = $('#ct-call-label'); if (!lbl || lbl.parentNode.querySelector('input')) return;
    lbl.style.display = 'none';
    var inp = document.createElement('input');
    inp.type = 'tel'; inp.id = 'ct-phone-input'; inp.placeholder = tr('Patient phone number'); inp.value = S.profile.phone || '';
    inp.className = 'fi font-semibold text-white placeholder:text-[rgba(255,255,255,0.7)] text-[18px] tracking-[0.18px] leading-[24px] w-[230px] bg-transparent border-0 outline-none p-0';
    lbl.parentNode.appendChild(inp); inp.focus();
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
    var done = function (save) {
      var v = inp.value.trim(); inp.remove(); lbl.style.display = '';
      if (save && v && requireDb()) {
        if (!/^[+\d][\d\s()-]{5,}$/.test(v)) { toast('Enter a phone number using digits, spaces or +.', 'warn'); return; }
        S.profile.phone = v; render();
        S.db.doc('profile/patient').set(Object.assign({}, S.profile, { updatedAt: new Date().toISOString() })).then(function () { toast('Patient phone saved. Tap Direct Call to dial.'); }).catch(function () { toast('Could not save the phone number.', 'warn'); });
      }
    };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', function () { done(true); });
  }
  function editPatient() {
    var box = $('#ct-patient-box'); if (!box || box.querySelector('input')) return;
    var t = $('#ct-patient'); t.style.display = 'none';
    var inp = document.createElement('input');
    inp.id = 'ct-patient-input'; inp.value = S.profile.name || ''; inp.placeholder = tr('Patient name');
    inp.className = 'fi font-semibold text-[#181c21] text-[18px] tracking-[0.18px] leading-[24px] w-full bg-transparent border-0 outline-none p-0';
    t.parentNode.appendChild(inp); inp.focus();
    var done = function (save) {
      var v = inp.value.trim(); inp.remove(); t.style.display = '';
      if (save && v && v !== S.profile.name && requireDb()) { S.profile.name = v; render(); S.db.doc('profile/patient').set(Object.assign({}, S.profile, { name: v, updatedAt: new Date().toISOString() })).catch(function () { toast('Could not save the patient name.', 'warn'); }); }
    };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', function () { done(true); });
  }

  function subEvents() {
    if (S.evUnsub) { try { S.evUnsub(); } catch (e) {} }
    S.evDay = today(); S.events = [];
    if (window.__gcEsc) window.__gcEsc.subscribe(S.db, S.evDay);
    S.evUnsub = S.db.collection('events').where('day', '==', S.evDay).onSnapshot(function (q) { S.events = q.docs.map(function (d) { return Object.assign({}, d.data(), { id: d.id }); }); render(); }, function () { toast('Live updates paused. Reload the page to reconnect.', 'warn'); });
  }
  // ---------- boot ----------
  function boot() {
    markStatic();
    if (window.__gcWatch) window.__gcWatch.init();
    if (window.__gcEsc) window.__gcEsc.init();
    if (window.__gcProfile) window.__gcProfile.init();
    ['pd-name', 'pd-next-title', 'pd-next-sub', 'pd-take-sub', 'mr-name', 'mr-dose', 'mr-time', 'mr-instr', 'sa-name', 'sa-dose', 'sa-when', 'sa-quote', 'da-title', 'da-sub', 'ct-patient', 'ct-adh', 'ct-adh-sub', 'ct-taken', 'ct-alert-title', 'ct-alert-text', 'ct-feed-title', 'ct-feed-text', 'ocr-status', 'ocr-title', 'ocr-desc', 'ocr-notice'].forEach(orig);
    bind();
    setInterval(render, 30000);
    if (!window.claude || !claude.use) { S.ready = true; render(); return; }
    Promise.all([claude.use('db'), claude.use('user')]).then(function (r) {
      S.db = r[0]; var user = r[1]; S.ready = true;
      if (user && user.id) user.id().then(function (id) { S.uid = id; }).catch(function () {});
      if (!S.db) { render(); return; }
      S.db.collection('meds').onSnapshot(function (q) { S.meds = q.docs.map(function (d) { return Object.assign({}, d.data(), { id: d.id }); }).filter(function (m) { return m.active !== false && m.name; }); render(); });
      subEvents();
      if (window.__gcWatch) window.__gcWatch.subscribe(S.db);
      setInterval(function () { if (S.evDay !== today()) subEvents(); }, 60000);
      S.db.doc('profile/patient').onSnapshot(function (d) { S.profile = Object.assign({}, d.exists ? d.data() : {}); render(); });
      S.db.doc('settings/app').onSnapshot(function (d) { if (d.exists) { var x = d.data() || {}; S.settings.fontSize = x.fontSize || 'standard'; S.settings.audioGuidance = x.audioGuidance !== false; if (x.language) S.settings.language = x.language; } render(); });
      var firstVoice = true;
      S.db.doc('signals/voice').onSnapshot(function (d) {
        var x = d.exists && d.data(); if (firstVoice) { firstVoice = false; return; }
        if (!x || x.by === S.uid) return;
        var vis = $('.screen:not([hidden])'), id = vis && vis.id;
        if (S.settings.audioGuidance !== false && /patient|medication|smartwatch/.test(id || '')) speak(x.text);
        toast(x.text);
      });
      render();
    });
    render();
  }
  window.__granCareRender = function () { render(); };
  window.__gc = { S: S, tr: tr, setT: setT, toast: toast, speak: speak, ago: ago, render: function () { render(); }, doseInstances: doseInstances, logEvent: logEvent, go: go, today: today, SLOT: SLOT, SLOTS: SLOTS, fmtTime: fmtTime };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
