#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionFile = getArg('--session');
const provider = getArg('--provider') ?? 'fake-provider';
const model = getArg('--model') ?? 'fake-model';
let thinkingLevel = getArg('--thinking') ?? 'medium';
const logFile = process.env.FAKE_RPC_LOG;
let isStreaming = false;
let lastAssistantText = null;
let timer = null;
let history = [];

if (sessionFile) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  if (fs.existsSync(sessionFile)) {
    for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.type === 'fake-turn') {
          history.push(item);
          lastAssistantText = item.response ?? lastAssistantText;
        }
      } catch {}
    }
  }
}

function log(command) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, command }) + '\n');
}

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function response(cmd, success, data, error) {
  const out = { type: 'response', command: cmd.type, success };
  if (cmd.id) out.id = cmd.id;
  if (data !== undefined) out.data = data;
  if (error !== undefined) out.error = error;
  write(out);
}

function persistTurn(message, text) {
  const item = { type: 'fake-turn', message, response: text };
  history.push(item);
  if (sessionFile) fs.appendFileSync(sessionFile, JSON.stringify(item) + '\n');
}

function complete(message, prefix = 'ECHO') {
  if (message === '__CRASH__') {
    setTimeout(() => process.exit(9), 10);
    return;
  }
  if (message === '__PROVIDER_ERROR__') {
    write({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'The usage limit has been reached',usage:{input:0,output:0,cacheRead:0,cacheWrite:0}}});
    isStreaming=false; write({type:'agent_settled'}); return;
  }
  let text;
  if (message === '__REMEMBER__') {
    text = history.at(-1)?.response ?? 'NOTHING';
  } else {
    text = `${prefix}:${message}`;
  }
  lastAssistantText = text;
  persistTurn(message, text);
  write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 10, output: 3, cacheRead: history.length > 1 ? 7 : 0, cacheWrite: 0, totalTokens: 13, cost: { total: 0 } } } });
  isStreaming = false;
  write({ type: 'agent_end', messages: [] });
  write({ type: 'agent_settled' });
  if (message === '__DUPLICATE_SETTLED__') write({type:'agent_settled'});
}

function startTurn(message, prefix = 'ECHO', delay = 15) {
  isStreaming = true;
  write({ type: 'agent_start' });
  timer = setTimeout(() => {
    timer = null;
    complete(message, prefix);
  }, delay);
}

async function handle(cmd) {
  log(cmd);
  switch (cmd.type) {
    case 'get_state':
      response(cmd, true, {
        model: { provider, id: model },
        thinkingLevel,
        isStreaming,
        isCompacting: false,
        sessionFile: sessionFile ?? null,
        sessionId: `fake-${process.pid}`,
        messageCount: history.length * 2,
        pendingMessageCount: 0,
        pid: process.pid,
      });
      break;
    case 'get_last_assistant_text':
      response(cmd, true, { text: lastAssistantText });
      break;
    case 'set_thinking_level':
      thinkingLevel = cmd.level;
      response(cmd, true, {});
      break;
    case 'prompt':
      if (cmd.message === '__WAIT_FOR_ACK__') break;
      if (isStreaming && !cmd.streamingBehavior) {
        response(cmd, false, undefined, 'prompt requires streamingBehavior while streaming');
        break;
      }
      response(cmd, true, {});
      startTurn(cmd.message, 'ECHO', cmd.message === '__SLOW__' ? 350 : 15);
      break;
    case 'steer':
      response(cmd, true, {});
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      startTurn(cmd.message, 'STEER', 15);
      break;
    case 'follow_up':
      response(cmd, true, {});
      if (isStreaming) {
        const poll = setInterval(() => {
          if (!isStreaming) {
            clearInterval(poll);
            startTurn(cmd.message, 'FOLLOW', 15);
          }
        }, 5);
      } else {
        startTurn(cmd.message, 'FOLLOW', 15);
      }
      break;
    case 'abort':
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      isStreaming = false;
      response(cmd, true, {});
      write({ type: 'agent_settled' });
      break;
    default:
      response(cmd, false, undefined, `unknown command: ${cmd.type}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); }
    catch (error) { process.stderr.write(`bad json: ${error.message}\n`); }
  }
});

process.on('SIGTERM', () => process.exit(0));
