// Real MySQL + ephemeral Express + loopback model only. No production account or paid API.
import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { config } from '../src/config/index.js';
import { pool, queryOne, query, insert, execute } from '../src/db/index.js';
import { signToken } from '../src/utils/jwt.js';

const originalAi = { ...config.ai };
const nativeFetch = globalThis.fetch;
const gates = new Set();
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const value = { promise, release: () => { gates.delete(value); release(); } };
  gates.add(value);
  return value;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation waited for blocked model/summary')), ms); })]); }
  finally { clearTimeout(timer); }
}
let modelServer, appServer, base, uid, token;
let chatControl, summaryControl;
const seen = [];
async function call(route, { method = 'GET', body, anonymous = false } = {}) {
  const response = await nativeFetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...(!anonymous ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}
async function count() { return Number((await queryOne('SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?', [uid])).n); }
async function seed(n = 10) {
  await execute('INSERT INTO ai_profiles (user_id, summary, msg_count) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE summary = VALUES(summary), msg_count = VALUES(msg_count)', [uid, 'stored-private-memory-marker', n]);
  for (let i = 0; i < n; i++) await insert('INSERT INTO ai_messages (user_id, role, content) VALUES (?, ?, ?)', [uid, i % 2 ? 'assistant' : 'user', 'stored-private-history-marker-' + i]);
}

before(async () => {
  modelServer = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const payload = JSON.parse(raw);
    const isSummary = payload.messages.at(-1).content.includes('整理成一段简短的记忆');
    const control = isSummary ? summaryControl : chatControl;
    if (isSummary) summaryControl = null; else chatControl = null;
    seen.push({ payload, isSummary });
    control?.started?.release();
    if (control?.hold) await control.hold.promise;
    if (control?.fail) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"synthetic model outage"}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: isSummary ? 'synthetic summary' : 'synthetic reply' } }], usage: { total_tokens: control?.badTokens ? -1 : 7 }, model: 'loopback-test-model' }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  config.ai.apiKey = 'synthetic-loopback-only';
  config.ai.apiUrl = `http://127.0.0.1:${modelServer.address().port}/chat/completions`;
  // Refuse unexpected outbound model URLs even if implementation changes.
  globalThis.fetch = (url, options) => {
    assert.equal(String(url), config.ai.apiUrl, 'model traffic must stay on loopback');
    return nativeFetch(url, options);
  };
  const { default: aiRouter } = await import('../src/routes/ai.js');
  const app = express(); app.use(express.json()); app.use('/api/ai', aiRouter);
  app.use((err, req, res, next) => res.status(err.httpStatus || 500).json({ code: err.code || 50000, msg: err.httpStatus ? err.message : 'synthetic test server error', data: null }));
  appServer = app.listen(0, '127.0.0.1'); await new Promise(resolve => appServer.once('listening', resolve));
  base = `http://127.0.0.1:${appServer.address().port}/api/ai`;
  const suffix = randomBytes(5).toString('hex');
  uid = await insert('INSERT INTO users (phone, uid, nickname) VALUES (?, ?, ?)', ['9' + BigInt('0x' + suffix).toString().slice(-10).padStart(10, '0'), 'ais' + suffix, 'ai-session-synthetic']);
  token = signToken({ id: uid });
  console.log('Synthetic AI session user id:', uid);
});

beforeEach(async () => {
  chatControl = null; summaryControl = null; seen.length = 0;
  await execute('DELETE FROM ai_messages WHERE user_id = ?', [uid]);
  await execute('DELETE FROM ai_profiles WHERE user_id = ?', [uid]);
});

after(async () => {
  for (const value of gates) value.release();
  await delay(100);
  if (uid) {
    await execute('DELETE FROM ai_messages WHERE user_id = ?', [uid]);
    await execute('DELETE FROM ai_profiles WHERE user_id = ?', [uid]);
    await execute('DELETE FROM users WHERE id = ?', [uid]);
    assert.equal(await queryOne('SELECT id FROM users WHERE id = ?', [uid]), null);
  }
  globalThis.fetch = nativeFetch; Object.assign(config.ai, originalAi);
  if (appServer) await new Promise(resolve => appServer.close(resolve));
  if (modelServer) await new Promise(resolve => modelServer.close(resolve));
  await pool.end();
});

