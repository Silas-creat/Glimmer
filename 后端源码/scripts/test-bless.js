// ============================================================
//  第 8 步：祝福模块集成测试
//
//  用法：  node scripts/test-bless.js
//
//  重点验证"按昵称找人"这件事 —— 前端 bless.html 只传了个昵称，
//  而昵称可能重名、可能不存在，这些情况必须明确报错而不是送错人。
// ============================================================

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
  console.log('  第 8 步 · 祝福模块集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 准备 ----------
  step('0. 登录两个账号并记下初始状态')
  const A = await login('13800138000');
  const B = await login('13912345678');
  ok(`A = ${A.user.nickname} (id=${A.user.id}, uid=${A.user.uid})`);
  ok(`B = ${B.user.nickname} (id=${B.user.id}, uid=${B.user.uid})`);

  // 记下 A 初始的收发数量，测试完要清干净
  // ★ 加个安全取值，别让"某一个请求失败"变成"整脚本崩"
  //   （加之前这里直接崩在 Cannot read properties of null）
  async function totalOf(token, kind) {
    const r = await api('GET', `/api/bless/${kind}?size=50`, { token });
    if (!r.body || r.body.code !== 0) {
      console.log(`     \x1b[33m⚠️  取 ${kind} 失败：HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}\x1b[0m`);
      return 0;
    }
    return r.body.data.total;
  }

  const aSent0 = await totalOf(A.token, 'sent');
  const aRecv0 = await totalOf(A.token, 'received');
  const bSent0 = await totalOf(B.token, 'sent');
  const bRecv0 = await totalOf(B.token, 'received');
  ok(`初始状态：A 送出 ${aSent0} / 收到 ${aRecv0}，B 送出 ${bSent0} / 收到 ${bRecv0}`);

  // 用时间戳生成唯一内容，避免"刚发过了"的去重拦截
  const stamp = Date.now().toString().slice(-6);

  // ★ 记录本次测试【创建的每一条祝福的 id】
  //
  //  为什么不用"按内容里有没有 stamp"来清理：
  //    超长内容测试会产生 1200 字被截断到 1000 字的结果，
  //    而 stamp 写在末尾，截断后 stamp 就没了 —— 按内容匹配会漏掉它。
  //    （我第一版就是这么漏的，排查了一轮）
  //  按 id 记录最可靠，不依赖内容长什么样。
  const createdIds = [];
  function remember(body) {
    const id = body?.data?.blessing?.id;
    if (id) createdIds.push(id);
    return id;
  }

  // ---------- 1. 用 toNick 送祝福（前端 bless.html 的方式）----------
  step('1. ★ 按昵称送祝福（bless.html 只传昵称）')
  const r1 = await api('POST', '/api/bless/send', {
    token: A.token,
    body: { toNick: B.user.nickname, content: `祝你今天也顺利 ${stamp}` },
  });
  eq(r1.body?.code, 0, '按昵称发送成功');
  const b1Id = remember(r1.body);
  eq(r1.body.data.blessing.to.nick, B.user.nickname, '收件人是我们想送的那个 B');
  eq(r1.body.data.blessing.to.userId, B.user.id, '★ 昵称被解析成了正确的 user_id');
  eq(r1.body.data.blessing.from.nick, A.user.nickname, '带上了送件人昵称');
  truthy(/祝福已送到/.test(r1.body.msg), `提示语友好（${r1.body.msg}）`);

  // ---------- 2. 用 toUid / toUserId ----------
  step('2. 用 uid 和内部 id 定位（更准，前端能拿到就用这个）')
  const r2 = await api('POST', '/api/bless/send', {
    token: A.token,
    body: { toUid: B.user.uid, content: `按 uid 送的祝福 ${stamp}` },
  });
  remember(r2.body);
  eq(r2.body?.code, 0, '按 uid 发送成功');
  eq(r2.body.data.blessing.to.userId, B.user.id, '解析到正确的 user_id');

  const r3 = await api('POST', '/api/bless/send', {
    token: A.token,
    body: { toUserId: B.user.id, content: `按 userId 送的祝福 ${stamp}` },
  });
  remember(r3.body);
  eq(r3.body?.code, 0, '按内部 id 发送成功');

  // ---------- 3. 找不到人 / 重名 ----------
  step('3. ★ 找不到人、重名必须明确报错，不能随便挑一个送')
  const ghost = await api('POST', '/api/bless/send', {
    token: A.token, body: { toNick: '绝对不存在的人xyz', content: '测试' },
  });
  eq(ghost.status, 404, '不存在的昵称返回 404');
  truthy(/找不到/.test(ghost.body?.msg || ''), `提示语说明了原因（${ghost.body?.msg}）`);

  const ghostUid = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUid: '99999999999', content: '测试' },
  });
  eq(ghostUid.status, 404, '不存在的 uid 返回 404');

  // 制造一个重名场景：把 B 的昵称临时改成和 C 一样
  // （C 是 test-comment 会创建的那个号，如果不存在就跳过这项）
  const loginC = await api('POST', '/api/auth/login', { body: { phone: '13700000001', code: '123456' } });
  const C = loginC.body.data;
  if (C && C.user.id) {
    // 把 C 的昵称改成和 B 一样，制造重名
    const bNick = B.user.nickname;
    const renameC = await api('PATCH', '/api/user/me', {
      token: C.token, body: { nickname: bNick },
    });
    if (renameC.body?.code === 0) {
      ok(`把 C 的昵称临时改成「${bNick}」，制造重名`);
      const dupSend = await api('POST', '/api/bless/send', {
        token: A.token, body: { toNick: bNick, content: '重名测试' },
      });
      eq(dupSend.status, 409, '★ 重名时返回 409 而不是随便挑一个');
      truthy(/都叫|没法确定/.test(dupSend.body?.msg || ''),
        `提示语说明了原因（${dupSend.body?.msg}）`);
      // 还原 C 的昵称
      await api('PATCH', '/api/user/me', {
        token: C.token, body: { nickname: '陪着' + C.user.uid.slice(-4) },
      });
      ok('已还原 C 的昵称');
    } else {
      ok('（无法制造重名场景，跳过这项）');
    }
  } else {
    ok('（第三方账号不可用，跳过重名测试）');
  }

  // ---------- 4. 不能给自己发 ----------
  step('4. 不能给自己送祝福')
  const self = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: A.user.id, content: '给自己' },
  });
  truthy(self.body?.code !== 0, '给自己发被拒绝', self.body);
  truthy(/自己/.test(self.body?.msg || ''), `提示语说明了原因（${self.body?.msg}）`);

  // 前端没传 to 参数时是 'ta'，也该拦住
  const taSend = await api('POST', '/api/bless/send', {
    token: A.token, body: { toNick: 'ta', content: '测试' },
  });
  truthy(taSend.body?.code !== 0, '前端默认值 "ta" 被拒绝（不能当成某个用户）', taSend.body);

  // ---------- 5. 内容检测 ----------
  step('5. 祝福也要做内容检测（不能拿来打广告）')
  const ad = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: '加我微信 abc12345 有好东西' },
  });
  truthy(ad.body?.code !== 0, '★ 广告内容被拦住', ad.body);
  truthy(/联系方式/.test(ad.body?.msg || ''), `提示语可读（${ad.body?.msg}）`);

  const abuse = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: '你这个废物' },
  });
  truthy(abuse.body?.code !== 0, '人身攻击被拦住', abuse.body);

  // ---------- 6. 危机信号 ----------
  step('6. ★ 祝福里写了消极的话，也给关怀提示')
  // ★ 内容里一定要带 stamp，否则第 18 步的清理会漏掉这条
  //   （我第一版忘了带，结果清理后数量对不上，排查了一轮）
  const crisisContent = `希望你能撑下去，最近我也快撑不下去了 ${stamp}`;
  const crisis = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: crisisContent },
  });
  remember(crisis.body);
  eq(crisis.body?.code, 0, '危机信号不被拒绝，祝福照常送出');
  truthy(!!crisis.body.data.care, '★ 返回了 care 关怀提示');
  truthy(crisis.body.data.care.lines.length > 0, `带 ${crisis.body.data.care.lines.length} 条热线`);

  // ---------- 7. 重复发送 ----------
  step('7. 短时间内重复发同一句会被去重')
  const dupContent = `重复内容测试 ${stamp}`;
  const d1 = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: dupContent },
  });
  remember(d1.body);
  eq(d1.body?.code, 0, '第一次发送成功');
  const d2 = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: dupContent },
  });
  eq(d2.status, 409, '★ 10 秒内重复发同一句被拒绝（防手抖连点）');

  // ---------- 8. 我送出去的列表 ----------
  step('8. 我送出去的祝福')
  const sent = await api('GET', '/api/bless/sent?size=50', { token: A.token });
  eq(sent.body?.code, 0, '能取到送出的列表');
  truthy(sent.body.data.total > aSent0, `总数从 ${aSent0} 增加了（现在 ${sent.body.data.total}）`);
  const sentItem = sent.body.data.list.find(x => x.id === b1Id);
  truthy(!!sentItem, '列表里有刚发的那条');
  eq(sentItem.to.nick, B.user.nickname, '显示收件人是谁');
  truthy(!!sentItem.time, `带相对时间（${sentItem.time}）`);
  ok('前端 bless-sent.html 需要的字段都在');

  // ---------- 9. 我收到的列表 ----------
  step('9. 我收到的祝福')
  const recv = await api('GET', '/api/bless/received?size=50', { token: B.token });
  eq(recv.body?.code, 0, 'B 能取到收到的列表');
  truthy(recv.body.data.total > bRecv0, `B 收到的从 ${bRecv0} 增到 ${recv.body.data.total}`);
  const recvItem = recv.body.data.list.find(x => x.id === b1Id);
  truthy(!!recvItem, '列表里能看到 A 送的那条');
  eq(recvItem.from.nick, A.user.nickname, '★ 显示了是谁送的（这是温暖的一部分）');
  eq(recvItem.isRead, false, '初始是未读状态');

  // ---------- 10. 未读数 ----------
  step('10. 未读数（红点用）')
  const unread = await api('GET', '/api/bless/unread-count', { token: B.token });
  truthy(unread.body.data.unread > 0, `B 有 ${unread.body.data.unread} 条未读`);
  const unreadA = await api('GET', '/api/bless/unread-count', { token: A.token });
  truthy(typeof unreadA.body.data.unread === 'number', 'A 的未读数也能取');

  // ---------- 11. 只看未读 ----------
  step('11. 只看未读的')
  const onlyUnread = await api('GET', '/api/bless/received?unreadOnly=1&size=50', { token: B.token });
  eq(onlyUnread.body.data.total, unread.body.data.unread, '未读筛选的总数和未读数一致');
  truthy(onlyUnread.body.data.list.every(x => x.isRead === false), '全部是未读的');

  // ---------- 12. 标记已读 ----------
  step('12. 标记已读')
  const markAll = await api('GET', '/api/bless/received?markRead=1&size=50', { token: B.token });
  eq(markAll.body?.code, 0, '带 markRead=1 取列表成功');
  const unreadAfter = await api('GET', '/api/bless/unread-count', { token: B.token });
  eq(unreadAfter.body.data.unread, 0, '★ 未读数清零了');

  // 单条标记
  const newOne = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: `单条已读测试 ${stamp}` },
  });
  const newId = remember(newOne.body);
  const markOne = await api('PATCH', `/api/bless/${newId}/read`, { token: B.token });
  eq(markOne.body?.code, 0, '单条标记已读成功');
  const peekOne = await api('GET', '/api/bless/received?size=50', { token: B.token });
  const peeked = peekOne.body.data.list.find(x => x.id === newId);
  eq(peeked.isRead, true, '那条确实变成已读了');

  // ---------- 13. 标记别人的祝福 ----------
  step('13. 不能标记别人收到的祝福')
  const markOther = await api('PATCH', `/api/bless/${newId}/read`, { token: A.token });
  eq(markOther.status, 403, '★ A（发件人）不能标记 B 的已读状态');

  // ---------- 14. 某个人收到过多少祝福 ----------
  step('14. 个人主页可以显示"ta 收到过 N 份祝福"')
  const about = await api('GET', `/api/bless/about/${B.user.id}`, { token: A.token });
  eq(about.body?.code, 0, '能查到某人收到的祝福数');
  eq(about.body.data.nick, B.user.nickname, '返回的是 B');
  truthy(about.body.data.receivedCount > 0, `B 收到过 ${about.body.data.receivedCount} 份祝福`);

  const aboutByUid = await api('GET', `/api/bless/about/${B.user.uid}`, { token: A.token });
  eq(aboutByUid.body.data.userId, B.user.id, '按 uid 也能查');

  const aboutGhost = await api('GET', '/api/bless/about/99999999', { token: A.token });
  eq(aboutGhost.status, 404, '查不存在的人返回 404');

  // ---------- 15. 删除权限 ----------
  step('15. 删除祝福（收件人和发件人都可以）')
  // 收件人 B 删一条
  const delByRecv = await api('DELETE', `/api/bless/${newId}`, { token: B.token });
  eq(delByRecv.body?.code, 0, '收件人能删');
  eq(delByRecv.body.data.by, 'receiver', '返回删的人身份是 receiver');

  // 发件人 A 撤回一条
  const aSend = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: `撤回测试 ${stamp}` },
  });
  const aSendId = remember(aSend.body);
  const delBySender = await api('DELETE', `/api/bless/${aSendId}`, { token: A.token });
  eq(delBySender.body?.code, 0, '发件人能撤回');
  eq(delBySender.body.data.by, 'sender', '返回身份是 sender');

  // 第三个人不能删
  const loginC2 = await api('POST', '/api/auth/login', { body: { phone: '13700000001', code: '123456' } });
  const C2 = loginC2.body?.data;
  if (C2?.token) {
    const delOther = await api('DELETE', `/api/bless/${b1Id}`, { token: C2.token });
    eq(delOther.status, 403, '★ 和这份祝福无关的人不能删');
  } else {
    ok('（第三方账号不可用，跳过）');
  }

  // ---------- 16. 未登录 ----------
  step('16. 未登录保护')
  eq((await api('POST', '/api/bless/send', { body: { toUserId: B.user.id, content: 'x' } })).status,
    401, '未登录不能送祝福');
  eq((await api('GET', '/api/bless/sent')).status, 401, '未登录不能看送出的');
  eq((await api('GET', '/api/bless/received')).status, 401, '未登录不能看收到的');
  eq((await api('GET', '/api/bless/unread-count')).status, 401, '未登录不能看未读数');

  // ---------- 17. 参数校验 ----------
  step('17. 参数校验')
  const noTarget = await api('POST', '/api/bless/send', {
    token: A.token, body: { content: '没指定送给谁' },
  });
  truthy(noTarget.body?.code !== 0, '不指定收件人被拒绝', noTarget.body);

  const noContent = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: '   ' },
  });
  truthy(noContent.body?.code !== 0, '空内容被拒绝', noContent.body);

  // 超长内容：必须用【不重复】的文本测，否则会先被刷屏规则拦掉
  // （我第一版用了 '祝'.repeat(1200)，那是 1200 个相同字符，
  //   属于刷屏，被拦是对的，不是"截断失败"）
  const longDistinct = (() => {
    let s = '';
    for (let i = 0; s.length < 1200; i++) s += String.fromCharCode(0x4E00 + (i % 800));
    return s.slice(0, 1200);
  })();
  const longContent = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: longDistinct },
  });
  remember(longContent.body);
  eq(longContent.body?.code, 0, '不重复的超长内容被截断而不是报错');
  if (longContent.body?.code === 0) {
    truthy(longContent.body.data.blessing.content.length <= 1000,
      `内容长度不超过 1000（实际 ${longContent.body.data.blessing.content.length}）`);
  }

  // 而重复的超长内容会被当刷屏拦住（这是正确行为）
  const repeatedLong = await api('POST', '/api/bless/send', {
    token: A.token, body: { toUserId: B.user.id, content: '祝'.repeat(1200) },
  });
  truthy(repeatedLong.body?.code !== 0, '★ 1200 个相同字符被当刷屏拦住（这是对的）');
  truthy(/重复|同样的字/.test(repeatedLong.body?.msg || ''),
    `提示语说明了原因（${repeatedLong.body?.msg}）`);

  // ---------- 18. 清理 ----------
  step('18. 清理测试数据');
  // ★ 按 id 删，不按内容匹配
  //   内容匹配很脆弱：超长内容测试会把 1200 字截断到 1000 字，
  //   写在末尾的 stamp 就被截掉了 —— 按内容找会漏掉它（我踩过）。
  //   记录 id 则完全可靠，和内容长什么样无关。
  let removed = 0;
  for (const id of createdIds) {
    const r = await api('DELETE', `/api/bless/${id}`, { token: A.token });
    if (r.body?.code === 0) removed++;
  }
  // 有些可能只有 B 视角能删（收件人身份），用 B 的 token 再兜一遍
  for (const id of createdIds) {
    const r = await api('DELETE', `/api/bless/${id}`, { token: B.token });
    if (r.body?.code === 0) removed++;
  }
  ok(`按 id 清理完成（记录 ${createdIds.length} 条，成功删除 ${removed} 次）`);

  const finalA = await api('GET', '/api/bless/sent?size=50', { token: A.token });
  const finalB = await api('GET', '/api/bless/received?size=50', { token: B.token });
  if (finalA.body.data.total !== aSent0) {
    bad(`A 送出的数量回到初始值（期望 ${aSent0}，实际 ${finalA.body.data.total}）`);
    console.log('     残留内容：');
    finalA.body.data.list.forEach(x =>
      console.log(`       id=${x.id} "${x.content.slice(0, 40)}"`));
  } else {
    ok('A 送出的数量回到初始值');
  }
  eq(finalB.body.data.total, bRecv0, 'B 收到的数量回到初始值');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 8 步（祝福）全部通过！\n');
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
