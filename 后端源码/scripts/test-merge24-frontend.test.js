import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL('../../前端参考/' + name, import.meta.url), 'utf8');
const index = read('index.html');
const privateChat = read('friend-chat.html');
const extract = (source, start, end) => source.slice(source.lastIndexOf(start), source.indexOf(end, source.lastIndexOf(start)));

for (const response of [
  { code: 0, data: { blocked: true, care: { message: '支持渠道' } } },
  { code: 403, msg: '发送失败', data: { care: { message: '支持渠道' } } },
]) {
  test('private chat shows sender care before returning on code ' + response.code, async () => {
    const events = [];
    const ctx = vm.createContext({ inputEl: { value: '测试消息', focus() {} }, partnerId: 2,
      api: async () => response, __careCard: value => events.push(['care', value]),
      __botLine: () => events.push(['blocked']), alert: () => events.push(['error']),
      addBubble: () => assert.fail('A blocked/error message must not become a delivered bubble'),
    });
    vm.runInContext(extract(privateChat, 'async function send() {', '// 点头像看'), ctx);
    await vm.runInContext('send()', ctx);
    assert.equal(events[0][0], 'care');
    assert.equal(events[1][0], response.code ? 'error' : 'blocked');
  });

  test('group chat shows sender care before returning on code ' + response.code, async () => {
    const events = [];
    const input = { value: '测试消息' };
    const ctx = vm.createContext({ currentRoom: 'test',
      document: { getElementById: id => id === 'ginput' ? input : {} },
      api: async () => response, showGroupCare: value => events.push(['care', value]),
      showToast: () => events.push(['notice']),
    });
    vm.runInContext(extract(index, 'async function sendGroup() {', '// ===== 补一刀'), ctx);
    await vm.runInContext('sendGroup()', ctx);
    assert.equal(events[0][0], 'care');
    assert.equal(events[1][0], 'notice');
  });
}

class Element {
  constructor() { this.children = []; this.dataset = {}; this.style = {}; this.hidden = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  setAttribute(name, value) { this[name] = value; }
  querySelector(selector) { return this.children.find(child => '.' + child.className === selector) || null; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}

function conversationsContext(response) {
  const nodes = Object.fromEntries(['followedList', 'recentDmList', 'recentDmSection'].map(id => [id, new Element()]));
  const context = {
    location: {}, getToken: () => 'test-token', api: async () => response,
    setTimeout() {}, setInterval() {}, addEventListener() {},
    document: {
      createElement: () => new Element(),
      getElementById: id => nodes[id], addEventListener() {},
      querySelectorAll: selector => selector.includes(',')
        ? [...nodes.followedList.children, ...nodes.recentDmList.children]
        : nodes.followedList.children,
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(extract(index, 'function friendRow(', 'async function renderFollowedUsers'), context);
  const script = [...index.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('(function dmUnreadBadge()'))[1];
  vm.runInContext(script, context);
  return { context, nodes };
}

test('unfollowed message senders remain reachable and untrusted names stay text', async () => {
  const { context, nodes } = conversationsContext({ code: 0, data: { list: [
    { partner: { userId: 2, nick: '已关注' }, unread: 1, lastMessage: '问候' },
    { partner: { userId: 3, nick: '<img onerror=alert(1)>' }, unread: 4, lastMessage: '<script>alert(1)</script>' },
  ] } });
  const followed = new Element(); followed.dataset.uid = '2';
  nodes.followedList.appendChild(followed);
  await context.refreshDmUnread();
  assert.equal(nodes.recentDmSection.hidden, false);
  assert.equal(nodes.recentDmList.children.length, 1);
  const row = nodes.recentDmList.children[0];
  assert.equal(row.dataset.uid, '3');
  assert.equal(row.children[1].children[0].textContent, '<img onerror=alert(1)>');
  assert.equal(row.children[1].children[0].children.length, 0);
  assert.equal(row.querySelector('.dm-dot').textContent, '4');
  assert.equal(followed.querySelector('.dm-dot').textContent, '1');
  row.onclick();
  assert.equal(context.location.href, 'friend-chat.html?userId=3');
});

test('conversation API failure produces visible error instead of an empty result', async () => {
  const { context, nodes } = conversationsContext({ code: 500, msg: '服务暂不可用' });
  await context.refreshDmUnread();
  assert.equal(nodes.recentDmSection.hidden, false);
  assert.equal(nodes.recentDmList.textContent, '服务暂不可用');
});

test('blocked shared-diary messages cannot regain a navigation card through the wrapper', () => {
  const blocked = { blocked: true, content: '【分享日记#1】内容' };
  const ctx = vm.createContext({ addBubble: message => message,
    document: { createElement: () => assert.fail('Blocked content must not create a navigation card') },
  });
  const script = [...privateChat.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('const __shareCard'))[1];
  vm.runInContext(script, ctx);
  assert.equal(ctx.addBubble(blocked), blocked);
});
