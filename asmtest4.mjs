import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage(); await p.setViewport({width:1280,height:800});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE '+m.text().slice(0,140))});
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2500));
const shot=async(name)=>{const d=await p.evaluate(()=>{const t=window.__twin;const r=t.renderer,s=t.scene,c=t.camera;r.render(s,c);return r.domElement.toDataURL('image/png')});const{writeFileSync}=await import('fs');writeFileSync('/tmp/'+name,Buffer.from(d.split(',')[1],'base64'));};
await p.evaluate(()=>{document.querySelector('[data-tab="build"]').click()});
await new Promise(r=>setTimeout(r,800));
await p.evaluate(()=>{window.__twin.setAsmStep(1)});
await new Promise(r=>setTimeout(r,6000)); await shot('d1-bearing.png');
// DOM panel screenshot for the Build tab UI
await p.screenshot({path:'/tmp/d2-panel.png'});
console.log('errors:',errs.length?errs.slice(0,6):'none');
await b.close();
