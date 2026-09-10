// Pi 0.85's reviewed adapters subtract cached reads/writes from OpenAI input,
// while Anthropic already reports the three disjoint input categories.
// Persist the interpretation with new observations; never infer it for old rows.
const APIS: Record<string, readonly string[]> = {
  openai: ['openai-responses', 'openai-completions'],
  'openai-codex': ['openai-codex-responses'],
  anthropic: ['anthropic-messages'],
};
export function cacheSemantics(provider:unknown,api:unknown):string|null {
  return typeof provider==='string'&&typeof api==='string'&&Object.hasOwn(APIS,provider)&&APIS[provider].includes(api)
    ? 'pi-0.85-exclusive-input-v1' : null;
}
export function cacheInput(usage:any,semantics:unknown):number|null {
  if(semantics!=='pi-0.85-exclusive-input-v1')return null;
  const values=[usage?.input,usage?.cacheRead,usage?.cacheWrite];
  if(!values.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))return null;
  const total=values.reduce((a,b)=>a+b,0);
  return Number.isFinite(total)?total:null;
}
export function cacheRatio(usage:any,semantics:unknown):number|null {
  const total=cacheInput(usage,semantics);
  return total!==null&&total>0?usage.cacheRead/total:null;
}
