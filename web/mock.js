(function(){
  const store={}; const subs=[];
  function notify(){ subs.forEach(f=>f()); }
  function mkDocSnap(path){ const v=store[path]; return {id:path.split('/').pop(), exists:!!v, data:()=>v?Object.freeze(JSON.parse(JSON.stringify(v))):undefined, metadata:{}}; }
  function query(col, filters){
    const run=()=>{ const docs=Object.keys(store).filter(k=>k.startsWith(col+'/')&&k.split('/').length===col.split('/').length+1).map(mkDocSnap).filter(d=>filters.every(([f,op,v])=>d.data()[f]===v)); return {docs,size:docs.length,empty:!docs.length,docChanges:()=>[],metadata:{}}; };
    return { where:(f,op,v)=>query(col,[...filters,[f,op,v]]), orderBy(){return this}, limit(){return this}, get:async()=>run(),
      onSnapshot(fn){ const f=()=>fn(run()); subs.push(f); setTimeout(f,0); return ()=>{}; } };
  }
  let n=0;
  const db={ collection(col){ const q=query(col,[]); return Object.assign(q,{path:col, doc:(id)=>db.doc(col+'/'+(id||('d'+(++n)))), add:async(d)=>{const p=col+'/a'+(++n); store[p]=d; setTimeout(notify,0); return db.doc(p);} }); },
    doc(path){ return { id:path.split('/').pop(), path, get:async()=>mkDocSnap(path), set:async(d)=>{store[path]=d; setTimeout(notify,0);}, update:async(d)=>{store[path]=Object.assign(store[path]||{},d); setTimeout(notify,0);}, delete:async()=>{delete store[path]; setTimeout(notify,0);}, onSnapshot(fn){ const f=()=>fn(mkDocSnap(path)); subs.push(f); setTimeout(f,0); return ()=>{}; } }; } };
  const sample=async()=>({text:''}); sample.json=async(p,o)=>{ window.__sampled=o&&o.images; return {name:'Metformin',dosage:'500 mg',frequency:'Morning / Night',durationDays:30,physician:'Dr. Rao',instructions:'Take after meals'}; }; sample.limits=async()=>({maxPromptBytes:1e6,images:{maxCount:4,maxInputBytes:5e6,mediaTypes:['image/png']}});
  const user={ id:async()=>'u1', isOwner:()=>true };
  window.__store=store;
  window.claude={ use:async(n)=>({db,sample,user}[n]||null) };
})();
