import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MetricsStore, type MetricFilter } from './metrics.ts';

export interface PanelSettings {
  getSettings():{workers:boolean;main:boolean};
  setTracking(role:'workers'|'main',enabled:boolean):Promise<void>;
}
export interface MetricsPanel {url:string;close():Promise<void>}
export async function startMetricsPanel(path:string,settings:PanelSettings):Promise<MetricsPanel> {
  const store=new MetricsStore(path),token=randomBytes(24).toString('hex');
  const html=readFileSync(new URL('./metrics-panel.html',import.meta.url),'utf8').replaceAll('__NONCE__',token);
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${token}'; style-src 'nonce-${token}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    const send=(status:number,body:string,type='application/json')=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
    let url:URL;
    try{url=new URL(req.url??'/', 'http://127.0.0.1');}catch{send(400,'{"error":"Invalid URL"}');return;}
    const provided=url.searchParams.get('token')??'';
    if(!/^127\.0\.0\.1:\d+$/.test(req.headers.host??'')||Buffer.byteLength(provided)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(provided),Buffer.from(token))){send(403,'{"error":"Forbidden"}');return;}
    try {
      if(req.method==='POST'&&url.pathname==='/settings'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>1024){send(413,'{"error":"Too large"}');return;}}
        const data=JSON.parse(body);
        if(!data||!['workers','main'].includes(data.role)||typeof data.enabled!=='boolean'||Object.keys(data).some(k=>!['role','enabled'].includes(k))){send(400,'{"error":"Invalid settings"}');return;}
        await settings.setTracking(data.role,data.enabled);send(200,JSON.stringify(settings.getSettings()));return;
      }
      if(req.method!=='GET'){send(405,'{"error":"Method not allowed"}');return;}
      if(url.pathname==='/'){send(200,html,'text/html; charset=utf-8');return;}
      if(!['/api','/export.json','/export.csv'].includes(url.pathname)){send(404,'{"error":"Not found"}');return;}
      const to=Number(url.searchParams.get('to')??Date.now()),from=Number(url.searchParams.get('from')??to-30*86400000);
      const role=url.searchParams.get('role')||undefined;
      if(!Number.isFinite(to)||!Number.isFinite(from)||from<0||to<from||to>8640000000000000||(role&&!['main','worker'].includes(role))){send(400,'{"error":"Invalid filter"}');return;}
      const filter:MetricFilter={from,to,role:role as MetricFilter['role']};
      for(const k of ['project','worker','session','provider','model'] as const)filter[k]=url.searchParams.get(k)||undefined;
      const report=store.report(filter);
      if(url.pathname==='/export.csv'){
        res.setHeader('Content-Disposition','attachment; filename="pi-metrics-calls.csv"');
        const fields=['project_id','session_id','worker_id','parent_worker_id','task_id','role','provider','model','start_ms','end_ms','status','input','output','cacheRead','cacheWrite','reasoning','model_ms','stream_ms','observed_tps','api_equivalent','tariff_source','price_timestamp_ms'];
        const escape=(v:unknown)=>{let s=v==null?'':String(v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
        const rows=report.calls.map(c=>({...c,...c.usage,api_equivalent:c.price?.total,tariff_source:c.price?.source,price_timestamp_ms:c.price?.timestamp_ms}));
        send(200,[fields.map(escape).join(','),...rows.map(r=>fields.map(k=>escape(r[k])).join(','))].join('\r\n'),'text/csv; charset=utf-8');return;
      }
      if(url.pathname==='/export.json')res.setHeader('Content-Disposition','attachment; filename="pi-metrics.json"');
      send(200,JSON.stringify({...report,settings:settings.getSettings()}));
    }catch{send(500,'{"error":"Metrics operation failed; no report was returned"}');}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});}
  catch(error){store.close();throw error;}
  const address=server.address();if(!address||typeof address==='string')throw new Error('No panel address');
  return {url:`http://127.0.0.1:${address.port}/?token=${token}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>{store.close();error?reject(error):resolve();});server.closeAllConnections();})};
}
