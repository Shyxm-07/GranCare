// Build script: expands screen templates into one self-contained HTML page.
// - <T lh="…" class="…">line<br>line</T>  -> Figma text node (div > p per line)
// - {{nodeId|w|h}}                        -> exact SVG exported from Figma, sized to its slot
// - {{nodeId}}                            -> SVG at its exported size (clipped exports)
// - {{LOGO}}                              -> logo raster (data URI)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

global.ICONS = [];
for (let i = 0; i < 8; i++) require(`./icons/p${i}.js`);
const SLOTS = JSON.parse(fs.readFileSync('slots.json', 'utf8'));
const LOGO = 'data:image/png;base64,' + fs.readFileSync('assets/logo.b64', 'utf8').trim();

const SCREENS = [
  ['role-selection', 'Role Selection', '03-role-selection.html'],
  ['patient-dashboard', 'Patient Dashboard', '06-patient-dashboard.html'],
  ['medication-reminder', 'Medication Reminder Alarm', '04-medication-reminder.html'],
  ['prescription-ocr', 'Prescription OCR Upload', '05-prescription-ocr.html'],
  ['smartwatch-alarm', 'Smartwatch Alarm', '01-smartwatch-alarm.html'],
  ['smartwatch-dose-alert', 'Smartwatch Dose Alert', '02-smartwatch-dose-alert.html'],
  ['caretaker-dashboard', 'Caretaker Dashboard', '07-caretaker-dashboard.html'],
  ['profile', 'Profile', '08-profile.html'],
  ['login', 'Log In', '09-login.html'],
  ['signup', 'Create Account', '10-signup.html'],
];

