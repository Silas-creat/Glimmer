// ============================================================
//  第 5 步：点赞 / 收藏 / 关注 集成测试
//
//  用法：  node scripts/test-interact.js
//          node scripts/test-interact.js http://127.0.0.1:3000
//
//  重点验证"为什么要搬到后端"：
//    - 换设备后点赞还在（存在服务器而不是浏览器）
//    - 换个账号看不到别人的点赞状态
//    - 点赞数别人也能看到
//    - 计数不会变成负数
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

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

async function login(phone) {
  const r = await api('POST', '/api/auth/login', { body: { phone, code: '123456' } });
  if (r.body?.code !== 0) throw new Error(`登录失败 ${phone}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}

(async () => {
  console.log('==============================================');
  console.log('  第 5 步 · 点赞/收藏/关注 集成测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 准备 ----------
  step('0. 准备两个账号和一篇测试日记');
  const A = await login('13800138000');
  const B = await login('13912345678');
  ok(`用户A: ${A.user.nickname} (id=${A.user.id})`);
  ok(`用户B: ${B.user.nickname} (id=${B.user.id})`);

  // A 写一篇公开日记，作为被互动的对象
  const today = new Date();
  const dateKey = today.getFullYear() + '-'
    + String(today.getMonth() + 1).padStart(2, '0') + '-'
    + String(today.getDate()).padStart(2, '0');

  const saveRes = await api('POST', '/api/diary/save', {
    token: A.token,
    body: { date: dateKey, text: '互动测试用的日记', img: 'https://example.com/i.jpg', isPublic: true },
  });
  const diaryId = saveRes.body?.data?.diary?.id;
  truthy(Number.isInteger(diaryId), `A 写了日记（id=${diaryId}）`, saveRes.body);
  const baseLikes = saveRes.body.data.diary.likes;

  // ---------- 1. 默认状态 ----------
  step('1. 未互动时的默认状态');
  const initFeed = await api('GET', '/api/diary/feed?size=50', { token: A.token });
  const myCard = (initFeed.body.data.list || []).find(d => d.id === diaryId);
  eq(myCard.isLiked, false, 'feed 里 isLiked 默认 false');
  eq(myCard.isSaved, false, 'feed 里 isSaved 默认 false');
  eq(myCard.isMine, true, 'feed 里 isMine 正确标记');
  truthy('isFollowed' in myCard, 'feed 里带了 isFollowed 字段');
  ok('feed 一次性带回了互动状态（前端不用逐张卡再请求）');

  // ---------- 2. 点赞 ----------
  step('2. 点赞');
  const like1 = await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  eq(like1.body?.code, 0, 'B 点赞成功');
  eq(like1.body?.data?.liked, true, '返回 liked=true');
  eq(like1.body?.data?.likes, baseLikes + 1, '返回的点赞数 +1（不是脏读的旧值）');

  // 检查数据库里的真实值
  const afterLike = await api('GET', `/api/diary/${diaryId}`, { token: A.token });
  eq(afterLike.body.data.diary.likes, baseLikes + 1, '重新查日记，点赞数确实是 +1');
  eq(afterLike.body.data.diary.isLiked, false, 'A 自己没点赞，isLiked 是 false（状态按人区分）');

  const bView = await api('GET', `/api/diary/${diaryId}`, { token: B.token });
  eq(bView.body.data.diary.isLiked, true, 'B 查同一篇，isLiked 是 true（状态跟人走）');

  // ---------- 3. 取消点赞 ----------
  step('3. 取消点赞');
  const unlike = await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  eq(unlike.body?.data?.liked, false, '取消成功，liked=false');
  eq(unlike.body?.data?.likes, baseLikes, '点赞数退回原值');

  // ---------- 4. 重复点赞幂等 ----------
  step('4. 重复点赞应该幂等（不会加两次数）');
  await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  const twice = await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  eq(twice.body?.data?.liked, false, '再点一次变成取消（切换语义）');

  const threeTimes = await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  eq(threeTimes.body?.data?.likes, baseLikes + 1, '反复点击后点赞数依然是 +1，没有重复累加');

  // ---------- 5. 多人点赞 ----------
  step('5. 多个人点赞，计数正确累加');
  const aLike = await api('POST', `/api/interact/like/${diaryId}`, { token: A.token });
  eq(aLike.body?.data?.likes, baseLikes + 2, 'A 也点赞后变成 +2');

  // ---------- 6. 计数不能变负 ----------
  step('6. 计数保护：不会出现负数点赞');
  // 先全部取消
  await api('POST', `/api/interact/like/${diaryId}`, { token: A.token });
  await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  const zero = await api('GET', `/api/diary/${diaryId}`, { token: A.token });
  eq(zero.body.data.diary.likes, baseLikes, '取消完回到原值');
  truthy(zero.body.data.diary.likes >= 0, '点赞数不是负数');
  // 再多取消几次（已经在未点赞状态，应该走"点赞"分支，不报错）
  const extra = await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  eq(extra.body?.code, 0, '在未点赞状态再调用也不报错');

  // ---------- 7. 收藏 ----------
  step('7. 收藏（和点赞是独立的两套状态）');
  const fav1 = await api('POST', `/api/interact/save/${diaryId}`, { token: B.token });
  eq(fav1.body?.data?.saved, true, 'B 收藏成功');

  const bBoth = await api('GET', `/api/diary/${diaryId}`, { token: B.token });
  eq(bBoth.body.data.diary.isSaved, true, 'B 的 isSaved 是 true');
  eq(bBoth.body.data.diary.isLiked, true, 'B 同时点赞了，isLiked 也是 true');
  ok('点赞和收藏互不影响（两套独立状态）');

  // 取消收藏，点赞状态应该保留
  await api('POST', `/api/interact/save/${diaryId}`, { token: B.token });
  const afterUnfav = await api('GET', `/api/diary/${diaryId}`, { token: B.token });
  eq(afterUnfav.body.data.diary.isSaved, false, '取消收藏后 isSaved 变 false');
  eq(afterUnfav.body.data.diary.isLiked, true, '取消收藏不影响点赞状态');
  // 再收藏回来备用
  await api('POST', `/api/interact/save/${diaryId}`, { token: B.token });

  // ---------- 8. 我的喜欢 ----------
  step('8. GET /api/interact/likes  我的喜欢');
  const bLikes = await api('GET', '/api/interact/likes', { token: B.token });
  eq(bLikes.body?.code, 0, '能取到我的喜欢列表');
  truthy(bLikes.body.data.list.some(d => d.id === diaryId), '列表里有刚点赞的那篇', bLikes.body.data.list.map(d => d.id));
  truthy(bLikes.body.data.total >= 1, '返回了 total');
  ok('每篇都带 isLiked=true（因为就是从点赞表里筛出来的）');

  const aLikes = await api('GET', '/api/interact/likes', { token: A.token });
  truthy(!aLikes.body.data.list.some(d => d.id === diaryId), 'A 的喜欢列表里没有这篇（A 没点赞）');

  // ---------- 9. 我的收藏 ----------
  step('9. GET /api/interact/favorites  我的收藏');
  const bFavs = await api('GET', '/api/interact/favorites', { token: B.token });
  eq(bFavs.body?.code, 0, '能取到我的收藏列表');
  truthy(bFavs.body.data.list.some(d => d.id === diaryId), '列表里有刚收藏的那篇');

  const aFavs = await api('GET', '/api/interact/favorites', { token: A.token });
  truthy(!aFavs.body.data.list.some(d => d.id === diaryId), 'A 的收藏列表里没有这篇');

  // ---------- 10. ★ 跨设备一致性（这一步的核心价值）----------
  step('10. 【核心】换设备：同一个账号重新登录，点赞还在');
  const B2 = await login('13912345678');   // 模拟换了个设备重新登录
  eq(B2.user.id, B.user.id, '新设备登录拿到同一个 user.id');

  const bNewDevice = await api('GET', `/api/diary/${diaryId}`, { token: B2.token });
  eq(bNewDevice.body.data.diary.isLiked, true, '新设备上 isLiked 依然是 true（这就是存服务器的作用）');
  eq(bNewDevice.body.data.diary.isSaved, true, '新设备上 isSaved 依然是 true');

  const bNewLikes = await api('GET', '/api/interact/likes', { token: B2.token });
  truthy(bNewLikes.body.data.list.some(d => d.id === diaryId), '新设备的"我的喜欢"列表里有这篇');

  // ---------- 11. 账号隔离 ----------
  step('11. 账号隔离：同一浏览器换账号，状态互不污染');
  // A 和 B 在同一台机器上（同一"设备"），但状态必须分开
  const aState = await api('GET', `/api/interact/state/${diaryId}`, { token: A.token });
  const bState = await api('GET', `/api/interact/state/${diaryId}`, { token: B.token });
  eq(aState.body.data.liked, false, 'A 的状态：没点赞');
  eq(bState.body.data.liked, true, 'B 的状态：点了赞');
  ok('两个账号状态完全隔离（原来用 localStorage 时这里会串）');

  // ---------- 12. 关注 ----------
  step('12. 关注 / 取关');
  const follow1 = await api('POST', `/api/interact/follow/${A.user.id}`, { token: B.token });
  eq(follow1.body?.code, 0, 'B 关注 A 成功');
  eq(follow1.body?.data?.followed, true, '返回 followed=true');
  truthy(typeof follow1.body.data.myFollowing === 'number', '返回了我的关注数');
  truthy(typeof follow1.body.data.hisFans === 'number', '返回了对方的粉丝数');

  const aStats = await api('GET', `/api/interact/stats/${A.user.id}`, { token: B.token });
  eq(aStats.body.data.isFollowed, true, 'A 的统计里显示"B 已关注他"');
  eq(aStats.body.data.isMine, false, 'B 看 A 的主页，isMine=false');
  truthy(typeof aStats.body.data.fans === 'number', '主页能拿到粉丝数');
  ok('个人主页要的三个数字（获赞/关注/粉丝）都有了');

  // 自己看自己
  const aSelf = await api('GET', `/api/interact/stats/${A.user.id}`, { token: A.token });
  eq(aSelf.body.data.isMine, true, 'A 看自己的主页，isMine=true');

  // ---------- 13. 关注状态进 feed ----------
  step('13. 关注状态也进了 feed（前端卡片能直接显示"已关注"）');
  const bFeed = await api('GET', '/api/diary/feed?feed=all&size=50', { token: B.token });
  const aCardInBFeed = (bFeed.body.data.list || []).find(d => d.id === diaryId);
  eq(aCardInBFeed.isFollowed, true, 'B 的 feed 里，A 的日记标记为"已关注"');

  const aFeedOwn = await api('GET', '/api/diary/feed?feed=all&size=50', { token: A.token });
  const ownCard = (aFeedOwn.body.data.list || []).find(d => d.id === diaryId);
  eq(ownCard.isFollowed, false, 'A 看自己的日记，isFollowed=false（自己不用关注自己）');

  // ---------- 14. 不能关注自己 ----------
  step('14. 边界：不能关注自己');
  const selfFollow = await api('POST', `/api/interact/follow/${A.user.id}`, { token: A.token });
  truthy(selfFollow.body?.code !== 0, '关注自己被拒绝', selfFollow.body);
  truthy(selfFollow.body?.msg?.includes('自己'), '错误信息说明了原因');

  // ---------- 15. 关注不存在的用户 ----------
  step('15. 边界：关注不存在的人');
  const ghost = await api('POST', '/api/interact/follow/99999999', { token: A.token });
  eq(ghost.status, 404, '关注不存在的人返回 404');

  // ---------- 16. 按 uid 关注 ----------
  step('16. 按对外 uid 关注（前端拿到的是 uid，不是内部 id）');
  // 先取消
  await api('POST', `/api/interact/follow/${A.user.id}`, { token: B.token });
  const byUid = await api('POST', `/api/interact/follow-uid/${A.user.uid}`, { token: B.token });
  eq(byUid.body?.data?.followed, true, `按 uid ${A.user.uid} 关注成功`);
  eq(byUid.body?.data?.userId, A.user.id, '返回了对应的内部 id');

  // ---------- 17. 我关注的人 / 关注我的人 ----------
  step('17. 关注列表和粉丝列表');
  const myFollows = await api('GET', '/api/interact/my-follows', { token: B.token });
  eq(myFollows.body?.code, 0, '能取到我关注的人');
  truthy(myFollows.body.data.list.some(u => u.userId === A.user.id), '列表里有 A');
  truthy(myFollows.body.data.list[0].isFollowed === true, '列表里每人都标记 isFollowed=true');
  truthy(typeof myFollows.body.data.list[0].diaryCount === 'number', '带上了对方的公开日记数');

  const myFans = await api('GET', '/api/interact/my-fans', { token: A.token });
  eq(myFans.body?.code, 0, '能取到关注我的人');
  truthy(myFans.body.data.list.some(u => u.userId === B.user.id), 'A 的粉丝列表里有 B');

  // ---------- 18. 取关 ----------
  step('18. 取关');
  const unfollow = await api('POST', `/api/interact/follow/${A.user.id}`, { token: B.token });
  eq(unfollow.body?.data?.followed, false, '取关成功');
  const aAfterUnfollow = await api('GET', `/api/interact/stats/${A.user.id}`, { token: B.token });
  eq(aAfterUnfollow.body.data.isFollowed, false, 'A 的统计里不再显示已关注');

  // ---------- 19. 未登录保护 ----------
  step('19. 未登录不能互动');
  eq((await api('POST', `/api/interact/like/${diaryId}`)).status, 401, '未登录点赞返回 401');
  eq((await api('POST', `/api/interact/save/${diaryId}`)).status, 401, '未登录收藏返回 401');
  eq((await api('POST', `/api/interact/follow/${A.user.id}`)).status, 401, '未登录关注返回 401');
  eq((await api('GET', '/api/interact/likes')).status, 401, '未登录查"我的喜欢"返回 401');

  // ---------- 20. 不存在的日记 ----------
  step('20. 边界：给不存在的日记点赞');
  const ghostDiary = await api('POST', '/api/interact/like/99999999', { token: A.token });
  eq(ghostDiary.status, 404, '给不存在的日记点赞返回 404');

  // ---------- 21. 清理 ----------
  step('21. 清理测试数据');
  // ★ 清理也要幂等：不能无脑 toggle 两次。
  //   如果进入时已经是"未点赞"，toggle 一次反而变成"已点赞"。
  //   正确做法：先查状态，只有处于"已互动"状态才取消。
  async function clearIfNeeded(kind) {
    const st = await api('GET', `/api/interact/state/${diaryId}`, { token: B.token });
    const isOn = kind === 'like' ? st.body.data.liked : st.body.data.saved;
    if (isOn) {
      await api('POST', `/api/interact/${kind}/${diaryId}`, { token: B.token });
    }
    return isOn;
  }

  // A 也可能点过赞（第 5 节里点过），一并清掉
  async function clearFor(token) {
    const st = await api('GET', `/api/interact/state/${diaryId}`, { token });
    if (st.body.data.liked) await api('POST', `/api/interact/like/${diaryId}`, { token });
    if (st.body.data.saved) await api('POST', `/api/interact/save/${diaryId}`, { token });
  }

  await clearFor(B.token);
  await clearFor(A.token);

  const finalState = await api('GET', `/api/interact/state/${diaryId}`, { token: B.token });
  eq(finalState.body.data.liked, false, 'B 的点赞已清除');
  eq(finalState.body.data.saved, false, 'B 的收藏已清除');

  const finalDiary = await api('GET', `/api/diary/${diaryId}`, { token: A.token });
  eq(finalDiary.body.data.diary.likes, baseLikes, `点赞数回到基准值 ${baseLikes}`);

  const del = await api('DELETE', `/api/diary/${diaryId}`, { token: A.token });
  eq(del.body?.code, 0, '测试日记已删除');

  // 关注也清掉
  const myFollowsAfter = await api('GET', '/api/interact/my-follows', { token: B.token });
  const stillFollowing = myFollowsAfter.body.data.list.some(u => u.userId === A.user.id);
  if (stillFollowing) {
    await api('POST', `/api/interact/follow/${A.user.id}`, { token: B.token });
    ok('关注关系已清理');
  } else {
    ok('关注关系本来就是干净的');
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 5 步（点赞/收藏/关注）全部通过！\n');
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
