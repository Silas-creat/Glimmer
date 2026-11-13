// ============================================================
//  第 7 步：前端 api.js 的评论接口契约测试
//
//  用法：  node scripts/test-api-comment.js
//
//  把 api.js 装进沙箱真打后端，确认前端渲染评论时
//  需要的字段（头像/昵称/时间/回复结构）都在。
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
  console.log('  第 7 步 · 前端 api.js 评论接口契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 1. 结构 ----------
  step('1. api.js 是否导出了 comment 命名空间');
  const API = loadApiClient();
  truthy(!!API.comment, 'API.comment 存在');
  for (const fn of ['add', 'list', 'mine', 'update', 'remove']) {
    eq(typeof API.comment[fn], 'function', `API.comment.${fn} 是函数`);
  }

  // ---------- 2. 登录 ----------
  step('2. 登录两个账号（不同设备要用独立沙箱）');
  const API_B = loadApiClient();
  const a = await API.auth.login('13800138000', '123456');
  const b = await API_B.auth.login('13912345678', '123456');
  ok(`A = ${a.user.nickname}`);
  ok(`B = ${b.user.nickname}`);

  // 建一篇日记
  // ★ 先清掉同日期可能残留的旧日记 ★
  //   之前测试崩溃时会留下日记和评论，下次运行又用同一天，
  //   就会"更新"那篇日记，评论数从非 0 开始，所有断言全乱。
  //   （我踩过：期望评论数 1 实际 3，因为上次残留了 2 条评论）
  const TEST_DATE = '2026-12-25';
  const stale = await API.diary.byDate(TEST_DATE);
  if (stale) {
    await API.diary.remove(stale.id);
    ok(`清掉了上次残留的日记 id=${stale.id}（避免污染本次断言）`);
  }

  const saved = await API.diary.save({
    date: TEST_DATE,
    text: '前端评论契约测试',
    img: 'https://example.com/x.jpg',
    isPublic: true,
  });
  const diaryId = saved.diary.id;
  truthy(Number.isInteger(diaryId), `日记 id=${diaryId}`);
  eq(saved.diary.comments, 0, '★ 新日记的评论数是 0（干净起点）');

  // ---------- 3. 发评论 ----------
  step('3. API.comment.add()');
  const c1 = await API_B.comment.add({ diaryId, content: '前端发的评论' });
  eq(typeof c1.comment.id, 'number', '返回了评论 id');
  eq(c1.comment.content, '前端发的评论', '内容正确');
  eq(c1.commentCount, 1, '返回评论数 = 1');
  eq(c1.care, null, '正常内容 care 是 null');
  const c1Id = c1.comment.id;

  // ---------- 4. 字段是否够渲染 ----------
  step('4. 评论字段是否满足前端渲染（diary-public.html 用到这些）');
  // 前端模板里用的字段
  for (const f of ['id', 'content', 'nick', 'avatar', 'time', 'isMine', 'replies']) {
    truthy(f in c1.comment, `字段 ${f} 存在`, Object.keys(c1.comment));
  }
  eq(c1.comment.isMine, true, 'B 看自己的评论 isMine=true');
  truthy(Array.isArray(c1.comment.replies), 'replies 是数组（前端要遍历）');
  ok('★ 前端不用再请求一次就能渲染出完整一条评论');

  // ---------- 5. 回复 ----------
  step('5. 回复（replyTo 信息要够显示"回复 @某某"）');
  const r1 = await API.comment.add({ diaryId, content: '谢谢你的话', parentId: c1Id });
  eq(r1.comment.parentId, c1Id, 'parentId 正确');
  truthy(!!r1.comment.replyTo, '带 replyTo');
  eq(r1.comment.replyTo.nick, b.user.nickname, 'replyTo.nick 是被回复人的昵称');
  truthy('uid' in r1.comment.replyTo, 'replyTo 里还有 uid');

  // ---------- 6. 列表结构 ----------
  step('6. API.comment.list() 返回的结构');
  const list = await API.comment.list(diaryId, { size: 50 });
  eq(Array.isArray(list.list), true, 'list 是数组');
  eq(list.list.length, 1, '一级评论 1 条');
  eq(list.total, 1, 'total 只数一级');
  eq(list.totalComments, 2, 'totalComments 含回复 = 2');
  eq(list.list[0].replies.length, 1, '回复挂在主评论下');
  truthy(typeof list.hasMore === 'boolean', '有 hasMore（前端做加载更多要用）');
  ok('★ 一次请求拿到完整两级结构，前端不需要递归请求');

  // ---------- 7. 二次扁平化 ----------
  step('7. 回复的回复被扁平化到顶层');
  const r2 = await API_B.comment.add({ diaryId, content: '我也接一句', parentId: r1.comment.id });
  eq(r2.comment.parentId, c1Id, '★ 挂到了顶层，不是挂到 r1 上');
  const list2 = await API.comment.list(diaryId, { size: 50 });
  eq(list2.list[0].replies.length, 2, '两条回复都在同一层');
  ok('前端只渲染两层就够，不用递归');

  // ---------- 8. 内容检测 ----------
  step('8. 违规内容：错误信息要能直接显示给用户');
  try {
    await API_B.comment.add({ diaryId, content: '加我微信 abc12345' });
    bad('广告内容竟然发出去了');
  } catch (e) {
    eq(typeof e.message, 'string', '抛出了带 message 的错误');
    truthy(e.message.length > 3, `消息可读：「${e.message}」`);
    truthy(/联系方式|不能/.test(e.message), '消息说明了原因');
  }

  // ---------- 9. 危机信号 ----------
  step('9. ★ 危机信号：care 字段（前端要特殊展示）');
  const crisis = await API_B.comment.add({ diaryId, content: '最近真的撑不下去了' });
  truthy(!!crisis.care, '★ 返回了 care 字段');
  truthy(typeof crisis.care.message === 'string', 'care.message 是文字');
  truthy(Array.isArray(crisis.care.lines), 'care.lines 是数组');
  truthy(crisis.care.lines.length > 0, `热线 ${crisis.care.lines.length} 条`);
  truthy('name' in crisis.care.lines[0] && 'phone' in crisis.care.lines[0],
    '每条热线有 name 和 phone（前端要拼成可点的 tel: 链接）');
  ok('页面据此弹出关怀提示，而不是报错');

  // ---------- 10. 未登录 ----------
  step('10. 未登录的行为');
  const anon = loadApiClient();
  eq(anon.auth.isLoggedIn(), false, '新沙箱未登录');
  try {
    await anon.comment.add({ diaryId, content: '匿名评论' });
    bad('未登录竟然能评论');
  } catch (e) {
    eq(e.needLogin, true, '抛出的错误带 needLogin（页面据此跳登录）');
  }
  // 但浏览评论不需要登录
  const anonList = await anon.comment.list(diaryId, { size: 10 });
  // ★ 此时一级评论应该有 2 条：
  //     c1（第3步 B 发的）+ 危机信号那条（第9步 B 发的）
  //   我第一版写"应该只有 1 条"，是漏算了第 9 步 ——
  //   第 9 步（163行）在这个检查（184行）之前就执行了。
  //   这种"自己把顺序记错"的失败只能靠打印真实内容定位。
  eq(anonList.list.length, 2, '★ 未登录也能看评论（此时有一级评论 2 条）');
  truthy(anonList.list.every(c => c.isMine === false),
    '★ 未登录时每条评论的 isMine 都是 false');
  truthy(anonList.list.some(c => c.id === c1Id), '能看到第 3 步发的那条');
  ok('浏览不需要登录，发言才需要');

  // ---------- 11. 我发过的评论 ----------
  step('11. API.comment.mine()');
  const mine = await API_B.comment.mine({ size: 20 });
  truthy(mine.list.length > 0, `B 发过 ${mine.list.length} 条`);
  const m0 = mine.list[0];
  for (const f of ['id', 'content', 'diaryId', 'diaryText', 'time', 'isReply']) {
    truthy(f in m0, `字段 ${f} 存在（"我的评论"页面要用）`, Object.keys(m0));
  }

  // ---------- 12. 改评论 ----------
  step('12. API.comment.update()');
  const edited = await API_B.comment.update(c1Id, '改过的内容');
  eq(edited.comment.content, '改过的内容', '改成功');
  try {
    await API.comment.update(c1Id, 'A 想改 B 的评论');
    bad('A 竟然能改 B 的评论');
  } catch (e) {
    truthy(/只能改自己/.test(e.message), `越权被拒绝（${e.message}）`);
  }

  // ---------- 13. 删评论 ----------
  step('13. API.comment.remove()');
  // ★ 谁是作者谁才能删：r1 是 A 发的回复，必须用 A 的 token
  //   （我第一版用了 API_B，被 403 拦住 —— 那是后端的正确行为，不是 bug）
  const del = await API.comment.remove(r1.comment.id);
  truthy(typeof del.commentCount === 'number', '返回更新后的评论数');
  const listAfter = await API.comment.list(diaryId, { size: 50 });
  truthy(!listAfter.list[0].replies.some(x => x.id === r1.comment.id), '那条回复没了');

  // 越权删除的三种身份，规则是：
  //   1. 评论作者本人           → 能删
  //   2. 日记主人（自己地盘）    → 能删（含别人的评论）
  //   3. 既不是作者也不是日记主人 → 不能删（403）
  //
  // ★ 我第一版把"日记主人删别人的评论"也写成应该 403，那是错的 ——
  //   整个评论模块的权限设计就是"自己的地盘自己管"，
  //   否则作者没法清理自己日记下面的骚扰评论。
  step('13.5 删除权限的三种身份');

  // 用一个第三方账号 C 来验证"既不是作者也不是日记主人"
  const API_C = loadApiClient();
  const c3 = await API_C.auth.login('13700000001', '123456');
  ok(`第三方账号 C = ${c3.user.nickname} (id=${c3.user.id})`);

  // 此时日记还在（下面才删），c1 是 B 发的、日记是 A 的
  try {
    await API_C.comment.remove(c1Id);
    bad('C 竟然能删 B 的评论（C 既不是作者也不是日记主人）');
  } catch (e) {
    truthy(/只能删自己/.test(e.message), `★ 与己无关的人删除被拒绝（${e.message}）`);
  }

  // 日记主人 A 删 B 的评论 → 应该成功
  const ownerDel = await API.comment.remove(c1Id);
  truthy(typeof ownerDel.commentCount === 'number',
    '★ 日记主人可以删除自己日记下的评论（自己的地盘自己管）');
  ok('三种身份的权限都验证过了');

  // ---------- 14. 清理 ----------
  step('14. 清理测试数据');
  const delDiary = await API.diary.remove(diaryId);
  eq(delDiary.id, diaryId, '测试日记已删除（评论级联删掉）');
  try {
    await API.comment.list(diaryId, { size: 10 });
    bad('日记删了评论接口竟然还能访问');
  } catch (e) {
    truthy(e.message.length > 0, '日记删除后评论接口返回错误');
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端评论接口契约完全对齐！\n');
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
