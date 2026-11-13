// Synthetic-only policy regression. No app server, database, credentials or models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { detectCrisis, moderate } from '../src/utils/moderation.js';
import { reviewGroupMessage, resetViolations } from '../src/utils/chatBot.js';

const fixtures = new Map([
  ['/db/index.js', `
    export const query = (...args) => globalThis.crisisFixture.query(...args);
    export const queryOne = async (...args) => (await query(...args))[0] || null;
    export const insert = (...args) => globalThis.crisisFixture.write(...args).insertId;
    export const execute = (...args) => globalThis.crisisFixture.write(...args).affectedRows;
    export const transaction = async fn => fn({ execute: async (...args) => [globalThis.crisisFixture.write(...args)] });
  `],
  ['/middleware/auth.js', 'export const auth = (req,res,next) => next(); export const authOptional = auth;'],
  ['/middleware/upload.js', "export const avatarUrl = value => value || '';"],
  ['/config/index.js', 'export const config = {};'],
]);
const hook = registerHooks({
  load(url, context, nextLoad) {
    for (const [suffix, source] of fixtures) {
      if (url.endsWith(suffix)) return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
process.env.MESSAGE_SEND_INTERVAL_MS = '0';
const diary = (await import('../src/routes/diary.js')).default;
const comment = (await import('../src/routes/comment.js')).default;
const message = (await import('../src/routes/message.js')).default;
const group = (await import('../src/routes/group.js')).default;
const bless = (await import('../src/routes/bless.js')).default;
const bottle = (await import('../src/routes/bottle.js')).default;
hook.deregister();

function fixture(text) {
  const writes = [];
  const row = { id: 31, user_id: 71, diary_id: 31, is_public: 0, date_key: '2026-11-12',
    text, content: text, comment_count: 1, created_at: '2026-11-12 12:00:00', status: 'normal' };
  globalThis.crisisFixture = {
    writes,
    write(sql, params) { writes.push({ sql, params }); return { insertId: 31, affectedRows: 1 }; },
    async query(sql, params) {
      if (/^\s*(UPDATE|DELETE|INSERT)/.test(sql)) return this.write(sql, params);
      if (/SELECT id FROM diaries WHERE user_id/.test(sql)) return [];
      // DIARY_SELECT 的收藏数子查询也包含 FROM favorites；先匹配外层日记行。
      if (/FROM diaries d/.test(sql)) return [row];
      if (/FROM (likes|favorites|follows)/.test(sql)) return [];
      if (/FROM notifications/.test(sql)) return [];
      if (/FROM users/.test(sql)) return [{ id: 72, nickname: 'synthetic target' }];
      if (/FROM blessings\s+WHERE/.test(sql)) return [];
      if (/FROM blessings b/.test(sql)) return [{ ...row, from_user: 71, to_user: 72 }];
      if (/ago_sec/.test(sql) || /FROM bottles WHERE user_id/.test(sql)) return [];
      if (/FROM bottles/.test(sql)) return [{ ...row, user_id: 72, is_anon: 1 }];
      if (/FROM conversations/.test(sql)) return [{ id: 11, user_a: 71, user_b: 72, blocked_by: null }];
      if (/FROM chat_rooms/.test(sql)) return [{ id: 12, code: 'interest', kind: 'interest' }];
      if (/remain_seconds/.test(sql)) return [{ remain_seconds: 0 }];
      if (/FROM chat_members/.test(sql)) return [{ id: 13, last_read_id: 0, muted_until: null }];
      if (/FROM chat_messages/.test(sql)) return [{ ...row, room_id: 12, type: 'text' }];
      if (/FROM messages/.test(sql)) return [{ ...row, conv_id: 11, from_user: 71, to_user: 72 }];
      if (/FROM (diaries|comments)/.test(sql)) return [row];
      throw new Error('Unexpected fixture SQL: ' + sql);
    },
  };
  return writes;
}

async function request(router, method, path, body, params = {}) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, 'route exists');
  let result;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(payload) { result = { status: this.statusCode, ...payload }; return this; } };
  await route.route.stack.at(-1).handle({ body, params, uid: 71, user: { nickname: 'synthetic' } }, res,
    error => { result = { status: error.httpStatus || 500, code: error.code, msg: error.message, data: null }; });
  assert.ok(result, 'handler responds');
  return result;
}

function assertCare(value) {
  assert.equal(typeof value?.message, 'string');
  assert.ok(value.message.length > 0);
  assert.ok(value.lines.some(line => line.phone === '12356'));
}

test('crisis remains visible when advertising matches first', () => {
  assert.equal(detectCrisis('加我微信 synthetic99，我不想活了'), true);
});

test('mixed crisis never hides another moderation category', () => {
  for (const [text, cat] of [['我不想活了，你这个废物', '人身攻击'], ['想结束生命，发票代开', '违法']]) {
    assert.equal(moderate(text).cat, cat);
    assert.equal(detectCrisis(text), true);
  }
});

test('group bot preserves both flags and the existing penalty tiers', () => {
  resetViolations();
  for (const [text, count, seconds] of [
    ['加我微信 synthetic99，我不想活了', 1, 0],
    ['想消失，你这个废物', 2, 30],
    ['想结束生命，你去死', 3, 300],
  ]) {
    const review = reviewGroupMessage(12, 71, text);
    assert.equal(review.allow, false);
    assert.equal(review.crisis, true);
    assert.equal(review.violationCount, count);
    assert.equal(review.muteSeconds, seconds);
  }
});

const routes = [
  ['public diary', diary, 'post', '/save', text => ({ text, date: '2026-11-12', isPublic: true }), {}],
  ['new comment', comment, 'post', '/', content => ({ content, diaryId: 31 }), {}],
  ['edited comment', comment, 'patch', '/:id', content => ({ content }), { id: '31' }],
  ['private message', message, 'post', '/send', content => ({ content, convId: 11 }), {}],
  ['group message', group, 'post', '/rooms/:key/messages', content => ({ content }), { key: 'interest' }],
  ['blessing', bless, 'post', '/send', content => ({ content, toUserId: 72 }), {}],
  ['bottle toss', bottle, 'post', '/toss', content => ({ content }), {}],
  ['bottle blessing', bottle, 'post', '/:id/bless', content => ({ content }), { id: '31' }],
];

for (const [name, router, method, path, body, params] of routes) {
  test(name + ' blocks mixed advertising while returning care', async () => {
    resetViolations();
    const text = '加我微信 synthetic99，我不想活了';
    const writes = fixture(text);
    const result = await request(router, method, path, body(text), params);
    if (name.endsWith('message')) {
      assert.equal(result.data?.blocked, true);
      assert.ok(!writes.some(w => /0, 'normal'|"text"/.test(w.sql)), 'mixed content not delivered');
    } else {
      assert.equal(result.status, 400);
      assert.equal(result.code, 40000);
      assert.equal(writes.length, 0);
    }
    assertCare(result.data?.care);
  });
  test(name + ' allows pure crisis with care', async () => {
    resetViolations();
    const writes = fixture('我不想活了');
    const result = await request(router, method, path, body('我不想活了'), params);
    assert.equal(result.status, 200);
    assert.equal(result.code, 0);
    assert.notEqual(result.data?.blocked, true);
    assertCare(result.data?.care);
    assert.ok(writes.length > 0);
  });
  test(name + ' does not let crisis cancel attacks or spam', async () => {
    for (const text of ['我不想活了，你这个废物', '想消失，加我微信 synthetic99', '我不想活了' + 'a'.repeat(20)]) {
      resetViolations();
      fixture(text);
      const result = await request(router, method, path, body(text), params);
      if (name.endsWith('message')) assert.equal(result.data?.blocked, true);
      else assert.equal(result.status, 400);
      assertCare(result.data?.care);
    }
  });
  test(name + ' keeps ordinary sadness and advertising separate', async () => {
    resetViolations();
    fixture('今天很难过，想找个人聊聊');
    const sadness = await request(router, method, path, body('今天很难过，想找个人聊聊'), params);
    assert.equal(sadness.code, 0);
    assert.equal(sadness.data?.care, null);
    assert.notEqual(sadness.data?.blocked, true);
    fixture('加我微信 synthetic99');
    const ad = await request(router, method, path, body('加我微信 synthetic99'), params);
    if (name.endsWith('message')) assert.equal(ad.data?.blocked, true);
    else assert.equal(ad.status, 400);
    assert.equal(ad.data?.care, null);
  });
}

test('publicizing a private mixed diary cannot bypass moderation', async () => {
  const writes = fixture('我不想活了，你这个废物');
  const result = await request(diary, 'patch', '/:id/visibility', { isPublic: true }, { id: '31' });
  assert.equal(result.status, 400);
  assertCare(result.data?.care);
  assert.equal(writes.length, 0);
});

test('private diary retains mixed content with care', async () => {
  fixture('加我微信 synthetic99，我不想活了');
  const result = await request(diary, 'post', '/save', {
    text: '加我微信 synthetic99，我不想活了', date: '2026-11-12', isPublic: false,
  });
  assert.equal(result.code, 0);
  assertCare(result.data?.care);
});

test('visibility permits a pure crisis and still permits making mixed content private', async () => {
  fixture('我不想活了');
  const published = await request(diary, 'patch', '/:id/visibility', { isPublic: true }, { id: '31' });
  assert.equal(published.code, 0);
  assert.equal(published.data?.isPublic, true);
  assertCare(published.data?.care);
  fixture('我不想活了，你这个废物');
  const privateResult = await request(diary, 'patch', '/:id/visibility', { isPublic: false }, { id: '31' });
  assert.equal(privateResult.code, 0);
  assert.equal(privateResult.data?.isPublic, false);
  assertCare(privateResult.data?.care);
});

// Model row state at the DB boundary and pause only the first ownership SELECT.
// The actual /save handler runs to completion between the visibility read/write.
async function raceVisibilityWithSave(replacementText, savedPublic = false) {
  fixture('今天是普通的一天');
  const db = globalThis.crisisFixture;
  const originalQuery = db.query.bind(db);
  const originalWrite = db.write.bind(db);
  const row = { id: 31, user_id: 71, is_public: 0, date_key: '2026-11-12',
    text: '今天是普通的一天', created_at: '2026-11-12 12:00:00' };
  let releaseRead;
  let announceRead;
  const readStarted = new Promise(resolve => { announceRead = resolve; });
  const readBarrier = new Promise(resolve => { releaseRead = resolve; });
  let firstOwnerRead = true;
  db.query = async (sql, params) => {
    if (/^\s*(UPDATE|DELETE|INSERT)/.test(sql)) return db.write(sql, params);
    if (/SELECT id FROM diaries WHERE user_id/.test(sql)) return [{ id: row.id }];
    if (/FROM diaries/.test(sql)) {
      const snapshot = { ...row };
      if (firstOwnerRead && /SELECT id, user_id, is_public, date_key, text/.test(sql)) {
        firstOwnerRead = false;
        announceRead();
        await readBarrier;
      }
      return [snapshot];
    }
    return originalQuery(sql, params);
  };
  db.write = (sql, params) => {
    if (/UPDATE diaries SET text = \?, is_public = \? WHERE id = \?/.test(sql)) {
      row.text = params[0];
      row.is_public = params[1];
    } else if (/UPDATE diaries SET is_public = \? WHERE id = \?/.test(sql)) {
      // Emulate the optimistic SQL predicates if supplied; an unguarded UPDATE
      // genuinely changes this state and reproduces the original safety failure.
      if (/AND user_id = \? AND BINARY text = BINARY \? AND is_public = \?/.test(sql)
          && (params[2] !== row.user_id || params[3] !== row.text || params[4] !== row.is_public)) {
        return { affectedRows: 0 };
      }
      row.is_public = params[0];
    }
    return originalWrite(sql, params);
  };
  const pendingVisibility = request(diary, 'patch', '/:id/visibility', { isPublic: true }, { id: '31' });
  await readStarted;
  let saved;
  try {
    saved = await request(diary, 'post', '/save', {
      text: replacementText, date: '2026-11-12', isPublic: savedPublic,
    });
  } finally {
    releaseRead();
  }
  const visibility = await pendingVisibility;
  return { saved, visibility, row };
}

test('visibility cannot publish mixed content saved after its moderation snapshot', async () => {
  const { saved, visibility, row } = await raceVisibilityWithSave('我不想活了，你这个废物');
  assert.equal(saved.code, 0);
  assert.equal(row.is_public, 0, 'concurrent private save must remain private');
  assert.equal(visibility.status, 409);
  assert.equal(visibility.code, 40900);
  assertCare(visibility.data?.care);
  assert.equal(row.text, '我不想活了，你这个废物');
});

test('visibility detects concurrent visibility changes even when text is unchanged', async () => {
  const { saved, visibility, row } = await raceVisibilityWithSave('今天是普通的一天', true);
  assert.equal(saved.code, 0);
  assert.equal(visibility.status, 409);
  assert.equal(visibility.code, 40900);
  assert.equal(visibility.data?.care, null);
  assert.equal(row.is_public, 1);
});

test('ordinary sadness and advertising alone do not trigger crisis care', () => {
  for (const text of ['今天很难过，想找个人聊聊', '加我微信 synthetic99', '', null, 42]) {
    assert.equal(detectCrisis(text), false);
  }
});
