import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersistentPiRpcClient } from '../src/rpc-client.ts';

const fakeCli = fileURLToPath(new URL('./fakes/fake-pi-rpc.mjs', import.meta.url));
const clients: PersistentPiRpcClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.stop()));
});

async function makeClient() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-persistent-rpc-'));
  const log = join(dir, 'commands.jsonl');
  const session = join(dir, 'session.jsonl');
  const client = new PersistentPiRpcClient({
    command: process.execPath,
    args: [fakeCli, '--mode', 'rpc', '--session', session, '--provider', 'work', '--model', 'worker-model'],
    env: { ...process.env, FAKE_RPC_LOG: log },
    startupTimeoutMs: 3_000,
    commandTimeoutMs: 3_000,
  });
  clients.push(client);
  return { client, log, session };
}

async function commands(log: string) {
  const text = await readFile(log, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).command);
}

describe('PersistentPiRpcClient', () => {
  it('performs a real get_state handshake and exposes the live pid', async () => {
    const { client } = await makeClient();
    const state = await client.start();
    assert.equal(state.model?.provider, 'work');
    assert.equal(state.model?.id, 'worker-model');
    assert.equal(state.pid, client.pid());
    assert.ok(client.pid() && client.pid()! > 0);
  });

  it('keeps the same process alive across settled prompt turns', async () => {
    const { client } = await makeClient();
    await client.start();
    const pid = client.pid();

    await client.prompt('first');
    await client.waitForIdle(2_000);
    assert.equal(await client.getLastAssistantText(), 'ECHO:first');

    await client.prompt('second');
    await client.waitForIdle(2_000);
    assert.equal(await client.getLastAssistantText(), 'ECHO:second');
    assert.equal(client.pid(), pid);
    assert.equal((await client.getState()).pid, pid);
  });

  it('uses strict LF framing and preserves U+2028/U+2029 inside JSON strings', async () => {
    const { client } = await makeClient();
    await client.start();
    const message = `alpha\u2028beta\u2029gamma`;
    await client.prompt(message);
    await client.waitForIdle(2_000);
    assert.equal(await client.getLastAssistantText(), `ECHO:${message}`);
  });

  it('routes explicit steer and follow_up RPC commands', async () => {
    const { client, log } = await makeClient();
    await client.start();
    await client.prompt('__SLOW__');
    await client.steer('redirect');
    await client.waitForIdle(2_000);
    assert.equal(await client.getLastAssistantText(), 'STEER:redirect');

    await client.prompt('__SLOW__');
    await client.followUp('after');
    await client.waitForIdle(2_000);
    await client.waitForIdle(2_000);

    const seen = await commands(log);
    assert.ok(seen.some((x) => x.type === 'steer' && x.message === 'redirect'));
    assert.ok(seen.some((x) => x.type === 'follow_up' && x.message === 'after'));
  });

  it('rejects unknown RPC commands with the provider error', async () => {
    const { client } = await makeClient();
    await client.start();
    await assert.rejects(() => client.request({ type: '__unknown__' }), /unknown command/);
  });

  it('notifies exit subscribers when the child dies unexpectedly', async () => {
    const { client } = await makeClient();
    await client.start();
    const exit = new Promise<Error>((resolve) => client.onExit(resolve));
    await client.prompt('__CRASH__');
    const error = await exit;
    assert.match(error.message, /exited/i);
  });

  it('rejects pending operations when the child process exits', async () => {
    const { client } = await makeClient();
    await client.start();
    await client.prompt('__CRASH__');
    await assert.rejects(() => client.waitForIdle(2_000), /exited|closed/i);
  });
});

it('terminates a worker that emits invalid JSON instead of merely marking it dead', async () => {
  const client=new PersistentPiRpcClient({command:process.execPath,args:['-e',`
    process.stdin.on('data',b=>{
      const c=JSON.parse(b);
      process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{isStreaming:false}})+'\\n');
      setTimeout(()=>process.stdout.write('invalid json\\n'),20);
    });
  `],shutdownGraceMs:100});
  clients.push(client);
  await client.start();
  const pid=client.pid()!;
  await new Promise<void>(resolve=>client.onExit(()=>resolve()));
  const deadline=Date.now()+1000;
  let alive=true;
  while(alive && Date.now()<deadline){
    try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw e;}
    if(alive)await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(alive,false,'invalid RPC output must terminate the OS process');
});

it('rejects commands submitted while process termination is in progress', async () => {
  const client=new PersistentPiRpcClient({command:process.execPath,args:['-e',`
    process.on('SIGTERM',()=>{});
    process.stdin.on('data',b=>{
      const c=JSON.parse(b);
      process.stdout.write(JSON.stringify({type:'response',id:c.id,success:true,data:{isStreaming:false}})+'\\n');
    });
  `],shutdownGraceMs:100,commandTimeoutMs:500});
  clients.push(client);
  await client.start();
  const stopping=client.stop();
  await assert.rejects(()=>client.getState(),/stopping/);
  await stopping;
});
