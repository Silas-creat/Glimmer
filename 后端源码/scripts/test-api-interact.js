// ============================================================
//  第 5 步：前端 api.js 的 interact 部分真实性测试
//
//  用法：  node scripts/test-api-interact.js
//
//  和 test-api-client.js 一个套路：把前端的 api.js 原封不动
//  装进 Node 沙箱，用真实 fetch 打真实后端。
//
//  这样能抓到"前端以为的返回结构"和"后端实际返回"对不上的问题，
//  而这类问题光看代码很难发现。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

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

/** 真实请求（绕过 api.js，用来做对照和清理） */
async function raw(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t }; }
  return { status: res.status, body: j };
}

// ============================================================
//  把前端 api.js 装进沙箱
// ============================================================
function loadApiClient(localStorageStub) {
  const src = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8');
  const patched = src.replace(/var BASE = '[^']*';/, `var BASE = '${BASE}';`);

  const sandbox = {
    window: {},
    localStorage: localStorageStub,
    fetch: globalThis.fetch,
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

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

(async () => {
  console.log('==============================================');
  console.log('  第 5 步 · 前端 api.js 互动接口契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const API = loadApiClient(makeStorage());

  // ---------- 结构 ----------
  step('1. api.js 是否导出了 interact 命名空间');
  truthy(!!API.interact, 'API.interact 存在');
  for (const fn of ['toggleLike', 'toggleSave', 'toggleFollow', 'toggleFollowByUid',
                    'likes', 'favorites', 'myFollows', 'myFans', 'state', 'stats']) {
    eq(typeof API.interact[fn], 'function', `API.interact.${fn} 是函数`);
  }

  // ---------- 登录两个账号 ----------
  step('2. 登录两个账号（A 写日记，B 来互动）');
  const a = await API.auth.login('13800138000', '123456');
  const BAPI = loadApiClient(makeStorage());   // 另建一个沙箱模拟"另一台设备"
  const b = await BAPI.auth.login('13912345678', '123456');
  ok(`A = ${a.user.nickname} (id=${a.user.id})`);
  ok(`B = ${b.user.nickname} (id=${b.user.id})（独立沙箱，模拟另一台设备）`);

  // ---------- A 写一篇日记 ----------
  const today = new Date();
  const dateKey = today.getFullYear() + '-'
    + String(today.getMonth() + 1).padStart(2, '0') + '-'
    + String(today.getDate()).padStart(2, '0');

  const saved = await API.diary.save({
    date: dateKey, text: 'api.js 互动契约测试', img: 'https://example.com/x.jpg', isPublic: true,
  });
  const diaryId = saved.diary.id;
  const baseLikes = saved.diary.likes;
  truthy(Number.isInteger(diaryId), `A 写了日记 id=${diaryId}`);

  // ---------- 3. save 返回里带互动状态 ----------
  step('3. 保存日记的返回值里应该带互动状态字段');
  for (const f of ['isLiked', 'isSaved', 'isFollowed', 'isMine']) {
    eq(f in saved.diary, true, `save 返回的 diary 有 ${f} 字段`);
  }
  eq(saved.diary.isMine, true, 'A 保存的日记 isMine=true');

  // ---------- 4. get 单篇也带状态 ----------
  step('4. 取单篇日记（前端点开某篇时用）也带互动状态');
  // API.diary.get 直接返回日记对象，不包 { diary: ... }
  const one = await API.diary.get(diaryId);
  truthy(one && typeof one === 'object', 'get 返回的是对象');
  eq(one.id, diaryId, 'get 返回的正是那篇日记（没有多余的包裹层）');
  for (const f of ['isLiked', 'isSaved', 'isFollowed']) {
    eq(f in one, true, `get 返回的 diary 有 ${f} 字段`);
  }

  // ---------- 5. B 点赞 ----------
  step('5. B 用 api.js 点赞');
  const likeRes = await BAPI.interact.toggleLike(diaryId);
  eq(likeRes.liked, true, 'toggleLike 返回 liked=true');
  eq(typeof likeRes.likes, 'number', 'toggleLike 返回 likes 数字');
  eq(likeRes.likes, baseLikes + 1, 'likes 是 +1 后的真实值');

  // ---------- 6. B 自己看到的状态 ----------
  step('6. B 再取这篇日记，状态应该是"已点赞"');
  const bView = await BAPI.diary.get(diaryId);
  eq(bView.isLiked, true, 'B 视角 isLiked=true');
  eq(bView.likes, baseLikes + 1, 'B 视角点赞数是 +1');

  // ---------- 7. A 自己看到的状态（按人区分）----------
  step('7. A 取同一篇，状态应该是"没点赞"（状态跟人走）');
  const aView = await API.diary.get(diaryId);
  eq(aView.isLiked, false, 'A 视角 isLiked=false（A 没点赞）');
  eq(aView.likes, baseLikes + 1, 'A 也能看到总点赞数 +1（数字是共享的）');
  ok('同一条日记，不同人看到不同的 isLiked —— 这就是必须存后端的原因');

  // ---------- 8. 收藏 ----------
  step('8. B 用 api.js 收藏');
  const favRes = await BAPI.interact.toggleSave(diaryId);
  eq(favRes.saved, true, 'toggleSave 返回 saved=true');

  // ---------- 9. 我的喜欢 ----------
  step('9. B 的"我的喜欢"列表');
  const bLikes = await BAPI.interact.likes({ size: 50 });
  truthy(Array.isArray(bLikes.list), '返回 list 数组');
  truthy(bLikes.list.some(d => d.id === diaryId), '列表里有刚点赞的日记');
  truthy(bLikes.list.every(d => d.isLiked === true), '列表里每篇 isLiked 都是 true');

  // ---------- 10. 我的收藏 ----------
  step('10. B 的"我的收藏"列表');
  const bFavs = await BAPI.interact.favorites({ size: 50 });
  truthy(bFavs.list.some(d => d.id === diaryId), '收藏列表里有这篇');

  // ---------- 11. 前端需要的字段都在不在 ----------
  step('11. 列表项字段是否满足前端模板（my-list.html 用到这些）');
  const item = bLikes.list.find(d => d.id === diaryId);
  for (const f of ['id', 'text', 'img', 'nick', 'avatar', 'likes']) {
    truthy(item[f] !== undefined, `字段 ${f} 存在`, Object.keys(item));
  }

  // ---------- 12. state 接口 ----------
  step('12. 单篇状态查询 API.interact.state()');
  const stB = await BAPI.interact.state(diaryId);
  eq(stB.liked, true, 'B 的 state.liked=true');
  eq(stB.saved, true, 'B 的 state.saved=true');
  const stA = await API.interact.state(diaryId);
  eq(stA.liked, false, 'A 的 state.liked=false');

  // ---------- 13. 关注 ----------
  step('13. 关注（按 uid，前端拿到的就是 uid）');
  const f1 = await BAPI.interact.toggleFollowByUid(a.user.uid);
  eq(f1.followed, true, 'B 关注 A 成功');
  eq(f1.userId, a.user.id, '返回了对方内部 userId');
  eq(f1.uid, a.user.uid, '原样返回了 uid');
  // 说明：follow-uid 接口故意不返回关注数/粉丝数，
  // 因为前端点关注后只是切个图标文字，不需要这两个数字；
  // 少查两次数据库。要数字的话下一步调 stats 接口就行。
  const statsAfterFollow = await BAPI.interact.stats(a.user.id);
  eq(statsAfterFollow.isFollowed, true, '调 stats 能拿到"已关注"状态');
  truthy(typeof statsAfterFollow.fans === 'number', 'stats 里有粉丝数');
  truthy(typeof statsAfterFollow.follows === 'number', 'stats 里有他的关注数');

  // ---------- 14. 关注状态进 feed ----------
  step('14. B 的 feed 里，A 的日记应该标记 isFollowed=true');
  const bFeed = await BAPI.diary.feed({ feed: 'all', size: 50 });
  const card = (bFeed.list || []).find(d => d.id === diaryId);
  eq(card.isFollowed, true, 'B 视角看 A 的日记，isFollowed=true');
  eq(card.isLiked, true, 'B 视角看 A 的日记，isLiked=true');
  ok('前端渲染卡片时直接读这三个字段就行，不用再逐个请求');

  // ---------- 15. stats ----------
  step('15. 个人主页统计 API.interact.stats()');
  const stats = await BAPI.interact.stats(a.user.id);
  eq(stats.isFollowed, true, 'B 看 A 的主页，isFollowed=true');
  eq(stats.isMine, false, 'B 看 A 的主页，isMine=false');
  for (const f of ['likes', 'follows', 'fans', 'nick', 'uid', 'avatar']) {
    truthy(stats[f] !== undefined, `统计里有 ${f}`);
  }
  ok('个人主页顶部三个数字（获赞/关注/粉丝）都能拿到真实值');

  // ---------- 16. 我关注的人 ----------
  step('16. 我关注的人列表');
  const follows = await BAPI.interact.myFollows({ size: 50 });
  truthy(follows.list.some(u => u.userId === a.user.id), '列表里有 A');
  truthy(follows.list[0].isFollowed === true, '每人标记 isFollowed');

  // ---------- 17. 关注我的人 ----------
  step('17. 关注我的人列表');
  const fans = await API.interact.myFans();
  truthy(fans.list.some(u => u.userId === b.user.id), 'A 的粉丝里有 B');

  // ---------- 18. 取关 ----------
  step('18. 取关');
  const un = await BAPI.interact.toggleFollowByUid(a.user.uid);
  eq(un.followed, false, '取关成功');

  // ---------- 19. 未登录时的行为 ----------
  step('19. 未登录调用互动接口，应该抛 needLogin 错误');
  const anon = loadApiClient(makeStorage());   // 全新沙箱，没有 token
  eq(anon.auth.isLoggedIn(), false, '新沙箱未登录');
  try {
    await anon.interact.toggleLike(diaryId);
    bad('未登录点赞竟然成功了');
  } catch (e) {
    eq(e.needLogin, true, '抛出的错误带 needLogin（页面据此跳登录）');
  }

  // ---------- 20. 清理 ----------
  step('20. 清理测试数据');
  // 先清互动状态
  const stNow = await BAPI.interact.state(diaryId);
  if (stNow.liked) await BAPI.interact.toggleLike(diaryId);
  if (stNow.saved) await BAPI.interact.toggleSave(diaryId);

  const finalState = await BAPI.interact.state(diaryId);
  eq(finalState.liked, false, 'B 的点赞已清除');
  eq(finalState.saved, false, 'B 的收藏已清除');

  const delRes = await API.diary.remove(diaryId);
  eq(delRes.id, diaryId, '测试日记已删除');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端 interact 接口契约完全对齐！\n');
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
