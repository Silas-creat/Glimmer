// Synthetic DB boundaries only: no services, real users, credentials or models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { moderate, detectCrisis, maskSensitive, checkSpam } from '../src/utils/moderation.js';
import { resetViolations } from '../src/utils/chatBot.js';

const fixtures = new Map([
  ['/db/index.js', `
    export const query = (...args) => globalThis.merge24Fixture.query(...args);
    export const queryOne = async (...args) => (await query(...args))[0] || null;
    export const insert = (...args) => globalThis.merge24Fixture.write(...args).insertId;
    export const execute = (...args) => globalThis.merge24Fixture.write(...args).affectedRows;
    export const transaction = async fn => fn({ execute: async (...args) => [globalThis.merge24Fixture.write(...args)] });
  `],
  ['/middleware/auth.js', 'export const auth = (req,res,next) => next();'],
  ['/middleware/upload.js', "export const avatarUrl = value => value || '';"],
  ['/config/index.js', 'export const config = {};'],
]);
const hooks = registerHooks({ load(url, context, next) {
  for (const [suffix, source] of fixtures) if (url.endsWith(suffix)) return { format: 'module', source, shortCircuit: true };
  return next(url, context);
} });
process.env.MESSAGE_SEND_INTERVAL_MS = '3000';
const message = (await import('../src/routes/message.js')).default;
const group = (await import('../src/routes/group.js')).default;
hooks.deregister();

function fixture({ text = '普通消息', mute = 0, ago = 5000 } = {}) {
  resetViolations();
  const writes = [];
  globalThis.merge24Fixture = {
    write(sql, params) { writes.push({ sql, params }); return { insertId: 31, affectedRows: 1 }; },
    async query(sql, params) {
      if (/^\s*(UPDATE|INSERT|DELETE)/.test(sql)) return this.write(sql, params);
      if (/FROM conversations/.test(sql)) return [{ id: 11, user_a: 71, user_b: 72, blocked_by: null }];
      if (/ago_ms/.test(sql)) return [{ id: 30, ago_ms: ago }];
      if (/FROM messages/.test(sql)) return [{ id: 31, from_user: 71, to_user: 72, content: text, status: 'normal', created_at: '2026-11-12 12:00:00' }];
      if (/FROM notifications/.test(sql)) return [];
      if (/FROM chat_rooms/.test(sql)) return [{ id: 12, code: 'interest', kind: 'interest' }];
      if (/END AS s/.test(sql)) return [{ s: mute }];
      if (/FROM chat_members/.test(sql)) return [{ id: 13, last_read_id: 0 }];
      if (/FROM chat_messages/.test(sql)) return [{ id: 31, user_id: 71, content: text, type: 'text', created_at: '2026-11-12 12:00:00' }];
      throw new Error('Unexpected fixture SQL: ' + sql);
    },
  };
  return writes;
}
async function request(router, path, content, params = {}) {
  const route = router.stack.find(x => x.route?.path === path && x.route.methods.post);
  let result;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(payload) { result = { status: this.statusCode, ...payload }; return this; } };
  await route.route.stack.at(-1).handle({ uid: 71, user: { nickname: 'synthetic' }, params,
    body: { content, convId: 11 } }, res, e => { result = { status: e.httpStatus || 500, msg: e.message }; });
  return result;
}
const care = result => assert.ok(result.data?.care?.lines.some(x => x.phone === '12356'));

