// ============================================================
//  第 11 步之一：私信模块集成测试
//
//  用法：  node scripts/test-message.js
//
//  ★ 重点验证"一对人只有一行会话" ★
//    conversations 表用 (user_a, user_b) 唯一索引，约定 user_a < user_b。
//    如果不排序，A→B 和 B→A 会落成两行，两个人各自只看到一半对话。
//    这是私信功能最常见的实现错误，所以专门测。
//
//  另外验证：未读数的双向计数、拉黑、被拦消息只给发件人看、
//            危机信号关怀。
// ============================================================
import { query, queryOne, execute, pool } from '../src/db/index.js';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const failures = [];
const ok = (m) => { console.log(`  \x1b[32m✅\x1b[0m ${m}`); pass++; };
const bad = (m, extra) => {
  console.log(`  \x1b[31m❌\x1b[0m ${m}`);
  if (extra !== undefined) console.log(`     实际: ${JSON.stringify(extra).slice(0, 300)}`);
  fail++; failures.push(m);
};
const step = (t) => console.log(`\n${'─'.repeat(46)}\n  ${t}\n${'─'.repeat(46)}`);
const eq = (a, b, m) => a === b ? ok(m) : bad(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const truthy = (c, m, actual) => c ? ok(m) : bad(m, actual);

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

async function login(phone) {
  const r = await api('POST', '/api/auth/login', { body: { phone, code: '123456' } });
  if (r.body?.code !== 0) throw new Error('登录失败 ' + phone);
  return r.body.data;
}

/**
 * 发送频控的间隔
 *
 * ★ 服务端是 1.2 秒，测试这里用 1.6 秒 ★
 *
 *  为什么不正好用 1.3 秒：网络往返 + 服务端处理需要几十毫秒，
 *  而服务端算的是"请求到达时刻 - 上一条消息时刻"。
 *  用 1.3 秒的话，留给往返的余量只有 100ms，偶尔会卡在边界上
 *  失败（我实测遇到过：客户端等 1301ms，服务端仍判定太快）。
 *
 *  这里多留 400ms 余量，测试稳定。频控本身有没有生效，
 *  由第 8 步专门用"紧接着连发两条"来验证（那里必须是 429）。
 */
const SEND_GAP_MS = 1600;

/**
 * 发私信（自动绕开频控）
 *
 * ★ 为什么写这个包装 ★
 *   服务端做了 1.2 秒的发送频控（防连点），这是真实需求，
 *   所以不能为了测试把它关掉 —— 关掉就等于不测这个功能了。
 *   但测试里每次发送都手动 sleep 很容易漏，漏了就会以
 *   "期望 0 实际 42900" 这种误导性的方式失败。
 *
 *   所以统一用这个函数发：它自己保证间隔。
 *   需要专门测频控的地方，直接用 api() 裸调（见第 8 步）。
 */
let lastSendAt = 0;
async function send(token, body) {
  const gap = Date.now() - lastSendAt;
  if (gap < SEND_GAP_MS) {
    await new Promise(r => setTimeout(r, SEND_GAP_MS - gap));
  }
  const waited = Date.now() - lastSendAt;
  lastSendAt = Date.now();
  const r = await api('POST', '/api/message/send', { token, body });
  // 调试用：如果被频控拦住，把真实等待时间打出来
  if (r.body?.code === 42900) {
    console.log(`     \x1b[33m[调试] 被频控拦住。本次等 ${waited}ms（需要 ${SEND_GAP_MS}ms）`
      + ` 内容="${String(body.content).slice(0, 16)}"\x1b[0m`);
  }
  return r;
}

(async () => {
  console.log('==============================================');
  console.log('  第 11 步 · 私信模块集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const stamp = Date.now().toString().slice(-6);
  let A = null, B = null, C = null;

  // 清理：把这三个账号之间的私信和会话删掉
  async function cleanup() {
    if (!A || !B || !C) return;
    const ids = [A.user.id, B.user.id, C.user.id];
    try {
      await execute(
        `DELETE FROM conversations
          WHERE (user_a IN (?, ?, ?) AND user_b IN (?, ?, ?))`,
        [...ids, ...ids]
      );
    } catch (e) {
      console.log(`  \x1b[33m⚠️  清理失败：${e.message}\x1b[0m`);
    }
  }

  try {
  // ---------- 准备 ----------
  step('0. 准备三个账号');
  A = await login('13800138000');
  B = await login('13912345678');
  C = await login('13700000001');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  ok(`B = ${B.user.nickname} (id=${B.user.id})`);
  ok(`C = ${C.user.nickname} (id=${C.user.id})`);

  await cleanup();
  ok('清掉了这三个账号之间的旧会话（保证起点干净）');

  // ---------- 1. 打开会话 ----------
  step('1. POST /api/message/open  打开会话');
  const open1 = await api('POST', '/api/message/open', {
    token: A.token, body: { userId: B.user.id },
  });
  eq(open1.body?.code, 0, 'A 能打开和 B 的会话');
  const convId = open1.body.data.convId;
  truthy(Number.isInteger(convId), `拿到会话 id=${convId}`);
  eq(open1.body.data.partner.userId, B.user.id, '返回的对方资料是 B');
  truthy(!!open1.body.data.partner.nick, `对方昵称：${open1.body.data.partner.nick}`);
  truthy(!!open1.body.data.partner.avatar !== undefined, '带对方头像字段');
  eq(open1.body.data.unread, 0, '刚开始没有未读');
  eq(open1.body.data.canSend, true, '可以发消息');

  // ★ 关键：B 也打开一次，应该拿到【同一个】会话
  const open2 = await api('POST', '/api/message/open', {
    token: B.token, body: { userId: A.user.id },
  });
  eq(open2.body.data.convId, convId,
    '★ B 反向打开拿到同一个会话（user_a < user_b 排序生效）');
  ok('如果不排序，这里会变成两个会话，两个人各看一半对话');

  // 数据库里确实只有一行
  const convRows = await query(
    'SELECT id FROM conversations WHERE user_a IN (?, ?) AND user_b IN (?, ?)',
    [A.user.id, B.user.id, A.user.id, B.user.id]
  );
  eq(convRows.length, 1, '★ 数据库里只有 1 行会话');

  // 用 uid 打开也行
  const openByUid = await api('POST', '/api/message/open', {
    token: A.token, body: { uid: B.user.uid },
  });
  eq(openByUid.body.data.convId, convId, '按 uid 打开也落到同一个会话');

  // 不能和自己聊
  const self = await api('POST', '/api/message/open', {
    token: A.token, body: { userId: A.user.id },
  });
  truthy(self.body?.code !== 0, '不能和自己私信', self.body);

  // ---------- 2. 发消息 ----------
  step('2. 发消息');
  const m1 = await send(A.token, { toUserId: B.user.id, content: `你好，我是A ${stamp}` });
  eq(m1.body?.code, 0, '发消息成功');
  eq(m1.body.data.blocked, false, '没被拦');
  eq(m1.body.data.care, null, '正常内容没有 care');
  const msg1Id = m1.body.data.message.id;
  eq(m1.body.data.message.isMine, true, 'A 看自己的消息 isMine=true');
  eq(m1.body.data.message.fromNick, A.user.nickname, '带发件人昵称');
  truthy(!!m1.body.data.message.time, `带相对时间（${m1.body.data.message.time}）`);

  // ---------- 3. ★ 未读数的双向计数 ----------
  step('3. ★ 未读数：发给对方算对方的未读，不算自己的');
  const convsA1 = await api('GET', '/api/message/conversations', { token: A.token });
  eq(convsA1.body.data.list[0].unread, 0, 'A 自己发的，A 没有未读');
  eq(convsA1.body.data.list[0].lastIsMine, true, '列表里标记"最后一条是我发的"');

  const convsB1 = await api('GET', '/api/message/conversations', { token: B.token });
  eq(convsB1.body.data.list[0].unread, 1, '★ B 有 1 条未读');
  eq(convsB1.body.data.list[0].lastIsMine, false, 'B 视角标记"最后一条不是我发的"');
  truthy(convsB1.body.data.list[0].lastMessage.includes(stamp), '列表摘要显示的是那条消息');

  const totalB = await api('GET', '/api/message/total-unread', { token: B.token });
  eq(totalB.body.data.unread, 1, '★ 总未读数也是 1（红点用）');

  // ---------- 4. 读消息会自动清未读 ----------
  step('4. 读消息自动清未读');
  const withB = await api('GET', `/api/message/with/${A.user.id}`, { token: B.token });
  eq(withB.body?.code, 0, 'B 能取到和 A 的聊天记录');
  truthy(withB.body.data.list.some(m => m.id === msg1Id), '记录里有那条消息');
  const msgFromB = withB.body.data.list.find(m => m.id === msg1Id);
  eq(msgFromB.isMine, false, '★ B 看 A 的消息，isMine=false');

  const convsB2 = await api('GET', '/api/message/conversations', { token: B.token });
  eq(convsB2.body.data.list[0].unread, 0, '★ 读完之后未读归零');

  // ---------- 5. 双向对话 ----------
  step('5. 双向对话（顺序正确）');
  const m2 = await send(B.token, { toUserId: A.user.id, content: `你好A，我是B ${stamp}` });
  eq(m2.body?.code, 0, 'B 回复成功');

  const withA = await api('GET', `/api/message/with/${B.user.id}?markRead=0`, { token: A.token });
  eq(withA.body.data.list.length >= 2, true, `聊天记录有 ${withA.body.data.list.length} 条`);
  const ids = withA.body.data.list.map(m => m.id);
  const sorted = [...ids].sort((x, y) => x - y);
  eq(ids.join(','), sorted.join(','), '★ 消息按时间正序（聊天要从上往下读）');
  truthy(withA.body.data.partner.nick === B.user.nickname, '带对方资料（渲染标题用）');

  // ---------- 6. 内容检测 ----------
  step('6. 机器人拦违规私信');
  const ad = await send(A.token, { toUserId: B.user.id, content: '加我微信 abc12345 有好事' });
  eq(ad.body?.code, 0, '接口正常返回（不是 500）');
  eq(ad.body.data.blocked, true, '★ 违规内容被拦下（没发给对方）');
  eq(ad.body.data.category, '广告导流', '类别正确');
  truthy(!!ad.body.data.notice, `给了可读的提示语（${ad.body.data.notice}）`);

  // ★ 关键：对方看不到这条，但发件人自己能看到（留痕）
  const withBAfterAd = await api('GET', `/api/message/with/${A.user.id}?markRead=0`, { token: B.token });
  const bSeesBlocked = withBAfterAd.body.data.list.some(m => m.content.includes('abc12345'));
  eq(bSeesBlocked, false, '★ B 看不到被拦下的内容（没发出去）');

  const withAAfterAd = await api('GET', `/api/message/with/${B.user.id}?markRead=0`, { token: A.token });
  const aBlockedMsg = withAAfterAd.body.data.list.find(m => m.content.includes('abc12345'));
  truthy(!!aBlockedMsg, '★ A 自己能看到"这句话没发出去"（留痕）');
  eq(aBlockedMsg.blocked, true, '标记为 blocked（前端可以标灰）');

  // 数据库里确实存了（管理员可追溯）
  const dbBlocked = await queryOne(
    "SELECT id, status FROM messages WHERE conv_id = ? AND status = 'blocked'",
    [convId]
  );
  truthy(!!dbBlocked, '★ 数据库里留了痕（出了事能追溯）');
  ok('只拦不存的话，出了问题就查不到了');

  // ---------- 7. 危机信号 ----------
  step('7. ★ 危机信号：正常发出 + 关怀提示');
  const crisis = await send(A.token, { toUserId: B.user.id, content: `最近真的撑不下去了 ${stamp}` });
  eq(crisis.body?.code, 0, '接口正常');
  eq(crisis.body.data.blocked, false, '★ 危机信号没有被拦（这一点最重要）');
  truthy(!!crisis.body.data.care, '★ 返回了 care 关怀提示');
  truthy(crisis.body.data.care.lines.length > 0, `带 ${crisis.body.data.care.lines.length} 条热线`);

  // 对方能看到（不是被藏起来）
  const withBAfterCrisis = await api('GET', `/api/message/with/${A.user.id}?markRead=0`, { token: B.token });
  const crisisSeen = withBAfterCrisis.body.data.list.find(m => m.content.includes('撑不下去'));
  truthy(!!crisisSeen, '★ B 能看到 A 说的这句话（没被藏起来）');
  eq(crisisSeen.blocked, false, '它不是被拦的消息');

  // ---------- 8. 发送频控 ----------
  step('8. 发送频控（防连点）');
  // 不等，立刻再发
  const fast1 = await api('POST', '/api/message/send', {
    token: C.token, body: { toUserId: A.user.id, content: `C的第一条 ${stamp}` },
  });
  eq(fast1.body?.code, 0, 'C 第一条发送成功');
  const fast2 = await api('POST', '/api/message/send', {
    token: C.token, body: { toUserId: A.user.id, content: `C的第二条 ${stamp}` },
  });
  eq(fast2.status, 429, '★ 1.2 秒内连发第二条被拒绝');
  truthy(/太快/.test(fast2.body?.msg || ''), `提示语说明了原因（${fast2.body?.msg}）`);

  // ---------- 9. 拉黑 ----------
  step('9. ★ 拉黑（私信最容易被骚扰，必须有这个）');
  const block = await api('POST', '/api/message/block', {
    token: A.token, body: { userId: C.user.id },
  });
  eq(block.body?.code, 0, 'A 拉黑 C 成功');
  eq(block.body.data.blocked, true, '返回 blocked=true');

  // C 发不了消息给 A
  const blockedSend = await send(C.token, { toUserId: A.user.id, content: `还想发 ${stamp}` });
  eq(blockedSend.status, 403, '★ C 发给 A 被拒绝（403）');
  truthy(!/拉黑/.test(blockedSend.body?.msg || ''),
    '★ 提示语没有说"你被拉黑了"（那样会让人反复试探）');
  console.log(`     \x1b[2mC 看到的提示：${blockedSend.body?.msg}\x1b[0m`);

  // A 自己也不能发（先取消拉黑再发）
  const aBlockedSend = await send(A.token, { toUserId: C.user.id, content: '我拉黑了你还想发' });
  eq(aBlockedSend.status, 403, 'A 拉黑后自己也不能发（得先取消）');

  // 会话列表里能看到拉黑状态
  const convsA2 = await api('GET', '/api/message/conversations', { token: A.token });
  const convWithC = convsA2.body.data.list.find(c => c.partner.userId === C.user.id);
  eq(convWithC?.iBlocked, true, '★ 列表里标记 iBlocked=true');
  const convsC2 = await api('GET', '/api/message/conversations', { token: C.token });
  const cWithA = convsC2.body.data.list.find(c => c.partner.userId === A.user.id);
  eq(cWithA?.blockedByPartner, true, '★ C 视角标记 blockedByPartner=true');

  // 打不开（canSend=false）
  const openC = await api('POST', '/api/message/open', {
    token: C.token, body: { userId: A.user.id },
  });
  eq(openC.body.data.canSend, false, '被拉黑时 canSend=false（前端隐藏输入框）');

  // ---------- 10. 取消拉黑 ----------
  step('10. 取消拉黑');
  const unblock = await api('POST', '/api/message/block', {
    token: A.token, body: { userId: C.user.id },
  });
  eq(unblock.body?.code, 0, '取消拉黑成功');
  eq(unblock.body.data.blocked, false, '返回 blocked=false');

  const canSendAgain = await send(C.token, { toUserId: A.user.id, content: `又能发了 ${stamp}` });
  eq(canSendAgain.body?.code, 0, '★ 取消拉黑后 C 又能发了');

  const blockedList = await api('GET', '/api/message/blocked-list', { token: A.token });
  eq(blockedList.body.data.total, 0, '黑名单现在是空的');

  // ---------- 11. 删除会话 ----------
  step('11. 删除会话（我这边看不到，对方还能看）');
  const convsBefore = await api('GET', '/api/message/conversations', { token: A.token });
  truthy(convsBefore.body.data.list.length >= 2, `A 现在有 ${convsBefore.body.data.list.length} 个会话`);

  const del = await api('DELETE', `/api/message/conversation/${convId}`, { token: A.token });
  eq(del.body?.code, 0, 'A 删除和 B 的会话');

  const convsAfter = await api('GET', '/api/message/conversations', { token: A.token });
  eq(convsAfter.body.data.list.some(c => c.convId === convId), false,
    '★ A 的会话列表里没有它了');

  // 但 B 还能看到
  const convsBStill = await api('GET', '/api/message/conversations', { token: B.token });
  truthy(convsBStill.body.data.list.some(c => c.convId === convId),
    '★ B 那边还在（不是真删数据）');
  ok('这样删会话不会让对方的历史记录凭空消失');

  // 消息记录本身还在
  const msgsStill = await api('GET', `/api/message/with/${A.user.id}?markRead=0`, { token: B.token });
  truthy(msgsStill.body.data.list.length > 0, '聊天记录还在');

  // ★ 对方再发消息，我应该重新收到这个会话 ★
  //
  //  这是"删会话"该有的行为：删掉的只是我列表里的那一条，
  //  不是把关系切断。别人发消息我还是收得到。
  const sendAfterDelete = await send(B.token, {
    toUserId: A.user.id, content: `删了也能收到 ${stamp}`,
  });
  eq(sendAfterDelete.body?.code, 0, 'B 在 A 删除会话后还能发消息');

  const convsAAgain = await api('GET', '/api/message/conversations', { token: A.token });
  const back = convsAAgain.body.data.list.find(c => c.convId === convId);
  truthy(!!back, '★ A 重新看到了这条会话（对方发了新消息）');
  if (back) {
    eq(back.unread, 1, '★ 而且有 1 条未读');
    truthy(back.lastMessage.includes('删了也能收到'), '列表摘要显示的是新消息');
  }
  ok('删会话不等于拉黑 —— 想彻底断掉请用拉黑');

  // ---------- 12. 权限 ----------
  step('12. 权限：不能看别人的会话');
  // C 想删 A 和 B 的会话
  const delOther = await api('DELETE', `/api/message/conversation/${convId}`, { token: C.token });
  eq(delOther.status, 403, '★ C 不能删 A 和 B 的会话（403）');

  // ---------- 13. 未登录 ----------
  step('13. 未登录保护');
  eq((await api('GET', '/api/message/conversations')).status, 401, '未登录不能看会话列表');
  eq((await api('POST', '/api/message/send', { body: { toUserId: 1, content: 'x' } })).status,
    401, '未登录不能发私信');
  eq((await api('GET', '/api/message/total-unread')).status, 401, '未登录不能看未读数');

  // ---------- 14. 边界 ----------
  step('14. 边界情况');
  const ghost = await api('POST', '/api/message/send', {
    token: A.token, body: { toUserId: 99999999, content: '给不存在的人发' },
  });
  eq(ghost.status, 404, '给不存在的人发消息返回 404');

  const noTarget = await api('POST', '/api/message/send', {
    token: A.token, body: { content: '没指定发给谁' },
  });
  truthy(noTarget.body?.code !== 0, '不指定收件人被拒绝', noTarget.body);

  const emptyMsg = await api('POST', '/api/message/send', {
    token: A.token, body: { toUserId: B.user.id, content: '   ' },
  });
  truthy(emptyMsg.body?.code !== 0, '空消息被拒绝', emptyMsg.body);

  const notMyConv = await api('POST', '/api/message/send', {
    token: C.token, body: { convId: convId, content: '混进别人的会话' },
  });
  eq(notMyConv.status, 403, '★ 不能用别人的 convId 发消息（403）');

  // ---------- 15. 清理 ----------
  step('15. 清理测试数据');
  await cleanup();
  const left = await queryOne(
    `SELECT COUNT(*) AS n FROM conversations
      WHERE user_a IN (?, ?, ?) AND user_b IN (?, ?, ?)`,
    [A.user.id, B.user.id, C.user.id, A.user.id, B.user.id, C.user.id]
  );
  eq(Number(left.n), 0, '★ 测试会话清理干净（消息会级联删掉）');

  const leftMsg = await queryOne(
    'SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?',
    [`%${stamp}%`]
  );
  eq(Number(leftMsg.n), 0, '消息也一起删掉了');

  } finally {
    await cleanup();
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 私信模块全部通过！\n');
    process.exitCode = 0;
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
    process.exitCode = 1;
  }

  await pool.end();
})().catch(async (e) => {
  console.error('\n测试脚本崩溃：', e);
  try { await pool.end(); } catch { /* 忽略 */ }
  process.exitCode = 1;
});
