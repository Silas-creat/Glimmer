import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTemporaryChat } = require('../../前端参考/chat-session.js');

const success = content => ({ code: 0, data: { reply: { content }, saved: false, provider: { provider: 'local' } } });

test('temporary chat sends explicit no-memory consent and retains only completed turns', async () => {
  const requests = [];
  const session = createTemporaryChat(async (url, options) => {
    requests.push({ url, body: options.body });
    return success('我在。');
  });
  await session.send('  今天有点累  ');
  await session.send('想整理一下');
  assert.equal(requests[0].url, '/ai/chat');
  assert.deepEqual(requests[0].body, { message: '今天有点累', remember: false, history: [] });
  assert.deepEqual(requests[1].body.history, [
    { role: 'user', content: '今天有点累' }, { role: 'assistant', content: '我在。' },
  ]);
});

test('a second submit cannot create another request while the first reply is pending', async () => {
  let release;
  let calls = 0;
  const session = createTemporaryChat(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = session.send('第一句话');
  await assert.rejects(session.send('重复回车'), /正在回复/);
  assert.equal(calls, 1);
  release(success('收到'));
  await first;
});

test('failed turns preserve care but are excluded from later model context', async () => {
  let fail = true;
  let nextBody;
  const care = { message: '请联系身边可信任的人', lines: [] };
  const session = createTemporaryChat(async (url, options) => {
    if (fail) return { code: 50200, msg: '暂时无法回应', data: { care } };
    nextBody = options.body;
    return success('你好');
  });
  await assert.rejects(session.send('尚未完成的对话'), error => error.message === '暂时无法回应' && error.care === care);
  fail = false;
  await session.send('再试一次');
  assert.deepEqual(nextBody.history, []);
});

test('history stays within the backend limit and long input never leaves the client', async () => {
  const requests = [];
  const session = createTemporaryChat(async (url, options) => { requests.push(options.body); return success('收到'); });
  for (let i = 0; i < 10; i++) await session.send('消息' + i);
  assert.equal(requests.at(-1).history.length, 16);
  assert.equal(requests.at(-1).history[0].content, '消息1');
  await assert.rejects(session.send('字'.repeat(2001)), /2000/);
  assert.equal(requests.length, 10);
});

test('long model replies remain fully visible without breaking subsequent history requests', async () => {
  const longReply = '字'.repeat(1999) + '🌱' + '后续内容';
  const requests = [];
  const session = createTemporaryChat(async (url, options) => {
    requests.push(options.body);
    assert.ok(options.body.history.every(item => item.content.length <= 2000));
    return success(requests.length === 1 ? longReply : '收到');
  });
  const first = await session.send('想继续聊');
  assert.equal(first.reply.content, longReply);
  await session.send('再聊一句');
  await session.send('继续');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].history[1].content, '字'.repeat(1999));
});