test('expanded abusive language detects spacing and zero-width obfuscation', () => {
  for (const text of ['你们都是傻逼吧', '脑子进屎了', '你个傻 逼', '你个傻\u200b逼', 'sb', 'SB', '你这个蠢猪']) {
    assert.equal(moderate(text).cat, '人身攻击', text);
  }
});
test('normal health, debt and security discussions are not punished', () => {
  for (const text of ['今天参加我们学校的活动', '去医院拍片，医生说需要麻醉', '验证码收不到怎么办',
    '给妈妈转账了', '网贷让我压力很大', '今天了解了神经病学', '脑瘫患者需要支持', '最近有些抑郁',
    '我快被逼疯了', 'absb subs', '请不要把验证码告诉别人']) assert.equal(moderate(text).ok, true, text);
});
test('explicit recruitment and credential solicitation remain blocked', () => {
  for (const text of ['扫码转账领奖', '招代理，一手货源，月入过万', '把验证码发给我', '需要网贷的私信我', '代考包过']) {
    assert.equal(moderate(text).ok, false, text);
  }
});
test('new crisis phrases including split characters are independently detected', () => {
  for (const text of ['我想轻生', '我想自尽', '想跳河', '想吞药', '活不下去了', '想结束这一切', '加我微信 abc123，我不 想 活了']) {
    assert.equal(detectCrisis(text), true, text);
  }
});
test('privacy number mask covers every occurrence and emoji uses codepoints', () => {
  const text = '110101199001011234 110101199001011234';
  assert.equal(moderate('110101199001011234').cat, '隐私');
  assert.ok(!maskSensitive(text).includes('110101199001011234'));
  assert.equal(checkSpam('😀'.repeat(4)).ok, true);
  assert.equal(checkSpam('😀'.repeat(16)).ok, false);
});
test('muted ordinary group messages remain rejected', async () => {
  const writes = fixture({ mute: 30 });
  assert.equal((await request(group, '/rooms/:key/messages', '大家好', { key: 'interest' })).status, 429);
  assert.equal(writes.length, 0);
});
test('muted pure crisis reaches group support', async () => {
  fixture({ text: '撑不下去了', mute: 30 });
  const result = await request(group, '/rooms/:key/messages', '撑不下去了', { key: 'interest' });
  assert.equal(result.status, 200);
  assert.equal(result.data.blocked, false);
  care(result);
});
test('muted mixed crisis returns care without broadcasting prohibited text', async () => {
  const text = '想消失，扫码转账领奖';
  const writes = fixture({ text, mute: 300 });
  const result = await request(group, '/rooms/:key/messages', text, { key: 'interest' });
  assert.equal(result.status, 200);
  assert.equal(result.data.blocked, true);
  care(result);
  assert.ok(!writes.some(x => /INSERT INTO chat_messages/.test(x.sql) && x.params.includes(text)));
});
test('DM frequency still rejects ordinary bursts', async () => {
  const writes = fixture({ ago: 0 });
  assert.equal((await request(message, '/send', '大家好')).status, 429);
  assert.equal(writes.length, 0);
});
test('DM pure crisis bypasses frequency but receives private care', async () => {
  fixture({ text: '撑不下去了', ago: 0 });
  const result = await request(message, '/send', '撑不下去了');
  assert.equal(result.status, 200);
  assert.equal(result.data.blocked, false);
  care(result);
});
test('DM mixed crisis bypasses frequency only for feedback, never delivery', async () => {
  const text = '我不想活了，你个傻逼';
  const writes = fixture({ text, ago: 0 });
  const result = await request(message, '/send', text);
  assert.equal(result.status, 200);
  assert.equal(result.data.blocked, true);
  care(result);
  assert.ok(writes.some(x => /'blocked'/.test(x.sql)));
  assert.ok(!writes.some(x => /UPDATE conversations|'normal'/.test(x.sql)));
});
test('private bot escalation never claims mute or hypothetical future sanctions', async () => {
  fixture();
  for (let i = 0; i < 3; i++) {
    const result = await request(message, '/send', '你个傻逼');
    assert.equal(result.data?.bot, true);
    assert.equal(result.data.violationCount, i + 1);
    assert.ok(!/禁言|限制发言|安静.*(秒|分钟)/.test(result.data.botNotice));
  }
});
test('normal DM relies on conversation unread without duplicate notification writes', async () => {
  const writes = fixture();
  assert.equal((await request(message, '/send', '今天过得怎样')).status, 200);
  assert.ok(writes.some(x => /UPDATE conversations/.test(x.sql)));
  assert.ok(!writes.some(x => /notifications/.test(x.sql)));
});
test('blocked private text is absent from runtime logs', async () => {
  const text = '110101199001011234';
  fixture({ text });
  const logs = [];
  const old = console.log;
  console.log = (...parts) => logs.push(parts.join(' '));
  try { assert.equal((await request(message, '/send', text)).data.blocked, true); } finally { console.log = old; }
  assert.ok(logs.every(x => !x.includes(text)));
});
