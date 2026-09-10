type Usage = {input?:number;output?:number;cacheRead?:number;cacheWrite?:number};
type Call = {provider:string;model:string;end_ms:number|null;usage?:Usage|null;price?:{total?:number}|null};
export function modelTotals(calls:Call[],compactions:Call[]) {
 const groups=new Map<string,{provider:string;model:string;calls:number;compactions:number;incomplete:number;partial_usage:number;unpriced:number;input:number|null;output:number|null;cache_read:number|null;cache_write:number|null;api_equivalent:number|null}>();
 for(const [rows,kind] of [[calls,'calls'],[compactions,'compactions']] as const)for(const c of rows){
  const key=JSON.stringify([c.provider,c.model]);
  let g=groups.get(key);
  if(!g){g={provider:c.provider,model:c.model,calls:0,compactions:0,incomplete:0,partial_usage:0,unpriced:0,input:null,output:null,cache_read:null,cache_write:null,api_equivalent:null};groups.set(key,g);}
  g[kind]++;
  if(c.end_ms===null){g.incomplete++;continue;}
  const fields=[['input','input'],['output','output'],['cacheRead','cache_read'],['cacheWrite','cache_write']] as const;
  if(fields.some(([source])=>c.usage?.[source]===undefined))g.partial_usage++;
  for(const [source,target] of fields){const n=c.usage?.[source];if(n!==undefined)g[target]=(g[target]??0)+n;}
  if(c.price?.total===undefined)g.unpriced++;else g.api_equivalent=(g.api_equivalent??0)+c.price.total;
 }
 return [...groups.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));
}