const TW = JSON.parse(fs.readFileSync('twidths.json', 'utf8'));
function expandText(html, key) {
  let idx = 0;
  // Figma line breaks are wrap points of one paragraph: join them so text reflows
  // inside its container (needed for alignment and for translated copy).
  return html.replace(/<T lh="([^"]+)" class="([^"]*)"([^>]*)>([\s\S]*?)<\/T>/g, (_, lh, cls, attrs, body) => {
    const w = (TW[key] || [])[idx++];
    const lines = body.split('<br>');
    let text = lines[0];
    for (let i = 1; i < lines.length; i++) text += (/-$/.test(text) ? '' : ' ') + lines[i];
    if (lines.length > 1) {
      cls = cls.replace(/\bwhitespace-nowrap\b/, '').replace(/\bh-\[/, 'min-h-[');
      if (w && !/(^|\s)w-\[/.test(cls)) cls += ` max-w-[${w}px] min-w-0`;
    }
    return `<div class="gct [word-break:normal] flex flex-col justify-center leading-[0] relative shrink-0 ${cls}"${attrs}><p class="leading-[${lh}]">${text}</p></div>`;
  });
}

const missing = new Set();
function expandIcons(html) {
  html = html.replace(/\{\{LOGO\}\}/g, LOGO);
  return html.replace(/\{\{([0-9]+:[0-9]+)(?:\|([0-9.]+)\|([0-9.]+))?(?:\|([a-z-]+))?\}\}/g, (_, id, w, h, mode) => {
    const idx = SLOTS[id];
    if (idx === undefined) { missing.add(id); return ''; }
    let svg = ICONS[idx];
    if (w && h) {
      svg = svg.replace(/^<svg width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
        `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" overflow="visible"`);
      svg = svg.replace('<svg ', '<svg class="absolute block inset-0 max-w-none size-full" ');
    } else {
      svg = svg.replace('<svg ', '<svg class="absolute block left-0 top-0 max-w-none" ');
    }
    return svg;
  });
}

let screensHtml = '';
let nav = '';
for (const [slug, title, file] of SCREENS) {
  const p = path.join('screens', file);
  if (!fs.existsSync(p)) continue;
  let html = fs.readFileSync(p, 'utf8');
  html = expandIcons(expandText(html, file.slice(0, 2))).replace(/[^\x00-\x7f]/gu, c => '&#' + c.codePointAt(0) + ';');
  screensHtml += `<section class="screen" id="${slug}" data-title="${title}">${html}</section>\n`;
  nav += `<button type="button" data-target="${slug}">${title}</button>`;
}
if (missing.size) console.warn('Missing slots:', [...missing].join(', '));

// Fonts (embedded so the page renders identically everywhere)
const fsrc = 'node_modules/@fontsource';
const fonts = [
  ['Plus Jakarta Sans', 'plus-jakarta-sans', [[400, 'normal'], [400, 'italic'], [600, 'normal'], [700, 'normal'], [800, 'normal']]],
  ['Inter', 'inter', [[400, 'normal'], [500, 'normal'], [600, 'normal'], [700, 'normal']]],
  ['Newsreader', 'newsreader', [[700, 'normal']]],
];
let fontCss = '';
for (const [fam, pkg, variants] of fonts) {
  for (const [wt, st] of variants) {
    const f = `${fsrc}/${pkg}/files/${pkg}-latin-${wt}-${st}.woff2`;
    const b64 = fs.readFileSync(f).toString('base64');
    fontCss += `@font-face{font-family:'${fam}';font-style:${st};font-weight:${wt};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
  }
}
for (const [fam, pkg, sub] of [['Noto Sans Devanagari', 'noto-sans-devanagari', 'devanagari'], ['Noto Sans Tamil', 'noto-sans-tamil', 'tamil']]) {
  for (const wt of [400, 600, 700]) {
    const b64 = fs.readFileSync(`${fsrc}/${pkg}/files/${pkg}-${sub}-${wt}-normal.woff2`).toString('base64');
    fontCss += `@font-face{font-family:'${fam}';font-style:normal;font-weight:${wt};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}\n`;
  }
}
const lib = fs.readFileSync('assets/liberation-serif-italic.woff2').toString('base64');
fontCss += `@font-face{font-family:'Liberation Serif';font-style:italic;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${lib}) format('woff2');}\n`;

// `node build.js --app` builds the Android (Capacitor) version: a full HTML document,
// no prototype screen switcher, the on-phone backend and the native bridge.
const APP = process.argv.includes('--app');
const OUT = APP ? 'dist-app' : 'dist';
const js = (f) => jsAscii(fs.readFileSync(f, 'utf8'));
const capCore = () => {
  const p = '../node_modules/@capacitor/core/dist/capacitor.js';
  return fs.existsSync(p) ? js(p) : '';
};
// Firebase accounts (app build): SDK + web/firebase-config.js + cloud.js.
// GC_FIREBASE_EMULATOR=1 points the build at the local emulators (CI tests).
const firebaseJs = () => {
  if (process.env.GC_FIREBASE_DISABLE === '1') return ''; // on-phone mode (tests)
  const emu = process.env.GC_FIREBASE_EMULATOR === '1';
  const cfgFile = 'firebase-config.js';
  let cfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  if (emu) cfg = "window.GC_FIREBASE_EMULATOR=true;window.GC_FIREBASE_CONFIG={apiKey:'demo-key',authDomain:'demo-grancare.firebaseapp.com',projectId:'demo-grancare',appId:'demo'};";
  if (process.env.GC_FIREBASE_MOCK === '1') { // local UI tests only
    return js('tests/firebase-mock.js') + '\n' + "window.GC_FIREBASE_CONFIG={apiKey:'mock'};" + '\n' + js('cloud.js');
  }
  if (!/apiKey\s*:\s*['"][^'"]+/.test(cfg)) return ''; // no Firebase project yet: on-phone mode
  const sdk = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-firestore-compat.js']
    .map((f) => js('node_modules/firebase/' + f).replace(/<\/script/gi, '<\\/script')).join('\n');
  return sdk + '\n' + jsAscii(cfg) + '\n' + js('cloud.js');
};
const appHead = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f7f9ff"><title>Gran Care</title>`;
const appCss = `.viewer-bar{display:none!important}.viewer-stage{padding:0;overflow-x:hidden;zoom:var(--gc-scale,1)}
.screen{box-shadow:none;margin:0}html,body{background:#f7f9ff;margin:0;-webkit-tap-highlight-color:transparent}
body{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}`;
const jsAscii = (s) => s.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const shell = (css) => `${APP ? appHead : '<title>Gran Care Prototype</title>'}
<style>
${fontCss}
${css}
${APP ? appCss : ''}
</style>${APP ? '</head><body class="gc-app">' : ''}
<header class="viewer-bar" role="tablist" aria-label="Prototype screens">${nav}</header>
<main class="viewer-stage">
${screensHtml}
</main>
<script>
(function(){
  var btns=[].slice.call(document.querySelectorAll('.viewer-bar button'));
  var screens=[].slice.call(document.querySelectorAll('.screen'));
  var cur=null;
  function show(slug){
    if(!document.getElementById(slug)) slug=screens[0].id;
    if(cur && cur!==slug) window.__prevScreen=cur; cur=slug;
    if(window.__granCareRender) window.__granCareRender();
    screens.forEach(function(s){s.hidden = s.id!==slug;});
    btns.forEach(function(b){b.setAttribute('aria-selected', b.dataset.target===slug ? 'true':'false');});
    if(window.__granCareFit) window.__granCareFit();
    window.scrollTo(0,0);
  }
  window.__showScreen=function(slug){ try{history.replaceState(null,'','#'+slug);}catch(e){} show(slug); };
  btns.forEach(function(b){b.addEventListener('click',function(){ window.__showScreen(b.dataset.target);});});
  var start=(location.hash||'').slice(1);
  try{ if(!start && document.body.classList.contains('gc-app')) start=localStorage.getItem('gc.home')||''; }catch(e){}
  show(start);
  window.addEventListener('hashchange',function(){show(location.hash.slice(1));});
})();
</script>
${APP ? '<script>' + capCore() + '</script>' : ''}
<script>
${APP ? js('standalone.js') : ''}
${APP ? firebaseJs() : ''}
${js('i18n.js')}
${js('watch.js')}
${js('escalation.js')}
${js('app.js')}
${js('profile.js')}
${APP ? js('native.js') : ''}
</script>${APP ? '</body></html>' : ''}`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(OUT + '/_content.html', shell(''));
execSync('npx tailwindcss -c tailwind.config.js -i input.css -o ' + OUT + '/_tw.css --minify', { stdio: 'inherit' });
const css = fs.readFileSync(OUT + '/_tw.css', 'utf8');
fs.writeFileSync(OUT + '/index.html', shell(css));
for (const f of ['_content.html', '_tw.css']) fs.rmSync(OUT + '/' + f, { force: true });
console.log('built ' + OUT + '/index.html', (fs.statSync(OUT + '/index.html').size / 1024).toFixed(0) + 'KB');
