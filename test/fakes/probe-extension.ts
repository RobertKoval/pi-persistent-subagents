import { PersistentPiRpcClient } from '../../src/rpc-client.ts';
import extension from '../../src/index.ts';
export default function probe(pi: any) {
  const tools = new Map<string, any>();
  const rpcLog: {pid?:number;command:unknown;phase:string}[]=[];
  const request=PersistentPiRpcClient.prototype.request;
  PersistentPiRpcClient.prototype.request=async function(command) {
    rpcLog.push({pid:this.pid(),command:command.type,phase:'send'});
    const result=await request.call(this,command);
    rpcLog.push({pid:this.pid(),command:command.type,phase:'accepted'});
    return result;
  };
  extension(new Proxy(pi, { get(target, key) {
    if (key === 'registerTool') return (t: any) => { tools.set(t.name, t); target.registerTool(t); };
    return target[key];
  } }));
  pi.registerCommand('probe', { description: 'Local acceptance driver', handler: async (args: string, ctx: any) => {
    const { id, tool, params } = JSON.parse(args);
    try {
      let result;
      if(tool === 'rpc-log') result=rpcLog;
      else if (tool === 'inspect') {
        const selection = ctx.sessionManager.getEntries().filter((e: any) => e.customType === 'pi-accounts-selection').at(-1);
        result = { tools: pi.getActiveTools(), provider: ctx.model?.provider, model: ctx.model?.id,
          hasAccountSelection: !!selection, selected: selection?.data?.providers,
          models: ctx.modelRegistry.getAll().filter((m: any) => m.provider === 'openai-codex' && /terra|luna/.test(m.id)).map((m: any) => m.id) };
      } else result = await tools.get(tool).execute(id, params, undefined, undefined, ctx);
      pi.sendMessage({customType:'probe-result', content: JSON.stringify({id,result}), display:false}, {triggerTurn:false});
    } catch (e) { pi.sendMessage({customType:'probe-result', content: JSON.stringify({id,error:String(e)}), display:false}, {triggerTurn:false}); }
  } });
}
