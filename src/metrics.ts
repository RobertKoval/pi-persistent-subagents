import { cacheInput, cacheRatio, cacheSemantics } from './metrics-cache.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type MetricRole = 'main' | 'worker';
export interface MetricIdentity {
  project_id: string; project: string; session_id: string; worker_id: string;
  parent_worker_id: string | null; role: MetricRole;
}
export const metricId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function metricsIdentity(cwd: string, session: string, worker = 'main', parent?: string): MetricIdentity {
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch { /* A removed project still has a stable lexical identity. */ }
  const project_id = metricId('project', canonical);
  return { project_id, project: `project-${project_id.slice(0, 10)}`, session_id: metricId('session', session),
    worker_id: metricId('worker', session, worker), parent_worker_id: parent ? metricId('worker', session, parent) : null,
    role: worker === 'main' ? 'main' : 'worker' };
}
function label(value: unknown): string {
  return typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9@][a-zA-Z0-9@._:/-]*$/.test(value)
    && !value.includes('://') && !/(?:sk-|api[_-]?key|secret|token=)/i.test(value) ? value : 'unknown';
}
function num(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
export type NumericUsage = Partial<Record<'input'|'output'|'cacheRead'|'cacheWrite'|'cacheWrite1h'|'reasoning'|'totalTokens', number>> & { cost?: Record<string, number> };
function numericUsage(raw: any): NumericUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage: NumericUsage = {};
  for (const key of ['input','output','cacheRead','cacheWrite','cacheWrite1h','reasoning','totalTokens'] as const) {
    const n = num(raw[key]); if (n !== null) usage[key] = n;
  }
  if (raw.cost && typeof raw.cost === 'object') {
    usage.cost = {};
    for (const key of ['input','output','cacheRead','cacheWrite','total']) { const n=num(raw.cost[key]); if(n!==null) usage.cost[key]=n; }
  }
  return usage;
}
type Status = 'running'|'stop'|'toolUse'|'length'|'error'|'aborted'|'interrupted'|'deferred'|'unknown';
type Span = {id:string; worker_id:string; task_id:string|null; kind:'model'|'tool'|'task'; start_ms:number|null; end_ms:number|null; status:Status; data:Record<string,any>};
export type MetricFilter = {from:number;to:number;project?:string;worker?:string;session?:string;role?:MetricRole;provider?:string;model?:string};
type Interval = {start:number;end:number};

/** Durations use half-open intervals; percentiles are weighted by elapsed time, not events. */
export function concurrency(intervals: Interval[], from: number, to: number) {
  const changes = new Map<number,number>([[from,0],[to,0]]);
  for (const i of intervals) {
    const start=Math.max(from,i.start), end=Math.min(to,i.end);
    if (end<=start) continue;
    changes.set(start,(changes.get(start)??0)+1); changes.set(end,(changes.get(end)??0)-1);
  }
  let count=0, previous=from, area=0, peak=0;
  const durations=new Map<number,number>(); const timeline: {start:number;end:number;concurrency:number}[]=[];
  for (const [time,delta] of [...changes].sort((a,b)=>a[0]-b[0])) {
    if(time>previous) { const ms=time-previous; durations.set(count,(durations.get(count)??0)+ms); area+=count*ms; peak=Math.max(peak,count); timeline.push({start:previous,end:time,concurrency:count}); }
    count+=delta; previous=time;
  }
  const distribution=[...durations].sort((a,b)=>a[0]-b[0]).map(([concurrency,ms])=>({concurrency,ms}));
  let accumulated=0, p95=0;
  for(const row of distribution) { accumulated+=row.ms; p95=row.concurrency; if(accumulated >= (to-from)*.95) break; }
  return {average:to>from?area/(to-from):null,peak,p95:to>from?p95:null,active_ms:Math.max(0,to-from)-(durations.get(0)??0),distribution,timeline};
}
const intervals = (rows: {start_ms:number|null;end_ms:number|null}[]): Interval[] => rows.flatMap(r=>r.start_ms!==null&&r.end_ms!==null&&r.end_ms>=r.start_ms?[{start:r.start_ms,end:r.end_ms}]:[]);
const unionMs = (rows: {start_ms:number|null;end_ms:number|null}[], from:number,to:number) => concurrency(intervals(rows),from,to).active_ms;
const percentile = (values:number[], p:number) => values.length ? [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)] : null;

