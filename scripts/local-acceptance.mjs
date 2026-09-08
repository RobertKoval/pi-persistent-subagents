import { PersistentPiRpcClient } from '../src/rpc-client.ts';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { seedAccountSelection } from '../src/account-selection.ts';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const work = await mkdtemp(join(tmpdir(), 'pi-live-'));
await mkdir(join(work, '.pi'));
await writeFile(join(work, '.pi/persistent-subagents.json'), JSON.stringify({ notifyOnSettled: process.argv.includes('--manager') }));
const client = new PersistentPiRpcClient({ command: 'pi', args: ['-e', join(root, 'test/fakes/probe-extension.ts'), '--mode', 'rpc', '--session', join(work, 'parent.jsonl'), '--provider', 'openai-codex', '--model', process.argv.includes('--manager') ? 'gpt-5.6-terra' : 'gpt-5.6-luna', '--thinking', 'low', '--offline', '--no-context-files', '--approve'], cwd: work, startupTimeoutMs: 30000, commandTimeoutMs: 120000, shutdownGraceMs: 10000 });
if(process.env.PI_TEST_ACCOUNT) seedAccountSelection(join(work,'parent.jsonl'),work,{
 getSessionId:()=> 'acceptance-seed', getEntries:()=>[{type:'custom',customType:'pi-accounts-selection',data:{version:1,sessionId:'acceptance-seed',providers:{'openai-codex':process.env.PI_TEST_ACCOUNT}}}]
});
let parentSessionId;
let seq = 0;
async function probe(tool, params = {}) {
 const id = `probe-${++seq}`;
 await client.prompt('/probe ' + JSON.stringify({ id, tool, params }));
 const response = await client.request({type:'get_messages'});
 const message = response.data.messages.filter(m => m.customType === 'probe-result').at(-1);
 if (!message) throw new Error('Missing probe result');
 const result = JSON.parse(message.content);
 assert.equal(result.id,id);
 if(result.error) throw new Error(result.error);
 return result.result;
}
try {
 parentSessionId = (await client.start()).sessionId;
 console.log(JSON.stringify({ stage: 'started', stderr: client.getStderr().replace(/Bearer\s+\S+/gi, 'Bearer <redacted>') }));
 const commands = await client.request({ type: 'get_commands' });
 assert.ok(commands.data.commands.some(c => c.name === 'probe'));
 const inspection = await probe('inspect');
 console.log(JSON.stringify({ stage: 'inspect', ...inspection, selected: undefined, accountSelectionCount: Object.keys(inspection.selected ?? {}).length }));
 const signal = process.argv.find(a => ['SIGTERM','SIGHUP','SIGKILL'].includes(a));
 if(process.argv.includes('--manager')) {
   const calls=[];
   const off=client.onEvent(e=>{if(e.type==='tool_execution_end') {
     calls.push({tool:e.toolName,error:e.isError,result:e.result?.details});
     console.log(JSON.stringify({stage:'manager-tool',tool:e.toolName,error:e.isError}));
   }});
   await client.prompt('This is a live acceptance test, not implementation work. Use the persistent tools spawn_agent, send_input, wait_agent, list_agents, close_agent, resume_agent. Do not use the legacy subagent tool or shell Pi processes. Spawn exactly two workers: gpt-5.6-luna and gpt-5.6-terra, both low thinking. Ask each to remember a distinct marker and reply READY; no file access is needed. Wait for both, list them, send each a follow-up asking for its marker, wait and list again. Then close and resume the Luna worker, ask it for its marker again, wait and list. Verify same PID/session for related live turns, changed PID and same session on resume, correct recall. Leave both workers idle and alive for an external shutdown observer. Finish with a brief factual assessment of whether the tools are convenient and any observed shortcomings. Do not call any more tools after your final assessment. Completion notifications are informational; do not spawn more workers in response to them.');
   await client.waitForIdle(240000);
   off();
   assert.equal(calls.filter(c=>c.tool==='spawn_agent').length,2);
   for(const tool of ['spawn_agent','send_input','wait_agent','list_agents','close_agent','resume_agent']) assert.ok(calls.some(c=>c.tool===tool),tool+' must be exercised by the manager');
   assert.ok(!calls.some(c=>c.error),'manager tools must succeed');
   const snapshots=(await probe('list_agents')).details;
   assert.equal(snapshots.length,2);
   for(const w of snapshots) { assert.equal(w.status,'idle');assert.equal(w.alive,true);assert.equal(w.error,undefined); }
   console.log(JSON.stringify({stage:'manager-complete',assessment:await client.getLastAssistantText(),workers:snapshots.map(w=>({id:w.id,pid:w.pid,model:w.model,usage:w.usage}))}));
   await client.stop();
   for(const w of snapshots) assert.throws(()=>process.kill(w.pid,0),{code:'ESRCH'});
   console.log(JSON.stringify({stage:'manager-shutdown',workersGone:true}));
 } else if(process.argv.includes('--cache')) {
   const arms={};
   const observations=[];
   for(let turn=0;turn<5;turn++) {
     for(const arm of (turn%2===0?['persistent','restarted']:['restarted','persistent'])) {
       const task=turn===0?'Remember CACHE-739. Reply only READY.':`Compute ${turn}+${turn}. Reply only the number.`;
       let previous=arms[arm];
       if(!previous) {
         const w=(await probe('spawn_agent',{task,model:'gpt-5.6-luna',thinking:'low'})).details;
         arms[arm]={id:w.id,pid:w.pid,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,turns:0}};
       } else {
         if(arm==='restarted') {
           await probe('close_agent',{id:previous.id});
           const next=(await probe('resume_agent',{id:previous.id})).details;
           assert.notEqual(next.pid,previous.pid);
           assert.equal(next.cacheContinuity,'cold_process');
         }
         await probe('send_input',{id:previous.id,message:task});
       }
       const base=arms[arm];
       await probe('wait_agent',{ids:[base.id],timeout_ms:120000});
       const current=(await probe('list_agents')).details.find(w=>w.id===base.id);
       assert.equal(current.error,undefined);assert.equal(current.status,'idle');
       assert.equal(current.lastOutput?.trim(),turn===0?'READY':String(turn+turn));
       if(arm==='persistent') assert.equal(current.pid,base.pid);
       observations.push({arm,turn,pid:current.pid,usage:Object.fromEntries(Object.keys(current.usage).map(k=>[k,current.usage[k]-base.usage[k]]))});
       arms[arm]=current;
     }
   }
   for(const state of Object.values(arms)) {
     const messages=(await readFile(state.sessionFile,'utf8')).trim().split('\n').map(JSON.parse).filter(e=>e.message?.role==='assistant').map(e=>e.message);
     const actual={input:0,output:0,cacheRead:0,cacheWrite:0,turns:0};
     for(const message of messages) if(message.usage) {
       for(const key of ['input','output','cacheRead','cacheWrite']) actual[key]+=message.usage[key]??0;
       actual.turns++;
     }
     assert.deepEqual(state.usage,actual,'tool usage must equal actual Pi assistant usage from the session');
   }
   console.log(JSON.stringify({stage:'cache-ab',usageMatchesPiSession:true,design:'five identical tasks per arm; restarted arm preserves session/transcript but replaces process each turn; alternating order; one trial, no quota/billing inference',observations,totals:Object.fromEntries(Object.entries(arms).map(([k,v])=>[k,v.usage]))}));
 } else if(process.argv.includes('--streaming')) {
   const w=(await probe('spawn_agent',{task:'Run bash sleep 3, then reply only INITIAL.',model:'gpt-5.6-luna',thinking:'low'})).details;
   await probe('send_input',{id:w.id,message:'Change the final reply to only STEER-739.',mode:'auto'});
   await probe('wait_agent',{ids:[w.id],timeout_ms:120000});
   let state=(await probe('list_agents')).details[0];
   assert.match(state.lastOutput,/STEER-739/); assert.equal(state.error,undefined);
   await probe('send_input',{id:w.id,message:'Run bash sleep 3, then reply only FIRST-PART.'});
   await probe('send_input',{id:w.id,message:'Now reply only FOLLOW-739.',mode:'follow_up'});
   await probe('wait_agent',{ids:[w.id],timeout_ms:120000});
   state=(await probe('list_agents')).details[0];
   assert.match(state.lastOutput,/FOLLOW-739/); assert.equal(state.error,undefined);
   await probe('send_input',{id:w.id,message:'Run bash sleep 10, then reply only OLD-TASK.'});
   await probe('send_input',{id:w.id,message:'Reply only INTERRUPT-739.',mode:'interrupt'});
   await probe('wait_agent',{ids:[w.id],timeout_ms:120000});
   state=(await probe('list_agents')).details[0];
   assert.match(state.lastOutput,/INTERRUPT-739/);assert.equal(state.pid,w.pid);assert.equal(state.error,undefined);
   const log=await probe('rpc-log');
   assert.ok(log.some(e=>e.command==='steer'&&e.phase==='accepted'));
   assert.ok(log.some(e=>e.command==='follow_up'&&e.phase==='accepted'));
   const abort=log.findIndex(e=>e.command==='abort'&&e.phase==='accepted');
   assert.ok(abort>=0);assert.ok(log.slice(abort+1).some(e=>e.command==='prompt'&&e.phase==='send'));
   console.log(JSON.stringify({stage:'streaming',samePid:true,steer:true,followUp:true,abortBeforePrompt:true,usage:state.usage,rpc:log}));
 } else if(process.argv.includes('--shutdown-work')) {
   assert.ok(signal);
   const idle=(await probe('spawn_agent',{task:'Reply only READY.',model:'gpt-5.6-luna',thinking:'low'})).details;
   await probe('wait_agent',{ids:[idle.id],timeout_ms:120000});
   const pidFile=join(work,'tool.pid');
   const running=(await probe('spawn_agent',{task:`Use the bash tool to run exactly: echo $$ > ${pidFile}; sleep 40 . The final period is punctuation, not part of the command. Do not do anything else until it finishes.`,model:'gpt-5.6-luna',thinking:'low'})).details;
   let toolPid;
   const deadline=Date.now()+40000;
   while(!toolPid && Date.now()<deadline) {
     try{toolPid=Number((await readFile(pidFile,'utf8')).trim());}catch(e){if(e.code!=='ENOENT')throw e;}
     if(!toolPid) await new Promise(r=>setTimeout(r,50));
   }
   assert.ok(Number.isInteger(toolPid)&&toolPid>0,'worker must actually start a shell tool');
   const parentPid=client.pid();
   const rows=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(r=>r.trim().split(/\s+/).map(Number));
   const owned=new Set([parentPid,idle.pid,running.pid,toolPid]);
   let changed=true;
   while(changed){changed=false;for(const [pid,ppid] of rows)if(owned.has(ppid)&&!owned.has(pid)){owned.add(pid);changed=true;}}
   const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
   process.kill(parentPid,signal);
   const exitDeadline=Date.now()+15000;
   while([...owned].some(alive)&&Date.now()<exitDeadline)await new Promise(r=>setTimeout(r,50));
   const remaining=[...owned].filter(alive);
   console.log(JSON.stringify({stage:'shutdown-work',signal,trackedProcessCount:owned.size,remaining}));
   assert.deepEqual(remaining,[],'all parent, worker and tool processes must exit');
 } else if(signal) {
   const pending = probe('spawn_agent',{task:'/accounts',model:'gpt-5.6-luna',thinking:'low'}).catch(()=>undefined);
   const parentPid=client.pid();
   let childPid;
   const startupDeadline=Date.now()+10000;
   while(!childPid && Date.now()<startupDeadline) {
     const rows=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n');
     const row=rows.map(r=>r.trim().split(/\s+/)).find(r=>Number(r[1])===parentPid && /(?:pi|node)$/.test(r[2]));
     if(row) childPid=Number(row[0]); else await new Promise(r=>setTimeout(r,50));
   }
   assert.ok(childPid,'child must start');
   const worker={pid:childPid};
   process.kill(parentPid,signal);
   const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
   const deadline=Date.now()+15000;
   while((alive(worker.pid)||alive(parentPid)) && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
   assert.equal(alive(parentPid),false,'parent must exit');
   assert.equal(alive(worker.pid),false,'worker must exit after parent death');
   console.log(JSON.stringify({stage:'parent-death',signal,parentGone:true,workerGone:true,modelCalls:0}));
 } else {
 const spawned = (await probe('spawn_agent', { task: 'Remember the marker ORCHID-739. Reply only READY.', model: 'gpt-5.6-luna', thinking: 'low' })).details;
 console.log(JSON.stringify({ stage: 'spawn', id: spawned.id, pid: spawned.pid, provider: spawned.provider, model: spawned.model }));
 await probe('wait_agent', { ids: [spawned.id], timeout_ms: 120000 });
 const first = (await probe('list_agents')).details[0];
 assert.equal(first.status, 'idle'); assert.equal(first.error,undefined,first.error); assert.ok(first.lastOutput?.includes('READY'), first.lastOutput);
 await probe('send_input', { id: spawned.id, message: 'What marker did I ask you to remember? Reply only the marker.' });
 await probe('wait_agent', { ids: [spawned.id], timeout_ms: 120000 });
 const second = (await probe('list_agents')).details[0];
 assert.equal(first.pid, second.pid); assert.equal(first.sessionFile, second.sessionFile); assert.equal(second.status, 'idle'); assert.ok(second.alive); assert.match(second.lastOutput, /ORCHID-739/);
 const session = (await readFile(second.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
 const selection = session.find(e => e.customType === 'pi-accounts-selection');
 assert.deepEqual(selection?.data.providers, inspection.selected);
 console.log(JSON.stringify({ stage: 'reuse', pid: second.pid, firstUsage: first.usage, secondUsage: second.usage, inheritedAccount: true }));
 await probe('close_agent', { id: spawned.id });
 assert.throws(() => process.kill(second.pid, 0), { code: 'ESRCH' });
 const resumed = (await probe('resume_agent', { id: spawned.id })).details;
 assert.notEqual(resumed.pid, second.pid); assert.equal(resumed.sessionFile, second.sessionFile); assert.equal(resumed.cacheContinuity, 'cold_process');
 await probe('send_input', { id: spawned.id, message: 'What marker did I ask you to remember? Reply only the marker.' });
 await probe('wait_agent', { ids: [spawned.id], timeout_ms: 120000 });
 const third = (await probe('list_agents')).details[0];
 assert.match(third.lastOutput, /ORCHID-739/);
 await client.stop();
 assert.throws(() => process.kill(third.pid, 0), { code: 'ESRCH' });
 console.log(JSON.stringify({ stage: 'resume-and-shutdown', newPid: third.pid, transcript: true, workerGone: true, usage: third.usage }));
}
} finally {
 await client.stop();
 await rm(work,{recursive:true,force:true});
 if(parentSessionId) {
  const scope='parent-'+createHash('sha256').update(parentSessionId).digest('hex').slice(0,16);
  await rm(join(process.env.PI_CODING_AGENT_DIR || join(homedir(),'.pi','agent'),'persistent-subagents','parents',scope),{recursive:true,force:true});
 }
}
