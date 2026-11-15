import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTemporaryChat, createSavedChat } = require('../../前端参考/chat-session.js');
const companion = require('../../前端参考/chat-companion.js');

const success = content => ({ code: 0, data: { reply: { content }, saved: true } });

test('saved chat sends explicit remember:true with an empty client history', async () => {
  const requests = [];
  const session = createSavedChat(async (url, options) => {
    requests.push({ url, options });
    return success('我记下了。');
  });
  await session.send('  今天散步了  ');
  await session.send('再记一句');
  assert.equal(requests[0].url, '/ai/chat');
  assert.deepEqual(requests[0].options.body, { message: '今天散步了', remember: true, history: [] });
  assert.equal(requests[0].options.silent401, true);
  assert.deepEqual(requests[1].options.body, { message: '再记一句', remember: true, history: [] });
});

test('temporary reset clears the next request history without changing the request shape', async () => {
  const requests = [];
  const session = createTemporaryChat(async (url, options) => {
    requests.push({ url, options });
    return success('收到');
  });
  await session.send('第一句');
  session.reset();
  await session.send('重置后');
  assert.deepEqual(requests[1].options.body.history, []);
  assert.equal(requests[1].options.body.remember, false);
  assert.equal(requests[1].options.silent401, undefined);
});

test('invalidate makes an in-flight response stale without changing the protocol', async () => {
  let release;
  const session = createTemporaryChat(() => new Promise(resolve => { release = resolve; }));
  const token = session.generation;
  const pending = session.send('清除前的消息');
  session.invalidate();
  release(success('迟到的回复'));
  await pending;
  assert.equal(session.isStale(token), true);
  assert.equal(session.isStale(session.generation), false);
});

test('save preference is scoped to the current uid and defaults to off', () => {
  const values = new Map();
  const storage = {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
  assert.equal(companion.saveModeKey('u1'), 'wg_ai_save_mode_u1');
  assert.equal(companion.readSaveMode('u1', storage), 'off');
  companion.writeSaveMode('u1', true, storage);
  assert.equal(companion.readSaveMode('u1', storage), 'on');
  assert.equal(companion.readSaveMode('u2', storage), 'off');
  assert.equal(companion.readSaveMode('', storage), 'off');
});

test('user id accepts both uid and id and never leaks other fields', () => {
  assert.equal(companion.readUserId({ uid: 'u-1', id: 9, phone: '13800000000' }), 'u-1');
  assert.equal(companion.readUserId({ id: 9 }), '9');
  assert.equal(companion.readUserId(null), '');
});

test('draft material keeps the selected order and rejects empty or over-2000 content', () => {
  const exact = companion.buildDraftMaterial(['字'.repeat(2000)]);
  assert.equal(exact.ok, true);
  assert.equal(exact.text.length, 2000);
  assert.deepEqual(companion.buildDraftMaterial(['第一段', ' 第二段 ']).text, '第一段\n第二段');
  const tooLong = companion.buildDraftMaterial(['字'.repeat(2001)]);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'TOO_LONG');
  assert.equal(companion.buildDraftMaterial([]).code, 'EMPTY');
  assert.equal(companion.buildDraftMaterial(['   ']).code, 'EMPTY');
});

test('draft text validation allows 5000 and rejects 5001 UTF-16 units', () => {
  assert.equal(companion.draftTextIssue('字'.repeat(5000)), '');
  assert.match(companion.draftTextIssue('字'.repeat(5001)), /5000/);
  assert.match(companion.draftTextIssue('   '), /不能为空/);
});

test('local date key uses calendar fields instead of UTC', () => {
  assert.equal(companion.localDateKey(new Date(2026, 0, 2, 23, 30)), '2026-01-02');
  assert.equal(companion.localDateKey(new Date(2026, 10, 13, 0, 5)), '2026-11-13');
  assert.equal(companion.isValidDateKey('2026-02-30'), false);
  assert.equal(companion.isValidDateKey('2026-11-13'), true);
});

test('older history pages are prepended and de-duplicated by id', () => {
  const page1 = [{ id: 2, content: 'b' }, { id: 3, content: 'c' }];
  const page2 = [{ id: 1, content: 'a' }, { id: 2, content: 'b' }];
  assert.deepEqual(companion.mergeHistoryPages(page1, page2).map(item => item.id), [1, 2, 3]);
  assert.deepEqual(companion.mergeHistoryPages([], page1).map(item => item.id), [2, 3]);
});

test('draft error codes map to actionable states', () => {
  assert.equal(companion.mapDraftError(40900).conflict, true);
  assert.equal(companion.mapDraftError({ code: 41000 }).expired, true);
  assert.equal(companion.mapDraftError({ code: 40400 }).needsPrepare, true);
  assert.equal(companion.mapDraftError({ code: 40100 }).needsLogin, true);
  assert.equal(companion.mapDraftError({ code: -1 }).uncertain, true);
  assert.equal(companion.mapDraftError({ code: 40000, msg: '日期无效' }).message, '日期无效');
});

test('only same-site diary write links are accepted', () => {
  assert.equal(companion.isSafeDiaryUrl('diary-write.html?date=2026-11-13'), true);
  assert.equal(companion.isSafeDiaryUrl('./diary-write.html?date=2026-11-13'), true);
  assert.equal(companion.isSafeDiaryUrl('/diary-write.html?date=2026-11-13'), true);
  assert.equal(companion.isSafeDiaryUrl('https://example.com/diary-write.html?date=2026-11-13'), false);
  assert.equal(companion.isSafeDiaryUrl('javascript:alert(1)'), false);
  assert.equal(companion.isSafeDiaryUrl('//example.com/diary-write.html?date=2026-11-13'), false);
  assert.equal(companion.isSafeDiaryUrl('diary-write.html?date=2026-02-30'), false);
  assert.equal(companion.isSafeDiaryUrl('diary-write.html?date=2026-11-13&x=1'), false);
});

test('provider status never presents the local fallback as a real model', () => {
  assert.equal(companion.providerText({ isReal: true }, false, false), '已连接 AI 服务');
  assert.equal(companion.providerText({ isReal: false }, false, false), '本地支持回复，未使用大模型');
  assert.equal(companion.providerText({ isReal: true }, true, false), '本地支持回复，未使用大模型');
  assert.equal(companion.providerText({ isReal: true }, false, true), '已配置 AI 服务，发送后确认响应');
});