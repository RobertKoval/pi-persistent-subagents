import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveMetricsSetting} from '../src/metrics-settings.ts';
import {loadConfig} from '../src/config.ts';

it('shares global metrics defaults across projects and allows explicit project inheritance',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pi-global-metrics-'));
  try{
    const agentDir=join(root,'agent'),a=join(root,'a'),b=join(root,'b');
    await mkdir(join(a,'.pi'),{recursive:true});
    await writeFile(join(a,'.pi','persistent-subagents.json'),JSON.stringify({metricsWorkers:true,maxAgents:2}));
    await saveMetricsSetting({scope:'global',agentDir},'workers',false);
    assert.equal((await loadConfig(b,agentDir)).config.metricsWorkers,false);
    assert.equal((await loadConfig(a,agentDir)).config.metricsWorkers,true);
    await saveMetricsSetting({scope:'project',cwd:a},'workers',null);
    assert.equal((await loadConfig(a,agentDir)).config.metricsWorkers,false);
    assert.equal((await loadConfig(a,agentDir)).config.maxAgents,2);
    await saveMetricsSetting({scope:'global',agentDir},'main',true);
    assert.equal((await loadConfig(b,agentDir)).config.metricsMain,true);
    assert.equal((await loadConfig(b,agentDir)).config.metricsWorkers,false);
    assert.deepEqual(JSON.parse(await readFile(join(a,'.pi','persistent-subagents.json'),'utf8')),{maxAgents:2});
  }finally{await rm(root,{recursive:true,force:true});}
});
