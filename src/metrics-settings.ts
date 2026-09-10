import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function saveMetricsSetting(cwd:string,role:'workers'|'main',enabled:boolean){
  const dir=join(cwd,'.pi'),path=join(dir,'persistent-subagents.json');
  let config:Record<string,unknown>={};
  try{config=JSON.parse(await readFile(path,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Invalid project config');
  config[role==='workers'?'metricsWorkers':'metricsMain']=enabled;
  await mkdir(dir,{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600});await rename(temp,path);
}
