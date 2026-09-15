type Headers = Record<string,string|null>;
export const ATTRIBUTION_ENV = 'PI_PERSISTENT_OPENROUTER_ATTRIBUTION';
export function attribution(value:unknown): Record<string,string> {
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const headers=new Map(Object.entries(value).map(([key,value])=>[key.toLowerCase(),value]));
 const result:Record<string,string>={};
 for(const [target,source] of [['HTTP-Referer','http-referer'],['X-OpenRouter-Title',headers.has('x-openrouter-title')?'x-openrouter-title':'x-title']]){
  const v=headers.get(source);if(typeof v==='string'&&v.length>0&&!/[\r\n]/.test(v))result[target]=v;
 }
 return result;
}
export function applyAttribution(headers:Headers,parent:Record<string,string>):void {
 const keys=new Set(Object.keys(headers).map(k=>k.toLowerCase()));
 for(const [key,value] of Object.entries(parent)){
  if(keys.has(key.toLowerCase())||(key==='X-OpenRouter-Title'&&keys.has('x-title')))continue;
  headers[key]=value;
 }
}
