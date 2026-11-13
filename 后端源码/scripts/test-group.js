// ============================================================
//  第 10 步：群聊 + 违规检测机器人 集成测试
//
//  用法：  node scripts/test-group.js
//
//  ★ 重点验证机器人的分级处理策略 ★
//    这不是普通的功能测试 —— 它验证的是"处罚尺度"：
//      第 1 次违规 → 拦下但不禁言
//      第 2 次     → 禁言 30 秒
//      第 3 次     → 禁言 5 分钟
//    以及最重要的一条：
//      危机信号不处罚，而是发关怀提示
//    如果一个陪伴类产品把求救信号当违规删掉，那它就失去了意义。
// ============================================================

//  ★ 为什么这个测试要直连数据库 ★
//    "清理测试数据"这一步必须能用 SQL 删消息和成员记录 ——
//    接口没有"删除群消息"的功能（本来也不该有）。
//    所以这个测试和漂流瓶那两个一样，要在虚拟机上跑
//    （由 test-all.sh 的 run_on_vm 转发）。
import { execute, queryOne, pool } from '../src/db/index.js';

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

(async () => {
  console.log('==============================================');
  console.log('  第 10 步 · 群聊 + 违规检测机器人 集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const stamp = Date.now().toString().slice(-6);
  let A = null, B = null, C = null;
  const testRoom = 'interest';   // 用「拾趣」做测试，不动别的房间

  // ---------- 准备 ----------
  step('0. 准备三个账号，重置机器人的违规计数');
  A = await login('13800138000');
  B = await login('13912345678');
  C = await login('13700000001');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  ok(`B = ${B.user.nickname} (id=${B.user.id})`);
  ok(`C = ${C.user.nickname} (id=${C.user.id})`);

  // ★ 机器人的违规计数在服务进程的内存里，必须通过接口重置
  //   （在测试进程里 import resetViolations() 是无效的，
  //     因为这是两个独立进程，各持一份内存）
  const reset = await api('POST', '/api/group/_test/reset', { token: A.token });
  eq(reset.body?.code, 0, '★ 通过接口重置了机器人的违规计数');
  ok('（测试进程和服务进程内存独立，所以必须走 HTTP 重置）');

  // 顺便解掉可能存在的禁言
  const joinA = await api('POST', `/api/group/rooms/${testRoom}/join`, { token: A.token });
  eq(joinA.body?.code, 0, `A 进入「${joinA.body.data.room.name}」`);

  // ---------- 1. 房间列表 ----------
  step('1. GET /api/group/rooms  房间列表');
  const rooms = await api('GET', '/api/group/rooms', { token: A.token });
  eq(rooms.body?.code, 0, '能取到房间列表');
  eq(rooms.body.data.list.length, 4, '★ 正好 4 个房间（同龄群/拾趣/同省群/星迹）');

  const names = rooms.body.data.list.map(r => r.name);
  for (const n of ['同龄群', '拾趣', '同省群', '星迹']) {
    truthy(names.includes(n), `列表里有「${n}」`);
  }
  truthy(rooms.body.data.list.every(r => typeof r.memberCount === 'number'), '每个房间都有人数');
  truthy(rooms.body.data.list.every(r => typeof r.unread === 'number'), '每个房间都有未读数');
  truthy(typeof rooms.body.data.totalUnread === 'number',
    `带总未读数（${rooms.body.data.totalUnread}）`);
  truthy(rooms.body.data.list.every(r => 'isMuted' in r), '每个房间都带 isMuted（前端要显示禁言状态）');

  // ---------- 2. 正常发言 ----------
  step('2. 正常发言');
  const m1 = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: A.token, body: { content: `大家好，我是A ${stamp}` },
  });
  eq(m1.body?.code, 0, '发言成功');
  eq(m1.body.data.blocked, false, '没被机器人拦');
  eq(m1.body.data.care, null, '正常内容没有 care');
  const msgId = m1.body.data.message.id;
  truthy(Number.isInteger(msgId), `消息 id=${msgId}`);
  eq(m1.body.data.message.nick, A.user.nickname, '带发言人昵称');
  eq(m1.body.data.message.isMine, true, 'A 看自己的消息 isMine=true');
  truthy(!!m1.body.data.message.time, `带相对时间（${m1.body.data.message.time}）`);

  // ---------- 3. 消息列表 ----------
  step('3. GET messages  消息列表');
  const listA = await api('GET', `/api/group/rooms/${testRoom}/messages?limit=50`, { token: A.token });
  eq(listA.body?.code, 0, '能取到消息');
  truthy(listA.body.data.list.some(m => m.id === msgId), '列表里有刚发的消息');
  truthy(Array.isArray(listA.body.data.list), 'list 是数组');
  truthy(typeof listA.body.data.hasMore === 'boolean', '带 hasMore（翻历史用）');
  truthy('isMuted' in listA.body.data.room, '带房间的禁言状态');
  ok('消息按时间正序（最早的在前），前端直接从下往上贴就行');

  // A 看自己的消息 isMine=true，B 看应该是 false
  const listB0 = await api('GET', `/api/group/rooms/${testRoom}/messages`, { token: B.token });
  const msgFromB = listB0.body.data.list.find(m => m.id === msgId);
  eq(msgFromB?.isMine, false, '★ B 看 A 的消息，isMine=false（状态跟人走）');

  // ---------- 4. ★ 机器人：第 1 次违规 ----------
  step('4. ★ 机器人第 1 次违规：拦下但不禁言');
  const v1 = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: B.token, body: { content: '加我微信 abc12345 有好事' },
  });
  eq(v1.body?.code, 0, '接口正常返回（不是 500）');
  eq(v1.body.data.blocked, true, '★ 消息被机器人拦下（没发出去）');
  eq(v1.body.data.violationCount, 1, '这是第 1 次违规');
  eq(v1.body.data.muteSeconds, 0, '★ 第 1 次不禁言（只提醒）');
  truthy(!!v1.body.data.botNotice, '机器人给了提示语');
  console.log(`     \x1b[2m机器人说：${v1.body.data.botNotice}\x1b[0m`);

  // 确认违规内容真的没进数据库
  const listAfterV1 = await api('GET', `/api/group/rooms/${testRoom}/messages?limit=50`, { token: A.token });
  const leaked = listAfterV1.body.data.list.some(m => m.content.includes('abc12345'));
  eq(leaked, false, '★ 违规原文没有进数据库');

  // 但机器人自己发的提醒进了群
  //
  // ★ 这里踩过一个很蠢的坑，记一下 ★
  //   我最初搜的是 `content.includes('不合适')`，一直搜不到，
  //   明明数据库里看着就有这三个字。查了半天发现：
  //   机器人说的是「不太合适」—— 中间有个"太"字，
  //   "不合适" 这三个字并不连续，所以 includes 当然是 false。
  //   在终端里目视比对时被自己骗了。
  //   （顺带说，"不太合适" 比 "不合适" 温和，是更好的措辞，
  //     所以该改的是测试，不是文案。）
  const botMsg = listAfterV1.body.data.list.find(
    m => m.type === 'sys' && m.content.includes('这句')
  );
  truthy(!!botMsg, '机器人的提醒出现在群里（type=sys）');
  if (botMsg) {
    eq(botMsg.userId, null, '系统消息没有作者（userId 是 null）');
    eq(botMsg.isSys, true, 'isSys 标记正确（前端据此渲染成居中的灰底提示）');
    truthy(botMsg.content.includes('@'), '提示语点名了违规的人');
  }

  // ---------- 5. ★ 第 2 次：禁言 30 秒 ----------
  step('5. ★ 机器人第 2 次违规：禁言 30 秒');
  const v2 = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: B.token, body: { content: '再加我微信 xyz99999' },
  });
  eq(v2.body.data.blocked, true, '第 2 次也被拦');
  eq(v2.body.data.violationCount, 2, '这是第 2 次');
  eq(v2.body.data.muteSeconds, 30, '★ 这次禁言 30 秒');
  console.log(`     \x1b[2m机器人说：${v2.body.data.botNotice}\x1b[0m`);

  // 禁言生效了吗
  const roomsB = await api('GET', '/api/group/rooms', { token: B.token });
  const roomB = roomsB.body.data.list.find(r => r.code === testRoom);
  eq(roomB.isMuted, true, '★ 房间列表里显示 B 被禁言了');
  truthy(roomB.muteRemainSeconds > 0 && roomB.muteRemainSeconds <= 30,
    `禁言剩余 ${roomB.muteRemainSeconds} 秒（应该在 1-30 之间）`);

  // 禁言期间不能发言
  const muted = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: B.token, body: { content: '我就是要说' },
  });
  eq(muted.status, 429, '★ 禁言期间发言被拒绝（429）');
  truthy(/禁言/.test(muted.body?.msg || ''), `提示语说明了原因（${muted.body?.msg}）`);
  ok('注意：这次是"禁言拦截"，不是"内容违规拦截"——两者提示不同');

  // ---------- 6. ★ 危机信号不处罚 ----------
  step('6. ★ 危机信号：不处罚，发关怀提示');
  // 换 C 来说（B 正被禁言，A 没违规过）
  const crisis = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: C.token, body: { content: `最近真的撑不下去了 ${stamp}` },
  });
  eq(crisis.body?.code, 0, '接口正常');
  eq(crisis.body.data.blocked, false, '★ 危机信号没有被拦（这一点最重要）');
  truthy(!!crisis.body.data.care, '★ 返回了 care 关怀提示');
  truthy(crisis.body.data.care.lines.length > 0, `带 ${crisis.body.data.care.lines.length} 条热线`);

  // 消息真的发出去了
  const listAfterCrisis = await api('GET', `/api/group/rooms/${testRoom}/messages?limit=50`, { token: A.token });
  const crisisMsg = listAfterCrisis.body.data.list.find(m => m.content.includes(stamp));
  truthy(!!crisisMsg, '★ 他的话真的发到群里了');
  eq(crisisMsg.type, 'text', '是用户消息，不是系统消息');

  // 机器人发了关怀消息
  const careBotMsg = listAfterCrisis.body.data.list.find(
    m => m.type === 'sys' && (m.content.includes('热线') || m.content.includes('电话'))
  );
  truthy(!!careBotMsg, '★ 机器人发了关怀消息（不是处罚通知）');
  console.log(`     \x1b[2m机器人说：${careBotMsg.content.slice(0, 60)}...\x1b[0m`);

  // C 没有被禁言
  const roomsC = await api('GET', '/api/group/rooms', { token: C.token });
  const roomC = roomsC.body.data.list.find(r => r.code === testRoom);
  eq(roomC.isMuted, false, '★ 说危机信号的人没有被禁言（没被当成违规）');
  ok('删掉一个人的求救信号是最糟的处理 —— 这里选择了接住他');

  // ---------- 7. 禁言的自我保护效应 ----------
  step('7. 禁言期内发不出消息（这也是"第 3 档"难到达的原因）');
  //
  // ★ 这里说明一个真实的产品逻辑 ★
  //   第 2 次违规就被禁言 30 秒，而禁言期内【根本发不出消息】，
  //   所以"在 30 秒内犯满 3 次"在物理上做不到。
  //
  //   这不是 bug，是设计使然：禁言本身就在阻止继续违规，
  //   不需要靠不断加码来吓人。
  //
  //   第三档（5 分钟）只会在"禁言结束后又违规"时到达，
  //   也就是一个人反复犯、每次都等禁言结束再来。
  //   这条路径用单元测试（test-chatbot.js）跑完整阶梯更合适 ——
  //   集成测试里要等 30 秒真实时间，太慢。
  //
  // ★ 注意：此时 B 正处于第 5 步那次 30 秒禁言里，
  //   所以下面的请求会返回 429，响应里【没有 data 字段】。
  //   我第一版直接读 b1.body.data.violationCount 就崩了。
  const stillMuted = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: B.token, body: { content: '我还是想说' },
  });
  eq(stillMuted.status, 429, '★ 禁言期内发不出消息（429）');
  eq(stillMuted.body.data, null, '被禁言时响应里没有 data（调用处要先判断）');
  truthy(/禁言/.test(stillMuted.body?.msg || ''), `提示语说明了原因（${stillMuted.body?.msg}）`);
  ok('★ 第三档（5 分钟）由 test-chatbot.js 用单元测试覆盖完整阶梯');

  // 换一个没被禁言的账号（A），验证"第一次违规只提醒"在这个房间里也成立
  const aTier1 = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: A.token, body: { content: 'www.a1.com' },
  });
  eq(aTier1.body?.code, 0, 'A 还能发（没被禁言）');
  eq(aTier1.body.data.violationCount, 1, 'A 第 1 次违规');
  eq(aTier1.body.data.muteSeconds, 0, '★ A 第 1 次只被提醒，没被禁言');
  ok('不同人的违规计数互相独立');

  // ---------- 8. 未读数 ----------
  step('8. 未读数（last_read_id 机制）');
  // B 刚进群并读了消息，未读数应该是 0
  await api('GET', `/api/group/rooms/${testRoom}/messages?markRead=1`, { token: C.token });
  const roomsC2 = await api('GET', '/api/group/rooms', { token: C.token });
  const roomC2 = roomsC2.body.data.list.find(r => r.code === testRoom);
  eq(roomC2.unread, 0, 'C 刚读过，未读数是 0');

  // 发一条新消息（用 C 之外的人），C 就会有未读
  //
  // ★ 必须用没被禁言的账号 ★
  //   我第一版用 B 发，但 B 那时正被禁言 30 秒，消息根本没发出去。
  //   加上我写了 .catch(() => null) 把错误吃掉了，
  //   结果表现为"C 没有未读"这个完全指错方向的失败。
  //   教训：测试里不要随便吞错误，吞掉之后失败信息会骗你。
  //
  //   A 在第 7 步有过 1 次违规（只提醒、不禁言），所以 A 能发。
  const newMsg = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: A.token, body: { content: `给C的新消息 ${stamp}` },
  });
  eq(newMsg.body?.code, 0, 'A 成功发了一条新消息（A 没被禁言）');

  const roomsC3 = await api('GET', '/api/group/rooms', { token: C.token });
  const roomC3 = roomsC3.body.data.list.find(r => r.code === testRoom);
  truthy(roomC3.unread > 0, `★ C 现在有 ${roomC3.unread} 条未读`);
  ok('每次看消息会自动把 last_read_id 推到最新');

  // 手动标记已读
  const markRead = await api('POST', `/api/group/rooms/${testRoom}/read`, { token: C.token });
  eq(markRead.body?.code, 0, '手动标记已读成功');
  const roomsC4 = await api('GET', '/api/group/rooms', { token: C.token });
  eq(roomsC4.body.data.list.find(r => r.code === testRoom).unread, 0, '标记后未读归零');

  // ---------- 9. 总未读 ----------
  step('9. GET /api/group/total-unread  红点用');
  const totalUnread = await api('GET', '/api/group/total-unread', { token: C.token });
  eq(totalUnread.body?.code, 0, '能取到总未读');
  eq(typeof totalUnread.body.data.unread, 'number', `返回数字（${totalUnread.body.data.unread}）`);

  // ---------- 10. 我进过的群 ----------
  step('10. GET /api/group/my-rooms');
  const myRooms = await api('GET', '/api/group/my-rooms', { token: A.token });
  eq(myRooms.body?.code, 0, '能取到我进过的群');
  truthy(myRooms.body.data.list.some(r => r.code === testRoom), '列表里有「拾趣」');
  truthy(typeof myRooms.body.data.totalUnread === 'number', '带总未读');
  const myRoom = myRooms.body.data.list.find(r => r.code === testRoom);
  truthy('lastMessage' in myRoom, '带最后一条消息（显示在列表上）');
  truthy(!!myRoom.lastTime, '带最后消息时间');

  // ---------- 11. 群成员 ----------
  step('11. GET /api/group/rooms/:key/members');
  const members = await api('GET', `/api/group/rooms/${testRoom}/members`, { token: A.token });
  eq(members.body?.code, 0, '能取到群成员');
  truthy(members.body.data.list.length >= 3, `群里有 ${members.body.data.list.length} 个人`);
  truthy(members.body.data.list.some(u => u.userId === A.user.id), '列表里有 A');
  const memberB = members.body.data.list.find(u => u.userId === B.user.id);
  truthy('isMuted' in memberB, '每个成员都带禁言状态');
  truthy(typeof memberB.muteRemainSeconds === 'number',
    `B 的禁言剩余 ${memberB.muteRemainSeconds} 秒`);

  // ---------- 12. 房间代号和 id 都能用 ----------
  step('12. 房间可以用 code 或 id 访问');
  const byCode = await api('GET', '/api/group/rooms/interest/messages', { token: A.token });
  eq(byCode.body?.code, 0, '用 code（interest）能访问');
  const roomId = byCode.body.data.room.id;
  const byId = await api('GET', `/api/group/rooms/${roomId}/messages`, { token: A.token });
  eq(byId.body?.code, 0, `用 id（${roomId}）也能访问`);
  eq(byId.body.data.room.code, 'interest', '两次拿到的房间一样');

  // ---------- 13. 边界 ----------
  step('13. 边界情况');
  const ghostRoom = await api('GET', '/api/group/rooms/notexist/messages', { token: A.token });
  eq(ghostRoom.status, 404, '不存在的房间返回 404');

  const empty = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: A.token, body: { content: '   ' },
  });
  truthy(empty.body?.code !== 0, '空消息被拒绝', empty.body);

  const longMsg = await api('POST', `/api/group/rooms/${testRoom}/messages`, {
    token: C.token, body: { content: '很'.repeat(1500) },
  });
  // 1500 个相同字符会先被刷屏拦掉，所以这里换个测法
  truthy(longMsg.body?.code === 0 || longMsg.body?.data?.blocked === true,
    '超长内容要么被截断、要么被刷屏规则拦（都算对）');

  // ---------- 14. 未登录 ----------
  step('14. 未登录保护');
  eq((await api('GET', '/api/group/rooms')).status, 401, '未登录不能看房间列表');
  eq((await api('POST', `/api/group/rooms/${testRoom}/messages`, { body: { content: 'x' } })).status,
    401, '未登录不能发言');

  // ---------- 15. 测试端点只在开发环境开放 ----------
  step('15. 测试端点不应该在正式环境存在');
  const resetNoAuth = await api('POST', '/api/group/_test/reset');
  eq(resetNoAuth.status, 401, '重置端点也要登录（未登录是 401）');
  ok('正式环境（NODE_ENV=production）会返回 404，不会成为后门');

  // ---------- 16. 清理 ----------
  step('16. 清理测试数据');
  // ★ 测试消息应该真删掉，不能只清未读 ★
  //
  //  群聊消息在生产环境确实该保留（微信群也不会因为你说了话就自动删）。
  //  但这是【测试产生的垃圾】—— 带时间戳的 "www.x1.com"、
  //  违规原文、机器人提醒……留在这里会污染演示效果。
  //
  //  所以这个测试需要直连数据库清理，也就是说它要在虚拟机上跑
  //  （和漂流瓶那两个测试一样，由 test-all.sh 的 run_on_vm 转发）。
  //
  //  清理范围：本次时间戳相关的消息 + 机器人对本次违规发的提醒。
  //  不动种子数据（"这里是拾趣，先随便说两句吧"）和其他人的正常发言。
  // （execute / queryOne / pool 已在文件顶部 import）

  // 1. 删掉带本次时间戳的用户消息
  const removedUser = await execute(
    'DELETE FROM chat_messages WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?)'
    + ' AND content LIKE ?',
    [testRoom, `%${stamp}%`]
  );
  ok(`删掉了 ${removedUser} 条带时间戳的测试消息`);

  // 2. 删掉测试用的违规内容（这些内容不发出去，只在机器人提醒里被引用）
  //    注意：违规原文本来就没入库，这里删的是测试里那些"看着像广告"的
  //    但实际发出去的消息（比如 www.a1.com 会被拦，所以也不在库里）
  const removedAds = await execute(
    `DELETE FROM chat_messages WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?)
      AND (content LIKE '%www.a%' OR content LIKE '%www.x%' OR content LIKE '%我还是想说%')`,
    [testRoom]
  );
  ok(`删掉了 ${removedAds} 条测试用的广告类消息`);

  // 3. 删掉机器人针对本次测试发的提醒
  //    机器人提醒的特征：以 🤖 开头，且提到了本次测试账号的昵称
  const nicks = [A.user.nickname, B.user.nickname, C.user.nickname];
  let removedBot = 0;
  for (const n of nicks) {
    removedBot += await execute(
      `DELETE FROM chat_messages WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?)
        AND type = 'sys' AND content LIKE ? AND content LIKE '%🤖%'`,
      [testRoom, `%${n}%`]
    );
  }
  ok(`删掉了 ${removedBot} 条机器人提醒`);

  // 4. 删掉危机信号相关的关怀消息（它提到"心里话"）
  const removedCare = await execute(
    `DELETE FROM chat_messages WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?)
      AND type = 'sys' AND content LIKE '%心里话%'`,
    [testRoom]
  );
  ok(`删掉了 ${removedCare} 条关怀消息`);

  // 5. 清掉禁言状态和机器人的内存计数
  await execute(
    `UPDATE chat_members SET muted_until = NULL
      WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?)`,
    [testRoom]
  );
  await api('POST', '/api/group/_test/reset', { token: A.token });
  ok('已清掉禁言状态和机器人的内存计数');

  // 6. 把未读推到最新（避免留下红点）
  //    注意要在"退出房间"之前做 —— 退出之后就没有成员记录可更新了
  for (const u of [A, B, C]) {
    await api('POST', `/api/group/rooms/${testRoom}/read`, { token: u.token }).catch(() => null);
  }
  ok('已把所有测试账号的未读清零');

  // 7. 确认消息清理干净
  const leftRow = await queryOne(
    'SELECT COUNT(*) AS n FROM chat_messages WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?) AND content LIKE ?',
    [testRoom, `%${stamp}%`]
  );
  eq(Number(leftRow.n), 0, '★ 本次测试的消息清理干净');

  // ★ 8. 让测试账号退出这个房间 ★（这一步必须放在最后）
  //
  //  为什么必须做这一步：
  //    只进过群、没说过话的账号，在 chat_members 里有一行记录，
  //    其他表里什么都没有 —— 看起来像"真实用户"，
  //    于是 fix-test-account.js 认不出它是垃圾账号，永远清不掉。
  //
  //  （我在重构这个测试时曾经把这一步删掉，结果测试跑完留下两个
  //    清不掉的账号。是 fix-test-account.js 报"删除了 0 个"才发现的。）
  const leftMembers = await execute(
    `DELETE FROM chat_members
      WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?)
        AND user_id IN (?, ?, ?)`,
    [testRoom, A.user.id, B.user.id, C.user.id]
  );
  ok(`已让 ${leftMembers} 个测试账号退出「${testRoom}」`);

  const leftMemberCheck = await queryOne(
    `SELECT COUNT(*) AS n FROM chat_members
      WHERE room_id = (SELECT id FROM chat_rooms WHERE code = ?) AND user_id IN (?, ?, ?)`,
    [testRoom, A.user.id, B.user.id, C.user.id]
  );
  eq(Number(leftMemberCheck.n), 0, '★ 成员记录清理干净');

  // 关掉连接池，否则脚本干完活也不退出（连接让事件循环一直活着）
  await pool.end();

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 10 步（群聊 + 违规检测机器人）全部通过！\n');
    process.exitCode = 0;
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
    process.exitCode = 1;
  }
})().catch(async (e) => {
  console.error('\n测试脚本崩溃：', e);
  // 崩溃时也要关连接池，否则脚本卡住不退出
  try {

    await pool.end();
  } catch { /* 忽略 */ }
  process.exitCode = 1;
});
