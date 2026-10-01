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
for(const [step,name] of [[1,'c1-bearing.png'],[5,'c2-shaft.png'],[6,'c3-gearcase.png']]){
  await p.evaluate(s=>{window.__twin.setAsmStep(s)},step);
  await new Promise(r=>setTimeout(r,6000)); await shot(name);
}
console.log('errors:',errs.length?errs.slice(0,6):'none');
await b.close();
