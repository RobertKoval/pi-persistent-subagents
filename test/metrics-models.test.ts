import {it} from 'node:test';
import assert from 'node:assert/strict';
import {modelTotals} from '../src/metrics-models.ts';
it('separates providers and models, preserves unknown usage and excludes unfinished usage',()=>{
 const rows=modelTotals([
 {provider:'a',model:'small',end_ms:10,usage:{input:2,output:3,cacheRead:4,cacheWrite:0},price:{total:0.1}},
 {provider:'a',model:'small',end_ms:20,usage:{output:7},price:null},
 {provider:'b',model:'small',end_ms:30,usage:null,price:null},
 {provider:'a',model:'large',end_ms:null,usage:{output:999},price:null},
 ],[{provider:'unknown',model:'unknown',end_ms:40,usage:{output:5},price:{total:0.2}}]);
 assert.equal(rows.length,4);
 const small=rows.find(r=>r.provider==='a'&&r.model==='small')!;
 assert.equal(small.output,10);assert.equal(small.input,2);assert.equal(small.cache_read,4);
 assert.equal(small.calls,2);assert.equal(small.api_equivalent,0.1);assert.equal(small.unpriced,1);assert.equal(small.partial_usage,1);
 assert.equal(rows.find(r=>r.provider==='b')!.output,null);
 assert.equal(rows.find(r=>r.model==='large')!.output,null);
 assert.equal(rows.find(r=>r.model==='large')!.incomplete,1);
 assert.equal(rows.find(r=>r.model==='unknown')!.compactions,1);
 assert.equal(rows.find(r=>r.model==='unknown')!.calls,0);
 assert.equal(rows.find(r=>r.model==='unknown')!.output,5);
 assert.deepEqual(modelTotals([],[]),[]);
});
