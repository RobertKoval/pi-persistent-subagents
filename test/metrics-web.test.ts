import {it} from 'node:test';
import {get} from 'node:http';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startMetricsPanel} from '../src/metrics-web.ts';
import {MetricsStore,MetricsRecorder,metricsIdentity} from '../src/metrics.ts';

it('malformed unauthenticated request cannot terminate the owning Pi process',()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-panel-bad-url-'));
  try{
    const module=new URL('../src/metrics-web.ts',import.meta.url).href;
    const code=`import {startMetricsPanel} from ${JSON.stringify(module)};import {get} from 'node:http';
      const p=await startMetricsPanel(process.argv[1],{getSettings:()=>({workers:true,main:false}),setTracking:async()=>{}});
      const u=new URL(p.url);const status=await new Promise((resolve,reject)=>get({host:u.hostname,port:u.port,path:'//['},r=>{r.resume();resolve(r.statusCode)}).on('error',reject));
      await p.close();if(status!==400)throw new Error('Expected 400, got '+status);`;
    const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,join(root,'m.sqlite')],{timeout:5000,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  }finally{rmSync(root,{recursive:true,force:true});}
});

it('serves a private local panel, filtered JSON/CSV, and validated tracking switches',async()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-panel-')),path=join(root,'m.sqlite');
  const store=new MetricsStore(path),r=new MetricsRecorder(store,metricsIdentity('/p','s','w'));
  r.event({type:'message_end',message:{role:'assistant',timestamp:1,provider:'provider',model:'@preset/test',usage:{input:1,output:2},stopReason:'stop'}});r.close();store.close();
  const settings={workers:true,main:false};
  let savedScope:string|undefined;
  const panel=await startMetricsPanel(path,{getSettings:()=>settings,setTracking:async(role,enabled,scope)=>{settings[role]=enabled;savedScope=scope;}});
  try {
    const base=new URL(panel.url);assert.equal(base.hostname,'127.0.0.1');
    assert.equal((await fetch(base.origin+'/api')).status,403);
    const badHost=await new Promise(resolve=>get(panel.url,{headers:{host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);}));
    assert.equal(badHost,403);
    const unicode=new URL(panel.url);unicode.searchParams.set('token','ю'.repeat(48));assert.equal((await fetch(unicode)).status,403);
    assert.equal((await fetch(panel.url)).status,200);
    const url=(pathname:string)=>{const u=new URL(panel.url);u.pathname=pathname;return u;};
    const api=url('/api');api.searchParams.set('from','0');api.searchParams.set('to',String(Date.now()+1000));
    const report=await (await fetch(api)).json();assert.equal(report.calls.length,1);
    api.searchParams.set('role','main');assert.equal((await (await fetch(api)).json()).calls.length,0);
    const exp=url('/export.csv');exp.searchParams.set('from','0');exp.searchParams.set('to',String(Date.now()+1000));
    const csv=await (await fetch(exp)).text();assert.match(csv,/project_id/);assert.match(csv,/'@preset\/test/);
    const setting=url('/settings');
    assert.equal((await fetch(setting,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'main',enabled:true,scope:'global'})})).status,200);
    assert.equal(settings.main,true);
    assert.equal(savedScope,'global');
    assert.equal((await fetch(setting,{method:'POST',body:JSON.stringify({role:'main',enabled:false,scope:'invalid'})})).status,400);
    assert.equal(settings.main,true);
    assert.equal((await fetch(setting,{method:'POST',body:JSON.stringify({role:'workers',enabled:'false'})})).status,400);
    assert.equal(settings.workers,true);
    api.searchParams.set('from','nonsense');assert.equal((await fetch(api)).status,400);
  }finally{await panel.close();rmSync(root,{recursive:true,force:true});}
});
