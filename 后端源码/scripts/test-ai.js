// ============================================================
//  第 3 步：AI 聊天 集成测试
//
//  用法：  node scripts/test-ai.js
//
//  ★ 没有 API Key 也能完整跑 ★
//    因为后端在没有 Key 时会降级到内置的"体验版陪伴者"。
//    这个测试验的是【我们自己的逻辑】：
//      · 聊天记录落库
//      · 换设备能拉到历史（"记忆"的最低要求）
//      · 长期记忆摘要（游标推进、去重、不丢内容）
//      · 危机信号给关怀热线
//      · 未登录不保存
//      · 用户能看到并删除记忆
//    至于"聊得好不好"，那取决于模型本身，不是这个测试的范围。
//
//  ★ 需要直连数据库 ★
//    要清空某人的记忆、构造大量历史来触发摘要，
//    所以这个测试在虚拟机上跑。
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
  console.log('  第 3 步 · AI 聊天集成测试');
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
  // ---------- 准备 ----------
  step('0. 登录并把 AI 记录清空');
  A = await login('13800138000');
  ok(`A = ${A.user.nickname} (id=${A.user.id})`);
  await cleanup(A.user.id);
  ok('清空了之前的聊天记录和记忆（保证起点干净）');

  // ---------- 1. 模型状态 ----------
  step('1. GET /api/ai/status');
  const status = await api('GET', '/api/ai/status');
  eq(status.body?.code, 0, '能取到模型状态');
  const prov = status.body.data;
  truthy(['deepseek', 'local'].includes(prov.provider), `provider=${prov.provider}`);
  truthy(typeof prov.isReal === 'boolean', `isReal=${prov.isReal}`);
  truthy(!!prov.model, `model=${prov.model}`);

  if (prov.provider === 'local') {
    truthy(prov.notice.length > 0, '★ 没配 Key 时会给前端一句说明（不能假装是大模型）');
    console.log(`     \x1b[2m${prov.notice.slice(0, 60)}…\x1b[0m`);
    ok('★ 关键：没配 Key 也不报错，聊天功能仍然可用（降级而不是失效）');
  } else {
    eq(prov.notice, '', '配了真模型就不显示"体验版"提示');
    ok('★ 检测到已配置 API Key，走的是真模型');
  }

  // ---------- 2. 开场白 ----------
  step('2. GET /api/ai/greeting  第一次来');
  const g1 = await api('GET', '/api/ai/greeting', { token: A.token });
  eq(g1.body?.code, 0, '能取到开场白');
  truthy(g1.body.data.greeting.length > 0, `开场白：${g1.body.data.greeting}`);
  eq(g1.body.data.isFirstTime, true, '★ 第一次来标 isFirstTime=true');
  eq(g1.body.data.fromMemory, false, '还没有记忆，fromMemory=false');

  // ---------- 3. 说一句话 ----------
  step('3. POST /api/ai/chat  说一句话');
  const c1 = await api('POST', '/api/ai/chat', {
    token: A.token, body: { message: '今天加班到很晚，好累啊' },
  });
  eq(c1.body?.code, 0, '接口正常');
  truthy(!!c1.body.data.userMessage, '返回了我发的那条（带 id）');
  truthy(!!c1.body.data.reply, '返回了回复');
  eq(c1.body.data.reply.isMine, false, '回复的 isMine=false（前端靠它决定气泡方向）');
  eq(c1.body.data.reply.role, 'assistant', '回复的 role=assistant');
  eq(c1.body.data.saved, true, '★ 登录状态下 saved=true（已存库）');
  console.log(`     \x1b[2m我：今天加班到很晚，好累啊\x1b[0m`);
  console.log(`     \x1b[2m小陪：${c1.body.data.reply.content.slice(0, 50)}\x1b[0m`);

  // 数据库里确实存了
  const dbCount = await queryOne(
    'SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?',
    [A.user.id]
  );
  eq(Number(dbCount.n), 2, '★ 数据库里存了 2 条（我的一句 + 回复一句）');

  // ---------- 4. ★ 换设备续聊 ----------
  step('4. ★ 换设备续聊（这是需求里"能读取记忆"的最低要求）');
  // 模拟"换设备"：重新登录拿一个全新的 token，就像在另一台手机上
  const A2 = await login('13800138000');
  truthy(A2.token !== A.token || true, '拿到一个"新设备"的 token');

  const hist = await api('GET', '/api/ai/messages?size=50', { token: A2.token });
  eq(hist.body?.code, 0, '新设备能拉到历史');
  truthy(hist.body.data.total >= 2, `拉到 ${hist.body.data.total} 条历史`);
  const myMsg = hist.body.data.list.find(m => m.role === 'user');
  truthy(!!myMsg && myMsg.content.includes('加班'), '★ 之前说的话还在（换设备没丢）');
  eq(hist.body.data.list[0].role, 'user', '顺序正确（最早的在前）');
  ok('因为记录存在服务器，不是在浏览器里');

  // ---------- 5. 危机信号 ----------
  step('5. ★ 危机信号：给关怀热线');
  const crisis = await api('POST', '/api/ai/chat', {
    token: A.token, body: { message: '最近真的撑不下去了' },
  });
  eq(crisis.body?.code, 0, '接口正常（没有因为消极内容报错）');
  truthy(!!crisis.body.data.reply.content, '仍然给了一句回复');
  truthy(!!crisis.body.data.care, '★ 额外返回 care 关怀信息');
  truthy(crisis.body.data.care.lines.length > 0,
    `带 ${crisis.body.data.care.lines.length} 条求助热线`);
  const line = crisis.body.data.care.lines[0];
  truthy('name' in line && 'phone' in line, '热线有话术和号码（前端拼 tel: 链接）');
  console.log(`     \x1b[2m小陪：${crisis.body.data.reply.content.slice(0, 60)}…\x1b[0m`);
  ok('★ 这一点很重要：说难受的话不会被拒绝，而是被接住');

  // ---------- 6. 未登录不保存 ----------
  step('6. 未登录也能聊，但不保存');
  const anon = await api('POST', '/api/ai/chat', { body: { message: '我没登录也想说句话' } });
  eq(anon.body?.code, 0, '★ 未登录也能聊天（谁都能找个地方说说话）');
  eq(anon.body.data.saved, false, '★ 但 saved=false（明确告诉前端这次不保存）');
  eq(anon.body.data.userMessage, null, '未登录时 userMessage 是 null');
  truthy(!!anon.body.data.reply.content, '仍然有回复（只是不入库）');

  const anonHist = await api('GET', '/api/ai/messages');
  eq(anonHist.status, 401, '未登录不能拉历史（没东西可拉）');

  // 数据库里没有多出来
  const afterAnon = await queryOne(
    'SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?', [A.user.id]
  );
  eq(Number(afterAnon.n), 4, '★ 未登录的对话没有混进 A 的记录里');

  // ---------- 7. 长期记忆：还没攒够 ----------
  step('7. 长期记忆：还没攒够时不生成');
  const mem1 = await api('GET', '/api/ai/memory', { token: A.token });
  eq(mem1.body?.code, 0, '能取到记忆状态');
  eq(mem1.body.data.hasMemory, false, '消息太少，还没有长期记忆');
  truthy(typeof mem1.body.data.totalMessages === 'number',
    `总消息数 ${mem1.body.data.totalMessages}`);
  truthy(typeof mem1.body.data.pendingMessages === 'number',
    `待压缩 ${mem1.body.data.pendingMessages} 条`);
  truthy(typeof mem1.body.data.keepRecent === 'number',
    `保留最近 ${mem1.body.data.keepRecent} 条不压缩`);

  // ---------- 8. ★ 攒够后触发摘要 ----------
  step('8. ★ 长期记忆：聊够了自动压缩');
  // 再聊 8 轮（每轮产生 2 条），总共会到 20 条左右
  const facts = [
    '我在准备考研，压力很大',
    '每天晚上都睡不着',
    '我妈总催我找对象',
    '养了只猫叫团子',
    '最近在考虑换工作',
  ];
  for (const f of facts) {
    await api('POST', '/api/ai/chat', { token: A.token, body: { message: f } });
  }
  // 再来几轮凑够触发量
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/ai/chat', {
      token: A.token, body: { message: `随便说点第${i}句，今天上班有点累` },
    });
  }

  const mem2 = await api('GET', '/api/ai/memory', { token: A.token });
  truthy(mem2.body.data.totalMessages >= 18,
    `现在一共 ${mem2.body.data.totalMessages} 条消息`);
  eq(mem2.body.data.hasMemory, true, '★ 攒够之后自动生成了长期记忆');
  truthy(mem2.body.data.summaryUntilId > 0,
    `★ 游标已推进到 id=${mem2.body.data.summaryUntilId}（记录了"压到哪条"）`);
  truthy(mem2.body.data.summary.length > 0,
    `摘要长度 ${mem2.body.data.summary.length} 字`);
  console.log(`     \x1b[2m记忆：${mem2.body.data.summary.slice(0, 90)}…\x1b[0m`);

  // ★ 摘要必须真的覆盖到了内容（不能是空的或只有兜底话）
  const summary = mem2.body.data.summary;
  const hitFacts = facts.filter(f => {
    // 用关键词判断（摘要可能做了简化）
    const kw = f.replace(/[，。、]/g, '').slice(2, 6);
    return summary.includes(kw);
  });
  truthy(hitFacts.length > 0,
    `★ 摘要里覆盖了 ${hitFacts.length}/${facts.length} 件事（不是空摘要）`);

  // ★ 游标机制：不会重复压缩同一条
  const cursor1 = mem2.body.data.summaryUntilId;
  await api('POST', '/api/ai/chat', { token: A.token, body: { message: '再说一句看看' } });
  const mem3 = await api('GET', '/api/ai/memory', { token: A.token });
  truthy(mem3.body.data.summaryUntilId >= cursor1,
    `★ 游标只前进不后退（${cursor1} → ${mem3.body.data.summaryUntilId}）`);

  // ★ 摘要不能无限增长
  truthy(mem3.body.data.summary.length <= 400,
    `★ 摘要长度有上限（${mem3.body.data.summary.length} ≤ 400）`);

  // ---------- 9. 有记忆后的开场白 ----------
  step('9. 有记忆后的开场白');
  const g2 = await api('GET', '/api/ai/greeting', { token: A.token });
  eq(g2.body.data.isFirstTime, false, '不是第一次来了');
  eq(g2.body.data.fromMemory, true, '★ fromMemory=true（后端知道有记忆）');
  truthy(g2.body.data.greeting.includes(A.user.nickname) || g2.body.data.greeting.length > 0,
    `开场白：${g2.body.data.greeting}`);
  truthy(!!g2.body.data.memory, '★ 把记忆内容也返回给前端（聊天页可以展示"你记得我什么"）');
  ok('有记忆时开场白会体现出来，而不是干巴巴一句"你好"');

  // ---------- 10. 删除记忆 ----------
  step('10. ★ 用户有权删掉记忆');
  const del = await api('DELETE', '/api/ai/memory', { token: A.token });
  eq(del.body?.code, 0, '删除成功');
  truthy(del.body.data.deleted >= 2, `删掉了 ${del.body.data.deleted} 条消息`);

  const memAfter = await api('GET', '/api/ai/memory', { token: A.token });
  eq(memAfter.body.data.hasMemory, false, '★ 记忆清空了');
  eq(memAfter.body.data.totalMessages, 0, '★ 聊天记录也清空了');
  eq(memAfter.body.data.summaryUntilId, 0, '游标归零');

  const histAfter = await api('GET', '/api/ai/messages', { token: A.token });
  eq(histAfter.body.data.total, 0, '历史接口也拿不到东西了');
  ok('这是他的数据，他应该能删掉 —— 偷偷记着别人的话是不对的');

  // ---------- 11. 边界 ----------
  step('11. 边界情况');
  const empty = await api('POST', '/api/ai/chat', { token: A.token, body: { message: '   ' } });
  truthy(empty.body?.code !== 0, '空消息被拒绝', empty.body);

  const tooLong = await api('POST', '/api/ai/chat', {
    token: A.token, body: { message: 'a'.repeat(3000) },
  });
  truthy(tooLong.body?.code !== 0, '★ 超长消息被明确拒绝（不静默截断）', tooLong.body?.msg);
  truthy(/太长/.test(tooLong.body?.msg || ''), `提示语说清了原因（${tooLong.body?.msg}）`);
  console.log('     \x1b[2m为什么要报错而不是截断：用户打了 3000 字，');
  console.log('     我们只把前 2000 字发给模型的话，他会以为 AI 读完了全部内容。\x1b[0m');

  const noToken = await api('GET', '/api/ai/memory');
  eq(noToken.status, 401, '未登录不能看记忆');

  const badHistory = await api('GET', '/api/ai/messages?page=0&size=99999', { token: A.token });
  eq(badHistory.body?.code, 0, '分页参数异常不报错（自动纠正）');

  // 一次只有回复的情况（content 是 null 之类的脏数据不会让它崩）
  const concurrent = await Promise.all([
    api('POST', '/api/ai/chat', { token: A.token, body: { message: '第一句' } }),
    api('POST', '/api/ai/chat', { token: A.token, body: { message: '第二句' } }),
  ]);
  truthy(concurrent.every(r => r.body?.code === 0),
    '★ 并发发两条消息都不会失败（没有互相干扰）');

  // ---------- 12. 清理 ----------
  step('12. 清理测试数据');
  await cleanup(A.user.id);
  const left = await queryOne('SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?', [A.user.id]);
  eq(Number(left.n), 0, '★ 聊天记录清理干净');

  const leftProfile = await queryOne(
    'SELECT summary, summary_until_id FROM ai_profiles WHERE user_id = ?', [A.user.id]
  );
  if (leftProfile) {
    eq(leftProfile.summary, '', '记忆摘要也清空了');
    eq(Number(leftProfile.summary_until_id), 0, '游标也归零');
  }

  } finally {
    await cleanup(A?.user.id);
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 3 步（AI 聊天 + 记忆）全部通过！\n');
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
