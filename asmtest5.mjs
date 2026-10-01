import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage(); await p.setViewport({width:900,height:900});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,2500));
await p.evaluate(()=>{const t=window.__twin;
  document.querySelector('[data-tab="build"]').click();
  t.setAsmStep(1);
  t.ASM[0].g.visible=false; // hide tub for the close-up
  t.camera.position.set(0.16,0.44,0.22); t.scene.children; });
await new Promise(r=>setTimeout(r,1500));
await p.evaluate(()=>{const t=window.__twin; t.camera.lookAt(0,0.352,0);
  const d=t.renderer.domElement.toDataURL('image/png');
  return d;}).then(async d=>{const{writeFileSync}=await import('fs');writeFileSync('/tmp/e1-bearing-macro.png',Buffer.from(d.split(',')[1],'base64'));});
console.log('errors:',errs.length?errs:'none');
await b.close();
