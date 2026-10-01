import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage(); await p.setViewport({width:1280,height:800});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE '+m.text().slice(0,120))});
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2500));
const shot=async(name)=>{const d=await p.evaluate(()=>{const t=window.__twin;const r=t.renderer,s=t.scene,c=t.camera;r.render(s,c);return r.domElement.toDataURL('image/png')});const{writeFileSync}=await import('fs');writeFileSync('/tmp/'+name,Buffer.from(d.split(',')[1],'base64'));};
// click Bearing tab
await p.evaluate(()=>{document.querySelector('[data-tab="bearing"]').click()});
await new Promise(r=>setTimeout(r,1200)); await shot('b1-header.png');
// jump to step 6 (old bearings out) then step 8 (new bearings in)
await p.evaluate(()=>{document.querySelector('[data-bs="6"]').click()});
await new Promise(r=>setTimeout(r,1200)); await shot('b2-step7.png');
await p.evaluate(()=>{document.getElementById('bNext').click()});
await new Promise(r=>setTimeout(r,1200)); await shot('b3-step8.png');
const st=await p.evaluate(()=>({step:(document.querySelector('#panel h3')||{}).textContent, xray: !!document.getElementById('btnXray').classList.contains('on')}));
console.log('state after next:',JSON.stringify(st));
console.log('errors:',errs.length?errs.slice(0,5):'none');
await b.close();
