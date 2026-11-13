// ============================================================
//  第 9 步：前端 api.js 的漂流瓶接口契约测试
//
//  用法：  node scripts/test-api-bottle.js
//
//  ★ 这个测试要在虚拟机上跑 ★
//    因为"造一批瓶子"需要直连数据库（接口有 20 秒频控，
//    用接口造 10 个瓶子要等 3 分钟）。
//
//  确认前端 weiguang.html 渲染时用到的字段都在，
//  以及"捞过的不再推给我"这个核心行为。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { query, queryOne, execute, insert, pool } from '../src/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

// 在虚拟机上跑时，前端目录可能不存在 —— 那就从测试目录旁边找
function resolveFrontendDir() {
  if (fs.existsSync(FRONTEND)) return FRONTEND;
  // 允许用环境变量指定
  if (process.env.FRONTEND_DIR && fs.existsSync(process.env.FRONTEND_DIR)) {
    return process.env.FRONTEND_DIR;
  }
  throw new Error(
    `找不到前端目录 ${FRONTEND}\n` +
    `  在虚拟机上跑时请用： FRONTEND_DIR=/path/to/前端八稿 node scripts/test-api-bottle.js`
  );
}

// ★ 判断"是不是抛错"，不能用 instanceof Error
//
//   api.js 是在 vm 沙箱里执行的，沙箱有【自己的 Error 构造函数】，
//   属于不同的 realm。所以：
//     sandboxError instanceof Error   → 永远是 false
//   这个问题很隐蔽 —— 错误明明抛出来了、message 也读得到，
//   但 instanceof 判断就是不成立（我在这上面浪费了一轮排查）。
//
//   正确做法是鸭子类型：
//     有 message 字符串，且不是成功响应的形状（成功时有 bottle/comment 等字段）
function isApiError(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.message !== 'string') return false;
  // 成功响应不会带这些字段
  return !('bottle' in v) && !('code' in v);
}

let pass = 0, fail = 0;
const failures = [];
const ok = (m) => { console.log(`  \x1b[32m✅\x1b[0m ${m}`); pass++; };
const bad = (m, extra) => {
  console.log(`  \x1b[31m❌\x1b[0m ${m}`);
  if (extra !== undefined) console.log(`     ${JSON.stringify(extra).slice(0, 260)}`);
  fail++; failures.push(m);
};
const step = (t) => console.log(`\n${'─'.repeat(46)}\n  ${t}\n${'─'.repeat(46)}`);
const eq = (a, b, m) => a === b ? ok(m) : bad(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const truthy = (c, m, actual) => c ? ok(m) : bad(m, actual);

function loadApiClient() {
  const dir = resolveFrontendDir();
  const src = fs.readFileSync(path.join(dir, 'api.js'), 'utf8');
  const patched = src.replace(/var BASE = '[^']*';/, `var BASE = '${BASE}';`);

  const store = new Map();
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: globalThis.fetch,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    File: globalThis.File,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    location: { href: '', pathname: 'x.html', search: '' },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, appendChild() {} }),
      body: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  new vm.Script(patched, { filename: 'api.js' }).runInContext(ctx);
  return ctx.API;
}

