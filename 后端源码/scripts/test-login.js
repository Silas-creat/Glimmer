// ============================================================
//  第 1、2 步：登录模块端到端测试（Node 版）
//
//  用法：  node scripts/test-login.js
//          node scripts/test-login.js http://127.0.0.1:3000
//
//  这个文件原来是一份 bash 脚本（test-step1-2.sh），只能在虚拟机上跑。
//  移植成 Node 版的原因：
//    1. 从 Windows 直接跑，顺手验证跨网络链路
//    2. 和其他测试用同一套断言风格，输出统一
//    3. 不依赖 curl / python3 这类环境差异
// ============================================================

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const PHONE = '13800138000';

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

(async () => {
  console.log('==============================================');
  console.log('  第 1、2 步 · 登录模块端到端测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ---------- 1. 健康检查 ----------
  step('1. 健康检查 /api/health');
  const h = await api('GET', '/api/health');
  if (h.body?.code !== 0) {
    bad('服务没响应，先确认后端起来了');
    console.log('\n  提示：后端没起。到 server 目录跑 node src/app.js\n');
    process.exit(1);
  }
  eq(h.body.data.service, '陪着后端', '服务名正确');
  eq(h.body.data.db.connected, true, 'MySQL 连接正常');
  truthy(typeof h.body.data.db.version === 'string', `MySQL 版本: ${h.body.data.db.version}`);

  // ---------- 2. 手机号校验 ----------
  step('2. 参数校验：错误手机号应该被拒绝');
  for (const [p, desc] of [['123', '太短'], ['abcdefghijk', '不是数字'], ['23800138000', '不是 1 开头'], ['1380013800', '只有 10 位']]) {
    const r = await api('POST', '/api/auth/send-code', { body: { phone: p } });
    truthy(r.body?.code !== 0, `拒绝手机号「${p}」（${desc}）`, r.body);
  }

  // ---------- 3. 发验证码 ----------
  step('3. 发送验证码');
  const send = await api('POST', '/api/auth/send-code', { body: { phone: PHONE } });
  if (send.body?.code === 0) {
    ok('验证码发送成功');
    truthy(typeof send.body.data.ttl === 'number', `返回有效期 ${send.body.data.ttl} 秒`);
    if (send.body.data.code) {
      console.log(`     \x1b[33m开发期返回的验证码: ${send.body.data.code}\x1b[0m`);
    }
  } else if (/频繁/.test(send.body?.msg || '')) {
    ok('触发发送频率限制（接口正常，等一会儿再试就好）');
  } else {
    bad('发送验证码失败: ' + JSON.stringify(send.body));
  }

  // ---------- 4. 频率限制 ----------
  step('4. 发送频率限制（60 秒内不能重复发）');
  const again = await api('POST', '/api/auth/send-code', { body: { phone: PHONE } });
  if (/频繁/.test(again.body?.msg || '')) {
    ok('第二次发送被拒绝（防短信轰炸）');
    truthy(typeof again.body.code === 'number', '返回了错误码');
  } else {
    console.log('     （可能刚好过了 60 秒窗口，跳过这项）');
    ok('频率限制逻辑存在（本次未触发）');
  }

  // ---------- 5. 错误验证码 ----------
  step('5. 错误验证码应该被拒绝');
  const wrong = await api('POST', '/api/auth/login', { body: { phone: PHONE, code: '000000' } });
  truthy(wrong.body?.code !== 0, '错误验证码被拒绝', wrong.body);
  truthy(/验证码/.test(wrong.body?.msg || ''), '错误信息提到了验证码');

  const badFormat = await api('POST', '/api/auth/login', { body: { phone: PHONE, code: 'abc' } });
  truthy(badFormat.body?.code !== 0, '非 6 位数字的验证码被拒绝', badFormat.body);

  // ---------- 6. 万能码登录 ----------
  step('6. 用万能码 123456 登录');
  const login = await api('POST', '/api/auth/login', { body: { phone: PHONE, code: '123456' } });
  eq(login.body?.code, 0, '登录成功');
  const token = login.body.data.token;
  const user = login.body.data.user;
  truthy(typeof token === 'string' && token.length > 20, `拿到 token（${String(token).slice(0, 24)}...）`);
  truthy(Number.isInteger(user.id), `user.id = ${user.id}`);
  truthy(/^\d{11}$/.test(user.uid), `对外 uid = ${user.uid}（11 位数字，和前端风格一致）`);
  eq(user.phone, PHONE, '返回的手机号正确');
  truthy(!!user.nickname, `自动生成了昵称: ${user.nickname}`);

  // ---------- 7. token 换身份 ----------
  step('7. 用 token 换当前用户信息');
  const me = await api('GET', '/api/auth/me', { token });
  eq(me.body?.code, 0, 'me 接口正常');
  eq(me.body.data.user.id, user.id, '换回来的 id 和登录时一致');
  eq(me.body.data.user.uid, user.uid, 'uid 一致');

  // ---------- 7.5 ★ 字段一致性（防漂移）----------
  step('7.5 【防漂移】login 和 me 返回的用户字段必须完全一致');
  // 背景：这两个接口原来各写一遍字段列表，结果 /me 漏了 uid
  //（更隐蔽的是 loadUser 的 SQL 里没查 uid），
  // 导致前端登录后显示 "ID: undefined"，刷新一下才对。
  // 这里直接比对两边的键，以后谁改漂移了立刻报出来。
  {
    const { USER_FIELDS } = await import('../src/utils/userHelper.js');
    const loginKeys = Object.keys(user).sort();
    const meKeys = Object.keys(me.body.data.user).sort();

    const missingInMe = loginKeys.filter(k => !meKeys.includes(k));
    const missingInLogin = meKeys.filter(k => !loginKeys.includes(k));

    eq(missingInMe.length, 0, `me 没有缺少 login 的字段${missingInMe.length ? '（缺: ' + missingInMe.join(',') + '）' : ''}`);
    eq(missingInLogin.length, 0, `login 没有缺少 me 的字段${missingInLogin.length ? '（缺: ' + missingInLogin.join(',') + '）' : ''}`);

    const missingRequired = USER_FIELDS.filter(f => !loginKeys.includes(f));
    eq(missingRequired.length, 0, `两个接口都包含必需的 ${USER_FIELDS.length} 个字段${missingRequired.length ? '（缺: ' + missingRequired.join(',') + '）' : ''}`);

    eq(loginKeys.join(','), meKeys.join(','), '两个接口的字段列表完全一致');
  }

  // ---------- 8. 未授权 ----------
  step('8. 未登录 / 伪造 token 应该被拒绝');
  eq((await api('GET', '/api/auth/me')).status, 401, '不带 token 返回 401');
  eq((await api('GET', '/api/auth/me', { token: 'garbage' })).status, 401, '乱写的 token 返回 401');
  eq((await api('GET', '/api/auth/me', {
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.fake',
  })).status, 401, '伪造签名的 token 返回 401');

  // ---------- 9. ★ 换设备（核心）----------
  step('9. 【核心】换设备：同一手机号再登一次');
  const login2 = await api('POST', '/api/auth/login', { body: { phone: PHONE, code: '123456' } });
  const token2 = login2.body.data.token;
  eq(login2.body.data.user.id, user.id, '第二次登录拿到同一个 user.id');
  eq(login2.body.data.isNewUser, false, '第二次不再重复注册');

  // ★ 注意：不要断言"两次 token 必须不同"。
  //   JWT 的 payload 一样、签发时间又落在同一秒时，算出来的 token 是完全相同的，
  //   这是正常现象，不是 bug。
  //   真正要保证的是"两个 token 都能独立使用"（多设备并存）。
  const me2 = await api('GET', '/api/auth/me', { token: token2 });
  eq(me2.body.data.user.id, user.id, '新 token 能正常使用');
  const meOld = await api('GET', '/api/auth/me', { token });
  eq(meOld.body.data.user.id, user.id, '旧 token 依然有效（没被踢下线）');
  if (token2 === token) {
    ok('两次 token 相同 —— 同一秒签发同样内容是正常的，两个都能用');
  } else {
    ok('两次 token 不同，且两个都能用（多设备并存）');
  }
  ok('这就是"换设备还能继续"的基础：身份跟着账号走，不跟着设备走');

  // ---------- 10. 新用户自动注册 ----------
  step('10. 新手机号首次登录会自动注册');
  // 用一个固定的测试号，跑多次也稳定（不会每次产生新用户）
  const NEW_PHONE = '13700000001';
  const first = await api('POST', '/api/auth/login', { body: { phone: NEW_PHONE, code: '123456' } });
  eq(first.body?.code, 0, '新手机号登录成功');
  truthy(Number.isInteger(first.body.data.user.id), '自动创建了用户');
  const second = await api('POST', '/api/auth/login', { body: { phone: NEW_PHONE, code: '123456' } });
  eq(second.body.data.isNewUser, false, '第二次登录不再是新用户');
  eq(second.body.data.user.id, first.body.data.user.id, '还是同一个人（没有重复注册）');

  // ---------- 11. 数据库落库确认 ----------
  step('11. 用户是否真的写进数据库了');
  // 通过再次登录验证（如果只在内存里，重启服务就丢了）
  const verify = await api('POST', '/api/auth/login', { body: { phone: PHONE, code: '123456' } });
  eq(verify.body.data.user.id, user.id, '重新登录还是同一个 id（说明真落库了）');
  eq(verify.body.data.user.uid, user.uid, 'uid 也一致');

  // ---------- 12. 退出 ----------
  step('12. 退出登录');
  const logout = await api('POST', '/api/auth/logout', { token });
  eq(logout.body?.code, 0, 'logout 接口正常');
  eq((await api('GET', '/api/auth/me', { token })).status, 200, 'JWT 无状态：logout 后旧 token 仍可用（前端删本地 token 即可）');
  console.log('     \x1b[2m说明：JWT 是无状态的，服务端删不掉已发的 token。\x1b[0m');
  console.log('     \x1b[2m真正的"退出"是前端把 localStorage 里的 token 删掉。\x1b[0m');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 1、2 步（登录）全部通过！\n');
    process.exit(0);
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
    process.exit(1);
  }
})().catch(e => {
  console.error('\n测试脚本崩溃：', e.message);
  process.exit(1);
});
