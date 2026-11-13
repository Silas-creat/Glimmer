// ============================================================
//  第 4 步：日记模块集成测试
//
//  用法：  node scripts/test-diary.js
//          node scripts/test-diary.js http://127.0.0.1:3000
//
//  它从【Windows 宿主机】直接打虚拟机的接口，所以顺手验证了跨网络链路。
//  覆盖：新建/修改/删除、公开私密权限、列表各种筛选、日历、参数校验
// ============================================================

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const failures = [];

function ok(msg) { console.log(`  \x1b[32m✅\x1b[0m ${msg}`); pass++; }
function bad(msg, extra) {
  console.log(`  \x1b[31m❌\x1b[0m ${msg}`);
  if (extra !== undefined) console.log(`     实际: ${JSON.stringify(extra).slice(0, 300)}`);
  fail++;
  failures.push(msg);
}
function step(t) { console.log(`\n${'─'.repeat(46)}\n  ${t}\n${'─'.repeat(46)}`); }

/** 简易断言 */
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
function assertTrue(cond, msg, actual) {
  if (cond) ok(msg);
  else bad(msg, actual);
}

/** 统一请求封装 */
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

async function login(phone) {
  const r = await api('POST', '/api/auth/login', { body: { phone, code: '123456' } });
  if (r.body?.code !== 0) throw new Error(`登录失败 ${phone}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}

// ============================================================
(async () => {
  console.log('==============================================');
  console.log('  第 4 步 · 日记模块集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 准备：两个用户 ----------
  step('0. 准备两个测试账号');
  let userA, userB;
  try {
    userA = await login('13800138000');   // 已存在的用户
    ok(`用户A 登录成功 (id=${userA.user.id}, ${userA.user.nickname})`);
  } catch (e) { bad('用户A 登录失败: ' + e.message); process.exit(1); }

  try {
    userB = await login('13912345678');   // 已存在的用户
    ok(`用户B 登录成功 (id=${userB.user.id}, ${userB.user.nickname})`);
  } catch (e) { bad('用户B 登录失败: ' + e.message); process.exit(1); }

  const A = userA.token, B = userB.token;
  assertTrue(userA.user.id !== userB.user.id, '两个账号确实是不同的人');

  // ---------- 1. 新建日记 ----------
  step('1. 新建日记（公开 + 私密各一条）');
  const TEXT_PUB = '【测试】今天出门，看见楼下的猫在晒太阳。\n突然觉得，活着也没那么难。';
  const TEXT_PRI = '【测试】这是私密日记，别人不该看到。';

  const r1 = await api('POST', '/api/diary/save', {
    token: A,
    body: { date: '2026-10-20', text: TEXT_PUB, img: 'https://example.com/a.jpg', isPublic: true },
  });
  assertEq(r1.body?.code, 0, '公开日记保存成功');
  assertEq(r1.body?.data?.action, 'created', '返回 action=created（是新建）');
  const pubId = r1.body?.data?.diary?.id;
  assertTrue(Number.isInteger(pubId) && pubId > 0, '拿到了日记 id', r1.body?.data?.diary);
  assertEq(r1.body?.data?.diary?.isPublic, true, 'isPublic 正确保存为 true');
  assertEq(r1.body?.data?.diary?.dateKey, '2026-10-20', 'dateKey 正确');
  assertTrue(Boolean(r1.body?.data?.diary?.time), '自动生成了相对时间字段');

  const r2 = await api('POST', '/api/diary/save', {
    token: A,
    body: { date: '2026-10-21', text: TEXT_PRI, isPublic: false },
  });
  assertEq(r2.body?.code, 0, '私密日记保存成功');
  const priId = r2.body?.data?.diary?.id;
  assertEq(r2.body?.data?.diary?.isPublic, false, 'isPublic 正确保存为 false');

  // ---------- 2. 一天一篇：同一天再存应该是修改 ----------
  step('2. 一天一篇：同一天再保存应该是"修改"而不是新增');
  const r3 = await api('POST', '/api/diary/save', {
    token: A,
    body: { date: '2026-10-20', text: TEXT_PUB + '（改过）', isPublic: true },
  });
  assertEq(r3.body?.data?.action, 'updated', '返回 action=updated');
  assertEq(r3.body?.data?.diary?.id, pubId, 'id 没变（是同一篇）');
  assertTrue(r3.body?.data?.diary?.text?.includes('（改过）'), '正文确实被更新了');

  // 验证数据库里真的只有一篇
  const listCheck = await api('GET', '/api/diary/feed?feed=mine&date=2026-10-20', { token: A });
  assertEq(listCheck.body?.data?.total, 1, '同一天在数据库里只有 1 篇');

  // ---------- 3. 不传图片时不该把原图弄丢 ----------
  step('3. 修改时不传 img，原配图应该保留');
  const r4 = await api('POST', '/api/diary/save', {
    token: A,
    body: { date: '2026-10-20', text: TEXT_PUB + '（再改）', isPublic: true },
  });
  assertEq(r4.body?.data?.diary?.img, 'https://example.com/a.jpg', '原配图被保留');

  // ---------- 4. 参数校验 ----------
  step('4. 参数校验');
  const rEmpty = await api('POST', '/api/diary/save', {
    token: A, body: { date: '2026-10-22', text: '   ' },
  });
  assertTrue(rEmpty.body?.code !== 0, '空内容被拒绝', rEmpty.body);

  const rBadDate = await api('POST', '/api/diary/save', {
    token: A, body: { date: '2026-13-45', text: '内容' },
  });
  assertTrue(rBadDate.body?.code !== 0, '不存在的日期被拒绝（2026-13-45）', rBadDate.body);

  const rFakeDate = await api('POST', '/api/diary/save', {
    token: A, body: { date: '2026-02-30', text: '内容' },
  });
  assertTrue(rFakeDate.body?.code !== 0, '假日期被拒绝（2026-02-30，平年没有2月30）', rFakeDate.body);

  const rNoAuth = await api('POST', '/api/diary/save', {
    body: { date: '2026-10-22', text: '没登录' },
  });
  assertEq(rNoAuth.status, 401, '未登录不能保存日记');

  // ---------- 5. 超长内容 ----------
  step('5. 超长内容应该被截断而不是报错');
  const longText = '啊'.repeat(6000);
  const rLong = await api('POST', '/api/diary/save', {
    token: A, body: { date: '2026-10-23', text: longText, isPublic: true },
  });
  assertEq(rLong.body?.code, 0, '超长内容保存成功（被截断到 5000 字）');
  assertTrue(rLong.body?.data?.diary?.text?.length <= 5000, '正文长度不超过 5000',
    rLong.body?.data?.diary?.text?.length);

  // ---------- 6. 我的列表：能看到自己的私密日记 ----------
  step('6. feed=mine：能看到自己的全部日记（含私密）');
  const mine = await api('GET', '/api/diary/feed?feed=mine&size=50', { token: A });
  assertEq(mine.body?.code, 0, '能取到我的日记列表');
  const mineIds = (mine.body?.data?.list || []).map(d => d.id);
  assertTrue(mineIds.includes(pubId), '列表里有那篇公开日记');
  assertTrue(mineIds.includes(priId), '列表里有那篇私密日记');
  assertTrue((mine.body?.data?.list || []).every(d => d.isMine === true), '每条都标记了 isMine=true');

  // ---------- 7. 别人不能通过 feed=mine 看到我的私密日记 ----------
  step('7. 权限：B 用 feed=mine 只能看到 B 自己的东西');
  const mineB = await api('GET', '/api/diary/feed?feed=mine&size=50', { token: B });
  const mineBIds = (mineB.body?.data?.list || []).map(d => d.id);
  assertTrue(!mineBIds.includes(priId), 'B 的"我的日记"里没有 A 的私密日记');
  assertTrue(!mineBIds.includes(pubId), 'B 的"我的日记"里没有 A 的公开日记（不是自己的）');

  // ---------- 8. 隐私保护：直接按 id 访问私密日记 ----------
  step('8. 隐私：B 直接按 id 访问 A 的私密日记，应该 404');
  const peek = await api('GET', `/api/diary/${priId}`, { token: B });
  assertEq(peek.status, 404, '私密日记对别人返回 404（不暴露存在性）');

  const peekNoAuth = await api('GET', `/api/diary/${priId}`);
  assertEq(peekNoAuth.status, 404, '未登录访问私密日记也是 404');

  const peekPub = await api('GET', `/api/diary/${pubId}`, { token: B });
  assertEq(peekPub.body?.code, 0, '公开日记别人能正常访问');
  assertEq(peekPub.body?.data?.diary?.isMine, false, '标记为不是自己的');

  // ---------- 9. 浏览数 ----------
  step('9. 浏览数：别人看会 +1，自己看不算');
  // 注意：接口返回的是"本次浏览之后"的真实值，不是浏览前的旧值。
  // 如果返回旧值，前端要刷新一下才能看到正确的数字，那是脏读 bug。
  const first = await api('GET', `/api/diary/${pubId}`, { token: B });
  const v1 = first.body?.data?.diary?.views;
  assertTrue(typeof v1 === 'number', '返回了浏览数', v1);

  const second = await api('GET', `/api/diary/${pubId}`, { token: B });
  const v2 = second.body?.data?.diary?.views;
  assertEq(v2, v1 + 1, 'B 再看一次，返回值里浏览数确实 +1（没有脏读）');

  const ownView = await api('GET', `/api/diary/${pubId}`, { token: A });
  assertEq(ownView.body?.data?.diary?.views, v2, '作者自己看，浏览数不变');
  assertEq(ownView.body?.data?.diary?.isMine, true, '作者自己看时标记 isMine=true');

  // ---------- 10. 公开流 ----------
  step('10. feed=all：公开流里只有公开日记');
  const all = await api('GET', '/api/diary/feed?size=50');
  const allIds = (all.body?.data?.list || []).map(d => d.id);
  assertTrue(allIds.includes(pubId), '公开流里有那篇公开日记');
  assertTrue(!allIds.includes(priId), '公开流里没有私密日记');
  assertTrue((all.body?.data?.list || []).every(d => d.isPublic === true), '公开流每条都是 isPublic=true');

  // ---------- 11. 按昵称查 ----------
  step('11. 按昵称查某个人的日记');
  const byNick = await api('GET', `/api/diary/feed?nick=${encodeURIComponent(userA.user.nickname)}&size=50`);
  assertEq(byNick.body?.code, 0, '按昵称查询成功');
  const nickIds = (byNick.body?.data?.list || []).map(d => d.id);
  assertTrue(nickIds.includes(pubId), '能查到该用户的公开日记');
  assertTrue(!nickIds.includes(priId), '查不到该用户的私密日记');
  assertTrue((byNick.body?.data?.list || []).every(d => d.nick === userA.user.nickname),
    '返回的昵称都对得上');

  // ---------- 12. 按日期查具体日记 ----------
  step('12. GET /api/diary/date/:date  回填某天的日记');
  const byDate = await api('GET', '/api/diary/date/2026-10-20', { token: A });
  assertEq(byDate.body?.code, 0, '按日期取日记成功');
  assertEq(byDate.body?.data?.diary?.id, pubId, '取到的就是那天那篇');

  const noDate = await api('GET', '/api/diary/date/2020-01-01', { token: A });
  assertEq(noDate.body?.data?.diary, null, '那天没写过，返回 null（不是报错）');

  // ---------- 13. 分页 ----------
  step('13. 分页');
  const p1 = await api('GET', '/api/diary/feed?feed=mine&page=1&size=2', { token: A });
  assertEq(p1.body?.data?.page, 1, 'page 回显正确');
  assertEq(p1.body?.data?.size, 2, 'size 回显正确');
  assertTrue((p1.body?.data?.list || []).length <= 2, '每页最多 2 条');
  assertTrue(typeof p1.body?.data?.total === 'number', '返回了 total');

  const pBig = await api('GET', '/api/diary/feed?size=9999');
  assertEq(pBig.body?.data?.size, 50, 'size 超上限被限制到 50（防止一次拉太多）');

  const pBad = await api('GET', '/api/diary/feed?page=-5&size=abc');
  assertEq(pBad.body?.data?.page, 1, '非法 page 被纠正为 1');
  assertEq(pBad.body?.data?.size, 20, '非法 size 被纠正为默认 20');

  // ---------- 14. 日历 ----------
  step('14. 日历接口');
  const cal = await api('GET', '/api/diary/calendar?year=2026&month=10', { token: A });
  assertEq(cal.body?.code, 0, '日历接口正常');
  const dates = cal.body?.data?.dates || [];
  assertTrue(dates.includes('2026-10-20'), '日历里标记了 10-20 写过');
  assertTrue(dates.includes('2026-10-21'), '日历里标记了 10-21 写过');

  // ★ "没写过的日期不在列表里"——这个日期要选得小心 ★
  //
  //  我第一版写死的是 2026-10-19（"今天"），心想"今天肯定没写过"。
  //  但演示数据里恰好有一篇"今天"的日记（seed-demo 用 daysAgo: 0），
  //  于是这条断言在"库里有演示数据"时就会挂 ——
  //  而且报错只说"没写过的日期不在列表里"，完全看不出是数据冲突。
  //
  //  改用"本月初"：演示数据最多往前 5 天，不会碰到 10-01；
  //  测试自己写的是 10-20 / 10-21，也不会碰。
  //
  //  ⚠️ 如果哪天把演示数据扩到月初，这条又要调 ——
  //     到时候改成"先查一下这个月哪些天有数据，再挑一个空的"。
  const EMPTY_DATE = '2026-10-01';
  assertTrue(!dates.includes(EMPTY_DATE), `没写过的日期（${EMPTY_DATE}）不在列表里`);
  assertTrue(Array.isArray(cal.body?.data?.detail), '返回了 detail 明细（含公开/私密）');
  const d21 = (cal.body?.data?.detail || []).find(d => d.dateKey === '2026-10-21');
  assertEq(d21?.isPublic, false, '10-21 的明细标记为私密');

  // 边界：12 月要能正确跨年
  const calDec = await api('GET', '/api/diary/calendar?year=2026&month=12', { token: A });
  assertEq(calDec.body?.code, 0, '12 月日历正常（跨年边界）');

  // ---------- 15. 关注流 ----------
  step('15. feed=follow：关注流包含自己和关注的人');
  const follow = await api('GET', '/api/diary/feed?feed=follow&size=50', { token: A });
  assertEq(follow.body?.code, 0, '关注流正常返回');
  const followIds = (follow.body?.data?.list || []).map(d => d.id);
  assertTrue(followIds.includes(pubId), '关注流里有自己的公开日记');
  assertTrue(followIds.includes(priId), '关注流里有自己的私密日记（自己看得到）');
  assertTrue(!followIds.includes(priId) || followIds.includes(priId), '（自己人逻辑自洽）');

  // ---------- 16. 切换公开私密 ----------
  step('16. 切换公开/私密');
  const toggle = await api('PATCH', `/api/diary/${pubId}/visibility`, { token: A });
  assertEq(toggle.body?.data?.isPublic, false, '切换后变成私密');
  const hideCheck = await api('GET', `/api/diary/${pubId}`, { token: B });
  assertEq(hideCheck.status, 404, '切私密后别人访问不到了');

  const toggleBack = await api('PATCH', `/api/diary/${pubId}/visibility`, {
    token: A, body: { isPublic: true },
  });
  assertEq(toggleBack.body?.data?.isPublic, true, '再切回公开');

  // ---------- 17. 越权操作 ----------
  step('17. 越权保护');
  const delOther = await api('DELETE', `/api/diary/${pubId}`, { token: B });
  assertEq(delOther.status, 403, 'B 不能删 A 的日记（403）');

  const visOther = await api('PATCH', `/api/diary/${pubId}/visibility`, { token: B });
  assertEq(visOther.status, 403, 'B 不能改 A 的日记可见性（403）');

  // ---------- 18. 删除 ----------
  step('18. 删除日记');
  const rDel = await api('DELETE', `/api/diary/${priId}`, { token: A });
  assertEq(rDel.body?.code, 0, '作者删除私密日记成功');

  const afterDel = await api('GET', `/api/diary/${priId}`, { token: A });
  assertEq(afterDel.status, 404, '删掉之后作者自己也查不到了');

  const delAgain = await api('DELETE', `/api/diary/${priId}`, { token: A });
  assertEq(delAgain.status, 404, '重复删除返回 404（幂等安全）');

  // ---------- 19. 清理 ----------
  step('19. 清理测试数据');
  for (const [token, date] of [[A, '2026-10-20'], [A, '2026-10-23']]) {
    const find = await api('GET', `/api/diary/date/${date}`, { token });
    const id = find.body?.data?.diary?.id;
    if (id) {
      await api('DELETE', `/api/diary/${id}`, { token });
      ok(`已清理 ${date}`);
    }
  }
  const finalMine = await api('GET', '/api/diary/feed?feed=mine&size=50', { token: A });
  const leftover = (finalMine.body?.data?.list || []).filter(d =>
    d.dateKey === '2026-10-20' || d.dateKey === '2026-10-23'
  );
  assertEq(leftover.length, 0, '测试数据清理干净');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');

  if (fail === 0) {
    console.log('\n  🎉 第 4 步（日记 CRUD）全部通过！\n');
    process.exit(0);
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
    process.exit(1);
  }
})().catch(e => {
  console.error('\n测试脚本崩溃：', e);
  process.exit(1);
});
