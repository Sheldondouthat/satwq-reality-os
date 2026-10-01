import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2000));
const rep=await p.evaluate(()=>{const t=window.__twin;
  document.querySelector('[data-tab="build"]').click();
  const parts=t.ASM.map(P=>{let n=0; P.g.traverse(o=>{if(o.isMesh)n++;}); return P.id+':'+n;});
  const bg=t.ASM[1].g;
  let balls=0; bg.traverse(o=>{if(o.isMesh&&o.geometry&&o.geometry.type==='SphereGeometry')balls++;});
  // bearing extents: union of world-transformed bounding boxes
  let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
  bg.updateWorldMatrix(true,true);
  bg.traverse(o=>{ if(!o.isMesh)return; const g=o.geometry; g.computeBoundingBox(); const bb=g.boundingBox;
    for(const x of [bb.min.x,bb.max.x]) for(const y of [bb.min.y,bb.max.y]) for(const z of [bb.min.z,bb.max.z]){
      const v=new o.position.constructor(x,y,z).applyMatrix4(o.matrixWorld);
      for(let i=0;i<3;i++){mn[i]=Math.min(mn[i],v.getComponent(i));mx[i]=Math.max(mx[i],v.getComponent(i));}}});
  const size=mx.map((v,i)=>(v-mn[i]).toFixed(4));
  let beltSegs=0,beltLen=0; t.ASM[8].g.traverse(o=>{if(o.isMesh&&o.geometry.type==='TubeGeometry'){beltSegs=o.geometry.parameters.tubularSegments;}});
  // belt path sanity: distance between first/last curve points ~0 (closed)
  return {parts, balls, brgSize:size, beltSegs};
});
console.log(JSON.stringify(rep));
console.log('errors:',errs.length?errs:'none');
await b.close();