export class MetricsStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    chmodSync(path,0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS metric_actors (
      worker_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project TEXT NOT NULL, session_id TEXT NOT NULL,
      parent_worker_id TEXT, role TEXT NOT NULL CHECK(role IN ('main','worker')));
      CREATE TABLE IF NOT EXISTS metric_spans (
      id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('model','tool','task')),
      start_ms REAL, end_ms REAL, status TEXT NOT NULL, data TEXT NOT NULL,
      CHECK(end_ms IS NULL OR start_ms IS NULL OR end_ms>=start_ms));
      CREATE INDEX IF NOT EXISTS metric_time ON metric_spans(end_ms,start_ms);
      CREATE INDEX IF NOT EXISTS metric_worker ON metric_spans(worker_id);`);
    for(const suffix of ['-wal','-shm'])chmodSync(path+suffix,0o600);
  }
  actor(i:MetricIdentity) {
    this.db.prepare('INSERT OR IGNORE INTO metric_actors VALUES(?,?,?,?,?,?)').run(i.worker_id,i.project_id,label(i.project),i.session_id,i.parent_worker_id,i.role);
  }
  bindTask(oldId:string,newId:string) {
    if(oldId===newId)return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO metric_spans SELECT ?,worker_id,task_id,kind,start_ms,end_ms,status,data FROM metric_spans WHERE id=?').run(newId,oldId);
      this.db.prepare('UPDATE metric_spans SET task_id=? WHERE task_id=?').run(newId,oldId);
      this.db.prepare("UPDATE metric_spans SET data=json_set(data,'$.parent_task_id',?) WHERE json_extract(data,'$.parent_task_id')=?").run(newId,oldId);
      this.db.prepare('DELETE FROM metric_spans WHERE id=?').run(oldId);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  discardOpen(id:string) {this.db.prepare("DELETE FROM metric_spans WHERE id=? AND status='running'").run(id);}
  hasFinal(id:string):boolean { return !!this.db.prepare("SELECT 1 FROM metric_spans WHERE id=? AND status!='running'").get(id); }
  put(s:Span) {
    this.db.prepare(`INSERT INTO metric_spans VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      end_ms=excluded.end_ms,status=excluded.status,data=excluded.data
      WHERE metric_spans.status='running'`).run(s.id,s.worker_id,s.task_id,s.kind,s.start_ms,s.end_ms,s.status,JSON.stringify(s.data));
  }
  report(filter:MetricFilter) {
    if(!Number.isFinite(filter.from)||!Number.isFinite(filter.to)||filter.to<filter.from) throw new Error('Invalid time range');
    const all=this.db.prepare(`SELECT s.*,a.project_id,a.project,a.session_id,a.parent_worker_id,a.role FROM metric_spans s
      JOIN metric_actors a USING(worker_id) WHERE (s.start_ms IS NULL OR s.start_ms < ?) AND (s.end_ms IS NULL OR s.end_ms >= ?)`)
      .all(filter.to,filter.from).map((raw:any)=>({...raw,...JSON.parse(raw.data),data:undefined})) as any[];
    const scoped=all.filter(r=>(!filter.project||r.project_id===filter.project)&&(!filter.worker||r.worker_id===filter.worker)&&(!filter.session||r.session_id===filter.session)&&(!filter.role||r.role===filter.role));
    const calls=scoped.filter(r=>r.kind==='model'&&r.operation!=='compaction'&&(!filter.provider||r.provider===filter.provider)&&(!filter.model||r.model===filter.model)).map(r=>{
      const stream=r.first_fragment_ms!==null&&r.last_fragment_ms!==null?r.last_fragment_ms-r.first_fragment_ms:null;
      return {...r,model_ms:r.start_ms!==null&&r.end_ms!==null?r.end_ms-r.start_ms:null,
        observed_tps:stream!==null&&stream>0&&r.usage?.output!==undefined?r.usage.output/(stream/1000):null,
        stream_ms:stream,ttff_ms:r.first_fragment_ms!==null&&r.start_ms!==null?r.first_fragment_ms-r.start_ms:null,
        cache_hit_ratio:cacheRatio(r.usage,r.cache_semantics)};
    });
    const compactions=scoped.filter(r=>r.operation==='compaction'&&(!filter.provider||r.provider===filter.provider)&&(!filter.model||r.model===filter.model)).map(r=>({...r,operation_ms:r.start_ms!==null&&r.end_ms!==null?r.end_ms-r.start_ms:null,model_ms:null,observed_tps:null,cache_hit_ratio:cacheRatio(r.usage,r.cache_semantics)}));
    const retries=scoped.filter(r=>r.operation==='retry'&&(!filter.provider||r.provider===filter.provider)&&(!filter.model||r.model===filter.model));
    const taskIds=new Set([...calls,...compactions].map(r=>r.task_id));
    const tasks=scoped.filter(r=>r.kind==='task'&&(!(filter.provider||filter.model)||taskIds.has(r.id))).map(t=>{
      const models=calls.filter(c=>c.task_id===t.id), tools=scoped.filter(c=>c.kind==='tool'&&c.operation!=='retry'&&c.task_id===t.id);
      const maintenance=compactions.filter(c=>c.task_id===t.id),backoffs=retries.filter(c=>c.task_id===t.id);
      const start=t.start_ms!==null?Math.max(t.start_ms,filter.from):null;
      const end=t.end_ms!==null?Math.min(t.end_ms,filter.to):null, wall=end!==null&&start!==null?Math.max(0,end-start):null;
      return {...t,wall_ms:wall,model_ms:wall!==null?unionMs(models,start!,end!):null,
        tool_ms:wall!==null?unionMs(tools.filter(x=>x.tool!=='wait_agent'),start!,end!):null,
        wait_ms:wall!==null?unionMs(tools.filter(x=>x.tool==='wait_agent'),start!,end!):null,
        retry_ms:wall!==null?unionMs(backoffs,start!,end!):null,
        compaction_ms:wall!==null?unionMs(maintenance,start!,end!):null,
        other_ms:wall!==null?wall-unionMs([...models,...tools,...maintenance,...backoffs],start!,end!):null,
        duty_cycle:wall!==null&&wall>0?unionMs(models,start!,end!)/wall:null};
    });
    const concurrent=concurrency(intervals(calls),filter.from,filter.to);
    const groups=new Map<string,any>();
    const group=(r:any,day:string)=>{
      const key=JSON.stringify([r.project_id,day]);
      if(!groups.has(key)) groups.set(key,{project_id:r.project_id,project:r.project,day,input:0,output:0,cache_read:0,cache_write:0,model_calls:0,compactions:0,retries:0,retry_ms:0,compaction_ms:0,cache_ratio_unavailable:0,cache_ratio_input:0,cache_ratio_read:0,model_call_ms:0,worker_hours:0,api_equivalent:0,unpriced_calls:0,missing_usage_calls:0,stream_output:0,stream_ms:0,reported:{input:0,output:0,cache_read:0,cache_write:0,api_equivalent:0}});
      return groups.get(key)!;
    };
    const split=(start:number,end:number,visit:(day:string,ms:number)=>void)=>{
      let at=Math.max(start,filter.from);const last=Math.min(end,filter.to);
      while(at<last) {const day=new Date(at).toISOString().slice(0,10),next=Math.min(last,Date.parse(day)+86400000);visit(day,next-at);at=next;}
    };
    for(const c of [...calls,...compactions]) {
      if(c.start_ms!==null&&c.end_ms!==null) split(c.start_ms,c.end_ms,(day,ms)=>group(c,day)[c.operation==='compaction'?'compaction_ms':'model_call_ms']+=ms);
      // Token and cost counters belong to the completion day. Never prorate unknown token timing.
      if(c.end_ms===null||c.end_ms<filter.from||c.end_ms>=filter.to) continue;
      const g=group(c,new Date(c.end_ms).toISOString().slice(0,10));g[c.operation==='compaction'?'compactions':'model_calls']++;
      const cacheTokens=cacheInput(c.usage,c.cache_semantics);
      if(cacheTokens===null)g.cache_ratio_unavailable++;else{g.cache_ratio_input+=cacheTokens;g.cache_ratio_read+=c.usage.cacheRead;}
      for(const [field,raw] of [['input','input'],['output','output'],['cache_read','cacheRead'],['cache_write','cacheWrite']])if(c.usage?.[raw]!==undefined)g.reported[field]++;
      if(c.price?.total!==null&&c.price?.total!==undefined)g.reported.api_equivalent++;
      g.input+=c.usage?.input??0;g.output+=c.usage?.output??0;g.cache_read+=c.usage?.cacheRead??0;g.cache_write+=c.usage?.cacheWrite??0;
      if(!c.usage||['input','output','cacheRead','cacheWrite'].some(k=>c.usage[k]===undefined))g.missing_usage_calls++;
      if(c.price?.total!==null&&c.price?.total!==undefined)g.api_equivalent+=c.price.total;else g.unpriced_calls++;
      if(c.observed_tps!==null){g.stream_output+=c.usage.output;g.stream_ms+=c.stream_ms;}
    }
    for(const r of retries){
      if(r.start_ms!==null&&r.end_ms!==null)split(r.start_ms,r.end_ms,(day,ms)=>group(r,day).retry_ms+=ms);
      if(r.start_ms!==null&&r.start_ms>=filter.from&&r.start_ms<filter.to)group(r,new Date(r.start_ms).toISOString().slice(0,10)).retries++;
    }
    for(const t of tasks)if(t.role==='worker'&&t.start_ms!==null&&t.end_ms!==null)split(t.start_ms,t.end_ms,(day,ms)=>group(t,day).worker_hours+=ms/3600000);
    const daily=[...groups.values()].map(g=>{for(const field of ['input','output','cache_read','cache_write','api_equivalent'])if(g.model_calls+g.compactions>0&&g.reported[field]===0)g[field]=null;return {...g,cache_hit_ratio:g.cache_ratio_unavailable===0&&g.cache_ratio_input>0?g.cache_ratio_read/g.cache_ratio_input:null,observed_tps:g.stream_ms>0?g.stream_output/(g.stream_ms/1000):null};}).sort((a,b)=>a.day.localeCompare(b.day)||a.project_id.localeCompare(b.project_id));
    const complete=calls.filter(c=>c.end_ms!==null&&c.end_ms>=filter.from&&c.end_ms<filter.to);
    const allComplete=[...complete,...compactions.filter(c=>c.end_ms!==null&&c.end_ms>=filter.from&&c.end_ms<filter.to)];
    const measurable=complete.filter(c=>c.start_ms!==null&&c.start_ms>=filter.from&&c.usage?.output!==undefined);
    const measuredActive=concurrency(intervals(measurable),filter.from,filter.to).active_ms;
    const workerIntervals=new Map<string,Interval[]>();
    for(const c of calls.filter(c=>c.role==='worker'))workerIntervals.set(c.worker_id,[...(workerIntervals.get(c.worker_id)??[]),...intervals([c])]);
    const mergedWorkers=[...workerIntervals.values()].flatMap(list=>concurrency(list,filter.from,filter.to).timeline.filter(i=>i.concurrency>0).map(({start,end})=>({start,end})));
    const wall=tasks.reduce((n,t)=>n+(t.wall_ms??0),0),model=tasks.reduce((n,t)=>n+(t.model_ms??0),0);
    return {filter,methodology:{timezone:'UTC',tokens:'completion day; missing usage is not zero',model_time:'observed turn_start to message_end; includes client/provider wait, not server decode',throughput:'output tokens / (last fragment - first fragment), including thinking/tool fragments',concurrency:'time weighted over selected interval; completed observable calls only',worker_hours:'sum of task wall time for workers; excludes idle resident processes',cost:'Pi API-equivalent estimate; immutable per-call snapshot, not a bill',cache_ratio:'cacheRead / (input + cacheRead + cacheWrite) for stamped Pi 0.85 OpenAI/Codex/Anthropic adapters; otherwise N/A',coverage:'assistant attempts and reported compaction usage; compaction intervals are operations, not individual model calls. Worker retry backoff is observable; main backoff and hidden HTTP retries are not'},
      actors:this.db.prepare('SELECT * FROM metric_actors').all(),calls,compactions,retries,tasks,tools:scoped.filter(r=>r.kind==='tool'&&r.operation!=='retry'),daily,concurrency:concurrent,
      capacity:{output_tokens:allComplete.length&&!allComplete.some(c=>c.usage?.output!==undefined)?null:allComplete.reduce((n,c)=>n+(c.usage?.output??0),0),model_call_hours:daily.reduce((n,g)=>n+g.model_call_ms,0)/3600000,
        generation_duty_cycle:wall>0?model/wall:null,average_concurrency:concurrent.average,peak_concurrency:concurrent.peak,p95_concurrency:concurrent.p95,
        p50_observed_tps:percentile(complete.flatMap(c=>c.observed_tps===null?[]:[c.observed_tps]),.5),p95_observed_tps:percentile(complete.flatMap(c=>c.observed_tps===null?[]:[c.observed_tps]),.95),
        peak_generating_workers:concurrency(mergedWorkers,filter.from,filter.to).peak,
        required_aggregate_tps:measuredActive>0?measurable.reduce((n,c)=>n+c.usage.output,0)/(measuredActive/1000):null,
        aggregate_tps_method:'output / union of model-call intervals for completed calls wholly inside range with reported output; not hardware sizing or decode TPS',
        compactions:compactions.length,retries:retries.length,compaction_hours:daily.reduce((n,g)=>n+g.compaction_ms,0)/3600000,retry_hours:daily.reduce((n,g)=>n+g.retry_ms,0)/3600000,
        incomplete_compactions:compactions.filter(c=>c.end_ms===null).length,
        incomplete_calls:calls.filter(c=>c.end_ms===null).length,missing_usage_calls:allComplete.filter(c=>!c.usage||c.usage.output===undefined).length}};
  }
  close(){this.db.close();}
}

/** Only allowlisted numeric fields and safe labels cross the persistence boundary. */
export class MetricsRecorder {
  private lastCallId:string|null=null;
  private summaryRetryEpoch=0;
  private compaction:Span|null=null;
  private retry:Span|null=null;
  private selection={provider:'unknown',model:'unknown',api:'unknown'};
  private task:Span|null=null;
  private taskBound=false;
  private call:Span|null=null;
  private pendingStart:number|null=null;
  private tools=new Map<string,Span>();
  constructor(privateStore:MetricsStore, identity:MetricIdentity, clock:()=>number=Date.now, context: {parentTaskId?:()=>string|null;taskId?:()=>string|null} = {}) {
    this.context=context;this.store=privateStore;this.identity=identity;this.clock=clock;this.store.actor(identity);
  }
  private context: {parentTaskId?:()=>string|null;taskId?:()=>string|null};
  private store:MetricsStore; private identity:MetricIdentity; private clock:()=>number;
  get taskId(){return this.task?.id??null;}
  private startTask(now:number) {
    if(this.task)return;
    this.taskBound=false;
    this.task={id:this.context.taskId?.()??randomUUID(),worker_id:this.identity.worker_id,task_id:null,kind:'task',start_ms:now,end_ms:null,status:'running',data:{parent_task_id:this.context.parentTaskId?.()??null}};this.store.put(this.task);
  }
  event(event:any) {
    const now=this.clock(), m=event.message;
    const selected=event.metricsModel??(m?.role==='assistant'?{provider:m.provider,model:m.model,api:m.api}:null);
    if(selected)this.selection={provider:label(selected.provider),model:label(selected.model),api:label(selected.api)};
    if(this.operationEvent(event,now))return;
    if(event.type==='agent_start'){this.startTask(now);return;}
    if(event.type==='turn_start'){this.startTask(now);this.pendingStart=now;return;}
    if((event.type==='message_start'||event.type==='message_end')&&m?.role==='assistant') {
      const id=metricId(this.identity.worker_id,'model',String(m.timestamp??randomUUID()));
      if(this.task&&!this.taskBound){
        const taskId=metricId(this.identity.worker_id,'task',String(m.timestamp??id));
        this.store.bindTask(this.task.id,taskId);this.task.id=taskId;this.taskBound=true;
      }
      if(this.store.hasFinal(id)){this.pendingStart=null;return;}
      if(!this.call||this.call.id!==id) {
        this.call={id,worker_id:this.identity.worker_id,task_id:this.taskId,kind:'model',start_ms:this.pendingStart,end_ms:null,status:'running',
          data:{operation:'assistant',provider:label(m.provider),model:label(m.model),api:label(m.api),cache_semantics:cacheSemantics(m.provider,m.api),first_fragment_ms:null,last_fragment_ms:null,usage:null,price:null}};
        this.store.put(this.call);
      }
      if(event.type==='message_end') {
        this.lastCallId=id;
        const usage=numericUsage(m.usage);
        this.call.end_ms=Math.max(now,this.call.start_ms??now);
        this.call.status=['stop','toolUse','length','error','aborted','deferred'].includes(m.stopReason)?m.stopReason:'unknown';
        this.call.data.usage=usage;
        this.call.data.provider=label(m.provider);this.call.data.model=label(m.model);
        this.call.data.price=priceSnapshot(usage,now);
        this.store.put(this.call);this.call=null;this.pendingStart=null;
      }
      return;
    }
    if(event.type==='message_update'&&this.call&&['text_delta','thinking_delta','toolcall_delta'].includes(event.assistantMessageEvent?.type)) {
      this.call.data.first_fragment_ms??=now;this.call.data.last_fragment_ms=now;return;
    }
    if(event.type==='tool_execution_start') {
      const id=metricId(this.identity.worker_id,'tool',String(event.toolCallId));
      if(this.tools.has(id)||this.store.hasFinal(id))return;
      const span:Span={id,worker_id:this.identity.worker_id,task_id:this.taskId,kind:'tool',start_ms:now,end_ms:null,status:'running',data:{tool:label(event.toolName)}};
      this.tools.set(id,span);this.store.put(span);return;
    }
    if(event.type==='tool_execution_end') {
      const id=metricId(this.identity.worker_id,'tool',String(event.toolCallId)),span=this.tools.get(id);
      if(span){span.end_ms=Math.max(now,span.start_ms!);span.status=event.isError?'error':'stop';this.store.put(span);this.tools.delete(id);}return;
    }
    if(event.type==='agent_settled'||(event.type==='agent_end'&&!event.willRetry))this.finish(now,'stop');
  }
  private finishRetry(now:number,status:Status='stop') {
    if(!this.retry)return;
    this.retry.end_ms=Math.max(now,this.retry.start_ms!);this.retry.status=status;this.store.put(this.retry);this.retry=null;
  }
  private operationEvent(event:any,now:number):boolean {
    const type=event.type;
    if(type==='summarization_retry_finished')this.summaryRetryEpoch++;
    if(type==='turn_start'||type==='auto_retry_end'||type==='summarization_retry_attempt_start'||type==='summarization_retry_finished')this.finishRetry(now,event.success===false?'aborted':'stop');
    if(type==='compaction_start'||type==='session_before_compact'){
      if(!this.compaction){
        const attribution=type==='compaction_start'?{provider:'unknown',model:'unknown',api:'unknown'}:this.selection;
        this.compaction={id:randomUUID(),worker_id:this.identity.worker_id,task_id:this.taskId,kind:'model',start_ms:now,end_ms:null,status:'running',data:{operation:'compaction',reason:['manual','threshold','overflow'].includes(event.reason)?event.reason:'unknown',...attribution,cache_semantics:cacheSemantics(attribution.provider,attribution.api),usage:null,price:null}};
        this.store.put(this.compaction);
      }
      return true;
    }
    if(type==='compaction_end'||type==='session_compact'||type==='session_compact_failed'){
      if(!this.compaction)return true;
      const span=this.compaction;this.compaction=null;this.finishRetry(now);
      if(event.compactionEntry?.id){
        const id=metricId(this.identity.worker_id,'compaction',String(event.compactionEntry.id));
        this.store.discardOpen(span.id);span.id=id;
        if(this.store.hasFinal(id))return true;
      }
      span.end_ms=Math.max(now,span.start_ms!);
      span.status=event.aborted?'aborted':(type==='session_compact_failed'||event.errorMessage||(!event.result&&type==='compaction_end'))?'error':'stop';
      span.data.usage=numericUsage(event.compactionEntry?.usage??event.result?.usage);
      span.data.price=priceSnapshot(span.data.usage,now);
      if(event.fromExtension){span.data.provider='unknown';span.data.model='unknown';span.data.api='unknown';span.data.cache_semantics=null;}
      this.store.put(span);return true;
    }
    if(type==='auto_retry_start'||type==='summarization_retry_scheduled'){
      if(type==='summarization_retry_scheduled'&&!this.compaction)return true;
      if(this.retry)return true;
      const attempt=num(event.attempt);if(attempt===null)return true;
      const scope=type==='auto_retry_start'?'assistant':'compaction';
      const id=metricId(this.identity.worker_id,'retry',scope,this.compaction?this.compaction.id+':'+this.summaryRetryEpoch:this.lastCallId??this.taskId??'',String(attempt));
      if(this.store.hasFinal(id))return true;
      this.retry={id,worker_id:this.identity.worker_id,task_id:this.taskId,kind:'tool',start_ms:now,end_ms:null,status:'running',data:{operation:'retry',scope,provider:this.compaction?.data.provider??this.selection.provider,model:this.compaction?.data.model??this.selection.model,attempt,scheduled_delay_ms:num(event.delayMs)}};
      this.store.put(this.retry);return true;
    }
    return false;
  }
  private finish(now:number,status:Status) {
    if(this.call){this.call.end_ms=Math.max(now,this.call.start_ms??now);this.call.status='interrupted';this.store.put(this.call);this.call=null;}
    else if(this.pendingStart!==null){this.store.put({id:randomUUID(),worker_id:this.identity.worker_id,task_id:this.taskId,kind:'model',start_ms:this.pendingStart,end_ms:Math.max(now,this.pendingStart),status:'interrupted',data:{provider:'unknown',model:'unknown',first_fragment_ms:null,last_fragment_ms:null,usage:null,price:null}});}
    this.pendingStart=null;
    for(const span of this.tools.values()){span.end_ms=Math.max(now,span.start_ms!);span.status='interrupted';this.store.put(span);}this.tools.clear();
    if(this.task){this.task.end_ms=Math.max(now,this.task.start_ms!);this.task.status=status;this.store.put(this.task);this.task=null;}
  }
  close(){const now=this.clock();this.finishRetry(now,'interrupted');if(this.compaction){this.compaction.end_ms=now;this.compaction.status='interrupted';this.store.put(this.compaction);this.compaction=null;}this.finish(now,'interrupted');}
}

function priceSnapshot(usage:NumericUsage|null,now:number){
  const rates:Record<string,number>={};
  for(const k of ['input','output','cacheRead','cacheWrite'] as const)if(usage?.[k]&&usage.cost?.[k]!==undefined)rates[k]=usage.cost[k]/usage[k]!*1e6;
  return {source:'pi-usage-cost',timestamp_ms:now,currency:'USD',total:usage?.cost?.total??null,components:usage?.cost??null,effective_rates_per_million:rates};
}
