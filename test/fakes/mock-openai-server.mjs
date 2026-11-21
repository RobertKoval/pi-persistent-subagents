#!/usr/bin/env node
// Deterministic OpenAI-compatible chat-completions server for zero-cost Pi runs.
// Directives in the last user message: DELAY=<ms> streams the reply slowly;
// FAIL=<status> answers with that HTTP status; RECALL replies with the first
// MARKER=<word> seen in the conversation. Every request is appended to MOCK_LLM_LOG.
import http from 'node:http';
import fs from 'node:fs';

const log = process.env.MOCK_LLM_LOG;
const text = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(p => p?.text ?? '').join('') : '';
const tokens = (s) => Math.max(1, Math.ceil(s.length / 4));

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }
    const request = JSON.parse(body);
    const messages = request.messages ?? [];
    const users = messages.filter(m => m.role === 'user').map(m => text(m.content));
    const last = users.at(-1) ?? '';
    const all = messages.map(m => text(m.content)).join('\n');
    if (log) fs.appendFileSync(log, JSON.stringify({ at: Date.now(), model: request.model, last: last.slice(0, 200), messages: messages.length }) + '\n');
    const fail = /FAIL=(\d{3})/.exec(last);
    if (fail) {
      res.writeHead(Number(fail[1]), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock failure ' + fail[1], type: 'invalid_request_error' } }));
      return;
    }
    const delay = Number(/DELAY=(\d+)/.exec(last)?.[1] ?? 0);
    const summary = /summar/i.test(text(messages[0]?.content)) && /summar/i.test(last);
    const marker = /MARKER=(\w+)/.exec(all)?.[1];
    const reply = summary ? 'SUMMARY: earlier work condensed.'
      : /RECALL/.test(last) ? 'RECALLED:' + (marker ?? 'NONE')
      : 'ECHO:' + last.replace(/\s+/g, ' ').trim().slice(0, 120);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({
      id: 'mock', object: 'chat.completion.chunk', created: 0, model: request.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) + '\n\n');
    const parts = reply.match(/.{1,8}/g) ?? [reply];
    chunk({ role: 'assistant', content: '' });
    for (const part of parts) {
      if (res.destroyed) return;
      chunk({ content: part });
      if (delay) await new Promise(r => setTimeout(r, delay / parts.length));
    }
    chunk({}, 'stop');
    const prompt = tokens(all);
    res.write('data: ' + JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: tokens(reply), total_tokens: prompt + tokens(reply) } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
server.listen(Number(process.env.MOCK_LLM_PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
