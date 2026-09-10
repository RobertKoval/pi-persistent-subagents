import { randomUUID } from 'node:crypto';
import { MetricsStore, MetricsRecorder, metricId, metricsIdentity, type MetricIdentity } from './metrics.ts';
import type { PersistentSubagentConfig } from './config.ts';
import type { WorkerRecord } from './registry.ts';

/** The parent observes child RPC once. Child extensions never track themselves as main. */
export class MetricsAdapter {
  private store:MetricsStore|null=null;
  private recorders=new Map<string,MetricsRecorder>();
  private failed=false;
  private parentTask:string|null=null;
  readonly main:MetricIdentity;
  constructor(privatePath:string, cwd:string, sessionId:string, config:PersistentSubagentConfig, depth:number, warn:()=>void, inherited?:MetricIdentity) {
    this.path=privatePath;this.config=config;this.depth=depth;this.warn=warn;
    this.main=inherited?{...inherited,session_id:metricId('session',sessionId)}:metricsIdentity(cwd,sessionId);
  }
  private path:string;private config:PersistentSubagentConfig;private depth:number;private warn:()=>void;
  private database(){return this.store??=new MetricsStore(this.path);}
  private enabled(role:'main'|'worker'){return role==='main'?this.depth===0&&this.config.metricsMain:this.config.metricsWorkers;}
  private observe(identity:MetricIdentity,event:any,model?:{provider?:string;model?:string;api?:string}){
    if(event.type==='agent_end')return; // Pi emits agent_settled after retries/compaction, unlike individual runs.
    if(this.failed||!this.enabled(identity.role))return;
    try {
      let recorder=this.recorders.get(identity.worker_id);
      if(!recorder){
        this.database().actor(this.main);
        recorder=new MetricsRecorder(this.database(),identity,Date.now,{parentTaskId:()=>identity.role==='worker'?this.parentTask:null,taskId:()=>identity.role==='main'?this.parentTask:null});
        if(model)recorder.event({type:'metrics_selection',metricsModel:model});
        this.recorders.set(identity.worker_id,recorder);
      }
      recorder.event(event);
    } catch { this.failed=true;this.warn(); }
  }
  mainEvent(event:any,model?:{provider?:string;model?:string;api?:string}){
    if(event.type==='agent_start')this.parentTask??=randomUUID();
    if(this.depth===0)this.observe(this.main,event.type==='session_before_compact'?{...event,metricsModel:model}:event,model);
    this.parentTask=this.recorders.get(this.main.worker_id)?.taskId??this.parentTask;
    if(event.type==='agent_settled')this.parentTask=null;
  }
  childIdentity(record:WorkerRecord, sessionId?:string):MetricIdentity{
    const identity=metricsIdentity(record.cwd,this.main.session_id,record.id);
    identity.parent_worker_id=this.main.worker_id;
    identity.session_id=metricId('session',sessionId??metricId('worker-session',this.main.session_id,record.id));
    return identity;
  }
  worker(record:WorkerRecord,sessionId?:string,api?:string){
    const identity=this.childIdentity(record,sessionId);
    return {event:(event:any)=>this.observe(identity,event,{provider:record.provider,model:record.model,api}),close:()=>this.closeRecorder(identity.worker_id)};
  }
  setTracking(role:'main'|'worker',enabled:boolean){
    if(role==='main')this.config.metricsMain=enabled;else this.config.metricsWorkers=enabled;
    // Close at toggle time; re-enabling starts a new observation, never backfills an unknown interval.
    for(const [id,recorder] of this.recorders)if((id===this.main.worker_id)===(role==='main')){recorder.close();this.recorders.delete(id);}
  }
  private closeRecorder(id:string){const r=this.recorders.get(id);if(r){try{r.close();}catch{this.warn();}this.recorders.delete(id);}}
  close(){for(const id of this.recorders.keys())this.closeRecorder(id);this.store?.close();this.store=null;}
}

export function inheritedMetricsIdentity(raw:string|undefined):MetricIdentity|undefined {
  if(!raw)return;
  try {
    const i=JSON.parse(raw);const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    if(!hash(i.project_id)||!hash(i.session_id)||!hash(i.worker_id)||!hash(i.parent_worker_id)||i.role!=='worker')return;
    return {project_id:i.project_id,project:`project-${i.project_id.slice(0,10)}`,session_id:i.session_id,worker_id:i.worker_id,parent_worker_id:i.parent_worker_id,role:'worker'};
  }catch{return;}
}
