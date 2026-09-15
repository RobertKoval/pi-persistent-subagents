import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import swarmExtension from '../src/swarm-extension.ts';

const originalDepth = process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
afterEach(() => {
  if (originalDepth === undefined) delete process.env.PI_PERSISTENT_SUBAGENT_DEPTH;
  else process.env.PI_PERSISTENT_SUBAGENT_DEPTH = originalDepth;
});

function fakePi() {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const events = new Map<string, any[]>();
  return {
    tools,
    commands,
    events,
    api: {
      registerTool(tool: any) { tools.push(tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: any) {
        const list = events.get(name) ?? [];
        list.push(handler);
        events.set(name, list);
      },
    } as any,
  };
}

describe('swarm extension contract', () => {
  it('registers one high-level swarm tool and one human status command at the root depth', () => {
    process.env.PI_PERSISTENT_SUBAGENT_DEPTH = '0';
    const pi = fakePi();
    swarmExtension(pi.api);
    assert.deepEqual(pi.tools.map(tool => tool.name), ['swarm']);
    assert.equal(pi.commands.has('pswarms'), true);
    assert.equal(pi.events.has('session_shutdown'), true);
    const swarm = pi.tools[0];
    assert.equal(swarm.executionMode, 'parallel');
    assert.match(swarm.description, /speculative|local/i);
  });

  it('does not expose recursive swarm tools inside child workers', () => {
    process.env.PI_PERSISTENT_SUBAGENT_DEPTH = '1';
    const pi = fakePi();
    swarmExtension(pi.api);
    assert.equal(pi.tools.length, 0);
    assert.equal(pi.commands.size, 0);
  });
});
