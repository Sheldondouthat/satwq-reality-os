import puppeteer from 'puppeteer';
const b=await puppeteer.launch({headless:'new',executablePath:'/opt/meta-chromium/chrome',args:['--no-sandbox','--allow-file-access-from-files','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const p=await b.newPage(); await p.setViewport({width:1280,height:800});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE '+m.text().slice(0,140))});
await p.goto('file:///home/hatch/workspace/your_files/washer-twin/wtw8540bw0-digital-twin.html',{waitUntil:'networkidle0',timeout:60000});
await p.waitForFunction('window.__twin && !document.getElementById("loader").offsetParent',{timeout:30000}).catch(()=>{});
await new Promise(r=>setTimeout(r,1500));
const rep=await p.evaluate(()=>{const t=window.__twin;
  document.querySelector('[data-tab="build"]').click(); t.setAsmStep(2);
  const out={};
  for(const id of ['tub','brgLo','shifter','washplate']){
    const P=t.ASM.find(x=>x.id===id);
    const {buf,facets}=t.buildPartSTL(P);
    const dv=new DataView(buf);
    out[id]={facets, hdr:dv.getUint32(80,true), bytes:buf.byteLength, expect:84+facets*50};
  }
  out.btn=!!document.getElementById('bStl');
  return out;
});
console.log(JSON.stringify(rep,null,1));
console.log('errors:',errs.length?errs.slice(0,6):'none');
await b.close();