(async () => {
  console.log('==============================================');
  console.log('  第 9 步 · 前端 api.js 漂流瓶接口契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const createdIds = [];
  let A = null, B = null;
  let cleaned = false;

  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try {
      if (createdIds.length > 0) {
        await execute(
          `DELETE FROM bottles WHERE id IN (${createdIds.map(() => '?').join(',')})`,
          createdIds
        );
      }
      if (A && B) {
        await execute('DELETE FROM bottles WHERE user_id IN (?, ?)', [A.user.id, B.user.id]);
        // ★ 捞取记录要显式删 ★
        //   测试账号可能捞到了别人的瓶子（比如演示数据里的），
        //   那条 bottle_picks 不属于被删的瓶子，级联删不到。
        //   不删的话，跑完会报"捞取记录也清掉了（期望 0，实际 3）"。
        //   根因是测试假设了"数据库是空的"。
        await execute('DELETE FROM bottle_picks WHERE user_id IN (?, ?)', [A.user.id, B.user.id]);
        // ★ 删完记录必须重算 pick_count ★
        //   pick_count 是 bottle_picks 行数的冗余计数。
        //   只删记录不重算，会留下"显示被捞过 1 次、实际没人捞"的瓶子，
        //   下次测试捞到它，计数就变成 2，断言会挂。
        await execute(
          `UPDATE bottles b
              SET pick_count = (SELECT COUNT(*) FROM bottle_picks bp WHERE bp.bottle_id = b.id)`
        );
      }
    } catch { /* 忽略 */ }
  }

  try {
  // ---------- 1. 结构 ----------
  step('1. api.js 是否导出了 bottle 命名空间');
  const API = loadApiClient();
  truthy(!!API.bottle, 'API.bottle 存在');
  for (const fn of ['toss', 'sea', 'pick', 'mine', 'picked', 'stats', 'remove']) {
    eq(typeof API.bottle[fn], 'function', `API.bottle.${fn} 是函数`);
  }

  // ---------- 2. 登录 ----------
  step('2. 登录两个账号');
  const API_B = loadApiClient();
  A = await API.auth.login('13800138000', '123456');
  B = await API_B.auth.login('13912345678', '123456');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  ok(`B = ${B.user.nickname} (id=${B.user.id})`);

  // 清掉旧数据，保证起点干净
  await execute('DELETE FROM bottles WHERE user_id IN (?, ?)', [A.user.id, B.user.id]);
  const stamp = Date.now().toString().slice(-6);

  // ★ 测试顺序很重要：扔瓶子有 20 秒频控 ★
  //
  //  顺序必须是：
  //    1. 先测"内容检测"（A 还没扔过，没有冷却期）
  //    2. 再让 A 成功扔一个
  //    3. 紧接着测"频控"（此时 A 正好在冷却期）
  //    4. 然后全是捞瓶子相关的测试（不受频控影响）
  //
  //  我第一版把内容检测写在扔瓶子之后，结果它被 A 自己的
  //  冷却期拦住，报的是"歇一会儿再扔吧"而不是内容检测的错 ——
  //  测试失败信息完全指错了方向。

  // ---------- 3. 内容检测（必须在扔之前测）----------
  step('3. 内容检测：广告/辱骂/刷屏都要拦住');
  const ad = await API.bottle.toss({ content: '加我微信 abc12345 有好事' }).catch(e => e);
  truthy(isApiError(ad), '广告内容被拦');
  if (isApiError(ad)) truthy(/联系方式/.test(ad.message), `提示语可读（${ad.message}）`);

  const abuse = await API.bottle.toss({ content: '你这个废物' }).catch(e => e);
  truthy(isApiError(abuse), '人身攻击被拦');

  const spam = await API.bottle.toss({ content: 'a'.repeat(30) }).catch(e => e);
  truthy(isApiError(spam), '刷屏被拦');

  const empty = await API.bottle.toss({ content: '   ' }).catch(e => e);
  truthy(isApiError(empty), '空内容被拦');

  // ---------- 4. 扔瓶子 ----------
  step('4. API.bottle.toss() 正常扔一个');
  const t1 = await API.bottle.toss({ content: `契约测试的瓶子 ${stamp}` });
  createdIds.push(t1.bottle.id);
  eq(typeof t1.bottle.id, 'number', '返回瓶子 id');
  eq(t1.care, null, '正常内容 care 是 null');

  // ---------- 5. 频控（紧接着扔，正好在冷却期）----------
  step('5. 频控：20 秒内不能再扔');
  const cooldown = await API.bottle.toss({ content: `紧接着再扔 ${stamp}` }).catch(e => e);
  truthy(isApiError(cooldown), '★ 连续扔被拦住');
  if (isApiError(cooldown)) {
    truthy(/歇一会儿/.test(cooldown.message), `提示语友好（${cooldown.message}）`);
  }

  // ---------- 6. 字段是否够渲染 ----------
  step('6. 瓶子字段是否满足前端渲染');
  for (const f of ['id', 'content', 'isAnon', 'time', 'pickCount', 'isMine']) {
    truthy(f in t1.bottle, `字段 ${f} 存在`, Object.keys(t1.bottle));
  }
  eq(t1.bottle.isMine, true, '★ 自己扔的 isMine=true（前端要显示"这是我扔的"）');
  eq(t1.bottle.isAnon, true, '默认匿名');
  truthy(t1.bottle.userId === A.user.id, '自己扔的能看到自己的 id');

  // ---------- 6.5 B 扔一个（测危机信号）----------
  step('6.5 B 扔一个瓶子（顺便测危机信号）');
  const crisis = await API_B.bottle.toss({
    content: `契约测试：最近撑不下去了 ${stamp}`,
  });
  createdIds.push(crisis.bottle.id);
  truthy(!!crisis.care, '★ 危机信号返回了 care');
  truthy(typeof crisis.care.message === 'string', 'care.message 是文字');
  truthy(Array.isArray(crisis.care.lines), 'care.lines 是数组');
  truthy('name' in crisis.care.lines[0] && 'phone' in crisis.care.lines[0],
    '每条热线有 name 和 phone（前端拼 tel: 链接）');

  // ---------- 5. 造瓶子测海 ----------
  step('5. 直接写数据库造 10 个瓶子（绕开 20 秒频控）');
  for (let i = 0; i < 10; i++) {
    const id = await insert(
      'INSERT INTO bottles (user_id, content, is_anon) VALUES (?, ?, ?)',
      [B.user.id, `造的瓶子 #${i} ${stamp}`, i % 2 === 0 ? 1 : 0]
    );
    createdIds.push(id);
  }
  ok('造了 10 个瓶子');

  // ---------- 6. 捞瓶子 ----------
  step('6. API.bottle.sea()');
  const sea = await API.bottle.sea(6);
  eq(Array.isArray(sea.list), true, 'list 是数组');
  truthy(sea.list.length > 0, `捞到 ${sea.list.length} 个瓶子`);
  truthy(typeof sea.count === 'number', '带 count');
  truthy(typeof sea.remaining === 'number', `带 remaining（还剩 ${sea.remaining} 个没捞过）`);

  // 不该捞到自己的
  eq(sea.list.some(b => b.userId === A.user.id), false, '★ 不会捞到自己扔的');

  // 匿名瓶子的作者信息
  const anon = sea.list.find(b => b.isAnon);
  if (anon) {
    eq(anon.nick, '一个陌生人', '★ 匿名瓶子作者显示为"一个陌生人"');
    eq(anon.avatar, '', '★ 匿名瓶子不给头像');
    eq(anon.userId, null, '★ 匿名瓶子不给 userId');
  } else {
    ok('（本次没捞到匿名瓶子）');
  }

  // ---------- 7. 捞过的不再推 ----------
  step('7. ★ 核心：捞过的不再推给我');
  const firstId = sea.list[0].id;
  const pick = await API.bottle.pick(firstId);
  eq(pick.alreadyPicked, false, '第一次捞取，不是重复');

  const pickAgain = await API.bottle.pick(firstId);
  eq(pickAgain.alreadyPicked, true, '重复捞取被识别（幂等，不报错）');

  const sea2 = await API.bottle.sea(10);
  eq(sea2.list.some(b => b.id === firstId), false, '★ 已捞过的不再出现');
  ok('前端刷新几次不会反复看到同样那几条');

  // ---------- 8. 我扔过的 ----------
  step('8. API.bottle.mine()');
  const mine = await API.bottle.mine({ size: 50 });
  truthy(Array.isArray(mine.list), 'list 是数组');
  truthy(mine.list.some(b => b.id === t1.bottle.id), '列表里有我扔的瓶子');
  const ownItem = mine.list.find(b => b.id === t1.bottle.id);
  eq(ownItem.isMine, true, '★ 自己看自己的瓶子，isMine=true（能显示"这是我扔的"）');
  truthy(typeof mine.totalPicks === 'number',
    `★ 带 totalPicks（我扔的瓶子一共被捞了 ${mine.totalPicks} 次）`);

  // ---------- 9. 我捞过的 ----------
  step('9. API.bottle.picked()');
  const picked = await API.bottle.picked({ size: 50 });
  truthy(picked.list.some(b => b.id === firstId), '列表里有刚捞的瓶子');
  const pickedItem = picked.list.find(b => b.id === firstId);
  truthy(!!pickedItem.pickedTime, `带捞取时间（${pickedItem.pickedTime}）`);

  // ---------- 10. 统计 ----------
  step('10. API.bottle.stats()');
  const stats = await API.bottle.stats();
  truthy(stats.floating > 0, `海里漂着 ${stats.floating} 个瓶子`);
  truthy(typeof stats.totalPicks === 'number', `一共被捞过 ${stats.totalPicks} 次`);

  // ---------- 11. 危机信号已在上面的 4.5 步测过 ----------
  // （扔瓶子集中在前面，避免 20 秒频控干扰后续测试）

  // ---------- 12. 收回 ----------
  step('12. API.bottle.remove()');
  const del = await API.bottle.remove(t1.bottle.id);
  eq(del.id, t1.bottle.id, '收回成功');
  const mineAfter = await API.bottle.mine({ size: 50 });
  eq(mineAfter.list.some(b => b.id === t1.bottle.id), false, '收回后不在我的列表里');

  // ---------- 13. 未登录 ----------
  step('13. 未登录的行为');
  const anonClient = loadApiClient();
  eq(anonClient.auth.isLoggedIn(), false, '新沙箱未登录');
  try {
    await anonClient.bottle.toss({ content: '匿名扔' });
    bad('未登录竟然能扔瓶子');
  } catch (e) {
    eq(e.needLogin, true, '抛出的错误带 needLogin');
  }
  // 但捞瓶子不需要登录
  const anonSea = await anonClient.bottle.sea(3);
  eq(Array.isArray(anonSea.list), true, '★ 未登录也能捞瓶子（浏览不需要登录）');

  // ---------- 14. 边界（内容检测已在第 3 步测过）----------
  step('14. 边界情况');
  const ghostPick = await API.bottle.pick(99999999).catch(e => e);
  truthy(isApiError(ghostPick), '捞不存在的瓶子报错');
  if (isApiError(ghostPick)) {
    truthy(/不在了/.test(ghostPick.message), `错误信息可读（${ghostPick.message}）`);
  }

  const ghostRemove = await API.bottle.remove(99999999).catch(e => e);
  truthy(isApiError(ghostRemove), '收回不存在的瓶子报错');

  // ---------- 15. 清理 ----------
  step('15. 清理测试数据');
  await cleanup();
  ok(`清理完成（记录 ${createdIds.length} 条）`);

  const leftBottles = await queryOne(
    'SELECT COUNT(*) AS n FROM bottles WHERE content LIKE ?',
    [`%${stamp}%`]
  );
  eq(Number(leftBottles.n), 0, '★ 测试瓶子清理干净');

  const leftPicks = await queryOne(
    'SELECT COUNT(*) AS n FROM bottle_picks WHERE user_id IN (?, ?)',
    [A.user.id, B.user.id]
  );
  eq(Number(leftPicks.n), 0, '捞取记录也清掉了');

  } finally {
    await cleanup();
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端漂流瓶接口契约完全对齐！\n');
    process.exitCode = 0;
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
    process.exitCode = 1;
  }

  await pool.end();
})().catch(async (e) => {
  console.error('\n测试脚本崩溃：', e.message);
  try { await pool.end(); } catch { /* 忽略 */ }
  process.exitCode = 1;
});
