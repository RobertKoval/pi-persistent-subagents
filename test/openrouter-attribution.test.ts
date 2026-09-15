import {it} from 'node:test';
import assert from 'node:assert/strict';
import {attribution,applyAttribution} from '../src/openrouter-attribution.ts';
it('transfers only app identity, handles casing and legacy title, and preserves worker overrides',()=>{
 const parent=attribution({'http-referer':'https://pi.dev','X-Title':'Pi','Authorization':'SECRET','X-Other':'SECRET'});
 assert.deepEqual(parent,{'HTTP-Referer':'https://pi.dev','X-OpenRouter-Title':'Pi'});
 const headers:Record<string,string|null>={'HTTP-Referer':'https://worker.example','x-title':'Worker'};
 applyAttribution(headers,parent);assert.deepEqual(headers,{'HTTP-Referer':'https://worker.example','x-title':'Worker'});
 const empty={};applyAttribution(empty,parent);assert.deepEqual(empty,parent);
 assert.deepEqual(attribution({'X-Title':'Old','X-OpenRouter-Title':'New'}),{'X-OpenRouter-Title':'New'});
 assert.deepEqual(attribution(null),{});
 const disabled={'HTTP-Referer':null};applyAttribution(disabled,parent);assert.equal(disabled['HTTP-Referer'],null);
});
