// ============================================================
//  前端 api.js 的真实性测试
//
//  用法：  node scripts/test-api-client.js
//          node scripts/test-api-client.js http://127.0.0.1:3000
//
//  它干什么：
//    把前端的 api.js 原封不动加载进 Node 的 vm 沙箱，
//    然后真的用 fetch 去打后端接口。
//
//  为什么值得这么做：
//    前端代码光靠"看"很容易漏 —— 比如参数名写错、少了个 await、
//    后端返回的字段名对不上。这个测试把前端和后端的接口契约
//    真正对了一遍，前后端改坏了立刻能发现。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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

// ============================================================
//  1. 造一个浏览器环境的替身，把 api.js 装进去
// ============================================================
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get _size() { return m.size; },
  };
}

function loadApiClient() {
  const apiPath = path.join(FRONTEND, 'api.js');
  if (!fs.existsSync(apiPath)) throw new Error('找不到前端 api.js: ' + apiPath);

  const code = fs.readFileSync(apiPath, 'utf8');

  // api.js 里的 BASE 默认写的是虚拟机地址。
  // 如果测试传了别的地址，就在源码里替换掉（只影响这次测试）。
  const patched = code.replace(
    /var BASE = '[^']*';/,
    "var BASE = '" + BASE + "';"
  );
  if (patched === code && !code.includes(BASE)) {
    console.log(`  ⚠️  没能替换 BASE，api.js 里的地址可能变了`);
  }

  const sandbox = {
    window: {},
    localStorage: makeStorage(),
    fetch: globalThis.fetch,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    location: { href: '', pathname: 'test.html', search: '' },
    document: {
      // 只实现 api.js 用到的那几个
      getElementById: () => null,
      createElement: () => ({ style: {}, set textContent(v) {}, appendChild() {} }),
      body: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;   // 让 window.API = ... 挂到沙箱根上

  const ctx = vm.createContext(sandbox);
  new vm.Script(patched, { filename: 'api.js' }).runInContext(ctx);

  if (!ctx.API) throw new Error('api.js 没有导出 window.API');
  return ctx.API;
}

// ============================================================
(async () => {
  console.log('==============================================');
  console.log('  前端 api.js 真实性测试');
  console.log('  目标后端: ' + BASE);
  console.log('==============================================');

  let API;
  step('1. 把前端 api.js 装进沙箱');
  try {
    API = loadApiClient();
    ok('api.js 加载成功，window.API 已导出');
  } catch (e) {
    bad('api.js 加载失败: ' + e.message);
    process.exit(1);
  }

  // ---------- 结构检查 ----------
  step('2. api.js 导出的接口是否齐全');
  const needFns = [
    ['BASE', 'string'],
    ['request', 'function'],
    ['health', 'function'],
    ['toast', 'function'],
    ['requireLogin', 'function'],
    ['handleError', 'function'],
  ];
  for (const [k, t] of needFns) {
    eq(typeof API[k], t, `API.${k} 是 ${t}`);
  }
  for (const k of ['sendCode', 'login', 'me', 'logout', 'isLoggedIn', 'getUser', 'getToken', 'clearAuth']) {
    eq(typeof API.auth[k], 'function', `API.auth.${k} 存在`);
  }
  for (const k of ['feed', 'save', 'get', 'byDate', 'calendar', 'setVisibility', 'remove']) {
    eq(typeof API.diary[k], 'function', `API.diary.${k} 存在`);
  }

  // ---------- 健康检查 ----------
  step('3. 真实请求：API.health()');
  const h = await API.health();
  eq(h.service, '陪着后端', 'health 返回了正确的 service 名');
  eq(h.db.connected, true, '后端报告数据库已连接');

  // ---------- 未登录状态 ----------
  step('4. 未登录时的行为');
  eq(API.auth.isLoggedIn(), false, '初始状态未登录');
  eq(API.auth.getToken(), '', '没有 token');

  // ---------- 参数校验错误 ----------
  step('5. 错误参数应该抛出可读的错误');
  try {
    await API.auth.sendCode('123');
    bad('错误手机号竟然没报错');
  } catch (e) {
    eq(e.message.includes('手机号'), true, '抛出的错误信息可读（提到了手机号）');
  }

  // ---------- 真实登录 ----------
  step('6. 真实登录流程');
  const PHONE = '13800138000';
  try {
    await API.auth.sendCode(PHONE);
    ok('sendCode 成功');
  } catch (e) {
    // 可能触发 60 秒频控，也算正常
    if (e.message.includes('频繁')) ok('sendCode 触发频控（接口正常）');
    else bad('sendCode 失败: ' + e.message);
  }

  const loginResult = await API.auth.login(PHONE, '123456');
  eq(typeof loginResult.token, 'string', '登录返回了 token');
  eq(typeof loginResult.user.id, 'number', '登录返回了 user.id');
  eq(loginResult.user.phone, PHONE, '登录返回的手机号正确');

  // 关键：登录后 token 应该被自动存进 localStorage
  eq(API.auth.isLoggedIn(), true, '登录后 isLoggedIn() 变成 true');
  eq(API.auth.getToken().length > 20, true, 'token 已自动存起来（长度合理）');
  eq(API.auth.getUser().id, loginResult.user.id, '用户信息已缓存');

  // ---------- 带 token 的请求 ----------
  step('7. 带 token 请求（api.js 应该自动加 Authorization 头）');
  const me = await API.auth.me();
  eq(me.id, loginResult.user.id, 'API.auth.me() 返回的是本人');

  // ---------- 日记：保存 ----------
  step('8. 日记接口：保存');
  const stamp = Date.now();
  const TEST_DATE = '2026-11-05';
  const saveRes = await API.diary.save({
    date: TEST_DATE,
    text: '这是 api.js 真实性测试写的日记 ' + stamp,
    img: 'https://example.com/test.jpg',
    isPublic: true,
  });
  eq(saveRes.action, 'created', 'save 返回 action=created');
  eq(saveRes.diary.dateKey, TEST_DATE, 'dateKey 正确');
  eq(saveRes.diary.isPublic, true, 'isPublic 正确');
  const diaryId = saveRes.diary.id;
  eq(typeof diaryId, 'number', '拿到了日记 id');

  // ---------- 日记：字段名对齐（前端渲染依赖这些字段） ----------
  step('9. 日记字段名是否和前端模板对齐');
  // diary-public.html 的模板用了这些字段，少一个就会显示 undefined
  const frontendFields = ['id', 'text', 'img', 'nick', 'avatar', 'uid', 'ip', 'likes', 'time'];
  for (const f of ['id', 'text', 'img', 'nick', 'avatar', 'uid', 'ip', 'likes', 'time']) {
    eq(saveRes.diary[f] !== undefined, true, `字段 ${f} 存在（前端模板需要）`);
  }

  // ---------- 日记：按日期读取 ----------
  step('10. 日记接口：按日期读取（diary-write.html 回填用）');
  const byDate = await API.diary.byDate(TEST_DATE);
  eq(byDate.id, diaryId, 'byDate 取回的是同一篇');
  eq(byDate.text.includes(String(stamp)), true, '内容正确');

  const notExist = await API.diary.byDate('2019-01-01');
  eq(notExist, null, '没写过的那天返回 null（页面不会崩）');

  // ---------- 日记：列表 ----------
  step('11. 日记接口：列表透传参数是否正确');
  const feedMine = await API.diary.feed({ feed: 'mine', size: 50 });
  eq(Array.isArray(feedMine.list), true, 'feed 返回 list 数组');
  eq(typeof feedMine.total, 'number', 'feed 返回 total');
  eq(feedMine.list.some(d => d.id === diaryId), true, '我的列表里有刚写的那篇');

  const feedAll = await API.diary.feed({ feed: 'all', size: 10 });
  eq(feedAll.list.some(d => d.id === diaryId), true, '公开流里也有（因为设了公开）');

  const feedBad = await API.diary.feed({ nick: '绝对不存在的人' + stamp });
  eq(feedBad.list.length, 0, '查不存在的昵称返回空数组（不是报错）');

  // ---------- 日记：分页参数是否正确传过去 ----------
  step('12. 分页参数是否真的传到了后端');
  const paged = await API.diary.feed({ feed: 'mine', page: 2, size: 1 });
  eq(paged.page, 2, 'page=2 被后端收到');
  eq(paged.size, 1, 'size=1 被后端收到');
  eq(paged.list.length <= 1, true, '每页条数生效');

  // ---------- 日记：日历 ----------
  step('13. 日历接口（diary-mine.html 用）');
  const cal = await API.diary.calendar(2026, 11);
  eq(cal.year, 2026, 'year 正确');
  eq(cal.month, 11, 'month 正确');
  eq(Array.isArray(cal.dates), true, 'dates 是数组');
  eq(cal.dates.includes(TEST_DATE), true, '刚写的那天出现在日历里');

  // ---------- 日记：切换可见性 ----------
  step('14. 切换公开/私密');
  const v1 = await API.diary.setVisibility(diaryId, false);
  eq(v1.isPublic, false, '设为私密成功');
  const v2 = await API.diary.setVisibility(diaryId, true);
  eq(v2.isPublic, true, '设回公开成功');
  // 不传参数应该取反
  const v3 = await API.diary.setVisibility(diaryId);
  eq(v3.isPublic, false, '不传参数时自动取反');

  // ---------- 401 统一处理 ----------
  step('15. token 失效时的统一处理（api.js 应该清掉本地记录）');
  API.auth.clearAuth();
  eq(API.auth.isLoggedIn(), false, 'clearAuth 之后未登录');
  try {
    await API.auth.me();
    bad('没 token 调 me() 竟然成功了');
  } catch (e) {
    eq(e.needLogin, true, '抛出的错误带 needLogin 标记（页面据此跳登录）');
  }

  // 重新登录，把测试数据删掉
  step('16. 清理测试数据');
  await API.auth.login(PHONE, '123456');
  const cleanup = await API.diary.remove(diaryId);
  eq(cleanup.id, diaryId, '测试日记已删除');
  const after = await API.diary.byDate(TEST_DATE);
  eq(after, null, '确认删干净了');

  // 登出
  await API.auth.logout();
  eq(API.auth.isLoggedIn(), false, 'logout 之后是未登录状态');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端 api.js 和后端的接口契约完全对齐！\n');
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
