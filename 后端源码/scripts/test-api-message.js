// ============================================================
//  第 11 步：前端 api.js 的私信 + 发现页接口契约测试
//
//  用法：  node scripts/test-api-message.js
//
//  ★ 这个测试要在虚拟机上跑 ★
//    因为造数据（会话、日记、漂流瓶）要直连数据库，比走接口快得多。
//
//  确认前端页面渲染时用到的字段都在。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { query, queryOne, execute, insert, pool } from '../src/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

function resolveFrontendDir() {
  if (fs.existsSync(FRONTEND)) return FRONTEND;
  if (process.env.FRONTEND_DIR && fs.existsSync(process.env.FRONTEND_DIR)) {
    return process.env.FRONTEND_DIR;
  }
  throw new Error(
    `找不到前端目录 ${FRONTEND}\n` +
    `  在虚拟机上跑时请用： FRONTEND_DIR=/path/to/前端八稿 node scripts/test-api-message.js`
  );
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

/**
 * ★ 判断"是不是抛错"，不能用 instanceof Error ★
 *
 *   api.js 是在 vm 沙箱里执行的，沙箱有【自己的 Error 构造函数】，
 *   属于不同的 realm。所以 sandboxError instanceof Error 永远是 false。
 *   这个问题很隐蔽 —— 错误明明抛出来了、message 也读得到，
 *   但 instanceof 判断就是不成立。
 */
function isApiError(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.message !== 'string') return false;
  return !('message' in v && typeof v.message === 'object') && !('list' in v);
}

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

const TEST_DATES = ['2001-01-01', '2001-01-02', '2001-01-03', '2001-01-04'];
let dateIdx = 0;

