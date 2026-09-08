import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PersistentPiRpcClient } from '../src/rpc-client.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
it('loads and executes the extension command in installed Pi without a model call', {skip: process.env.PI_PERSISTENT_SUBAGENTS_E2E !== '1'}, async () => {
  const client = new PersistentPiRpcClient({command:'pi',args:['--no-extensions','-e',root,'--mode','rpc','--no-session','--offline'],cwd:root});
  const errors: unknown[] = [];
  client.onEvent(e=>{if(e.type==='extension_error') errors.push(e);});
  try {
    await client.start();
    const response = await client.request({type:'get_commands'});
    assert.ok((response.data as any).commands.some((c:any)=>c.name==='pworkers'));
    await client.prompt('/pworkers');
    assert.deepEqual(errors,[]);
  } finally {await client.stop();}
});
