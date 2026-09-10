import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export type MetricsSettingsTarget = {scope:'project';cwd:string}|{scope:'global';agentDir:string};
export async function saveMetricsSetting(target:MetricsSettingsTarget,role:'workers'|'main',enabled:boolean|null){
  const dir=target.scope==='global'?join(target.agentDir,'persistent-subagents'):join(target.cwd,'.pi');
  const path=join(dir,target.scope==='global'?'config.json':'persistent-subagents.json');
  let config:Record<string,unknown>={};
  try{config=JSON.parse(await readFile(path,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Invalid metrics config');
  const key=role==='workers'?'metricsWorkers':'metricsMain';
  if(enabled===null)delete config[key];else config[key]=enabled;
  await mkdir(dir,{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600});await rename(temp,path);
}
