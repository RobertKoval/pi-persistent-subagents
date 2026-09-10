import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetricsAdapter} from '../src/metrics-adapter.ts';
import {MetricsStore} from '../src/metrics.ts';
import {DEFAULT_CONFIG} from '../src/config.ts';

it('connects nested workers to the same recorded parent actor without recording main twice',()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-nested-metrics-')),path=join(root,'m.sqlite');
  const config={...DEFAULT_CONFIG,metricsWorkers:true,metricsMain:true};
  const parent=new MetricsAdapter(path,root,'parent',config,0,()=>assert.fail('metrics error'));
  const record={id:'child',cwd:root} as any;
  const inherited=typeof parent.childIdentity==='function'?parent.childIdentity(record,'child-session'):undefined;
  const child=new MetricsAdapter(path,root,'child-session',config,1,()=>assert.fail('metrics error'),inherited);
  const observed=parent.worker(record,'child-session'),grandchild=child.worker({id:'grandchild',cwd:root} as any,'grandchild-session');
  const event={type:'message_end',message:{role:'assistant',timestamp:1,provider:'p',model:'m',stopReason:'stop',usage:{output:1}}};
  observed.event(event);child.mainEvent(event);grandchild.event(event);parent.close();child.close();
  const s=new MetricsStore(path);try{
    const r=s.report({from:0,to:Date.now()+1000});assert.equal(r.calls.length,2);
    const first=r.actors.find(a=>a.parent_worker_id===parent.main.worker_id)!;
    assert.ok(first);assert.ok(r.actors.some(a=>a.parent_worker_id===first.worker_id));
    assert.equal(r.actors.filter(a=>a.role==='main').length,1);
  }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

it('preserves an in-flight call when a settings save leaves effective tracking unchanged',()=>{
  const root=mkdtempSync(join(tmpdir(),'pi-metrics-noop-')),path=join(root,'m.sqlite');
  const adapter=new MetricsAdapter(path,root,'parent',{...DEFAULT_CONFIG,metricsWorkers:true},0,()=>assert.fail('metrics error'));
  try{
    const worker=adapter.worker({id:'w',cwd:root} as any,'worker-session');
    const message={role:'assistant',timestamp:1,provider:'p',model:'m',stopReason:'stop',usage:{output:42}};
    worker.event({type:'agent_start'});worker.event({type:'turn_start'});worker.event({type:'message_start',message});
    adapter.setTracking('worker',true);
    worker.event({type:'message_end',message});worker.event({type:'agent_settled'});adapter.close();
    const s=new MetricsStore(path);try{const calls=s.report({from:0,to:Date.now()+1000}).calls;assert.equal(calls.length,1);assert.equal(calls[0].status,'stop');assert.equal(calls[0].usage.output,42);}finally{s.close();}
  }finally{adapter.close();rmSync(root,{recursive:true,force:true});}
});
