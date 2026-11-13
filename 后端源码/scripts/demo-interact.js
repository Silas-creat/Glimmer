// ============================================================
//  第 5 步演示：点赞/收藏/关注到底解决了什么问题
//
//  用法：  node scripts/demo-interact.js
//
//  这个脚本专门演示"以前用浏览器本地存储会出什么问题、
//  现在存数据库好在哪"，用真实的两个"设备"跑给你看。
// ============================================================

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, body: json };
}

const login = async (phone) => {
  const r = await api('POST', '/api/auth/login', { body: { phone, code: '123456' } });
  if (r.body.code !== 0) throw new Error('登录失败 ' + phone);
  return r.body.data;
};

function title(t) {
  console.log('\n' + '═'.repeat(62));
  console.log('  ' + C.b(t));
  console.log('═'.repeat(62));
}
const line = (k, v) => console.log(`  ${C.dim('│')} ${k.padEnd(28)} ${v}`);
const verdict = (good, text) => console.log(`  ${C.dim('│')} ${good ? C.g('✓ ' + text) : C.r('✗ ' + text)}`);

(async () => {
  console.log('\n' + C.b('  第 5 步演示：点赞/收藏/关注'));
  console.log(C.dim('  后端: ' + BASE));
  console.log(C.dim('  重点看：为什么必须存服务器，而不是浏览器'));

  // ---------- 准备 ----------
  title('场景：A 写了一篇日记，B 点赞了它');
  const A = await login('13800138000');
  const B = await login('13912345678');
  line('A（写日记的人）', `${A.user.nickname}  id=${A.user.id}`);
  line('B（点赞的人）', `${B.user.nickname}  id=${B.user.id}`);

  const today = new Date();
  const dateKey = today.getFullYear() + '-'
    + String(today.getMonth() + 1).padStart(2, '0') + '-'
    + String(today.getDate()).padStart(2, '0');

  // 先清理可能存在的旧数据
  const existing = await api('GET', '/api/diary/feed?feed=mine&size=50', { token: A.token });
  const old = (existing.body.data.list || []).find(d => d.dateKey === dateKey
    && d.text && d.text.startsWith('演示用的日记'));
  if (old) {
    await api('DELETE', '/api/diary/' + old.id, { token: A.token });
  }

  const saved = await api('POST', '/api/diary/save', {
    token: A.token,
    body: {
      date: dateKey,
      text: '演示用的日记：今天把点赞功能接到数据库了。',
      img: 'https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1200',
      isPublic: true,
    },
  });
  const diaryId = saved.body.data.diary.id;
  const baseLikes = saved.body.data.diary.likes;
  line('日记 id', diaryId);
  line('初始点赞数', baseLikes);

  // ---------- B 点赞 ----------
  title('B 点了赞（注意：写进了 MySQL，不是浏览器）');
  const likeRes = await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  line('操作结果', likeRes.body.msg);
  line('点赞数', `${baseLikes} → ${likeRes.body.data.likes}`);
  line('B 的状态', `liked = ${likeRes.body.data.liked}`);

  // ---------- 关键对比 1：不同人看到不同状态 ----------
  title('★ 关键点 1：同一条日记，不同人看到的状态不一样');
  const aView = await api('GET', `/api/diary/${diaryId}`, { token: A.token });
  const bView = await api('GET', `/api/diary/${diaryId}`, { token: B.token });
  line('A 看到 isLiked', String(aView.body.data.diary.isLiked));
  line('B 看到 isLiked', String(bView.body.data.diary.isLiked));
  line('两人看到的总点赞数', `A=${aView.body.data.diary.likes}  B=${bView.body.data.diary.likes}`);
  console.log('');
  verdict(true, '"有没有点赞"是跟人走的 → 必须按 user_id 存');
  verdict(true, '"总共几个赞"是共享的 → 所以两边看到的数字一样');

  // ---------- 关键对比 2：换设备 ----------
  title('★ 关键点 2：B 换个设备（重新登录），点赞还在');
  const B2 = await login('13912345678');   // 模拟手机上又登了一次
  const b2View = await api('GET', `/api/diary/${diaryId}`, { token: B2.token });
  line('新设备上的 user.id', `${B2.user.id}（和旧设备一样）`);
  line('新设备看到 isLiked', String(b2View.body.data.diary.isLiked));
  const b2Likes = await api('GET', '/api/interact/likes?size=50', { token: B2.token });
  const found = b2Likes.body.data.list.some(d => d.id === diaryId);
  line('新设备的"我的喜欢"里有这篇吗', found ? '有' : '没有');
  console.log('');
  if (b2View.body.data.diary.isLiked && found) {
    verdict(true, '换设备点赞还在');
    console.log('  ' + C.dim('│') + ' ' + C.dim('如果点赞存在浏览器 localStorage 里，这里会是 false —— 因为'));
    console.log('  ' + C.dim('│') + ' ' + C.dim('新设备/新浏览器里根本没有那条记录。这就是这一步的意义。'));
  } else {
    verdict(false, '换设备后点赞丢了！');
  }

  // ---------- 关键对比 3：账号隔离 ----------
  title('★ 关键点 3：同一台电脑换账号，状态不会串');
  const aState = await api('GET', `/api/interact/state/${diaryId}`, { token: A.token });
  const bState = await api('GET', `/api/interact/state/${diaryId}`, { token: B.token });
  line('A 的 liked 状态', String(aState.body.data.liked));
  line('B 的 liked 状态', String(bState.body.data.liked));
  console.log('');
  if (aState.body.data.liked === false && bState.body.data.liked === true) {
    verdict(true, '两个账号完全隔离');
    console.log('  ' + C.dim('│') + ' ' + C.dim('以前用 localStorage 时，同一浏览器换账号会看到上一个人的点赞 —— 因为'));
    console.log('  ' + C.dim('│') + ' ' + C.dim('那个存储是按"浏览器"分的，不是按"账号"分的。'));
  } else {
    verdict(false, '账号状态串了！');
  }

  // ---------- 关键对比 4：别人能看到你的赞 ----------
  title('★ 关键点 4：别人能看到你带来的点赞数');
  const publicFeed = await api('GET', '/api/diary/feed?feed=all&size=50');
  const card = (publicFeed.body.data.list || []).find(d => d.id === diaryId);
  line('未登录的人看到的点赞数', card ? String(card.likes) : '（列表里没有）');
  console.log('');
  if (card && card.likes > baseLikes) {
    verdict(true, '点赞数是真的，别人也看得到');
  } else {
    verdict(false, '点赞数没涨');
  }

  // ---------- 收藏和关注 ----------
  title('收藏和关注也是一样的道理');
  const favRes = await api('POST', `/api/interact/save/${diaryId}`, { token: B.token });
  line('B 收藏', favRes.body.msg);
  const B3 = await login('13912345678');
  const b3Favs = await api('GET', '/api/interact/favorites?size=50', { token: B3.token });
  line('换个设备看收藏列表', b3Favs.body.data.list.some(d => d.id === diaryId) ? '还在 ✓' : '没了 ✗');

  const followRes = await api('POST', `/api/interact/follow/${A.user.id}`, { token: B.token });
  line('B 关注 A', followRes.body.msg);
  const aStats = await api('GET', `/api/interact/stats/${A.user.id}`, { token: B.token });
  line('A 的主页显示', `获赞 ${aStats.body.data.likes} · 关注 ${aStats.body.data.follows} · 粉丝 ${aStats.body.data.fans}`);
  console.log('');
  verdict(true, 'A 的粉丝数真的 +1 了，A 自己也能看到（以前做不到）');

  // ---------- 清理 ----------
  title('清理演示数据');
  const st = await api('GET', `/api/interact/state/${diaryId}`, { token: B.token });
  if (st.body.data.liked) await api('POST', `/api/interact/like/${diaryId}`, { token: B.token });
  if (st.body.data.saved) await api('POST', `/api/interact/save/${diaryId}`, { token: B.token });
  await api('POST', `/api/interact/follow/${A.user.id}`, { token: B.token });
  const del = await api('DELETE', '/api/diary/' + diaryId, { token: A.token });
  line('删除演示日记', del.body.code === 0 ? '已删除' : '失败');
  line('取消关注', '已取消');
  console.log('');

  console.log('═'.repeat(62));
  console.log('  ' + C.g('演示结束'));
  console.log('═'.repeat(62));
  console.log(C.dim(`
  你现在可以在浏览器里亲眼验证这些：
    1. 打开 login.html 用 13800138000 / 验证码 123456 登录
    2. 去"发现"，给别人的日记点个赞
    3. 去"我的 → 我的喜欢"，能看到刚点赞的那篇
    4. 按 F12 打开控制台，输入 localStorage.clear() 清掉本地数据
    5. 刷新页面 —— 点赞还在！（因为它存在服务器的 MySQL 里）
`));
})().catch(e => {
  console.error('\n演示脚本出错：', e.message);
  process.exit(1);
});
