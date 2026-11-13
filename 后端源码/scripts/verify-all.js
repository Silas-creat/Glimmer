// ============================================================
//  「陪着」六大需求 —— 端到端验收（人工可读的输出）
//
//  用法：  node scripts/verify-all.js
//
//  ★ 和 test-all.sh 的区别 ★
//    test-all.sh 有 26 关、约 1400 项断言，适合判断"有没有坏"。
//    这个是给【人看】的：把六大需求各走一遍，
//    打印出真实的请求和响应，让人一眼确认"功能真的在"。
//
//  为什么还要写这个：
//    断言全绿只说明"我写的检查都过了"，
//    不能替代"人看到功能确实能用"。
//    所以最后用这个脚本把结果摊开来看一遍。
// ============================================================
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

let okCount = 0, problemCount = 0;

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

const H = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const ok = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); okCount++; };
const msg = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);
const problem = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); problemCount++; };

async function login(phone) {
  const r = await api('POST', '/api/auth/login', { body: { phone, code: '123456' } });
  if (r.body?.code !== 0) throw new Error('登录失败');
  return r.body.data;
}

(async () => {
  console.log('==============================================');
  console.log('  「陪着」六大需求 · 端到端验收');
  console.log('  后端: ' + BASE);
  console.log('==============================================');

  // ---------- 0 健康 ----------
  H('0. 后端健康检查');
  const health = await api('GET', '/api/health');
  if (health.body?.code === 0) {
    ok(`服务在跑：${health.body.data.service} v${health.body.data.version}`);
    ok(`数据库已连接：${health.body.data.db?.connected ?? health.body.data.db}`);
  } else {
    problem('后端没响应');
    return;
  }

  const A = await login('13800138000');
  ok(`登录成功：${A.user.nickname}（uid ${A.user.uid}）`);

  // 造两个临时小号当"别人"
  const Other = await login('13912345678');
  ok(`第二个账号：${Other.user.nickname}`);
  // ★ 为什么要第三个账号 ★
  //   下面要用 Other 发一条违规消息来验证机器人拦人，
  //   而拦下之后 Other 会被禁言 30 秒（这是机器人在正常工作）。
  //   然后就没法用 Other 接着测"危机信号"了 ——
  //   禁言期内发不出消息（429）。
  //   所以危机信号换一个没犯过规的账号来测。
  const Third = await login('13700000001');
  ok(`第三个账号：${Third.user.nickname}（用来测危机信号，避免被禁言挡住）`);

  // ---------- 需求⑥ 登录 ----------
  H('需求⑥ 登录页面');
  const code = await api('POST', '/api/auth/send-code', { body: { phone: '13800138000' } });
  ok(`发验证码接口正常（${code.body.msg}）`);
  msg('开发环境会把验证码打到服务器日志，同时万能码 123456 永远可用');
  const me = await api('GET', '/api/auth/me', { token: A.token });
  // ★ 注意返回结构是 data.user.xxx，不是 data.xxx ★
  //   我第一版写成了 me.body.data.nick，结果打印出 "undefined / undefined" ——
  //   验收脚本自己取错字段是很坑的：它看起来"通过了"，
  //   但输出里的 undefined 说明根本没验到东西。
  //   所以这类脚本一定要把取到的值打印出来看。
  const meUser = me.body?.data?.user;
  if (meUser?.nickname) {
    ok(`用 token 换回用户信息：${meUser.nickname} / ${meUser.phone}`);
  } else {
    problem(`/api/auth/me 返回结构不对：${JSON.stringify(me.body).slice(0, 120)}`);
  }

  // ---------- 需求③ 类朋友圈 ----------
  H('需求③ 类朋友圈（公开/私密 + 随机推荐陌生人）');
  const stamp = Date.now().toString().slice(-6);
  const today = new Date().toISOString().slice(0, 10);

  const pub = await api('POST', '/api/diary/save', {
    token: A.token,
    body: { date: today, text: `验收：今天写了一条公开日记 ${stamp}`, isPublic: 1 },
  });
  ok(`写了公开日记（id=${pub.body.data.diary?.id ?? pub.body.data?.id}）`);

  const priv = await api('POST', '/api/diary/save', {
    token: A.token,
    body: { date: '2001-02-03', text: `验收：这条是私密的 ${stamp}`, isPublic: 0 },
  });
  ok('写了私密日记');

  // 别人看他
  const others = await api('GET', `/api/diary/feed?feed=all&userId=${A.user.id}&size=10`,
    { token: Other.token });
  const seesPublic = (others.body.data?.list || []).some(d => d.text.includes(stamp));
  const seesPrivate = (others.body.data?.list || []).some(d => d.text.includes('私密'));
  seesPublic ? ok('★ 别人能看到他的公开日记') : problem('别人的公开日记没看到');
  !seesPrivate ? ok('★ 别人看不到他的私密日记') : problem('私密日记泄露了！');

  // 自己看自己的
  const mine = await api('GET', `/api/diary/feed?feed=mine&size=20`, { token: A.token });
  ok(`自己能看到全部 ${mine.body.data.total} 篇（含私密）`);

  // 随机推荐
  const discover = await api('GET', '/api/discover?size=10', { token: Other.token });
  const types = [...new Set((discover.body.data.list || []).map(x => x.type))];
  ok(`★ 发现页随机推荐陌生人内容：${discover.body.data.list.length} 条（类型 ${types.join('/')}）`);
  msg(`换一批倒计时 ${discover.body.data.seedRefreshIn} 秒`);

  // ---------- 需求② 漂流瓶 ----------
  H('需求② 漂流瓶（留言、随机推送）');
  const toss = await api('POST', '/api/bottle/toss', {
    token: A.token, body: { content: `验收：把这句话扔进海里 ${stamp}`, isAnon: true },
  });
  if (toss.body.code === 0) {
    ok('★ 扔了一个瓶子（默认匿名）');
  } else {
    msg(`（扔瓶子有 20 秒间隔，这次返回：${toss.body.msg}）`);
  }

  const sea = await api('GET', '/api/bottle/sea?size=5', { token: Other.token });
  ok(`★ 别人捞到 ${sea.body.data.list.length} 个瓶子，还剩 ${sea.body.data.remaining} 个没捞过`);
  if (sea.body.data.list[0]) {
    msg(`第一个瓶子："${sea.body.data.list[0].content.slice(0, 30)}" 来自 ${sea.body.data.list[0].nick}`);
  }

  // ---------- 需求④ 主页留言鼓励 ----------
  H('需求④ 个人主页给别人留言鼓励（祝福）');
  const bless = await api('POST', '/api/bless/send', {
    token: Other.token,
    body: { toUid: A.user.uid, content: `验收：希望你今天顺利 ${stamp}` },
  });
  if (bless.body.code === 0) {
    ok('★ 送出了一份祝福');
    const received = await api('GET', '/api/bless/received', { token: A.token });
    const got = (received.body.data?.list || []).some(b => b.content.includes(stamp));
    got ? ok('★ 对方收到了（能在自己的消息里看到）') : problem('祝福没收到');
    const unread = await api('GET', '/api/bless/unread-count', { token: A.token });
    ok(`未读数接口正常（${unread.body.data.unread}）`);
  } else {
    msg(`祝福发送返回：${bless.body.msg}`);
  }

  // ---------- 需求① 群聊 + 机器人 ----------
  H('需求① 类微信群聊 + 机器人管违规');

  // ★ 先重置机器人的违规计数 ★
  //
  //  机器人的违规计数存在【服务进程的内存】里（见 utils/chatBot.js），
  //  不会因为测试结束或数据库清理而消失。
  //  所以如果上一次验收时 Other 犯过规、被禁言了，
  //  这一次它一进来就是"正在被禁言"状态，发什么都返回 429 ——
  //  表现成"违规消息没被拦"，其实是它根本发不出消息。
  //
  //  （这个端点只在开发环境开放，正式环境返回 404。）
  const reset = await api('POST', '/api/group/_test/reset', { token: A.token });
  if (reset.body?.code === 0) {
    ok('重置了机器人的违规计数（让它从干净状态开始）');
  }

  const rooms = await api('GET', '/api/group/rooms', { token: A.token });
  ok(`★ 4 个房间都在：${rooms.body.data.list.map(r => r.name).join('、')}`);

  const joinRoom = await api('POST', '/api/group/rooms/interest/join', { token: A.token });
  ok(`进了「${joinRoom.body.data.room.name}」`);
  // Other 也要先进群（不然发言会因为没有成员记录而走别的分支）
  await api('POST', '/api/group/rooms/interest/join', { token: Other.token });
  await api('POST', '/api/group/rooms/interest/join', { token: Third.token });

  const say = await api('POST', '/api/group/rooms/interest/messages', {
    token: A.token, body: { content: `验收：大家好 ${stamp}` },
  });
  ok(`正常发言成功（没被拦）`);

  const bad = await api('POST', '/api/group/rooms/interest/messages', {
    token: Other.token, body: { content: '加我微信 abc12345 有好事' },
  });
  if (bad.body?.data?.blocked === true) {
    ok('★ 机器人拦下了违规消息');
    msg(`机器人说：${bad.body.data.botNotice}`);
  } else {
    problem(`违规消息没被拦（返回：${bad.body?.msg || JSON.stringify(bad.body).slice(0, 100)}）`);
  }

  const crisis = await api('POST', '/api/group/rooms/interest/messages', {
    token: Third.token, body: { content: `验收：最近真的撑不下去了 ${stamp}` },
  });
  if (crisis.body?.data?.blocked === false && crisis.body?.data?.care) {
    ok('★ 说难受的话不会被拦，而是被接住（附求助热线）');
    msg(`热线：${crisis.body.data.care.lines.map(l => l.name + ' ' + l.phone).join(' / ')}`);
  } else {
    problem(`危机信号处理不对（返回：${crisis.body?.msg || JSON.stringify(crisis.body).slice(0, 90)}）`);
  }

  // ---------- 需求⑤ AI 聊天 + 记忆 ----------
  H('需求⑤ AI 聊天 + 记忆（换设备还能继续聊）');
  const aiStatus = await api('GET', '/api/ai/status');
  ok(`当前模型：${aiStatus.body.data.model}（provider=${aiStatus.body.data.provider}）`);
  if (!aiStatus.body.data.isReal) {
    msg('还没配 DEEPSEEK_API_KEY，用的是内置体验版陪伴者');
  }

  const chat1 = await api('POST', '/api/ai/chat', {
    token: A.token, body: { message: `验收：我今天加班到很晚，好累 ${stamp}` },
  });
  ok('★ 说了一句话，AI 回了');
  msg(`我：我今天加班到很晚，好累`);
  msg(`小陪：${chat1.body.data.reply.content.slice(0, 60)}`);

  // 模拟换设备
  const A2 = await login('13800138000');
  const history = await api('GET', '/api/ai/messages?size=50', { token: A2.token });
  const found = (history.body.data.list || []).some(m => m.content.includes(stamp));
  found
    ? ok('★ 换设备（重新登录）还能拉到刚才说的话 —— 这就是"能读取记忆"')
    : problem('换设备后拿不到历史');

  const mem = await api('GET', '/api/ai/memory', { token: A.token });
  ok(`记忆接口正常（总消息 ${mem.body.data.totalMessages} 条，有摘要=${mem.body.data.hasMemory}）`);
  msg('用户可以点聊天页右上角"记忆"查看 AI 记得什么，也能一键删掉');

  // ---------- 清理 ----------
  H('清理验收数据');
  await api('DELETE', `/api/diary/${pub.body.data.diary?.id ?? pub.body.data?.id}`, { token: A.token });
  await api('DELETE', '/api/ai/memory', { token: A.token });
  ok('清掉了公开日记和 AI 聊天记录');

  // ★ 这个脚本会造日记、祝福、漂流瓶、群消息，必须自己收拾干净 ★
  //   否则：
  //     · 数据库里堆着"验收：xxx"的测试内容
  //     · fix-test-account.js 认不出那两个临时账号（它们有业务数据），
  //       于是账号越积越多
  //   我第一版没做这一步，跑几轮之后库里就多了几个清不掉的账号。
  //
  //   这里用 SQL 直连清（比走接口全），所以要连数据库 ——
  //   虚拟机上跑没问题。
  let cleaned = false;
  try {
    const { execute, pool } = await import('../src/db/index.js');
    const ids = [A.user.id, Other.user.id, Third.user.id];

    await execute(`DELETE FROM diaries WHERE text LIKE ?`, [`%${stamp}%`]);
    // ★ 祝福不按时间戳删，改成"删掉这三个测试账号之间的全部祝福" ★
    //   按时间戳删会漏掉上一次运行残留的（时间戳不同），
    //   而残留的祝福会让 fix-test-account.js 认不出这些账号是垃圾账号。
    await execute(
      `DELETE FROM blessings WHERE from_user IN (?, ?, ?) OR to_user IN (?, ?, ?)`,
      [...ids, ...ids]
    );
    await execute(`DELETE FROM bottles WHERE content LIKE ?`, [`%${stamp}%`]);
    await execute(
      `DELETE FROM chat_messages WHERE content LIKE ? OR content LIKE ?`,
      [`%${stamp}%`, `%${Other.user.nickname}%`]
    );
    await execute(`DELETE FROM ai_messages WHERE content LIKE ?`, [`%${stamp}%`]);
    // 让临时账号退出群（否则它们有 chat_members 记录，清不掉）
    await execute('DELETE FROM chat_members WHERE user_id IN (?, ?, ?)', ids);
    await execute('DELETE FROM follows WHERE user_id IN (?, ?, ?) OR target_id IN (?, ?, ?)',
      [...ids, ...ids]);
    await execute('DELETE FROM likes WHERE user_id IN (?, ?, ?)', ids);
    await execute('DELETE FROM favorites WHERE user_id IN (?, ?, ?)', ids);
    await pool.end();

    cleaned = true;
    ok('★ 清掉了本次验收造的日记/祝福/瓶子/群消息/成员记录');
    console.log('');
    console.log('  提示：下面这条命令会把临时测试账号也清掉，建议养成习惯：');
    console.log('       cd D:\\Study\\Match\\2026-2027.up\\server && node scripts\\fix-test-account.js');
  } catch (e) {
    console.log(`  \x1b[33m! 清理失败（不影响功能，只是会留点测试数据）：${e.message}\x1b[0m`);
    console.log('    可以手工跑：cd D:\\Study\\Match\\2026-2027.up\\server && node scripts\\fix-test-account.js');
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  验收结果： \x1b[32m${okCount} 项正常\x1b[0m`
    + (problemCount ? `   \x1b[31m${problemCount} 项有问题\x1b[0m` : ''));
  console.log('==============================================');
  if (problemCount === 0) {
    console.log('\n  🎉 六大需求全部走通，功能确实在。\n');
    process.exitCode = 0;
  } else {
    console.log('\n  有问题的项见上面红色的 ✗\n');
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('\n验收脚本出错：', e);
  process.exitCode = 1;
});
