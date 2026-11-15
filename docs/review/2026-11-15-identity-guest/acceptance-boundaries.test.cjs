// Independent acceptance assertions: exit 0 means all expected behaviors pass.
// Uses the existing lightweight DOM fixture; never edits production files or calls a live API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, '后端源码/scripts/test-chat-companion-repair.test.js'), 'utf8');
const fixture = source.slice(source.indexOf('class El {'), source.indexOf('const chatSuccess ='));
const { setup, deferred, flush } = new Function('fs', 'vm', 'ROOT', fixture + '\nreturn { setup, deferred, flush };')(fs, vm, path.join(root, '前端参考') + path.sep);
const reply = { code: 0, data: { reply: { content: 'synthetic guest reply' }, saved: false, provider: { isReal: false } } };
const guest = handler => setup(handler || (url => url === '/ai/chat' ? reply : { code: 0, data: {} }), { user: {}, token: '' });
const send = async (s, text) => {
  s.nodes.input.value = text;
  await s.nodes.send.emit('click');
  await flush();
};

test('F1: late A verification after storage-switch must not submit A material with B credentials', async () => {
  const verification = deferred();
  const posts = [];
  const s = setup((url, opts) => {
    if (url === '/auth/me') return verification.promise;
    if (url === '/companion/prepare') {
      posts.push(opts.body);
      return { code: 0, data: { draft: { id: 'synthetic', status: 'pending' } } };
    }
    return { code: 0, data: {} };
  });
  s.ui.state.turns = [{ role: 'user', content: 'A synthetic private material' }];
  await s.action('draft');
  s.nodes['cc-panel-body'].querySelectorAll = () => [{ value: '0' }];
  s.setAccount({ uid: 'A' }, 'token-A-refreshed');
  const pending = s.findButton('生成草稿').onclick();
  await flush();
  assert.equal(s.calls.filter(c => c.url === '/auth/me').length, 1);
  s.setAccount({ uid: 'B' }, 'token-B');
  s.emitStorage('wg_user');
  verification.resolve({ code: 0, data: { user: { uid: 'A' } } });
  await pending;
  assert.equal(posts.length, 0);
  assert.equal(s.ui.state.uid, 'B');
  assert.equal(s.ui.state.mode, 'temporary');
  assert.doesNotMatch(s.nodes.chat.textContent, /A synthetic private material/);
});

test('G1: a guest can send three consecutive messages with unsaved page-local context', async () => {
  const s = guest();
  await send(s, 'synthetic first message');
  await send(s, 'synthetic second message');
  const afterSecond = s.calls.filter(c => c.url === '/ai/chat');
  assert.equal(afterSecond.length, 2, 'second guest message must reach the API');
  assert.equal(afterSecond[1].body.history.length, 2);
  await send(s, 'synthetic third message');
  const chats = s.calls.filter(c => c.url === '/ai/chat');
  assert.equal(chats.length, 3);
  assert.equal(chats[2].body.history.length, 4);
  assert.ok(chats.every(c => c.body.remember === false));
  assert.equal(s.calls.some(c => c.url === '/auth/me'), false);
  assert.equal(s.ui.state.turns.length, 6);
  assert.doesNotMatch(s.nodes['cc-save-state'].textContent, /登录状态已失效/);
});

test('G2: a login-only tool must preserve legitimate guest conversation', async () => {
  const s = guest();
  await send(s, 'synthetic guest context');
  await s.action('history');
  assert.match(s.nodes['cc-panel-body'].textContent, /登录后才能/);
  assert.match(s.nodes.chat.textContent, /synthetic guest context/, 'opening history must not erase guest turns');
  assert.equal(s.ui.state.turns.length, 2);
  assert.equal(s.calls.some(c => c.url === '/ai/messages'), false);
  s.ui.closePanel();
  await send(s, 'synthetic follow-up');
  assert.equal(s.calls.filter(c => c.url === '/ai/chat').length, 2);
});

test('G3: a guest may retry a failed request without the restored input being discarded', async () => {
  let attempts = 0;
  const s = guest(url => {
    if (url === '/ai/chat') return ++attempts === 1 ? { code: 50000, msg: 'synthetic request failed' } : reply;
    return { code: 0, data: {} };
  });
  await send(s, 'synthetic retry text');
  assert.equal(s.nodes.input.value, 'synthetic retry text');
  await s.nodes.send.emit('click');
  await flush();
  assert.equal(attempts, 2, 'retry must reach the API');
  assert.match(s.nodes.chat.textContent, /synthetic guest reply/);
});
