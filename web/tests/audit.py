from playwright.sync_api import sync_playwright
HANDLED_IDS="pd-take pd-voice pd-contact pd-audio mr-taken mr-snooze sa-taken sa-later sa-speak ct-voice ct-patient-box ocr-save da-hold".split()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':520,'height':900})
    pg.add_init_script(path='mock.js')
    pg.goto('file://../dist/index.html'); pg.wait_for_timeout(300)
    res=pg.evaluate("""(ids)=>[...document.querySelectorAll('.screen')].map(s=>[s.id,[...s.querySelectorAll('button,a,label,[role=button],[role=switch],input')].filter(e=>{
      if(e.matches('[data-go],[data-back],[data-sos],[data-help],[data-font]')) return false;
      if(ids.includes(e.id)) return false; if(e.tagName==='INPUT') return false;
      if(e.tagName==='LABEL' && e.htmlFor) return false;
      return true;}).map(e=>e.tagName+':'+e.textContent.trim().replace(/\\s+/g,' ').slice(0,40))])""", HANDLED_IDS)
    for s,l in res: print(s, l)
    b.close()
