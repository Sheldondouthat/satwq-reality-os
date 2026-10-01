import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage(); await p.setViewport({width:1280,height:800});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE '+m.text().slice(0,140))});
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2500));
const shot=async(name)=>{const d=await p.evaluate(()=>{const t=window.__twin;const r=t.renderer,s=t.scene,c=t.camera;r.render(s,c);return r.domElement.toDataURL('image/png')});const{writeFileSync}=await import('fs');writeFileSync('/tmp/'+name,Buffer.from(d.split(',')[1],'base64'));};
const info=await p.evaluate(()=>({nparts:window.__twin.ASM.length, gAsm:!!window.__twin.gAsm}));
console.log('ASM parts:',JSON.stringify(info));
// enter Build tab
await p.evaluate(()=>{document.querySelector('[data-tab="build"]').click()});
await new Promise(r=>setTimeout(r,1500)); await shot('a1-tub.png');
// step to bearings (part 2)
await p.evaluate(()=>{window.__twin.setAsmStep(1)});
await new Promise(r=>setTimeout(r,1500)); await shot('a2-bearing.png');
// step to belt (index 8)
await p.evaluate(()=>{window.__twin.setAsmStep(8)});
await new Promise(r=>setTimeout(r,1500)); await shot('a3-belt.png');
// full assembly (index 13)
await p.evaluate(()=>{window.__twin.setAsmStep(13)});
await new Promise(r=>setTimeout(r,1500)); await shot('a4-full.png');
const st=await p.evaluate(()=>({asmCur:(document.querySelector('#panel h3')||{textContent:''}).textContent.slice(0,60)}));
console.log('panel:',JSON.stringify(st));
console.log('errors:',errs.length?errs.slice(0,6):'none');
await b.close();