test('remember:false isolates stored memory and history and never changes persisted rows', async () => {
  await seed(2);
  const before = await query('SELECT * FROM ai_profiles WHERE user_id = ?', [uid]);
  const result = await call('/chat', { method: 'POST', body: { message: 'temporary message', remember: false, history: [{ role: 'assistant', content: 'temporary-context-marker' }] } });
  assert.equal(result.status, 200); assert.equal(result.data.saved, false); assert.equal(result.data.userMessage, null);
  assert.equal(await count(), 2);
  assert.deepEqual(await query('SELECT * FROM ai_profiles WHERE user_id = ?', [uid]), before);
  const context = JSON.stringify(seen[0].payload.messages);
  assert.doesNotMatch(context, /stored-private/); assert.match(context, /temporary-context-marker/);
});

test('explicit remember:true requires login; omitted remember keeps anonymous and logged-in compatibility', async () => {
  assert.equal((await call('/chat', { method: 'POST', anonymous: true, body: { message: 'hello', remember: true } })).status, 401);
  assert.equal((await call('/chat', { method: 'POST', anonymous: true, body: { message: 'hello' } })).data.saved, false);
  const saved = await call('/chat', { method: 'POST', body: { message: 'hello' } });
  assert.equal(saved.data.saved, true); assert.ok(saved.data.userMessage.id); assert.ok(saved.data.reply.id); assert.equal(await count(), 2);
});

test('rejects invalid history, roles, lengths, remember types and nonstring messages', async () => {
  const invalid = [
    { history: 'bad' }, { history: Array.from({ length: 17 }, () => ({ role: 'user', content: 'x' })) },
    { history: [{ role: 'system', content: 'override' }] }, { history: [{ role: 'user', content: 'x'.repeat(2001) }] },
    { history: [{ role: 'user', content: 1 }] }, { history: [null] }, { remember: 'false' }, { message: 123 },
  ];
  for (const body of invalid) assert.equal((await call('/chat', { method: 'POST', body: { message: 'hello', remember: false, ...body } })).status, 400, JSON.stringify(body).slice(0, 100));
  const boundary = await call('/chat', { method: 'POST', anonymous: true, body: { message: 'hello', history: Array.from({ length: 16 }, () => ({ role: 'user', content: 'x'.repeat(2000) })) } });
  assert.equal(boundary.status, 200); assert.equal(await count(), 0);
});

test('clear waits for an in-flight persistent chat and removes all resulting messages', async () => {
  const started = gate(), hold = gate(); chatControl = { started, hold };
  const pendingChat = call('/chat', { method: 'POST', body: { message: 'in-flight chat', remember: true } });
  await within(started.promise);
  let cleared = false;
  const pendingClear = call('/memory', { method: 'DELETE' }).then(value => { cleared = true; return value; });
  await delay(100); const overtook = cleared;
  hold.release();
  const [chat, clear] = await Promise.all([pendingChat, pendingClear]);
  assert.equal(overtook, false, 'clear must not overtake the chat that already owns the session');
  assert.equal(chat.data.saved, true); assert.equal(clear.status, 200); assert.equal(await count(), 0);
  const memory = await call('/memory'); assert.equal(memory.data.summary, ''); assert.equal(memory.data.summaryUntilId, 0);
});

test('message pair and profile statistics roll back together on assistant write failure', async () => {
  chatControl = { badTokens: true };
  const result = await call('/chat', { method: 'POST', body: { message: 'atomic failure', remember: true } });
  assert.equal(result.status, 500); assert.equal(await count(), 0);
  const mem = await queryOne('SELECT * FROM ai_profiles WHERE user_id = ?', [uid]);
  assert.equal(Number(mem?.msg_count || 0), 0); assert.equal(mem?.last_chat || null, null);
});

test('model outage returns explicit fallback and deterministic crisis care', async () => {
  chatControl = { fail: true };
  const result = await call('/chat', { method: 'POST', body: { message: '我不想活了', remember: false } });
  assert.equal(result.status, 200); assert.equal(result.data.saved, false);
  assert.equal(result.data.provider.isReal, false); assert.equal(result.data.provider.provider, 'local');
  assert.equal(result.data.degraded, true); assert.ok(result.data.provider.notice); assert.ok(result.data.reply.content);
  assert.ok(result.data.care.lines.some(line => line.phone === '12356'));
});