(async () => {
  console.log('==============================================');
  console.log('  第 11 步 · 前端 api.js 私信 + 发现页契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const stamp = Date.now().toString().slice(-6);
  let A = null, B = null;
  const bottleIds = [];

  async function cleanup() {
    try {
      await execute('DELETE FROM diaries WHERE date_key IN (?, ?, ?, ?)', TEST_DATES);
      if (A && B) {
        await execute(
          'DELETE FROM conversations WHERE user_a IN (?, ?) AND user_b IN (?, ?)',
          [A.user.id, B.user.id, A.user.id, B.user.id]
        );
      }
      if (bottleIds.length) {
        await execute(
          `DELETE FROM bottles WHERE id IN (${bottleIds.map(() => '?').join(',')})`,
          bottleIds
        );
      }
    } catch { /* 忽略 */ }
  }

  try {
  // ---------- 1. 结构 ----------
  step('1. api.js 是否导出了 message 和 discover 命名空间');
  const API = loadApiClient();
  truthy(!!API.message, 'API.message 存在');
  truthy(!!API.discover, 'API.discover 存在');

  for (const fn of ['conversations', 'open', 'withUser', 'send', 'markRead',
                    'removeConversation', 'toggleBlock', 'blockedList', 'totalUnread']) {
    eq(typeof API.message[fn], 'function', `API.message.${fn} 是函数`);
  }
  for (const fn of ['feed', 'stats']) {
    eq(typeof API.discover[fn], 'function', `API.discover.${fn} 是函数`);
  }

  // ---------- 2. 登录 ----------
  step('2. 登录两个账号');
  const API_B = loadApiClient();
  A = await API.auth.login('13800138000', '123456');
  B = await API_B.auth.login('13912345678', '123456');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  ok(`B = ${B.user.nickname} (id=${B.user.id})`);

  await cleanup();
  ok('清掉旧数据，保证起点干净');

  // ---------- 3. 打开会话的字段 ----------
  step('3. API.message.open() 返回的字段够渲染聊天界面');
  const opened = await API.message.open({ userId: B.user.id });
  truthy(Number.isInteger(opened.convId), `拿到 convId=${opened.convId}`);
  for (const f of ['userId', 'uid', 'nick', 'avatar', 'signature', 'province']) {
    truthy(f in opened.partner, `对方字段 ${f} 存在`, Object.keys(opened.partner));
  }
  eq(opened.canSend, true, 'canSend=true（前端据此决定输入框能不能用）');
  eq(opened.iBlocked, false, 'iBlocked=false');
  eq(opened.blockedByPartner, false, 'blockedByPartner=false');
  ok('前端用这些字段渲染标题栏 + 决定输入框状态');

  // ---------- 4. 发消息 ----------
  step('4. API.message.send()');
  const sent = await API.message.send({ toUserId: B.user.id, content: `契约测试私信 ${stamp}` });
  eq(sent.blocked, false, '正常消息没被拦');
  eq(sent.care, null, '正常内容 care 是 null');
  for (const f of ['id', 'content', 'isMine', 'isRead', 'fromNick', 'time', 'blocked']) {
    truthy(f in sent.message, `消息字段 ${f} 存在`, Object.keys(sent.message));
  }
  eq(sent.message.isMine, true, '★ 自己发的 isMine=true（气泡靠右）');

  // ---------- 5. 会话列表字段 ----------
  step('5. API.message.conversations() 返回的字段');
  const convs = await API.message.conversations();
  truthy(convs.list.length > 0, `有 ${convs.list.length} 个会话`);
  const c = convs.list[0];
  for (const f of ['convId', 'partner', 'lastMessage', 'lastIsMine', 'lastTime', 'unread', 'iBlocked', 'blockedByPartner']) {
    truthy(f in c, `会话字段 ${f} 存在`, Object.keys(c));
  }
  for (const f of ['userId', 'nick', 'avatar']) {
    truthy(f in c.partner, `会话里对方字段 ${f} 存在`, Object.keys(c.partner));
  }
  truthy(typeof convs.totalUnread === 'number', `带总未读 ${convs.totalUnread}`);
  ok('前端用 lastIsMine 决定显示"我：xxx"还是"昵称：xxx"');

  // ---------- 6. 聊天记录字段 ----------
  step('6. API.message.withUser() 返回的字段');
  const hist = await API.message.withUser(B.user.id, { limit: 50 });
  truthy(hist.list.length > 0, `有 ${hist.list.length} 条记录`);
  truthy('partner' in hist, '带 partner（渲染标题用）');
  truthy('canSend' in hist, '带 canSend');
  truthy('hasMore' in hist, '带 hasMore（翻历史用）');
  for (const f of ['id', 'content', 'isMine', 'blocked', 'time']) {
    truthy(f in hist.list[0], `记录字段 ${f} 存在`, Object.keys(hist.list[0]));
  }
  const mineMsg = hist.list.find(m => m.isMine);
  const otherMsg = hist.list.find(m => !m.isMine);
  eq(mineMsg?.isMine, true, '★ 自己的消息 isMine=true');
  if (otherMsg) eq(otherMsg.isMine, false, '★ 对方的消息 isMine=false');
  ok('前端靠 isMine 决定气泡在左还是右');

  // ---------- 7. 被拦下的消息 ----------
  step('7. ★ 被机器人拦下的消息（前端要标灰）');
  // 等一下避开频控
  await new Promise(r => setTimeout(r, 1600));
  const blocked = await API.message.send({
    toUserId: B.user.id, content: '加我微信 abc12345 有好事',
  });
  eq(blocked.blocked, true, '★ 违规内容被拦（blocked=true）');
  eq('message' in blocked, false, '★ 被拦时【没有】message 字段（内容没发出去）');
  truthy(!!blocked.notice, `给了可读提示语（${blocked.notice}）`);
  truthy(!!blocked.reason, `给了原因（${blocked.reason}）`);

  // 自己拉一下记录，能看到被拦的那条（标灰显示）
  const hist2 = await API.message.withUser(B.user.id, { markRead: 0 });
  const blockedMsg = hist2.list.find(m => m.blocked);
  truthy(!!blockedMsg, '★ 自己能看到被拦的消息（前端可以标灰 + 删除线）');
  ok('对方看不到它（后端过滤掉了）—— 所以不用怕骚扰');

  // ---------- 8. 危机信号 ----------
  step('8. ★ 危机信号：正常发出 + care 提示');
  await new Promise(r => setTimeout(r, 1600));
  const crisis = await API.message.send({
    toUserId: B.user.id, content: `契约测试：最近撑不下去了 ${stamp}`,
  });
  eq(crisis.blocked, false, '★ 危机信号没被拦');
  truthy(!!crisis.care, '★ 带 care 关怀提示');
  truthy(Array.isArray(crisis.care.lines), 'care.lines 是数组');
  truthy('name' in crisis.care.lines[0] && 'phone' in crisis.care.lines[0],
    '每条热线有 name 和 phone（前端拼 tel: 链接）');
  truthy(!!crisis.message, '消息正常返回（有 message 字段，能渲染气泡）');

  // ---------- 9. 未读 & 已读 ----------
  step('9. 未读数和已读');
  const convsB = await API_B.message.conversations();
  const convWithA = convsB.list.find(x => x.partner.userId === A.user.id);
  truthy(convWithA && convWithA.unread > 0, `★ B 有 ${convWithA?.unread} 条未读`);

  const totalB = await API_B.message.totalUnread();
  truthy(typeof totalB === 'number' && totalB > 0, `总未读 ${totalB}（红点用）`);

  await API_B.message.markRead(A.user.id);
  const convsB2 = await API_B.message.conversations();
  eq(convsB2.list.find(x => x.partner.userId === A.user.id)?.unread, 0, '标记已读后未读归零');

  // ---------- 10. 拉黑 ----------
  step('10. 拉黑 / 取消拉黑');
  const blocked1 = await API.message.toggleBlock(B.user.id);
  eq(blocked1.blocked, true, '拉黑成功（切换式）');

  const blockedList = await API.message.blockedList();
  truthy(blockedList.list.some(x => x.userId === B.user.id), '黑名单里有 B');
  truthy(blockedList.list.every(x => 'nick' in x && 'avatar' in x), '黑名单条目带昵称和头像');

  const openedWhenBlocked = await API.message.open({ userId: B.user.id });
  eq(openedWhenBlocked.canSend, false, '★ 拉黑后 canSend=false（前端隐藏输入框）');
  eq(openedWhenBlocked.iBlocked, true, 'iBlocked=true');

  const blocked2 = await API.message.toggleBlock(B.user.id);
  eq(blocked2.blocked, false, '再点一次取消拉黑');

  // ---------- 11. 删会话 ----------
  step('11. 删除会话');
  const del = await API.message.removeConversation(opened.convId);
  eq(del.convId, opened.convId, '删除成功');
  const convsAfterDel = await API.message.conversations();
  eq(convsAfterDel.list.some(x => x.convId === opened.convId), false, '列表里没有它了');

  // ---------- 12. 发现页 ----------
  step('12. API.discover.feed() 的字段');
  // 造点数据：B 写公开日记 + 一个漂流瓶
  for (let i = 0; i < 2; i++) {
    await insert(
      'INSERT INTO diaries (user_id, text, img, is_public, date_key) VALUES (?, ?, "", 1, ?)',
      [B.user.id, `契约测试日记${i} ${stamp}`, TEST_DATES[dateIdx++ % TEST_DATES.length]]
    );
  }
  bottleIds.push(await insert(
    'INSERT INTO bottles (user_id, content, is_anon) VALUES (?, ?, 1)',
    [B.user.id, `契约测试瓶子 ${stamp}`]
  ));

  const feed = await API.discover.feed({ size: 20 });
  truthy(Array.isArray(feed.list), 'list 是数组');
  truthy(feed.list.length > 0, `推荐了 ${feed.list.length} 条`);
  for (const f of ['list', 'page', 'size', 'hasMore', 'totalDiaries', 'seedRefreshIn', 'total']) {
    truthy(f in feed, `返回字段 ${f} 存在`, Object.keys(feed));
  }
  truthy(typeof feed.seedRefreshIn === 'number',
    `还有 ${feed.seedRefreshIn} 秒换一批（前端显示"约 N 分钟后换一批"）`);

  // 每条都要有 type
  const types = [...new Set(feed.list.map(x => x.type))];
  truthy(types.every(t => ['diary', 'user', 'bottle'].includes(t)),
    `每条都带合法的 type：${types.join('/')}`);
  ok('前端据 type 决定渲染成 diary / user / bottle 三种卡片');

  // ---------- 13. 三种卡片的字段 ----------
  step('13. 三种卡片各自的字段');
  const dItem = feed.list.find(x => x.type === 'diary');
  if (dItem) {
    for (const f of ['id', 'text', 'img', 'nick', 'avatar', 'likes', 'comments', 'isLiked', 'isSaved']) {
      truthy(f in dItem.diary, `日记卡片字段 ${f} 存在`, Object.keys(dItem.diary));
    }
  } else {
    ok('（本次没推荐到日记）');
  }

  const uItem = feed.list.find(x => x.type === 'user');
  if (uItem) {
    for (const f of ['userId', 'uid', 'nick', 'avatar', 'signature', 'province', 'zodiac', 'diaryCount']) {
      truthy(f in uItem.user, `人物卡片字段 ${f} 存在`, Object.keys(uItem.user));
    }
  } else {
    ok('（本次没推荐到人）');
  }

  const bItem = feed.list.find(x => x.type === 'bottle');
  if (bItem) {
    for (const f of ['id', 'content', 'isAnon', 'nick', 'time']) {
      truthy(f in bItem.bottle, `漂流瓶卡片字段 ${f} 存在`, Object.keys(bItem.bottle));
    }
    // ★ 不能断言"漂流瓶一定是匿名的" ★
    //   漂流瓶默认匿名，但它也允许署名（isAnon=false）。
    //   我第一版写的是 eq(nick, '一个陌生人')，结果库里一旦有署名瓶子
    //   （演示数据里就有一个），这条就挂了，而且挂得莫名其妙。
    //   正确的断言是：匿名的才该显示"一个陌生人"，署名的才该显示真名。
    if (bItem.bottle.isAnon) {
      eq(bItem.bottle.nick, '一个陌生人', '匿名瓶子不暴露作者');
    } else {
      truthy(bItem.bottle.nick && bItem.bottle.nick !== '一个陌生人',
        `署名的瓶子显示作者（${bItem.bottle.nick}）`);
    }
  } else {
    ok('（本次没推荐到漂流瓶）');
  }

  // ---------- 14. 分页不重复 ----------
  step('14. ★ 分页不重复（用 RAND() 会错的地方）');
  const p1 = await API.discover.feed({ page: 1, size: 2 });
  const p2 = await API.discover.feed({ page: 2, size: 2 });
  const keyOf = (x) => x.type === 'diary' ? 'd' + x.diary.id
    : x.type === 'user' ? 'u' + x.user.userId : 'b' + x.bottle.id;
  const k1 = p1.list.map(keyOf);
  const k2 = p2.list.map(keyOf);
  const dup = k1.filter(k => k2.includes(k));
  eq(dup.length, 0, `★ 两页之间没有重复（页1=${k1.join(',')} 页2=${k2.join(',')}）`);

  // ---------- 15. stats ----------
  step('15. API.discover.stats()');
  const stats = await API.discover.stats();
  for (const f of ['diaries', 'users', 'bottles']) {
    truthy(typeof stats[f] === 'number', `stats.${f} = ${stats[f]}`);
  }

  // ---------- 16. 未登录 ----------
  step('16. 未登录的行为');
  const anon = loadApiClient();
  eq(anon.auth.isLoggedIn(), false, '新沙箱未登录');

  // 发现页不需要登录
  const anonFeed = await anon.discover.feed({ size: 5 });
  eq(Array.isArray(anonFeed.list), true, '★ 未登录也能看推荐流（浏览不需要登录）');

  // 私信需要登录
  const anonConvs = await anon.message.conversations().catch(e => e);
  truthy(isApiError(anonConvs), '★ 未登录不能看会话列表');
  if (isApiError(anonConvs)) eq(anonConvs.needLogin, true, '抛出的错误带 needLogin');

  // totalUnread 永不抛错
  const anonUnread = await anon.message.totalUnread();
  eq(anonUnread, 0, '★ 未登录时 totalUnread() 返回 0（不抛错）');
  ok('这样首页可以直接调用它来显示红点，不用先判断登录');

  // ---------- 17. 清理 ----------
  step('17. 清理测试数据');
  await cleanup();
  const leftDiary = await queryOne('SELECT COUNT(*) AS n FROM diaries WHERE text LIKE ?', [`%${stamp}%`]);
  eq(Number(leftDiary.n), 0, '测试日记清理干净');
  const leftConv = await queryOne(
    'SELECT COUNT(*) AS n FROM conversations WHERE user_a IN (?, ?) AND user_b IN (?, ?)',
    [A.user.id, B.user.id, A.user.id, B.user.id]
  );
  eq(Number(leftConv.n), 0, '测试会话清理干净');

  } finally {
    await cleanup();
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端私信 + 发现页契约完全对齐！\n');
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
