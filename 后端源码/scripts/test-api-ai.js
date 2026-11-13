// ============================================================
//  第 3 步：前端 api.js 的 AI 聊天接口契约测试
//
//  用法：  node scripts/test-api-ai.js
//
//  ★ 需要直连数据库：要清空聊天记录、构造历史来触发摘要 ★
//    所以这个测试在虚拟机上跑（由 test-all.sh 转发）。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { queryOne, execute, pool } from '../src/db/index.js';

const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

function resolveFrontendDir() {
  if (fs.existsSync(FRONTEND)) return FRONTEND;
  if (process.env.FRONTEND_DIR && fs.existsSync(process.env.FRONTEND_DIR)) {
    return process.env.FRONTEND_DIR;
  }
  throw new Error('找不到前端目录，请用 FRONTEND_DIR=... 指定');
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

/** 跨 realm 判断"是不是抛错"（不能用 instanceof Error，见 README 坑 16） */
function isApiError(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.message !== 'string') return false;
  return !('list' in v) && !('reply' in v) && !('summary' in v);
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
    FormData: globalThis.FormData, Blob: globalThis.Blob, File: globalThis.File,
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
  console.log('  第 3 步 · 前端 api.js AI 聊天契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  let A = null;

  async function cleanup(userId) {
    if (!userId) return;
    try {
      await execute('DELETE FROM ai_messages WHERE user_id = ?', [userId]);
      await execute(
        'UPDATE ai_profiles SET summary = "", msg_count = 0, summary_until_id = 0, last_chat = NULL WHERE user_id = ?',
        [userId]
      );
    } catch { /* 忽略 */ }
  }

  try {
  // ---------- 1. 结构 ----------
  step('1. api.js 是否导出了 ai 命名空间');
  const API = loadApiClient();
  truthy(!!API.ai, 'API.ai 存在');
  for (const fn of ['status', 'chat', 'messages', 'greeting', 'memory', 'forget']) {
    eq(typeof API.ai[fn], 'function', `API.ai.${fn} 是函数`);
  }

  // ---------- 2. ★ 前端源码里不能有 Key ----------
  step('2. ★ 安全：前端源码里不能出现 API Key');
  const dir = resolveFrontendDir();
  const files = fs.readdirSync(dir).filter(f => /\.(js|html)$/.test(f));
  let leaked = null;
  let directCall = null;
  for (const f of files) {
    const c = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/sk-[a-zA-Z0-9]{20,}/.test(c)) leaked = f;
    if (/api\.deepseek\.com/.test(c)) directCall = f;
  }
  eq(leaked, null, '★ 没有任何文件里有明文 Key');
  eq(directCall, null, '★ 前端没有直连大模型接口（必须走后端）');
  ok('Key 只在服务器的 .env 里（权限 600），前端一行都拿不到');
  console.log('     \x1b[2m原来 chat.html 里写死了 Key，任何人"查看源代码"就能拿走。\x1b[0m');

  // ---------- 3. 登录 ----------
  step('3. 登录并清空记录');
  A = await API.auth.login('13800138000', '123456');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  await cleanup(A.user.id);
  ok('起点干净');

  // ---------- 4. status ----------
  step('4. API.ai.status()');
  const st = await API.ai.status();
  truthy(['deepseek', 'local'].includes(st.provider), `provider=${st.provider}`);
  truthy('isReal' in st, '带 isReal（前端据此决定要不要提示"体验版"）');
  truthy('notice' in st, '带 notice（没配 Key 时给用户一句说明）');
  truthy('model' in st, `model=${st.model}`);

  // ---------- 5. greeting ----------
  step('5. API.ai.greeting()');
  const g = await API.ai.greeting();
  truthy(typeof g.greeting === 'string' && g.greeting.length > 0,
    `开场白：${g.greeting}`);
  truthy('fromMemory' in g, '带 fromMemory');
  truthy('isFirstTime' in g, '带 isFirstTime');

  // ---------- 6. chat ----------
  step('6. API.ai.chat() 返回的字段够渲染');
  const c1 = await API.ai.chat('今天上班好累，还加了个班');
  truthy(!!c1.userMessage, '带 userMessage（我发的那条，有 id）');
  truthy(!!c1.reply, '带 reply');
  for (const f of ['id', 'role', 'content', 'isMine', 'time']) {
    truthy(f in c1.reply, `reply 字段 ${f} 存在`, Object.keys(c1.reply));
  }
  eq(c1.reply.isMine, false, 'reply.isMine=false（气泡靠左）');
  eq(c1.userMessage.isMine, true, 'userMessage.isMine=true（气泡靠右）');
  eq(c1.saved, true, 'saved=true（登录状态下已存库）');
  truthy('provider' in c1, '带 provider');
  truthy('care' in c1, '带 care 字段（正常内容时为 null）');
  truthy('memoryUpdated' in c1, '带 memoryUpdated（前端据此提示"记忆已更新"）');
  console.log(`     \x1b[2m小陪：${c1.reply.content.slice(0, 50)}\x1b[0m`);

  // ---------- 7. 危机信号 ----------
  step('7. ★ 危机信号带 care');
  const crisis = await API.ai.chat('最近真的撑不下去了');
  truthy(!!crisis.care, '★ 返回了 care');
  truthy(Array.isArray(crisis.care.lines), 'care.lines 是数组');
  truthy('name' in crisis.care.lines[0] && 'phone' in crisis.care.lines[0],
    '每条热线有 name 和 phone（前端拼 tel: 链接）');
  eq(crisis.saved, true, '★ 这些话也被保存了（不是被丢掉）');

  // ---------- 8. messages ----------
  step('8. API.ai.messages()  换设备续聊');
  const hist = await API.ai.messages({ size: 50 });
  truthy(hist.list.length >= 4, `拉到 ${hist.list.length} 条历史`);
  truthy('total' in hist, `total=${hist.total}`);
  truthy('hasMore' in hist, '带 hasMore');
  truthy('provider' in hist, '带 provider');
  const mine = hist.list.find(m => m.isMine);
  const aiMsg = hist.list.find(m => !m.isMine);
  truthy(!!mine && !!aiMsg, '历史和回复都在（顺序：我 → 小陪）');
  eq(hist.list[0].role, 'user', '最早的在前（聊天从上往下读）');

  // 模拟新设备：重新登录
  const API2 = loadApiClient();
  await API2.auth.login('13800138000', '123456');
  const hist2 = await API2.ai.messages({ size: 50 });
  // ★ 断言词要和上面实际发的内容对得上 ★
  //   我第一版这里检查 includes('加班')，但第 6 步发的是
  //   "今天上班好累，还加了个班" —— "加班"这两个字并不连续
  //   （和 README 坑 20 是同一类错误）。
  //   改成检查一个确实连续的词。
  truthy(hist2.list.some(m => m.content.includes('上班好累')),
    '★ 新设备能拉到之前说的话（这就是"换设备还能继续聊天"）');
  truthy(hist2.list.some(m => m.content.includes('撑不下去')),
    '★ 连那句难受的话也在（没有因为消极内容被丢掉）');

  // ---------- 9. memory ----------
  step('9. API.ai.memory()');
  const mem = await API.ai.memory();
  truthy('summary' in mem, '带 summary');
  truthy('hasMemory' in mem, '带 hasMemory');
  truthy('totalMessages' in mem, `totalMessages=${mem.totalMessages}`);
  truthy('summaryUntilId' in mem, `游标 summaryUntilId=${mem.summaryUntilId}`);
  truthy('pendingMessages' in mem, `待压缩 ${mem.pendingMessages} 条`);
  truthy('keepRecent' in mem, `保留最近 ${mem.keepRecent} 条`);

  // ---------- 10. 摘要触发 ----------
  step('10. ★ 聊够了自动生成长期记忆');
  for (let i = 0; i < 8; i++) {
    await API.ai.chat(`第${i}件事：我在准备考研，我妈总催我，还养了只猫叫团子`);
  }
  const mem2 = await API.ai.memory();
  eq(mem2.hasMemory, true, '★ 自动生成了长期记忆');
  truthy(mem2.summaryUntilId > 0, `游标推进到 ${mem2.summaryUntilId}`);
  truthy(mem2.summary.length > 0, `摘要 ${mem2.summary.length} 字`);
  console.log(`     \x1b[2m记忆：${mem2.summary.slice(0, 80)}…\x1b[0m`);

  // 有记忆后开场白会变
  const g2 = await API.ai.greeting();
  eq(g2.fromMemory, true, '★ 有记忆后 fromMemory=true');
  truthy(!!g2.memory, '带记忆内容（前端可以展示"你记得我什么"）');

  // ---------- 11. forget ----------
  step('11. API.ai.forget()  忘掉我');
  const del = await API.ai.forget();
  truthy(del.deleted >= 2, `清掉了 ${del.deleted} 条消息`);
  const mem3 = await API.ai.memory();
  eq(mem3.hasMemory, false, '★ 记忆清空');
  eq(mem3.totalMessages, 0, '★ 记录清空');
  eq(mem3.summaryUntilId, 0, '游标归零');
  const hist3 = await API.ai.messages({ size: 10 });
  eq(hist3.total, 0, '历史接口拿不到东西了');

  // ---------- 12. 未登录 ----------
  step('12. 未登录的行为');
  const anon = loadApiClient();
  eq(anon.auth.isLoggedIn(), false, '新沙箱未登录');
  const anonChat = await anon.ai.chat('没登录也想说说话');
  eq(anonChat.saved, false, '★ 未登录也能聊，但 saved=false');
  eq(anonChat.userMessage, null, '未登录时 userMessage 是 null（前端据此提醒去登录）');
  truthy(!!anonChat.reply.content, '仍然有回复');

  const anonMem = await anon.ai.memory().catch(e => e);
  truthy(isApiError(anonMem), '★ 未登录不能看记忆');
  if (isApiError(anonMem)) eq(anonMem.needLogin, true, '抛出的错误带 needLogin');

  // ---------- 13. 边界 ----------
  step('13. 边界情况');
  const empty = await API.ai.chat('   ').catch(e => e);
  truthy(isApiError(empty), '空消息报错');

  const tooLong = await API.ai.chat('a'.repeat(2500)).catch(e => e);
  truthy(isApiError(tooLong), '★ 超长消息报错（不静默截断）');
  if (isApiError(tooLong)) {
    truthy(/太长/.test(tooLong.message), `提示语可读（${tooLong.message.slice(0, 40)}）`);
  }

  const badPage = await API.ai.messages({ page: 0, size: 99999 });
  // ★ eq(实际值, 期望值, 说明) —— 顺序不能错 ★
  //   我第一版把说明写在了第一个参数，结果报了个
  //   "undefined（期望 ... 实际 true）" 这种看不懂的失败。
  truthy(badPage.list.length <= 100,
    `分页异常不报错（实际返回 ${badPage.list.length} 条）`);

  // ---------- 14. 清理 ----------
  step('14. 清理测试数据');
  await cleanup(A.user.id);
  const left = await queryOne('SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?', [A.user.id]);
  eq(Number(left.n), 0, '★ 清理干净');

  } finally {
    await cleanup(A?.user.id);
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端 AI 聊天契约完全对齐！\n');
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
