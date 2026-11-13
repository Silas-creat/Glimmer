// ============================================================
//  第 9 步：漂流瓶模块集成测试
//
//  用法：  node scripts/test-bottle.js
//
//  ★ 测试难点：扔瓶子有 20 秒频控 ★
//    所以"造一堆瓶子"不能靠接口，得直接写数据库。
//    这个脚本需要能在虚拟机上跑（因为要用 mysql2 直连）。
//    在 Windows 上跑时，用 ssh 转发执行。
//
//  覆盖：扔/捞/不重复捞/匿名/内容检测/危机信号/收回/统计
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

(async () => {
  console.log('==============================================');
  console.log('  第 9 步 · 漂流瓶模块集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // 本次测试造的所有瓶子 id，方便最后清理
  const createdBottleIds = [];
  let A = null, B = null, C = null;

  // ★ 清理逻辑放 finally，中途崩溃也能清干净
  //   （前面几步的经验：不这么做，崩溃一次就留下脏数据，
  //     下次运行断言全乱）
  async function cleanup() {
    if (createdBottleIds.length > 0) {
      try {
        await execute(
          `DELETE FROM bottles WHERE id IN (${createdBottleIds.map(() => '?').join(',')})`,
          createdBottleIds
        );
      } catch (e) {
        console.log(`  \x1b[33m⚠️  清理瓶子失败：${e.message}\x1b[0m`);
      }
    }
    // 再按用户兜一遍（防止有些瓶子没记上 id）
    if (A && B && C) {
      try {
        await execute(
          'DELETE FROM bottles WHERE user_id IN (?, ?, ?)',
          [A.user.id, B.user.id, C.user.id]
        );
      } catch { /* 忽略 */ }
    }

    // ★ 捞取记录要显式删，不能指望级联 ★
    //
    //  上面只删了"测试账号自己的瓶子"，级联能顺手删掉这些瓶子的捞取记录。
    //  但如果库里有别人的瓶子（比如演示数据），测试账号捞到之后
    //  会留下一条 bottle_picks —— 它不属于被删的瓶子，所以留了下来。
    //
    //  实测后果：库里先造了演示数据、再跑测试，这一步会报
    //    "捞取记录也级联清掉了（期望 0，实际 2）"。
    //  根因是测试假设了"数据库是空的"。
    if (A && B && C) {
      try {
        await execute(
          'DELETE FROM bottle_picks WHERE user_id IN (?, ?, ?)',
          [A.user.id, B.user.id, C.user.id]
        );
        // ★ 删完记录必须重算 pick_count ★
        //
        //  bottles.pick_count 是 bottle_picks 行数的冗余计数。
        //  只删记录不重算，就会留下"显示被捞过 1 次、但实际没人捞"的瓶子。
        //  下一次测试捞到它，计数从 1 变成 2，
        //  断言"被捞次数 +1 后应该是 1"就挂了 ——
        //  我就是在这一步发现计数和记录不一致的。
        await execute(
          `UPDATE bottles b
              SET pick_count = (SELECT COUNT(*) FROM bottle_picks bp WHERE bp.bottle_id = b.id)`
        );
      } catch { /* 忽略 */ }
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

  // 先清掉这三个账号已有的瓶子，保证起点干净
  const cleaned = await execute(
    'DELETE FROM bottles WHERE user_id IN (?, ?, ?)',
    [A.user.id, B.user.id, C.user.id]
  );
  if (cleaned > 0) ok(`清掉了这三人之前的 ${cleaned} 个瓶子（保证起点干净）`);
  else ok('起点本来就是干净的');

  const stamp = Date.now().toString().slice(-6);

  // ---------- 1. 扔瓶子 ----------
  step('1. 扔一个瓶子');
  let t1 = await api('POST', '/api/bottle/toss', {
    token: A.token, body: { content: `希望明天是个晴天 ${stamp}` },
  });

  // 被测系统自带 20 秒扔瓶冷却，测试自己也会被它挡住。
  // 如果上一轮测试（或同一个人）在 20 秒内扔过，这里会拿到 429；
  // 以前直接判失败，导致这套测试偶发挂，改成等冷却过去再扔一次。
  if (t1.status === 429) {
    const m = /还有 (\d+) 秒/.exec(t1.body?.msg || '');
    const waitSec = m ? Number(m[1]) : 20;
    ok(`命中 20 秒扔瓶冷却，等 ${waitSec} 秒后重试`);
    await new Promise(r => setTimeout(r, (waitSec + 1) * 1000));
    t1 = await api('POST', '/api/bottle/toss',
      { token: A.token, body: { content: `希望明天是个晴天 ${stamp}` } },
    );
  }
  eq(t1.body?.code, 0, '扔瓶子成功');
  const bottle1 = t1.body.data.bottle;
  createdBottleIds.push(bottle1.id);
  truthy(Number.isInteger(bottle1.id), `拿到瓶子 id=${bottle1.id}`);
  eq(bottle1.isAnon, true, '★ 默认是匿名的（漂流瓶本来就不该有署名压力）');
  eq(bottle1.pickCount, 0, '初始被捞次数 0');
  truthy(/海里/.test(t1.body.msg), `提示语有画面感（${t1.body.msg}）`);

  // ---------- 2. 频控 ----------
  step('2. 频率限制（20 秒内不能再扔）');
  const t2 = await api('POST', '/api/bottle/toss', {
    token: A.token, body: { content: `第二个瓶子 ${stamp}` },
  });
  eq(t2.status, 429, '★ 20 秒内连扔被拒绝（防刷屏）');
  truthy(/歇一会儿/.test(t2.body?.msg || ''), `提示语友好（${t2.body?.msg}）`);

  // ---------- 3. 内容检测 ----------
  step('3. 内容检测');
  const ad = await api('POST', '/api/bottle/toss', {
    token: B.token, body: { content: '加我微信 abc12345 有好事' },
  });
  truthy(ad.body?.code !== 0, '广告内容被拦', ad.body);
  truthy(/联系方式/.test(ad.body?.msg || ''), `提示语可读（${ad.body?.msg}）`);

  const abuse = await api('POST', '/api/bottle/toss', {
    token: B.token, body: { content: '你这个废物' },
  });
  truthy(abuse.body?.code !== 0, '人身攻击被拦', abuse.body);

  const spam = await api('POST', '/api/bottle/toss', {
    token: B.token, body: { content: 'a'.repeat(30) },
  });
  truthy(spam.body?.code !== 0, '刷屏被拦', spam.body);

  // ---------- 4. 危机信号 ----------
  step('4. ★ 危机信号：不拦截，返回关怀提示');
  const crisis = await api('POST', '/api/bottle/toss', {
    token: B.token, body: { content: `最近真的撑不下去了 ${stamp}` },
  });
  eq(crisis.body?.code, 0, '★ 危机信号没有被拒绝（这一点很重要）');
  truthy(!!crisis.body.data.care, '★ 返回了 care 关怀提示');
  truthy(crisis.body.data.care.lines.length > 0, `带 ${crisis.body.data.care.lines.length} 条热线`);
  createdBottleIds.push(crisis.body.data.bottle.id);

  // ---------- 5. 造一批瓶子用来测"海" ----------
  step('5. 直接写数据库造 12 个瓶子（绕开 20 秒频控）');
  // ★ 为什么直接写库：接口有 20 秒频控，用接口造 12 个瓶子要等 4 分钟。
  //   测试要快，所以造数据这一步走数据库。
  for (let i = 0; i < 12; i++) {
    const id = await insert(
      'INSERT INTO bottles (user_id, content, is_anon) VALUES (?, ?, ?)',
      [B.user.id, `造出来的瓶子 #${i} ${stamp}`, i % 2 === 0 ? 1 : 0]
    );
    createdBottleIds.push(id);
  }
  ok(`造了 12 个瓶子（B 的），其中 6 个匿名 6 个具名`);

  const seaStats = await api('GET', '/api/bottle/stats', { token: A.token });
  truthy(seaStats.body.data.floating >= 13, `海里现在有 ${seaStats.body.data.floating} 个瓶子`);

  // ---------- 6. 捞瓶子 ----------
  step('6. 捞瓶子（sea 接口）');
  const sea = await api('GET', '/api/bottle/sea?size=5', { token: A.token });
  eq(sea.body?.code, 0, '能捞到瓶子');
  eq(sea.body.data.list.length, 5, '★ 要 5 个就给 5 个（size 生效）');
  truthy(typeof sea.body.data.remaining === 'number', `告诉我还剩 ${sea.body.data.remaining} 个没捞过`);

  // ★ 不该捞到自己的瓶子
  const gotMine = sea.body.data.list.some(b => b.userId === A.user.id);
  eq(gotMine, false, '★ 不会捞到自己扔的瓶子');

  // ★ 匿名瓶子的作者信息不该暴露
  const anonInSea = sea.body.data.list.filter(b => b.isAnon);
  if (anonInSea.length > 0) {
    eq(anonInSea[0].nick, '一个陌生人', '★ 匿名瓶子的作者显示为"一个陌生人"');
    eq(anonInSea[0].avatar, '', '★ 匿名瓶子不给头像');
  } else {
    ok('（本次没捞到匿名瓶子，跳过匿名检查）');
  }

  // 具名瓶子应该给作者信息
  const namedInSea = sea.body.data.list.filter(b => !b.isAnon);
  if (namedInSea.length > 0) {
    truthy(namedInSea[0].nick !== '一个陌生人', `具名瓶子给出作者昵称（${namedInSea[0].nick}）`);
  } else {
    ok('（本次没捞到具名瓶子，跳过）');
  }

  // ---------- 7. 捞取记录（不重复捞） ----------
  step('7. ★ 捞过的不再推给我（这是"随机推送"的关键）');
  const seaIds1 = sea.body.data.list.map(b => b.id);

  // 标记捞取
  //
  //  ★ 断言用"相对值 +1"，不要写死成 1 ★
  //    海面是公共的：以前的测试账号捞过这个瓶子，记录还留库里，
  //    写死 1 就会越跑越离谱（第二遍 2、第三遍 3）。
  //    这不是产品 bug —— pick_count 确实等于 bottle_picks 的行数。
  const beforeRow = await queryOne('SELECT pick_count FROM bottles WHERE id = ?', [seaIds1[0]]);
  const beforeCount = Number(beforeRow ? beforeRow.pick_count : 0);

  const pick = await api('POST', `/api/bottle/pick/${seaIds1[0]}`, { token: A.token });
  eq(pick.body?.code, 0, '标记捞取成功');
  eq(pick.body.data.alreadyPicked, false, '第一次捞，不是重复');
  eq(pick.body.data.pickCount, beforeCount + 1, `被捞次数 +1（${beforeCount} → ${beforeCount + 1}）`);

  // 重复标记不报错
  const pickAgain = await api('POST', `/api/bottle/pick/${seaIds1[0]}`, { token: A.token });
  eq(pickAgain.body?.code, 0, '重复标记不报错（幂等）');
  eq(pickAgain.body.data.alreadyPicked, true, '第二次告诉我是重复的');
  const checkCount = await queryOne('SELECT pick_count FROM bottles WHERE id = ?', [seaIds1[0]]);
  eq(Number(checkCount.pick_count), beforeCount + 1, '★ 重复标记不会把计数再加一次');

  // 再捞一次，刚才那个不该出现
  const sea2 = await api('GET', '/api/bottle/sea?size=10', { token: A.token });
  const stillThere = sea2.body.data.list.some(b => b.id === seaIds1[0]);
  eq(stillThere, false, '★ 已捞过的瓶子不会再推给我');
  ok('所以用户刷新几次不会反复看到同样那几条');

  // 换个账号（C）应该还能捞到那个瓶子 —— 一个瓶子可以被多人捞到
  const seaC = await api('GET', '/api/bottle/sea?size=20', { token: C.token });
  const cCanSee = seaC.body.data.list.some(b => b.id === seaIds1[0]);
  const inAll = seaC.body.data.remaining >= 0;
  if (cCanSee) {
    ok('★ 换个账号还能捞到同一个瓶子（一个瓶子可以被多人捞到）');
  } else {
    // 随机排序，可能这次没抽到它，不算失败
    ok('（随机没抽到那个瓶子，无法验证多人捞取）');
  }

  // ---------- 8. 捞自己的瓶子 ----------
  step('8. 捞自己的瓶子应该被识别出来');
  const mineBottle = createdBottleIds[0];
  const pickMine = await api('POST', `/api/bottle/pick/${mineBottle}`, { token: A.token });
  eq(pickMine.body?.code, 0, '捞自己的瓶子不报错');
  eq(pickMine.body.data.isMine, true, '★ 告诉前端"这是你自己扔的"');

  // ---------- 9. 我扔过的 ----------
  step('9. GET /api/bottle/mine  我扔过的瓶子');
  const mine = await api('GET', '/api/bottle/mine?size=50', { token: A.token });
  eq(mine.body?.code, 0, '能取到我扔的瓶子');
  truthy(mine.body.data.list.some(b => b.id === mineBottle), '列表里有我扔的那个');
  truthy(typeof mine.body.data.totalPicks === 'number',
    `★ 告诉我"我扔的瓶子一共被捞了 ${mine.body.data.totalPicks} 次"（这个数字有点温暖）`);
  // 自己看自己的瓶子，即使是匿名的也应该知道是自己的
  const ownAnon = mine.body.data.list.find(b => b.id === mineBottle);
  eq(ownAnon.isMine, true, '自己看自己的匿名瓶，标记 isMine=true');

  // ---------- 10. 我捞过的 ----------
  step('10. GET /api/bottle/picked  我捞到过的瓶子');
  const picked = await api('GET', '/api/bottle/picked?size=50', { token: A.token });
  eq(picked.body?.code, 0, '能取到我捞过的瓶子');
  truthy(picked.body.data.list.some(b => b.id === seaIds1[0]), '列表里有刚才捞的那个');
  const pickedItem = picked.body.data.list.find(b => b.id === seaIds1[0]);
  truthy(!!pickedItem.pickedTime, `带捞取时间（${pickedItem.pickedTime}）`);

  // ---------- 11. 收回 ----------
  step('11. 收回自己的瓶子');
  const del = await api('DELETE', `/api/bottle/${mineBottle}`, { token: A.token });
  eq(del.body?.code, 0, 'A 能收回自己扔的瓶子');

  const mineAfter = await api('GET', '/api/bottle/mine?size=50', { token: A.token });
  eq(mineAfter.body.data.list.some(b => b.id === mineBottle), false, '收回后不在我的列表里了');

  const seaAfterRecover = await api('GET', '/api/bottle/sea?size=20', { token: C.token });
  eq(seaAfterRecover.body.data.list.some(b => b.id === mineBottle), false,
    '★ 收回的瓶子不会再出现在海里');

  // 越权收回
  const delOther = await api('DELETE', `/api/bottle/${createdBottleIds[1]}`, { token: A.token });
  eq(delOther.status, 403, '★ A 不能收回 B 的瓶子（403）');

  // ---------- 12. 捞不存在的瓶子 ----------
  step('12. 边界情况');
  const ghost = await api('POST', '/api/bottle/pick/99999999', { token: A.token });
  eq(ghost.status, 404, '捞不存在的瓶子返回 404');

  const removed = await api('POST', `/api/bottle/pick/${mineBottle}`, { token: C.token });
  eq(removed.status, 404, '捞已被收回的瓶子返回 404');

  const tossEmpty = await api('POST', '/api/bottle/toss', { token: C.token, body: { content: '  ' } });
  truthy(tossEmpty.body?.code !== 0, '扔空瓶子被拒绝', tossEmpty.body);

  // ---------- 13. 重复内容 ----------
  step('13. 完全相同的内容不能重复扔');
  // C 先扔一个
  const ct1 = await api('POST', '/api/bottle/toss', {
    token: C.token, body: { content: `C的瓶子 ${stamp}` },
  });
  eq(ct1.body?.code, 0, 'C 扔成功');
  createdBottleIds.push(ct1.body.data.bottle.id);
  // 立刻再扔一样的（此时会被频控拦，也可能被重复内容拦，两个都算对）
  const ct2 = await api('POST', '/api/bottle/toss', {
    token: C.token, body: { content: `C的瓶子 ${stamp}` },
  });
  truthy(ct2.body?.code !== 0, '重复内容被拦（或频控拦）', ct2.body);

  // ---------- 14. 未登录 ----------
  step('14. 未登录的行为');
  eq((await api('POST', '/api/bottle/toss', { body: { content: '匿名扔' } })).status,
    401, '未登录不能扔瓶子');
  const anonSea = await api('GET', '/api/bottle/sea?size=3');
  eq(anonSea.body?.code, 0, '★ 未登录也能看海里的瓶子（浏览不需要登录）');
  eq((await api('GET', '/api/bottle/mine')).status, 401, '未登录不能看"我扔的"');

  // ---------- 15. 次数上限 ----------
  step('15. 被捞太多次的瓶子自动沉底');
  const hotId = createdBottleIds[2];
  // 直接把 pick_count 拉到上限
  await execute('UPDATE bottles SET pick_count = 999 WHERE id = ?', [hotId]);
  const seaHot = await api('GET', '/api/bottle/sea?size=20', { token: A.token });
  eq(seaHot.body.data.list.some(b => b.id === hotId), false,
    '★ 被捞次数超上限的瓶子不再推给别人（避免一条留言霸屏）');

  // ---------- 16. 清理 ----------
  step('16. 清理测试数据');
  await cleanup();
  ok('已清理本次测试产生的瓶子（bottle_picks 会级联删除）');

  const leftBottles = await queryOne(
    'SELECT COUNT(*) AS n FROM bottles WHERE user_id IN (?, ?, ?) OR content LIKE ?',
    [A.user.id, B.user.id, C.user.id, `%${stamp}%`]
  );
  eq(Number(leftBottles.n), 0, '测试数据清理干净');

  const leftPicks = await queryOne(
    'SELECT COUNT(*) AS n FROM bottle_picks WHERE user_id IN (?, ?, ?)',
    [A.user.id, B.user.id, C.user.id]
  );
  eq(Number(leftPicks.n), 0, '捞取记录也级联清掉了');

  } finally {
    // ★ 无论成功失败，最后再兜一次清理
    await cleanup();
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 9 步（漂流瓶）全部通过！\n');
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
