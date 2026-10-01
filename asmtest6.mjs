import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2000));
const rep=await p.evaluate(()=>{const t=window.__twin;
  document.querySelector('[data-tab="build"]').click();
  const out=t.ASM.map(P=>{let n=0; P.g.traverse(o=>{if(o.isMesh)n++;});
    const bb=new (Object.getPrototypeOf(t.scene).constructor)(); // unused
    return {id:P.id, meshes:n};});
  // bearing bounding box
  const bg=t.ASM[1].g; const box=new THREE.Box3().setFromObject(bg);
  const s=box.getSize(new THREE.Vector3());
  // ball count check
  let balls=0; bg.traverse(o=>{if(o.isMesh&&o.geometry&&o.geometry.type==='SphereGeometry')balls++;});
  // belt: check tube geometry exists and is closed-ish (point count)
  let beltPts=0; t.ASM[8].g.traverse(o=>{if(o.isMesh&&o.geometry.type==='TubeGeometry')beltPts=o.geometry.parameters.tubularSegments;});
  return {parts:out, brgSize:[s.x.toFixed(4),s.y.toFixed(4),s.z.toFixed(4)], balls, beltSegs:beltPts};
});
console.log(JSON.stringify(rep,null,1));
console.log('errors:',errs.length?errs:'none');
await b.close();
