/** Wave 6 — IMO Meteor Shower Calendar (keyless, static list per IMO). */
const SHOWERS = [
  {name:'Quadrantids',peak:'2026-01-03',active:'2026-12-28/2026-01-07',zhr:110},
  {name:'Perseids',peak:'2026-08-13',active:'2026-07-17/2026-08-24',zhr:100},
  {name:'Geminids',peak:'2026-12-14',active:'2026-12-07/2026-12-17',zhr:120}
];
function sendJson(res,status,body,cache='public, max-age=86400'){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':cache});res.end(JSON.stringify(body));}
export function meteorShowersProxy(){async function handler(req,res){if(req.method!=='GET')return sendJson(res,405,{error:'method_not_allowed'},'no-store');const now=new Date();const next=SHOWERS.map(s=>({name:s.name,peak:s.peak,active:s.active,zhr:s.zhr,daysToPeak:Math.floor((new Date(s.peak+'T00:00:00Z')-now)/86400000)})).sort((a,b)=>a.daysToPeak-b.daysToPeak);sendJson(res,200,{generatedAt:now.toISOString(),count:next.length,showers:next,source:'IMO Meteor Shower Calendar (static keyless)'})}return {name:'meteor-showers',configureServer({middlewares}){middlewares.use('/api/meteor-showers',handler)},configurePreviewServer({middlewares}){middlewares.use('/api/meteor-showers',handler)};}
