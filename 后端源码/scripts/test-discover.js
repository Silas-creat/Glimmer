// ============================================================
//  第 11 步之二：发现页推荐流 集成测试
//
//  用法：  node scripts/test-discover.js
//
//  ★ 这个功能最容易做错的地方 ★
//    1. 做成了"时间线"而不是"推荐"（按时间倒序就是时间线）
//    2. 用 ORDER BY RAND() → 翻页会重复、会漏
//    3. 把自己 / 已关注的人 / 拉黑过自己的人都推给自己
//    4. 私密日记泄露到推荐流里（这是最严重的）
//
//  所以测试重点是：随机性 + 分页稳定性 + 各种该排除的人真的被排除了。
// ============================================================
import { query, queryOne, execute, insert, pool } from '../src/db/index.js';

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

/** 造日记用的固定日期（避免撞上 (user_id, date_key) 唯一约束） */
const TEST_DATES = [
  '2000-01-01', '2000-01-02', '2000-01-03', '2000-01-04',
  '2000-02-01', '2000-02-02', '2000-02-03', '2000-02-04',
  '2030-12-30',   // 一个"很新"的日期，用来验证推荐流不是按时间排的
  '2019-06-06',
];
let dateIdx = 0;

/** 直接写库造一篇日记，比走接口快得多 */
async function makeDiary(userId, text, { isPublic = 1 } = {}) {
  // ★ 日期必须是固定的，不能随机 ★
  //   diaries 表有 (user_id, date_key) 唯一约束（一人一天只能写一篇）。
  //   我第一版用随机日期，结果撞了唯一键直接崩。
  const dateKey = TEST_DATES[dateIdx++ % TEST_DATES.length];
  return insert(
    `INSERT INTO diaries (user_id, text, img, is_public, date_key)
     VALUES (?, ?, '', ?, ?)`,
    [userId, text, isPublic, dateKey]
  );
}

