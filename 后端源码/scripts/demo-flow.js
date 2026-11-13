// ============================================================
//  真实使用流程演示（不是测试，是给你看"到底跑成什么样"）
//
//  用法：  node scripts/demo-flow.js
//
//  它模拟一个人从登录到写完日记的完整动作，每一步都把
//  请求和响应真实打印出来，方便你对照前端页面的表现。
// ============================================================

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const PHONE = '13800138000';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, body: json };
}

function title(n, t, page) {
  console.log('\n' + '═'.repeat(62));
  console.log(`  ${C.b('第 ' + n + ' 步')}  ${t}`);
  if (page) console.log(C.dim(`  对应前端页面：${page}`));
  console.log('═'.repeat(62));
}
function show(label, v) {
  console.log(`  ${C.dim('→')} ${label}`);
  console.log('    ' + C.c(typeof v === 'string' ? v : JSON.stringify(v)));
}

(async () => {
  console.log('\n' + C.b('  「陪着」真实使用流程演示'));
  console.log(C.dim('  后端: ' + BASE));
  console.log(C.dim('  这不是测试，是模拟真人操作，展示每一步的真实数据'));

  // ---------- 0. 服务是否活着 ----------
  title(0, '确认服务器在线', '（所有页面的前置条件）');
  const h = await api('GET', '/api/health');
  show('服务', h.body.data.service);
  show('数据库', h.body.data.db.connected ? C.g('已连接 MySQL ' + h.body.data.db.version) : '未连接');
  show('AI 配置', h.body.data.ai.configured ? '已配置' : C.y('未配置（第 3 步要填 DEEPSEEK_API_KEY）'));

  // ---------- 1. 登录 ----------
  title(1, '手机号登录', 'login.html');
  const send = await api('POST', '/api/auth/send-code', { body: { phone: PHONE } });
  show('发送验证码', send.body.msg);
  if (send.body.data && send.body.data.code) {
    console.log('    ' + C.y(`验证码是 ${send.body.data.code}（开发期返回，方便你测试）`));
  }

  const login = await api('POST', '/api/auth/login', { body: { phone: PHONE, code: '123456' } });
  if (login.body.code !== 0) {
    console.log('  登录失败：' + login.body.msg);
    process.exit(1);
  }
  const TOKEN = login.body.data.token;
  const user = login.body.data.user;
  show('登录结果', login.body.msg);
  show('用户昵称', user.nickname);
  show('对外 ID', user.uid);
  show('token', TOKEN.slice(0, 32) + '...');
  console.log('    ' + C.dim('（前端会把 token 存进 localStorage，下次打开就不用再登）'));

  // ---------- 2. 写今天的日记 ----------
  title(2, '写一篇今天的日记（设为公开）', 'diary-write.html');
  const now = new Date();
  const today = now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
  const text = '演示：今天把后端的日记功能接好了，第一次看到自己写的东西真的存进数据库。';

  show('要写入的日期', today);
  show('要写入的内容', text);

  const save = await api('POST', '/api/diary/save', {
    token: TOKEN,
    body: { date: today, text, img: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=1200', isPublic: true },
  });
  if (save.body.code !== 0) { console.log('  保存失败：' + save.body.msg); process.exit(1); }

  const diary = save.body.data.diary;
  show('保存结果', save.body.data.action === 'created' ? '新建成功' : '更新成功');
  show('日记 id', diary.id);
  show('相对时间', diary.time);
  show('是否公开', diary.isPublic ? '公开' : '私密');
  console.log('    ' + C.dim('（这时候去数据库查 diaries 表就能看到这一行）'));

  // ---------- 3. 日历会显示什么 ----------
  title(3, '日历页会怎么显示', 'diary-mine.html');
  const cal = await api('GET', `/api/diary/calendar?year=${now.getFullYear()}&month=${now.getMonth() + 1}`, { token: TOKEN });
  show('本月写过的日期', cal.body.data.dates);
  console.log('    ' + C.dim(`（前端会把 ${today} 那个格子染成绿色）`));

  // ---------- 4. 重新打开写日记页 ----------
  title(4, '重新打开写日记页（应该回填刚才的内容）', 'diary-write.html');
  const reopen = await api('GET', '/api/diary/date/' + today, { token: TOKEN });
  show('回填的正文', reopen.body.data.diary.text);
  show('回填的配图', reopen.body.data.diary.img.slice(0, 60) + '...');
  console.log('    ' + C.dim('（前端把它填进 textarea，左右按钮也变成"修改"）'));

  // ---------- 5. 发现页 ----------
  title(5, '发现页能看到什么', 'discover.html → GET /api/diary/feed?feed=all');
  const all = await api('GET', '/api/diary/feed?feed=all&size=5');
  show('公开日记总数', all.body.data.total);
  (all.body.data.list || []).slice(0, 3).forEach((d, i) => {
    console.log(`    ${i + 1}. ${C.c(d.nick)}  ${C.dim(d.dateKey + ' · ' + d.time)}`);
    console.log(`       ${d.text.slice(0, 44)}${d.text.length > 44 ? '…' : ''}`);
    console.log(`       ${C.dim('♡ ' + d.likes + '   💬 ' + d.comments + '   👁 ' + d.views)}`);
  });

  // ---------- 6. 别人的视角 ----------
  title(6, '换另一个账号看，验证隐私', 'diary-public.html');
  const loginB = await api('POST', '/api/auth/login', { body: { phone: '13912345678', code: '123456' } });
  const TOKEN_B = loginB.body.data.token;
  show('B 用户', loginB.body.data.user.nickname);

  const bMine = await api('GET', '/api/diary/feed?feed=mine&size=50', { token: TOKEN_B });
  const bHasMyDiary = (bMine.body.data.list || []).some(d => d.id === diary.id);
  show('B 的"我的日记"里有 A 的日记吗', bHasMyDiary ? C.y('有（不正常！）') : C.g('没有（正确）'));

  const bPeek = await api('GET', '/api/diary/' + diary.id, { token: TOKEN_B });
  show('B 能直接打开这篇吗', bPeek.body.code === 0 ? '能（因为是公开的，正确）' : '不能');

  // 把这篇改成私密，再试试
  await api('PATCH', '/api/diary/' + diary.id + '/visibility', { token: TOKEN, body: { isPublic: false } });
  const bPeek2 = await api('GET', '/api/diary/' + diary.id, { token: TOKEN_B });
  show('改成私密后 B 还能打开吗', bPeek2.status === 404 ? C.g('404，打不开了（正确）') : C.y('居然还能打开（不正常！）'));

  // 改回公开
  await api('PATCH', '/api/diary/' + diary.id + '/visibility', { token: TOKEN, body: { isPublic: true } });

  // ---------- 7. 数据库里长什么样 ----------
  title(7, '顺便看看数据库里真实的样子', '（不是接口，是 MySQL 里的行）');
  console.log('    ' + C.dim('在虚拟机上执行这句就能看到：'));
  console.log('    ' + C.c(`mysql -h127.0.0.1 -uroot -p'123456xx' peizhe -e "SELECT id, user_id, date_key, is_public, LEFT(text,30) AS text FROM diaries ORDER BY id DESC LIMIT 5"`));

  // ---------- 收尾 ----------
  console.log('\n' + '═'.repeat(62));
  console.log('  ' + C.g('演示结束'));
  console.log('═'.repeat(62));
  console.log(C.dim(`
  刚才这一串动作，在前端页面上是这样发生的：
    login.html        → 发验证码、登录、把 token 存进 localStorage
    diary-write.html  → 保存时 POST /api/diary/save
    diary-mine.html   → 进页面时 GET /api/diary/calendar
    discover.html     → GET /api/diary/feed?feed=all
    mine.html         → GET /api/auth/me + /api/diary/feed?feed=mine

  你现在可以真的打开这些页面看一眼（在 Windows 浏览器里）：
    file:///D:/Study/Match/2026-2027.up/chat/前端八稿/login.html
`));

  // 清理演示日记，避免污染你的数据
  const del = await api('DELETE', '/api/diary/' + diary.id, { token: TOKEN });
  if (del.body.code === 0) {
    console.log('  ' + C.dim('（演示用的这篇日记已经删掉了，不污染你的数据）\n'));
  }
})().catch(e => {
  console.error('\n演示脚本出错：', e.message);
  process.exit(1);
});
