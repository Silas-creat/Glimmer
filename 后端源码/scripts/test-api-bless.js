// ============================================================
//  第 8 步：前端 api.js 的祝福接口契约测试
//
//  用法：  node scripts/test-api-bless.js
//
//  重点确认：前端 bless.html / bless-sent.html 渲染时用到的字段都在，
//  以及"按昵称找人"的各种失败情况前端能拿到可读的报错。
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

function loadApiClient() {
  const src = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8');
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
  console.log('  第 8 步 · 前端 api.js 祝福接口契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 1. 结构 ----------
  step('1. api.js 是否导出了 bless 命名空间');
  const API = loadApiClient();
  truthy(!!API.bless, 'API.bless 存在');
  for (const fn of ['send', 'sent', 'received', 'unreadCount', 'about', 'markRead', 'remove']) {
    eq(typeof API.bless[fn], 'function', `API.bless.${fn} 是函数`);
  }

  // ---------- 2. 登录 ----------
  step('2. 登录两个账号（独立沙箱模拟两台设备）');
  const API_B = loadApiClient();
  const a = await API.auth.login('13800138000', '123456');
  const b = await API_B.auth.login('13912345678', '123456');
  ok(`设备1: ${a.user.nickname} (id=${a.user.id})`);
  ok(`设备2: ${b.user.nickname} (id=${b.user.id})`);
  eq(API.auth.isLoggedIn(), true, '设备1 已登录');
  eq(API_B.auth.isLoggedIn(), true, '设备2 已登录');

  const createdIds = [];
  const stamp = Date.now().toString().slice(-6);

  // ---------- 3. 按昵称发送 ----------
  step('3. API.bless.send() 按昵称（bless.html 的默认方式）');
  const r1 = await API.bless.send({ toNick: b.user.nickname, content: `前端契约测试 ${stamp}` });
  createdIds.push(r1.blessing.id);
  eq(typeof r1.blessing.id, 'number', '返回了祝福 id');
  eq(r1.care, null, '正常内容 care 是 null');

  // ---------- 4. 字段是否够渲染 ----------
  step('4. 祝福字段是否满足前端渲染');
  // bless-sent.html 用到：blessing.to.nick, blessing.time, blessing.content
  for (const f of ['id', 'content', 'time', 'from', 'to']) {
    truthy(f in r1.blessing, `字段 ${f} 存在`, Object.keys(r1.blessing));
  }
  for (const f of ['userId', 'nick', 'uid', 'avatar']) {
    truthy(f in r1.blessing.to, `to.${f} 存在（收件人信息）`);
    truthy(f in r1.blessing.from, `from.${f} 存在（送件人信息）`);
  }
  eq(r1.blessing.to.nick, b.user.nickname, 'to.nick 是收件人昵称');
  eq(r1.blessing.from.nick, a.user.nickname, 'from.nick 是送件人昵称');
  ok('★ 前端不用再查一次用户就能显示"谁送给谁"');

  // ---------- 5. 按 uid / userId ----------
  step('5. 按 uid 和 userId（更准，优先用）');
  const r2 = await API.bless.send({ toUid: b.user.uid, content: `按uid ${stamp}` });
  createdIds.push(r2.blessing.id);
  eq(r2.blessing.to.userId, b.user.id, '按 uid 定位正确');

  const r3 = await API.bless.send({ toUserId: b.user.id, content: `按userId ${stamp}` });
  createdIds.push(r3.blessing.id);
  eq(r3.blessing.to.userId, b.user.id, '按 userId 定位正确');

  // ---------- 6. 找不到人 ----------
  step('6. 找不到人时的报错要可读');
  try {
    await API.bless.send({ toNick: '不存在的人xyz123', content: '测试' });
    bad('不存在的昵称竟然发送成功了');
  } catch (e) {
    truthy(/找不到/.test(e.message), `错误信息可读（${e.message}）`);
  }

  try {
    await API.bless.send({ toUid: '99999999999', content: '测试' });
    bad('不存在的 uid 竟然发送成功了');
  } catch (e) {
    truthy(e.message.length > 0, `uid 不存在时也有报错（${e.message}）`);
  }

  // ---------- 7. 不能给自己发 ----------
  step('7. 不能给自己发（前端要能提示）');
  try {
    await API.bless.send({ toUserId: a.user.id, content: '给自己' });
    bad('给自己发竟然成功了');
  } catch (e) {
    truthy(/自己/.test(e.message), `错误信息说明了原因（${e.message}）`);
  }

  // ---------- 8. 内容检测 ----------
  step('8. 内容检测：错误信息能直接 toast 给用户');
  try {
    await API.bless.send({ toUserId: b.user.id, content: '加我微信 abc12345' });
    bad('广告内容竟然发出去了');
  } catch (e) {
    truthy(/联系方式|不能/.test(e.message), `错误信息可读（${e.message}）`);
  }

  // ---------- 9. 危机信号 ----------
  step('9. ★ 危机信号：care 字段（前端要先显示关怀再显示已送到）');
  const crisis = await API.bless.send({
    toUserId: b.user.id, content: `希望你能好好的，我最近也快撑不下去了 ${stamp}`,
  });
  createdIds.push(crisis.blessing.id);
  truthy(!!crisis.care, '★ 返回了 care');
  truthy(typeof crisis.care.message === 'string', 'care.message 是文字');
  truthy(Array.isArray(crisis.care.lines), 'care.lines 是数组');
  truthy('name' in crisis.care.lines[0] && 'phone' in crisis.care.lines[0],
    '每条热线有 name 和 phone（前端拼 tel: 链接）');
  ok('bless.html 会先弹关怀框，用户点"我知道了"再显示"已送到"');

  // ---------- 10. 我送出去的 ----------
  step('10. API.bless.sent()');
  const sent = await API.bless.sent({ size: 50 });
  truthy(Array.isArray(sent.list), 'list 是数组');
  truthy(sent.total >= createdIds.length, `total=${sent.total}（至少包含本次的 ${createdIds.length} 条）`);
  const item = sent.list.find(x => x.id === createdIds[0]);
  truthy(!!item, '列表里有刚发的那条');
  eq(item.to.nick, b.user.nickname, 'bless-sent.html 要的 to.nick 在');
  truthy(!!item.time, `bless-sent.html 要的 time 在（${item.time}）`);
  truthy(!!item.content, 'bless-sent.html 要的 content 在');

  // ---------- 11. 我收到的 ----------
  step('11. API.bless.received()');
  const recv = await API_B.bless.received({ size: 50 });
  truthy(recv.total > 0, `B 收到 ${recv.total} 条`);
  const rItem = recv.list.find(x => x.id === createdIds[0]);
  truthy(!!rItem, 'B 能看到 A 送的那条');
  eq(rItem.from.nick, a.user.nickname, '★ 显示了是谁送的');
  truthy(typeof recv.unread === 'number', `带 unread 未读数（${recv.unread}）`);

  // ---------- 12. 未读数 ----------
  step('12. API.bless.unreadCount()（红点用，静默失败不打断页面）');
  const unread = await API_B.bless.unreadCount();
  eq(typeof unread, 'number', `返回数字（${unread}）`);
  // 未登录时应该静默返回 0 而不是抛错（因为它用了 silent: true）
  const anon = loadApiClient();
  let anonUnread = null;
  try {
    anonUnread = await anon.bless.unreadCount();
    eq(anonUnread, 0, '未登录时静默返回 0（不打断页面渲染）');
  } catch (e) {
    bad('未登录时 unreadCount 抛错了：' + e.message);
  }

  // ---------- 13. 标记已读 ----------
  step('13. API.bless.markRead()');
  const mark = await API_B.bless.markRead(createdIds[0]);
  eq(mark.isRead, true, '标记成功');
  const afterMark = await API_B.bless.received({ size: 50 });
  const marked = afterMark.list.find(x => x.id === createdIds[0]);
  eq(marked.isRead, true, '列表里也变成已读');

  // ---------- 14. 未读筛选 ----------
  step('14. 只看未读');
  const onlyUnread = await API_B.bless.received({ unreadOnly: 1, size: 50 });
  truthy(onlyUnread.list.every(x => x.isRead === false), '全部是未读');
  truthy(onlyUnread.total <= afterMark.total, '未读数不超过总数');

  // ---------- 15. 某人收到多少 ----------
  step('15. API.bless.about()（个人主页可以显示"ta 收到过 N 份祝福"）');
  const about = await API.bless.about(b.user.id);
  truthy(about.receivedCount > 0, `B 收到过 ${about.receivedCount} 份`);
  eq(about.nick, b.user.nickname, '返回昵称正确');
  const aboutByUid = await API.bless.about(b.user.uid);
  eq(aboutByUid.userId, b.user.id, '按 uid 也能查');

  // ---------- 16. 未登录 ----------
  step('16. 未登录的行为');
  try {
    await anon.bless.send({ toUserId: b.user.id, content: '匿名祝福' });
    bad('未登录竟然能发祝福');
  } catch (e) {
    eq(e.needLogin, true, '抛出的错误带 needLogin（页面据此跳登录）');
  }

  // ---------- 17. 删除 ----------
  step('17. 删除（bless-sent.html 的"撤回"按钮）');
  const del = await API.bless.remove(createdIds[0]);
  eq(del.by, 'sender', 'A 撤回自己送出的，身份是 sender');
  const afterDel = await API.bless.sent({ size: 50 });
  truthy(!afterDel.list.some(x => x.id === createdIds[0]), '列表里没有了');

  // ---------- 18. 清理 ----------
  step('18. 清理测试数据');
  let removed = 0;
  for (const id of createdIds) {
    for (const client of [API, API_B]) {
      const r = await client.bless.remove(id).catch(() => null);
      if (r) { removed++; break; }
    }
  }
  ok(`清理完成（记录 ${createdIds.length} 条，删除 ${removed} 条）`);

  const finalSent = await API.bless.sent({ size: 50 });
  const left = finalSent.list.filter(x => x.content.includes(stamp));
  if (left.length === 0) {
    ok('★ 本次测试产生的祝福都清理干净了');
  } else {
    bad(`还有 ${left.length} 条残留`, left.map(x => ({ id: x.id, c: x.content.slice(0, 30) })));
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端祝福接口契约完全对齐！\n');
    process.exitCode = 0;
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('\n测试脚本崩溃：', e);
  process.exitCode = 1;
});