(async () => {
  console.log('==============================================');
  console.log('  第 11 步 · 发现页推荐流 集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const stamp = Date.now().toString().slice(-6);
  let A = null, B = null, C = null;
  const createdDiaryIds = [];
  const bottleIds = [];

  async function cleanup() {
    try {
      // 按测试专用的日期删（比按文本匹配可靠，私密日记也能删到）
      await execute(
        `DELETE FROM diaries WHERE date_key IN (${TEST_DATES.map(() => '?').join(',')})`,
        TEST_DATES
      );
      await execute('DELETE FROM follows WHERE user_id IN (?, ?, ?)',
        [A?.user.id || 0, B?.user.id || 0, C?.user.id || 0]);
    } catch { /* 忽略 */ }
  }

  try {
  // ---------- 准备 ----------
  step('0. 准备三个账号并造数据');
  A = await login('13800138000');
  B = await login('13912345678');
  C = await login('13700000001');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  ok(`B = ${B.user.nickname} (id=${B.user.id})`);
  ok(`C = ${C.user.nickname} (id=${C.user.id})`);

  await cleanup();

  // B 和 C 各造几篇公开日记
  for (let i = 1; i <= 3; i++) {
    createdDiaryIds.push(await makeDiary(B.user.id, `B的公开日记${i} ${stamp}`, { isPublic: 1 }));
  }
  for (let i = 1; i <= 2; i++) {
    createdDiaryIds.push(await makeDiary(C.user.id, `C的公开日记${i} ${stamp}`, { isPublic: 1 }));
  }
  // ★ B 还有一篇【私密】日记 —— 绝对不能出现在推荐流里 ★
  const bPrivate = await makeDiary(B.user.id, `B的私密日记 ${stamp}`, { isPublic: 0 });
  createdDiaryIds.push(bPrivate);
  ok('造了 5 篇公开日记 + 1 篇私密日记');

  // ---------- 1. 基本结构 ----------
  step('1. GET /api/discover  基本结构');
  const d1 = await api('GET', '/api/discover?size=10', { token: A.token });
  eq(d1.body?.code, 0, '能取到推荐流');
  truthy(Array.isArray(d1.body.data.list), 'list 是数组');
  truthy(d1.body.data.list.length > 0, `推荐了 ${d1.body.data.list.length} 条内容`);
  truthy(typeof d1.body.data.totalDiaries === 'number',
    `告诉我有 ${d1.body.data.totalDiaries} 篇可推荐的日记`);
  truthy(typeof d1.body.data.seedRefreshIn === 'number',
    `还有 ${d1.body.data.seedRefreshIn} 秒换一批`);
  truthy(typeof d1.body.data.hasMore === 'boolean', '带 hasMore');

  // 每条都要有 type 标记
  const types = [...new Set(d1.body.data.list.map(x => x.type))];
  truthy(types.every(t => ['diary', 'user', 'bottle'].includes(t)),
    `内容类型合法：${types.join('/')}`);
  ok('前端据 type 决定渲染成日记卡片、人物卡片还是漂流瓶');

  // ---------- 2. ★ 私密日记绝不泄露 ----------
  step('2. ★ 私密日记绝不能出现在推荐流里');
  const allTexts = d1.body.data.list
    .filter(x => x.type === 'diary')
    .map(x => x.diary.text)
    .join('|');
  eq(allTexts.includes('私密日记'), false, '★ 私密日记没出现在推荐流里');
  ok('这是最严重的一类 bug —— 私密内容泄露');

  // 数据库里确认那篇私密日记确实存在（不是因为没造出来才没出现）
  const privCheck = await queryOne('SELECT id, is_public FROM diaries WHERE id = ?', [bPrivate]);
  eq(Number(privCheck.is_public), 0, '（确认那篇私密日记真的存在且是私密的）');

  // ---------- 3. ★ 不推给自己 ----------
  step('3. ★ 不推荐自己的内容');
  // A 自己写一篇公开日记
  const aDiary = await makeDiary(A.user.id, `A自己的公开日记 ${stamp}`, { isPublic: 1 });
  createdDiaryIds.push(aDiary);

  const d2 = await api('GET', '/api/discover?size=50', { token: A.token });
  const hasMine = d2.body.data.list.some(x => x.type === 'diary' && x.diary.userId === A.user.id);
  eq(hasMine, false, '★ A 看不到自己的日记（自己的在"我的主页"里）');
  const meAsUser = d2.body.data.list.some(x => x.type === 'user' && x.user.userId === A.user.id);
  eq(meAsUser, false, '★ 也不会把自己当"人"推荐给自己');

  // B 看的话应该能看到 A 的
  const dB = await api('GET', '/api/discover?size=50', { token: B.token });
  truthy(dB.body.data.list.some(x => x.type === 'diary' && x.diary.userId === A.user.id),
    '★ B 能看到 A 的日记（说明只是"不推给自己"）');

  // ---------- 4. ★ 已关注的人不推 ----------
  step('4. ★ 已关注的人不重复推荐（他们在关注流里）');
  const follow = await api('POST', `/api/interact/follow-uid/${B.user.uid}`, { token: A.token });
  eq(follow.body?.code, 0, 'A 关注了 B');

  const d3 = await api('GET', '/api/discover?size=50', { token: A.token });
  const bDiaryInFeed = d3.body.data.list.some(
    x => x.type === 'diary' && x.diary.userId === B.user.id
  );
  eq(bDiaryInFeed, false, '★ 关注 B 之后，B 的日记不再出现在推荐流');
  const bAsUser = d3.body.data.list.some(x => x.type === 'user' && x.user.userId === B.user.id);
  eq(bAsUser, false, '★ B 这个人也不推荐了');

  // 但 C 的还在
  truthy(d3.body.data.list.some(x => x.type === 'diary' && x.diary.userId === C.user.id),
    'C 没被关注，他的日记还在推荐流里');

  // 取消关注后回来
  await api('POST', `/api/interact/follow-uid/${B.user.uid}`, { token: A.token });
  const d4 = await api('GET', '/api/discover?size=50', { token: A.token });
  truthy(d4.body.data.list.some(x => x.type === 'diary' && x.diary.userId === B.user.id),
    '取消关注后 B 的日记又出现了');
  ok('（关注/取关都会立刻影响推荐结果）');

  // ---------- 5. ★ 分页稳定性 ----------
  step('5. ★ 同一个种子下，翻页不重复（这是用 RAND() 会出错的地方）');
  // 取两页，检查没有重复
  const p1 = await api('GET', '/api/discover?size=2&page=1', { token: A.token });
  const p2 = await api('GET', '/api/discover?size=2&page=2', { token: A.token });

  const keyOf = (x) => x.type === 'diary' ? 'd' + x.diary.id
    : x.type === 'user' ? 'u' + x.user.userId
    : 'b' + x.bottle.id;

  const keys1 = p1.body.data.list.map(keyOf);
  const keys2 = p2.body.data.list.map(keyOf);
  const overlap = keys1.filter(k => keys2.includes(k));
  eq(overlap.length, 0, `★ 第 1 页和第 2 页没有重复（页1=${keys1.join(',')} 页2=${keys2.join(',')}）`);
  ok('如果用 ORDER BY RAND()，这里几乎必然有重复');

  // 再请求一次第 1 页，结果应该完全一样（种子没变）
  const p1again = await api('GET', '/api/discover?size=2&page=1', { token: A.token });
  eq(p1again.body.data.list.map(keyOf).join(','), keys1.join(','),
    '★ 同一个种子内重复请求第 1 页，结果完全一致（分页才有意义）');

  // ---------- 6. 不是时间线 ----------
  step('6. ★ 不是"按时间倒序"的时间线');
  // 我们在造数据时用了两个极端日期：
  //   2000-01-01（很旧）和 2030-12-30（很新）
  // 如果发现页是时间线，那么 2030 那篇一定排在最前面。
  // 推荐流用的是 MOD(id * 种子) 排序，和日期无关，所以不会这样。
  const d5 = await api('GET', '/api/discover?size=50', { token: A.token });
  const diaryItems = d5.body.data.list.filter(x => x.type === 'diary');

  const oldOne = diaryItems.find(x => x.diary.dateKey === '2000-01-01');
  const newOne = diaryItems.find(x => x.diary.dateKey === '2030-12-30');

  if (oldOne && newOne) {
    const oldPos = diaryItems.indexOf(oldOne);
    const newPos = diaryItems.indexOf(newOne);
    eq(newPos === 0, false, `★ 日期最新的那篇没有排在第 1 位（它排在第 ${newPos + 1} 位）`);
    console.log(`     \x1b[2m很旧的那篇（2000-01-01）排在第 ${oldPos + 1} 位\x1b[0m`);
    console.log(`     \x1b[2m最新的那篇（2030-12-30）排在第 ${newPos + 1} 位\x1b[0m`);
    ok('推荐流和日期无关 → 新旧内容会打散混在一起，这才叫"推荐"');
  } else {
    ok('（本次没同时取到那两篇极端日期的日记，跳过）');
  }

  // 顺带确认：推荐顺序【不是】简单的 id 倒序
  //
  //  说明：现在实现是"按哈希排名排 + 按类型轮流取"，
  //  拿到的已经是最终顺序，不再是原始 id 顺序。
  //  所以这里改成一个更有意义的检查：**推荐顺序不等于按 id 倒序**，
  //  同时顺序必须是**确定的**（同样请求两次结果一致），
  //  否则翻页就会乱。
  const diaryIds = diaryItems.map(x => x.diary.id);
  if (diaryIds.length >= 3) {
    const descending = [...diaryIds].sort((a, b) => b - a);
    eq(diaryIds.join(',') === descending.join(','), false,
      `★ 顺序不是按 id 倒序（实际 ${diaryIds.join(',')}）`);

    // 再请求一次（同一个种子），顺序必须完全一样
    const d5again = await api('GET', '/api/discover?size=50', { token: A.token });
    const idsAgain = d5again.body.data.list
      .filter(x => x.type === 'diary').map(x => x.diary.id);
    eq(idsAgain.join(','), diaryIds.join(','),
      '★ 同一批内重复请求，顺序完全一致（分页才可靠）');
  }

  // ---------- 7. 单类型筛选 ----------
  step('7. type 参数：只要某一类');
  const onlyDiary = await api('GET', '/api/discover?size=20&type=diary', { token: A.token });
  eq(onlyDiary.body.data.list.every(x => x.type === 'diary'), true,
    `type=diary 只返回日记（${onlyDiary.body.data.list.length} 条）`);

  const onlyUser = await api('GET', '/api/discover?size=20&type=user', { token: A.token });
  eq(onlyUser.body.data.list.every(x => x.type === 'user'), true,
    `type=user 只返回人（${onlyUser.body.data.list.length} 条）`);

  const onlyBottle = await api('GET', '/api/discover?size=20&type=bottle', { token: A.token });
  eq(onlyBottle.body.data.list.every(x => x.type === 'bottle'), true,
    `type=bottle 只返回漂流瓶（${onlyBottle.body.data.list.length} 条）`);

  // ---------- 8. 混合确实混着 ----------
  step('8. ★ 混合模式下三类内容是【交错】的，不是分组拼接');
  // 造几个漂流瓶，保证三类都有
  for (let i = 0; i < 3; i++) {
    bottleIds.push(await insert(
      'INSERT INTO bottles (user_id, content, is_anon) VALUES (?, ?, 1)',
      [B.user.id, `发现页测试瓶子${i} ${stamp}`]
    ));
  }

  const mixed = await api('GET', '/api/discover?size=50', { token: A.token });
  const mixedTypes = mixed.body.data.list.map(x => x.type);
  const distinct = [...new Set(mixedTypes)];
  truthy(distinct.length >= 2, `混合模式返回了 ${distinct.length} 种类型：${distinct.join('/')}`);
  console.log(`     \x1b[2m类型序列：${mixedTypes.map(t => t[0]).join(',')}\x1b[0m`);

  // ★ 检查"交错"而不是"分组" ★
  //
  //  分组的话形状是 [d,d,d,d,d,b,b,b,u,u] —— 同一个类型全连在一起，
  //  中间不会再有别的类型出现。
  //  判定方法：一个已经出现过的类型，后面又出现了，就说明是交错的。
  //
  //  （只靠哈希排名是不够的：日记有 5 篇、瓶子 3 个、人 2 个，
  //    总会有几篇日记的排名挨在一起。所以实现里额外做了"按类型轮流取"。）
  if (mixedTypes.length >= 3 && distinct.length >= 2) {
    // 找出"分组"的形状：每种类型只出现在一段连续区间里
    const runs = [];
    mixedTypes.forEach(t => {
      if (runs.length === 0 || runs[runs.length - 1] !== t) runs.push(t);
    });
    const isGrouped = runs.length === distinct.length;
    eq(isGrouped, false,
      `★ 类型是交错的（出现 ${runs.length} 段，${distinct.length} 种类型），不是分组拼接`);
  } else {
    ok('（内容太少，跳过交错检查）');
  }

  // ---------- 9. 未登录也能看 ----------
  step('9. 未登录也能看推荐流（浏览不需要登录）');
  const anon = await api('GET', '/api/discover?size=5');
  eq(anon.body?.code, 0, '★ 未登录能取推荐流');
  truthy(Array.isArray(anon.body.data.list), 'list 是数组');
  const anonDiary = anon.body.data.list.find(x => x.type === 'diary');
  if (anonDiary) {
    eq(anonDiary.diary.isLiked, false, '未登录时 isLiked 是 false（没有"我"的视角）');
    eq(anonDiary.diary.isMine, false, '未登录时 isMine 是 false');
  }
  ok('前端可以给未登录用户看，点操作时再引导登录');

  // ---------- 10. 字段够渲染 ----------
  step('10. 返回的字段够前端渲染');
  const d6 = await api('GET', '/api/discover?size=20', { token: A.token });
  const aDiaryItem = d6.body.data.list.find(x => x.type === 'diary');
  if (aDiaryItem) {
    for (const f of ['id', 'text', 'img', 'nick', 'avatar', 'likes', 'comments', 'isLiked', 'isSaved']) {
      truthy(f in aDiaryItem.diary, `日记字段 ${f} 存在`, Object.keys(aDiaryItem.diary));
    }
    ok(`头像已经转成完整 URL：${aDiaryItem.diary.avatar || '（默认头像）'}`);
  }
  const aUserItem = d6.body.data.list.find(x => x.type === 'user');
  if (aUserItem) {
    for (const f of ['userId', 'uid', 'nick', 'avatar', 'signature', 'diaryCount']) {
      truthy(f in aUserItem.user, `人物字段 ${f} 存在`, Object.keys(aUserItem.user));
    }
  }
  const aBottleItem = d6.body.data.list.find(x => x.type === 'bottle');
  if (aBottleItem) {
    for (const f of ['id', 'content', 'isAnon', 'nick', 'time']) {
      truthy(f in aBottleItem.bottle, `漂流瓶字段 ${f} 存在`, Object.keys(aBottleItem.bottle));
    }
    // ★ 不能断言"漂流瓶一定是匿名的" ★
    //   漂流瓶默认匿名，但它允许署名（isAnon=false）。
    //   我第一版写死 eq(nick, '一个陌生人')，库里一旦有署名瓶子
    //   （演示数据里就有一个）这条就挂，而且报错很误导。
    //   正确断言：匿名的显示"一个陌生人"，署名的显示真名。
    if (aBottleItem.bottle.isAnon) {
      eq(aBottleItem.bottle.nick, '一个陌生人', '匿名瓶子不暴露作者');
    } else {
      truthy(aBottleItem.bottle.nick && aBottleItem.bottle.nick !== '一个陌生人',
        `署名的瓶子显示作者（${aBottleItem.bottle.nick}）`);
    }
  }

  // ---------- 11. stats ----------
  step('11. GET /api/discover/stats');
  const stats = await api('GET', '/api/discover/stats', { token: A.token });
  eq(stats.body?.code, 0, '能取到推荐池统计');
  truthy(typeof stats.body.data.diaries === 'number', `日记 ${stats.body.data.diaries} 篇`);
  truthy(typeof stats.body.data.users === 'number', `用户 ${stats.body.data.users} 个`);
  truthy(typeof stats.body.data.bottles === 'number', `漂流瓶 ${stats.body.data.bottles} 个`);

  // ---------- 12. 参数边界 ----------
  step('12. 参数边界');
  const huge = await api('GET', '/api/discover?size=9999', { token: A.token });
  eq(huge.body?.code, 0, 'size 超大会被限制（不报错）');
  truthy(huge.body.data.list.length <= 50, `实际返回 ${huge.body.data.list.length} 条（上限 50）`);

  const badPage = await api('GET', '/api/discover?page=0', { token: A.token });
  eq(badPage.body?.code, 0, 'page=0 被纠正成第 1 页（不报错）');

  const weirdSize = await api('GET', '/api/discover?size=abc', { token: A.token });
  eq(weirdSize.body?.code, 0, 'size 传非数字不报错（用默认值）');

  const badType = await api('GET', '/api/discover?type=不存在的类型', { token: A.token });
  eq(badType.body?.code, 0, 'type 传非法值不报错（当作混合）');

  // ---------- 13. 清理 ----------
  step('13. 清理测试数据');
  await cleanup();
  for (const id of bottleIds) {
    await execute('DELETE FROM bottles WHERE id = ?', [id]);
  }
  ok(`删掉了 ${bottleIds.length} 个测试瓶子`);

  const leftDiaries = await queryOne(
    'SELECT COUNT(*) AS n FROM diaries WHERE text LIKE ?',
    [`%${stamp}%`]
  );
  eq(Number(leftDiaries.n), 0, '★ 测试日记清理干净');

  const leftFollows = await queryOne(
    'SELECT COUNT(*) AS n FROM follows WHERE user_id IN (?, ?, ?)',
    [A.user.id, B.user.id, C.user.id]
  );
  eq(Number(leftFollows.n), 0, '关注记录也清掉了');

  } finally {
    await cleanup();
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 发现页推荐流全部通过！\n');
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
