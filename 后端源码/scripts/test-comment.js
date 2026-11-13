// ============================================================
//  第 7 步：评论模块集成测试
//
//  用法：  node scripts/test-comment.js
//
//  覆盖：发评论/回复、两级扁平化、权限、计数、级联删除、
//        内容检测拦截、危机信号的特殊处理
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
  console.log('  第 7 步 · 评论模块集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 准备 ----------
  step('0. 准备三个账号')
  const A = await login('13800138000');
  const B = await login('13912345678');
  const C = await login('13700000001');
  ok(`A(日记作者) = ${A.user.nickname}`);
  ok(`B(评论者)   = ${B.user.nickname}`);
  ok(`C(路人)     = ${C.user.nickname}`);

  // A 写一篇公开日记
  const today = new Date();
  const dateKey = today.getFullYear() + '-'
    + String(today.getMonth() + 1).padStart(2, '0') + '-'
    + String(today.getDate()).padStart(2, '0');

  // 先清掉今天可能残留的
  const oldFeed = await api('GET', '/api/diary/feed?feed=mine&size=50', { token: A.token });
  const old = (oldFeed.body.data.list || []).find(d => d.dateKey === dateKey);
  if (old) await api('DELETE', '/api/diary/' + old.id, { token: A.token });

  const savedDiary = await api('POST', '/api/diary/save', {
    token: A.token,
    body: { date: dateKey, text: '评论测试用的日记', img: 'https://example.com/c.jpg', isPublic: true },
  });
  const diaryId = savedDiary.body.data.diary.id;
  truthy(Number.isInteger(diaryId), `A 写了公开日记 id=${diaryId}`);

  // ---------- 1. 空评论 ----------
  step('1. 初始状态：没有评论')
  const empty = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(empty.body?.code, 0, '能取评论列表');
  eq(empty.body.data.list.length, 0, '列表是空的');
  eq(empty.body.data.total, 0, 'total 是 0');

  // ---------- 2. 发评论 ----------
  step('2. B 发一条评论')
  const c1 = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: '加油，我也有过这样的日子' },
  });
  eq(c1.body?.code, 0, '评论发布成功');
  const c1Id = c1.body.data.comment.id;
  eq(c1.body.data.comment.content, '加油，我也有过这样的日子', '内容正确');
  eq(c1.body.data.comment.nick, B.user.nickname, '带上了评论者昵称');
  eq(c1.body.data.comment.isMine, true, 'B 看自己的评论 isMine=true');
  eq(c1.body.data.commentCount, 1, '★ 日记的评论数变成 1');

  // 计数真的落库了吗
  const diaryAfter = await api('GET', `/api/diary/${diaryId}`, { token: A.token });
  eq(diaryAfter.body.data.diary.comments, 1, '★ 日记详情里的评论数也是 1（真的落库了）');

  // ---------- 3. 列表读取 ----------
  step('3. 读取评论列表')
  const list1 = await api('GET', `/api/comment/diary/${diaryId}`, { token: A.token });
  eq(list1.body.data.list.length, 1, '列表里有 1 条');
  eq(list1.body.data.total, 1, 'total = 1');
  eq(list1.body.data.totalComments, 1, 'totalComments = 1');
  const first = list1.body.data.list[0];
  eq(first.id, c1Id, '就是刚发的那条');
  eq(first.replies.length, 0, '还没有回复');
  eq(first.isMine, false, '★ A 看 B 的评论，isMine=false（状态跟人走）');
  truthy(Boolean(first.time), `带相对时间（${first.time}）`);
  truthy(Boolean(first.avatar !== undefined), '带头像字段');

  // ---------- 4. 回复 ----------
  step('4. A 回复 B 的评论')
  const r1 = await api('POST', '/api/comment', {
    token: A.token, body: { diaryId, content: '谢谢你，看到这句话好多了', parentId: c1Id },
  });
  eq(r1.body?.code, 0, '回复成功');
  const r1Id = r1.body.data.comment.id;
  eq(r1.body.data.comment.parentId, c1Id, 'parentId 指向被回复的评论');
  truthy(Boolean(r1.body.data.comment.replyTo), '★ 带上了"回复谁"的信息');
  eq(r1.body.data.comment.replyTo.nick, B.user.nickname, 'replyTo 是 B');
  eq(r1.body.data.commentCount, 2, '评论数变成 2');

  // ---------- 5. 回复挂在父评论下 ----------
  step('5. 列表结构：回复挂在一级评论下面')
  const list2 = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(list2.body.data.list.length, 1, '一级评论还是 1 条（回复不算一级）');
  eq(list2.body.data.list[0].replies.length, 1, '★ 这条一级评论下有 1 条回复');
  eq(list2.body.data.list[0].replies[0].id, r1Id, '回复的内容对得上');
  eq(list2.body.data.total, 1, 'total 只数一级评论');
  eq(list2.body.data.totalComments, 2, 'totalComments 含回复 = 2');
  ok('一级评论分页、回复全带出 —— 前端一次请求就能显示完整');

  // ---------- 6. ★ 两级扁平化 ----------
  step('6. ★ 回复的回复应该挂到顶层，不会越嵌越深');
  const r2 = await api('POST', '/api/comment', {
    token: C.token, body: { diaryId, content: '我也想说一句', parentId: r1Id },
  });
  eq(r2.body?.code, 0, 'C 回复了"回复"');
  eq(r2.body.data.comment.parentId, c1Id,
    '★ 挂到了顶层父评论上（不是挂到那条回复上）—— 只保留两级');

  const list3 = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(list3.body.data.list.length, 1, '一级评论仍然只有 1 条');
  eq(list3.body.data.list[0].replies.length, 2, '两条回复都挂在同一条一级评论下');
  ok('手机上两列结构就够看了，不会出现无限缩进');

  // ---------- 7. 多条一级评论 ----------
  step('7. 再发几条一级评论，看排序');
  const c2 = await api('POST', '/api/comment', {
    token: C.token, body: { diaryId, content: '第一条一级评论' },
  });
  const c3 = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: '第二条一级评论' },
  });
  const c2Id = c2.body.data.comment.id;
  const c3Id = c3.body.data.comment.id;
  ok(`C 发了评论 id=${c2Id}，B 发了评论 id=${c3Id}`);

  const list4 = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(list4.body.data.list.length, 3, '现在有 3 条一级评论');
  eq(list4.body.data.list[0].id, c3Id, '★ 最新的排最前面（倒序）');
  eq(list4.body.data.list[2].id, c1Id, '最早的排最后');
  eq(list4.body.data.totalComments, 5, '含回复共 5 条');

  // ---------- 8. 内容检测 ----------
  step('8. 违规内容被拦截');
  const ad = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: '加我微信 abc12345 有好事' },
  });
  truthy(ad.body?.code !== 0, '★ 广告导流被拦住', ad.body);
  truthy(/联系方式/.test(ad.body?.msg || ''), `提示语可读（${ad.body?.msg}）`);

  const abuse = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: '你这个废物' },
  });
  truthy(abuse.body?.code !== 0, '人身攻击被拦住', abuse.body);
  truthy(/善语/.test(abuse.body?.msg || ''), `提示语温和（${abuse.body?.msg}）`);

  const spam = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: 'a'.repeat(30) },
  });
  truthy(spam.body?.code !== 0, '刷屏被拦住', spam.body);

  // 被拦的内容不该进数据库
  const listAfterBlock = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(listAfterBlock.body.data.totalComments, 5, '★ 被拦的评论没有进数据库（数量没变）');

  // ---------- 9. ★ 危机信号特殊处理 ----------
  step('9. ★ 危机信号：不拦截，但返回关怀提示');
  const crisis = await api('POST', '/api/comment', {
    token: C.token, body: { diaryId, content: '最近真的撑不下去了' },
  });
  eq(crisis.body?.code, 0, '★ 危机信号没有被拒绝（这一点很重要）');
  truthy(Boolean(crisis.body.data.care), '★ 返回了 care 关怀提示');
  truthy(Array.isArray(crisis.body.data.care.lines), 'care 里带了求助热线列表');
  truthy(crisis.body.data.care.lines.length > 0, `共 ${crisis.body.data.care.lines.length} 条热线`);
  console.log(`     \x1b[2m提示语：${crisis.body.data.care.message.slice(0, 40)}...\x1b[0m`);
  crisis.body.data.care.lines.forEach(l => {
    console.log(`     \x1b[2m  ${l.name}: ${l.phone}\x1b[0m`);
  });
  ok('删掉一个人的求救信号是最糟的处理 —— 这里选择了接住他');

  // ---------- 10. 参数校验 ----------
  step('10. 参数校验');
  const noContent = await api('POST', '/api/comment', { token: B.token, body: { diaryId, content: '  ' } });
  truthy(noContent.body?.code !== 0, '空内容被拒绝', noContent.body);

  const noDiary = await api('POST', '/api/comment', { token: B.token, body: { content: '没有日记ID' } });
  truthy(noDiary.body?.code !== 0, '不带 diaryId 被拒绝', noDiary.body);

  const ghostDiary = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId: 99999999, content: '给不存在的日记评论' },
  });
  eq(ghostDiary.status, 404, '给不存在的日记评论返回 404');

  const ghostParent = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: '回复不存在的评论', parentId: 99999999 },
  });
  eq(ghostParent.status, 404, '回复不存在的评论返回 404');

  // 超长内容：必须用【不重复】的文本测，否则会先被刷屏规则拦掉
  // （我第一版用了 '很'.repeat(600)，那是 600 个相同字符，
  //   属于刷屏，被拦是对的，不是"截断失败"）
  const longDistinct = (() => {
    let s = '';
    for (let i = 0; s.length < 600; i++) s += String.fromCharCode(0x4E00 + (i % 500));
    return s.slice(0, 600);
  })();
  const longContent = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: longDistinct },
  });
  eq(longContent.body?.code, 0, '不重复的超长内容被截断而不是报错');
  if (longContent.body?.code === 0) {
    truthy(longContent.body.data.comment.content.length <= 500,
      `内容长度不超过 500（实际 ${longContent.body.data.comment.content.length}）`);
  }

  // 而重复的超长内容应该被当刷屏拦住（这是正确行为）
  const repeated = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId, content: '很'.repeat(600) },
  });
  truthy(repeated.body?.code !== 0, '★ 600 个相同字符被当刷屏拦住（这是对的）');
  truthy(/重复|同样的字/.test(repeated.body?.msg || ''), `提示语说明了原因（${repeated.body?.msg}）`);

  // ---------- 11. 私密日记的评论权限 ----------
  step('11. 私密日记：别人看不到，也评论不了');
  // A 写一篇私密日记
  const priv = await api('POST', '/api/diary/save', {
    token: A.token,
    body: { date: '2026-12-15', text: '这是私密日记', isPublic: false },
  });
  const privId = priv.body.data.diary.id;

  const peekComments = await api('GET', `/api/comment/diary/${privId}`, { token: B.token });
  eq(peekComments.status, 404, 'B 看不到私密日记的评论（404）');

  const commentPriv = await api('POST', '/api/comment', {
    token: B.token, body: { diaryId: privId, content: '我来评论' },
  });
  eq(commentPriv.status, 404, 'B 不能评论私密日记（404）');

  const ownPriv = await api('GET', `/api/comment/diary/${privId}`, { token: A.token });
  eq(ownPriv.body?.code, 0, '★ A 自己能看自己私密日记的评论');

  const ownComment = await api('POST', '/api/comment', {
    token: A.token, body: { diaryId: privId, content: '自己给自己留言' },
  });
  eq(ownComment.body?.code, 0, '★ 作者可以给自己的私密日记写评论');

  // ---------- 12. 删评论 ----------
  step('12. 删评论和级联');
  // ★ 先问一下当前总数，不要硬编码期望值 ——
  //   我第一版写死"期望 4"，但实际此时已经有 6 条
  //   （c1 + r1(A的回复) + r2(C的回复) + c2 + c3 + 危机信号那条），
  //   算错一次就浪费了一轮排查。动态取值最稳。
  const beforeDelete = await api('GET', `/api/comment/diary/${diaryId}`);
  const countBefore = beforeDelete.body.data.totalComments;
  ok(`删除前日记共有 ${countBefore} 条评论`);

  // A 删掉自己发的那条回复（r1Id）
  const delOwn = await api('DELETE', `/api/comment/${r1Id}`, { token: A.token });
  eq(delOwn.body?.code, 0, 'A 删掉自己发的那条回复');
  eq(delOwn.body.data.commentCount, countBefore - 1, `★ 计数正确扣减（${countBefore} → ${countBefore - 1}）`);
  const afterDelReply = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(afterDelReply.body.data.totalComments, countBefore - 1, '详情里的评论数也一致');

  // 越权删除：C 想删 B 发的评论
  const delOther = await api('DELETE', `/api/comment/${c3Id}`, { token: C.token });
  eq(delOther.status, 403, '★ C 不能删 B 的评论（403）');

  // ★ 删一级评论要连回复一起删
  const listBefore = await api('GET', `/api/comment/diary/${diaryId}`);
  const topWithReplies = listBefore.body.data.list.find(c => c.replies.length > 0);
  if (topWithReplies) {
    const replyCount = topWithReplies.replies.length;
    const totalBefore = listBefore.body.data.totalComments;
    const del = await api('DELETE', `/api/comment/${topWithReplies.id}`, { token: A.token });
    eq(del.body?.code, 0, `删除带 ${replyCount} 条回复的一级评论`);
    eq(del.body.data.commentCount, totalBefore - 1 - replyCount,
      `★ 计数正确扣减（1 条主评论 + ${replyCount} 条回复）`);

    const afterDel = await api('GET', `/api/comment/diary/${diaryId}`);
    truthy(!afterDel.body.data.list.some(c => c.id === topWithReplies.id), '那条评论没了');
    eq(afterDel.body.data.totalComments, totalBefore - 1 - replyCount, '详情里的评论数一致');
    ok('不会出现"评论数 5 但只看得到 1 条"的诡异现象');
  } else {
    bad('没找到带回复的评论，无法测试级联删除');
  }

  // 重复删除
  const delAgain = await api('DELETE', `/api/comment/${c1Id}`, { token: A.token });
  truthy(delAgain.status === 200 || delAgain.status === 404, '重复删除不会 500');

  // ---------- 13. 未登录 ----------
  step('13. 未登录不能评论');
  const anon = await api('POST', '/api/comment', { body: { diaryId, content: '匿名评论' } });
  eq(anon.status, 401, '未登录发评论返回 401');
  const anonDel = await api('DELETE', `/api/comment/1`);
  eq(anonDel.status, 401, '未登录删评论返回 401');
  const anonList = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(anonList.body?.code, 0, '★ 未登录可以看评论（浏览不需要登录）');

  // ---------- 14. 我发过的评论 ----------
  step('14. 我发过的评论');
  const mine = await api('GET', '/api/comment/mine', { token: C.token });
  eq(mine.body?.code, 0, '能取到我发过的评论');
  truthy(mine.body.data.list.length > 0, `C 发过 ${mine.body.data.list.length} 条评论`);
  const oneMine = mine.body.data.list[0];
  truthy('diaryId' in oneMine, '带日记 id（能点进去）');
  truthy('diaryText' in oneMine, '带日记摘要');
  truthy('isReply' in oneMine, '标记了是评论还是回复');

  // ---------- 15. 改评论 ----------
  step('15. 改评论');
  const toEdit = (await api('GET', '/api/comment/mine', { token: B.token })).body.data.list[0];
  if (toEdit) {
    const edited = await api('PATCH', `/api/comment/${toEdit.id}`, {
      token: B.token, body: { content: '改过的内容' },
    });
    eq(edited.body?.code, 0, 'B 能改自己的评论');
    eq(edited.body.data.comment.content, '改过的内容', '内容确实变了');
    const editOther = await api('PATCH', `/api/comment/${toEdit.id}`, {
      token: C.token, body: { content: '我要改别人的' },
    });
    eq(editOther.status, 403, '★ C 不能改 B 的评论（403）');
  } else {
    bad('B 没有可改的评论，跳过');
  }

  // ---------- 16. 清理 ----------
  step('16. 清理测试数据');
  const delPriv = await api('DELETE', '/api/diary/' + privId, { token: A.token });
  eq(delPriv.body?.code, 0, '删除私密测试日记（评论会被级联删掉）');

  const delPub = await api('DELETE', '/api/diary/' + diaryId, { token: A.token });
  eq(delPub.body?.code, 0, '删除公开测试日记');

  const finalCheck = await api('GET', `/api/comment/diary/${diaryId}`);
  eq(finalCheck.status, 404, '日记删了，评论也访问不到了');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 7 步（评论）全部通过！\n');
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