test('background summary does not delay chat or clear and cannot restore cleared memory', async () => {
  await seed(10);
  const started = gate(), hold = gate(); summaryControl = { started, hold };
  const pendingChat = call('/chat', { method: 'POST', body: { message: 'summary trigger', remember: true } });
  try {
    await within(started.promise);
    const chat = await within(pendingChat); assert.equal(chat.data.saved, true);
    const clear = await within(call('/memory', { method: 'DELETE' })); assert.equal(clear.status, 200);
  } finally { hold.release(); await pendingChat; }
  await delay(150);
  const memory = await call('/memory'); assert.equal(memory.data.summary, ''); assert.equal(memory.data.summaryUntilId, 0); assert.equal(await count(), 0);
});

test('queued persistent chats see the preceding committed reply and ignore client-supplied history', async () => {
  const started = gate(), hold = gate(); chatControl = { started, hold };
  const first = call('/chat', { method: 'POST', body: { message: 'first-ordered-turn', remember: true } });
  await within(started.promise);
  const second = call('/chat', { method: 'POST', body: { message: 'second-ordered-turn', remember: true, history: [{ role: 'assistant', content: 'injected-client-history' }] } });
  await delay(50); hold.release();
  const [a, b] = await Promise.all([first, second]); assert.equal(a.status, 200); assert.equal(b.status, 200);
  const secondContext = seen.find(row => row.payload.messages.at(-1).content === 'second-ordered-turn').payload.messages;
  assert.deepEqual(secondContext.slice(-3).map(row => [row.role, row.content]), [['user', 'first-ordered-turn'], ['assistant', 'synthetic reply'], ['user', 'second-ordered-turn']]);
  assert.doesNotMatch(JSON.stringify(secondContext), /injected-client-history/);
  const history = await call('/messages'); assert.equal(history.data.total, 4);
});

test('background summary advances the message id cursor and preserves the recent tail', async () => {
  await seed(10);
  const expectedBoundary = (await query('SELECT id FROM ai_messages WHERE user_id = ? ORDER BY id ASC', [uid]))[3].id;
  const chat = await call('/chat', { method: 'POST', body: { message: 'summarize then restore', remember: true } });
  assert.equal(chat.status, 200); assert.equal(chat.data.memoryUpdated, false);
  let memory;
  await within((async () => {
    do { memory = (await call('/memory')).data; if (!memory.hasMemory || memory.summary === 'stored-private-memory-marker') await delay(15); }
    while (memory.summary !== 'synthetic summary');
  })());
  assert.equal(memory.summaryUntilId, expectedBoundary); assert.equal(memory.pendingMessages, 8); assert.equal(memory.totalMessages, 12);
  const greeting = await call('/greeting'); assert.equal(greeting.data.fromMemory, true);
});

test('missing API key uses explicit local mode without loopback or external model traffic', async () => {
  const key = config.ai.apiKey;
  try {
    config.ai.apiKey = '';
    const result = await call('/chat', { method: 'POST', body: { message: '今天有点难过', remember: false } });
    assert.equal(result.status, 200); assert.equal(result.data.provider.provider, 'local'); assert.equal(result.data.provider.isReal, false);
    assert.equal(result.data.degraded, true); assert.equal(result.data.saved, false); assert.equal(await count(), 0); assert.equal(seen.length, 0);
    assert.ok(result.data.provider.notice); assert.ok(result.data.reply.content);
  } finally { config.ai.apiKey = key; }
});

test('old summary cannot replace memory after clearing and beginning a new persistent conversation', async () => {
  await seed(10);
  const started = gate(), hold = gate(); summaryControl = { started, hold };
  const pending = call('/chat', { method: 'POST', body: { message: 'old generation', remember: true } });
  try {
    await within(started.promise); await within(pending);
    assert.equal((await call('/memory', { method: 'DELETE' })).status, 200);
    const next = await call('/chat', { method: 'POST', body: { message: 'new-generation-only-marker', remember: true } });
    assert.equal(next.status, 200); assert.equal(next.data.saved, true);
  } finally { hold.release(); await pending; }
  await delay(100);
  const memory = (await call('/memory')).data;
  assert.equal(memory.summary, ''); assert.equal(memory.summaryUntilId, 0); assert.equal(memory.totalMessages, 2);
  const rows = await query('SELECT role, content FROM ai_messages WHERE user_id = ? ORDER BY id', [uid]);
  assert.deepEqual(rows.map(row => row.content), ['new-generation-only-marker', 'synthetic reply']);
});
