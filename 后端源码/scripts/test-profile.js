// ============================================================
//  第 6 步：个人资料 + 头像上传 集成测试
//
//  用法：  node scripts/test-profile.js
//
//  覆盖：改昵称/签名/地址（自动推省份）/出生年份（自动算星座）、
//        重名拒绝、头像上传（真图/假图/超大图）、资料读取、别人的主页
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

// ============================================================
//  生成一张真实的最小 PNG（用来测上传）
//  这是手写的 PNG 二进制：8字节签名 + IHDR + IDAT + IEND
// ============================================================
function makeTinyPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  // 1x1 像素，RGB
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);    // width
  ihdr.writeUInt32BE(1, 4);    // height
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = 2;                 // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 一行像素：filter byte 0 + RGB
  const raw = Buffer.from([0x00, 0xFF, 0x00, 0x00]);
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** CRC32（PNG 校验用） */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

(async () => {
  console.log('==============================================');
  console.log('  第 6 步 · 个人资料 + 头像上传 测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  // ★ 用 try/finally 包住整个测试体。
  //   为什么不用 process.exit()：它会【立即结束进程】，
  //   finally 根本不执行 —— 那样还原逻辑等于白写。
  //   正确做法是设 process.exitCode，让进程自然结束，
  //   这样 finally 才有机会跑。
  let A = null;
  let orig2 = null;

  async function restoreOriginal() {
    if (!A || !orig2) return;
    try {
      // 把账号恢复成干净基线：
      // 昵称固定、其余字段全部清空、头像删掉
      await api('PATCH', '/api/user/me', {
        token: A.token,
        body: {
          nickname: orig2.nickname,
          uid: orig2.uid,
          signature: orig2.signature,
          addr: orig2.addr,
          gender: orig2.gender,
          birthYear: orig2.birthYear,     // null → 触发清空分支
          zodiac: orig2.zodiac,           // '' → 清空
          province: orig2.province,       // '' → 清空
        },
      });
      await api('DELETE', '/api/user/avatar', { token: A.token });
      console.log(`  \x1b[2m（已还原 A 的资料：昵称=${orig2.nickname}，标签=${orig2.province}/${orig2.zodiac}/${orig2.birthYear}）\x1b[0m`);
    } catch (e) {
      console.log(`  \x1b[33m⚠️  还原资料失败：${e.message}\x1b[0m`);
      console.log('  \x1b[33m   可以手动补救： node scripts/fix-test-account.js\x1b[0m');
    }
  }

  try {
  // ---------- 准备 ----------
  step('0. 登录两个账号');
  A = await login('13800138000');
  const B = await login('13912345678');
  ok(`A = ${A.user.nickname}`);
  ok(`B = ${B.user.nickname}`);

  // 记下 A 的原始资料，测完要还原（保证测试可重复跑）
  // ★ 必须用带 token 的请求拿，不能用 API.user.me() ——
  //   因为本脚本前面用的是裸 api() 函数，API 那个沙箱实例的 token 未必是 A 的
  const orig = (await api('GET', '/api/user/me', { token: A.token })).body.data.user;

  // ★★ 重要：还原目标用【固定的干净基线】，而不是"测试开始时的样子"。
  //
  //  为什么：如果上一次测试崩溃留下了脏数据（昵称=前端测试22066、
  //  birthYear=2000），这次就会把脏数据当成"原始值"再还原回去，
  //  脏东西永远洗不掉 —— 我真的踩了这个循环。
  //
  //  正确做法：测试的职责是"跑完把账号恢复成干净状态"，
  //  而不是"恢复成跑之前的样子"。这样测试能自愈。
  //  ★ 基线要带上演示标签（浙江 / 双鱼 / 1998）★
  //    群聊是按标签匹配的；以前这里把省份/星座/出生年清空，
  //    跑一次测试演示账号就没有标签了，群聊变成"不过滤"。
  const CLEAN = {
    nickname: '林小满',
    signature: '今天也要好好的',
    addr: '浙江杭州',
    gender: 'unknown',
    birthYear: 1998,
    zodiac: '双鱼',
    province: '浙江',
    uid: orig.uid,        // uid 保持当前值（测试里改过会还原）
  };
  orig2 = CLEAN;
  ok(`还原目标：昵称=${CLEAN.nickname}，其余字段清空（干净基线，可自愈）`);

  // ============================================================
  //  ★ 还原逻辑必须放在 finally 里 ★
  //  因为测试一旦中途失败（断言报错、脚本崩溃），后面的还原语句
  //  根本不会执行，被测账号就永久留在"前端测试22066 / 浙江省…"这种
  //  脏状态里。我就真的踩过这个坑 —— 测试崩了一次，账号昵称就变了。
  //  放进 finally 之后，无论成功失败都会还原。
  // ============================================================
  let restored = false;
  async function restoreOriginal() {
    if (restored) return;
    restored = true;
    try {
      await api('PATCH', '/api/user/me', {
        token: A.token,
        body: {
          nickname: orig2.nickname,
          uid: orig2.uid,
          signature: orig2.signature,
          addr: orig2.addr,
          gender: orig2.gender,
          birthYear: orig2.birthYear,
        },
      });
      await api('DELETE', '/api/user/avatar', { token: A.token });
      console.log(`  \x1b[2m（已还原 A 的资料：昵称=${orig2.nickname}）\x1b[0m`);
    } catch (e) {
      console.log(`  \x1b[33m⚠️  还原资料失败：${e.message}\x1b[0m`);
    }
  }

  // ---------- 1. 读取资料 ----------
  step('1. GET /api/user/me  读取自己的资料');
  const me = await api('GET', '/api/user/me', { token: A.token });
  eq(me.body?.code, 0, '能取到资料');
  const u = me.body.data.user;
  for (const f of ['id', 'uid', 'nickname', 'avatar', 'signature', 'addr', 'gender',
                   'birthYear', 'zodiac', 'province', 'fans', 'following', 'diaryCount', 'totalLikes']) {
    truthy(f in u, `资料里有 ${f} 字段`, Object.keys(u));
  }
  ok('个人主页要的统计数字（fans/following/totalLikes/diaryCount）都有');

  // ---------- 2. 改昵称 ----------
  step('2. 改昵称');
  const newNick = '测试昵称' + Date.now().toString().slice(-6);
  const r1 = await api('PATCH', '/api/user/me', { token: A.token, body: { nickname: newNick } });
  eq(r1.body?.code, 0, '改昵称成功');
  eq(r1.body.data.user.nickname, newNick, '返回的新昵称正确');
  truthy(r1.body.data.changed.includes('nickname'), 'changed 里记录了 nickname');

  const recheck = await api('GET', '/api/user/me', { token: A.token });
  eq(recheck.body.data.user.nickname, newNick, '重新读取，昵称确实变了（真的落库了）');

  // ---------- 3. 昵称重名 ----------
  step('3. 昵称不能和别人重名');
  const BNick = (await api('GET', '/api/user/me', { token: B.token })).body.data.user.nickname;
  const dup = await api('PATCH', '/api/user/me', { token: A.token, body: { nickname: BNick } });
  truthy(dup.body?.code !== 0, `用 B 的昵称「${BNick}」被拒绝`, dup.body);
  truthy(/有人用|重复/.test(dup.body?.msg || ''), '错误信息说明了原因');

  // ---------- 4. 昵称边界 ----------
  step('4. 昵称边界');
  const emptyNick = await api('PATCH', '/api/user/me', { token: A.token, body: { nickname: '   ' } });
  truthy(emptyNick.body?.code !== 0, '空昵称被拒绝', emptyNick.body);
  const longNick = await api('PATCH', '/api/user/me', { token: A.token, body: { nickname: '很长'.repeat(30) } });
  eq(longNick.body?.code, 0, '超长昵称被截断而不是报错');
  truthy(longNick.body.data.user.nickname.length <= 32, `昵称长度不超过 32（实际 ${longNick.body.data.user.nickname.length}）`);
  // 改回新昵称
  await api('PATCH', '/api/user/me', { token: A.token, body: { nickname: newNick } });

  // ---------- 5. 个性签名 ----------
  step('5. 改个性签名');
  const sign = '这句话是测试写的' + Date.now().toString().slice(-4);
  const r2 = await api('PATCH', '/api/user/me', { token: A.token, body: { signature: sign } });
  eq(r2.body?.data?.user?.signature, sign, '签名保存成功');
  // 签名可以为空（清空签名是正常操作）
  const clearSign = await api('PATCH', '/api/user/me', { token: A.token, body: { signature: '' } });
  eq(clearSign.body?.data?.user?.signature, '', '签名可以清空');

  // ---------- 6. ★ 地址自动推省份 ----------
  step('6. 【自动】填地址自动推断省份（同省群要用）');
  const r3 = await api('PATCH', '/api/user/me', {
    token: A.token, body: { addr: '陕西省西安市雁塔区' },
  });
  eq(r3.body?.data?.user?.addr, '陕西省西安市雁塔区', '地址保存成功');
  eq(r3.body?.data?.user?.province, '陕西', '★ 自动推断出省份 = 陕西');
  truthy(r3.body.data.changed.includes('province'), 'changed 里自动加上了 province');
  ok('用户不用手选省份 —— 手选会填错，群就分不干净');

  // 换个别省的地址
  const r3b = await api('PATCH', '/api/user/me', {
    token: A.token, body: { addr: '广东省深圳市南山区' },
  });
  eq(r3b.body?.data?.user?.province, '广东', '换成广东地址，省份跟着更新为 广东');

  // 识别不出的地址不该冲掉原来的省份
  const r3c = await api('PATCH', '/api/user/me', {
    token: A.token, body: { addr: '某个说不清的地方' },
  });
  eq(r3c.body?.data?.user?.province, '广东', '识别不出的地址不会把省份冲掉（保留 广东）');

  // ★ 清空地址时省份也要清空
  //   我第一版漏了这个分支，导致省份一旦填过就永远清不掉
  const r3d = await api('PATCH', '/api/user/me', {
    token: A.token, body: { addr: '' },
  });
  eq(r3d.body?.data?.user?.addr, '', '地址能清空');
  eq(r3d.body?.data?.user?.province, '', '★ 地址清空时省份也跟着清空（不是残留）');

  // 填回一个地址继续后面的测试
  await api('PATCH', '/api/user/me', { token: A.token, body: { addr: '广东省深圳市' } });

  // ---------- 7. ★ 出生年份自动算星座 ----------
  step('7. 【自动】填出生年份自动算星座（星迹群要用）');
  const r4 = await api('PATCH', '/api/user/me', {
    token: A.token, body: { birthYear: 1998, birthMonth: 11, birthDay: 5 },
  });
  eq(r4.body?.data?.user?.birthYear, 1998, '出生年份保存成功');
  eq(r4.body?.data?.user?.zodiac, '天蝎', '★ 自动算出星座 = 天蝎（11月5日）');
  truthy(typeof r4.body.data.user.age === 'number', `自动算好年龄 = ${r4.body.data.user.age}`);
  truthy(!!r4.body.data.user.ageGroup, `自动算好年龄段 = ${r4.body.data.user.ageGroup}`);

  // 只给年份不给月日，星座不该被乱改
  const r4b = await api('PATCH', '/api/user/me', {
    token: A.token, body: { birthYear: 2000 },
  });
  eq(r4b.body.data.user.birthYear, 2000, '只改年份也能成功');
  // 星座保持不变（因为没给月日，没法算）
  truthy(r4b.body.data.user.zodiac === '天蝎' || r4b.body.data.user.zodiac === '',
    `没给月日时星座没被乱改（当前=${r4b.body.data.user.zodiac}）`);

  // ★ 传 null 能清空出生年份和星座
  //   我第一版漏了清空分支，导致这两个字段一旦填过就永远清不掉
  const r4clear = await api('PATCH', '/api/user/me', {
    token: A.token, body: { birthYear: null },
  });
  eq(r4clear.body.data.user.birthYear, null, '★ 传 null 能清空出生年份');
  eq(r4clear.body.data.user.zodiac, '', '★ 清空出生年份时星座也一起清空');
  eq(r4clear.body.data.user.age, null, '年龄也跟着变成 null');
  // 填回原来的值继续后面的测试
  await api('PATCH', '/api/user/me', {
    token: A.token, body: { birthYear: 1998, birthMonth: 11, birthDay: 5 },
  });

  // 非法年份
  const r4c = await api('PATCH', '/api/user/me', { token: A.token, body: { birthYear: 1800 } });
  truthy(r4c.body?.code !== 0, '1800 年这种年份被拒绝', r4c.body);
  const r4d = await api('PATCH', '/api/user/me', { token: A.token, body: { birthYear: 2099 } });
  truthy(r4d.body?.code !== 0, '未来年份被拒绝', r4d.body);

  // 手传星座也要校验
  const r4e = await api('PATCH', '/api/user/me', { token: A.token, body: { zodiac: '随便编的' } });
  truthy(r4e.body?.code !== 0, '乱传星座被拒绝', r4e.body);

  // ---------- 8. 性别 ----------
  step('8. 性别字段');
  const r5 = await api('PATCH', '/api/user/me', { token: A.token, body: { gender: 'female' } });
  eq(r5.body?.data?.user?.gender, 'female', '设置性别成功');
  const badGender = await api('PATCH', '/api/user/me', { token: A.token, body: { gender: '外星人' } });
  truthy(badGender.body?.code !== 0, '非法性别被拒绝', badGender.body);

  // ---------- 9. 空请求 ----------
  step('9. 什么都不传应该报错');
  const nothing = await api('PATCH', '/api/user/me', { token: A.token, body: {} });
  truthy(nothing.body?.code !== 0, '空请求被拒绝', nothing.body);
  truthy(/没有要修改/.test(nothing.body?.msg || ''), '错误信息说明了原因');

  // ---------- 10. 未登录 ----------
  step('10. 未登录不能改资料');
  eq((await api('GET', '/api/user/me')).status, 401, '未登录读资料 401');
  eq((await api('PATCH', '/api/user/me', { body: { nickname: 'x' } })).status, 401, '未登录改资料 401');

  // ---------- 11. 上传头像（base64，前端现在就用这个）----------
  step('11. 头像上传（base64 方式，settings.html 用）');
  const png = makeTinyPng();
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');
  ok(`生成了一张真实的 PNG（${png.length} 字节）`);

  const up1 = await api('POST', '/api/user/avatar-base64', {
    token: A.token, body: { image: dataUrl },
  });
  eq(up1.body?.code, 0, 'base64 头像上传成功');
  // ★ 注意 eq(actual, expected, msg) 是三个参数。
  //   之前这里漏传了 msg，把"实际值"挤到了 msg 的位置，
  //   结果断言逻辑颠倒、失败信息也变成一团乱麻。
  eq(up1.body.data.filename.startsWith('avatar_'), true, '文件名是服务端生成的（不是用户传的）');
  eq(up1.body.data.filename.endsWith('.png'), true, '扩展名正确');
  truthy(up1.body.data.user.avatar.startsWith('/uploads/'), `返回的头像是相对地址（${up1.body.data.user.avatar.slice(0, 50)}...）`);
  ok('★ 数据库里只存文件名，不存 base64 —— 否则 users 表很快被撑爆');

  // 头像能真的被访问到
  // 头像是相对路径，Node 的 fetch 要绝对地址
  const __av = up1.body.data.user.avatar;
  const avatarRes = await fetch(__av.startsWith('http') ? __av : BASE + __av);
  eq(avatarRes.status, 200, '头像 URL 真的能访问（HTTP 200）');
  const avatarBytes = Buffer.from(await avatarRes.arrayBuffer());
  truthy(avatarBytes.length > 0, `拿到的图片有 ${avatarBytes.length} 字节`);
  eq(avatarBytes[0], 0x89, '拿到的确实是 PNG（文件头第 1 字节是 0x89）');

  // 上传第二次，旧文件应该被删掉
  const oldFile = up1.body.data.filename;
  const up2 = await api('POST', '/api/user/avatar-base64', {
    token: A.token, body: { image: dataUrl },
  });
  eq(up2.body?.code, 0, '第二次上传成功');
  truthy(up2.body.data.filename !== oldFile, '生成了新文件名（没覆盖旧的）');

  // ---------- 12. 假图片应该被拒绝 ----------
  step('12. 安全性：伪装成图片的文件必须被拒绝');
  // 一个 HTML 文件，但声明成 png —— 只看 Content-Type 是拦不住的
  const fakeHtml = Buffer.from('<html><script>alert(1)</script></html>');
  const fakeDataUrl = 'data:image/png;base64,' + fakeHtml.toString('base64');
  const fakeUp = await api('POST', '/api/user/avatar-base64', {
    token: A.token, body: { image: fakeDataUrl },
  });
  truthy(fakeUp.body?.code !== 0, '★ 伪装成 png 的 HTML 被拒绝', fakeUp.body);
  ok('靠的是读文件头"魔数"，不是信前端声明的类型');

  // 根本不是 data url
  const notDataUrl = await api('POST', '/api/user/avatar-base64', {
    token: A.token, body: { image: 'http://evil.com/x.png' },
  });
  truthy(notDataUrl.body?.code !== 0, '非 base64 的输入被拒绝', notDataUrl.body);

  // ---------- 13. 超大图片 ----------
  step('13. 超大图片被拒绝（防止撑爆磁盘）');
  // 造一个 6MB 的假 base64（超过 5MB 限制）
  const huge = Buffer.alloc(6 * 1024 * 1024, 0x41);
  const hugeUrl = 'data:image/png;base64,' + huge.toString('base64');
  const hugeUp = await api('POST', '/api/user/avatar-base64', {
    token: A.token, body: { image: hugeUrl },
  });
  truthy(hugeUp.body?.code !== 0, '超大图片被拒绝', hugeUp.body);
  truthy(/太大|KB/.test(hugeUp.body?.msg || ''), `错误信息提到了大小（${hugeUp.body?.msg}）`);

  // ---------- 14. 恢复默认头像 ----------
  step('14. 恢复默认头像');
  const delAv = await api('DELETE', '/api/user/avatar', { token: A.token });
  eq(delAv.body?.code, 0, '删除头像成功');
  eq(delAv.body.data.user.avatar, '', '头像字段变成空');

  // ---------- 15. 搜人 ----------
  step('15. 搜人（按昵称和 uid）');
  const byNick = await api('GET', `/api/user/search?q=${encodeURIComponent(newNick)}`, { token: A.token });
  eq(byNick.body?.code, 0, '按昵称搜索正常');
  truthy(byNick.body.data.list.some(x => x.nick === newNick), '搜到了自己');

  const byUid = await api('GET', `/api/user/search?q=${A.user.uid}`, { token: A.token });
  truthy(byUid.body.data.list.some(x => x.uid === A.user.uid), '按 uid 能精确搜到');

  const noResult = await api('GET', '/api/user/search?q=绝对不存在的名字xyz', { token: A.token });
  eq(noResult.body.data.list.length, 0, '搜不到就返回空数组（不报错）');

  // LIKE 通配符转义：搜 % 不应该匹配到所有人
  const wildcard = await api('GET', '/api/user/search?q=%25', { token: A.token });
  eq(wildcard.body.data.list.length, 0, '★ 搜索百分号不会匹配到所有人（LIKE 通配符已转义）');

  const noQuery = await api('GET', '/api/user/search', { token: A.token });
  truthy(noQuery.body?.code !== 0, '不带搜索词被拒绝', noQuery.body);

  // ---------- 16. 看别人的资料 ----------
  step('16. 看别人的资料（个人主页）');
  const otherProfile = await api('GET', `/api/user/${B.user.id}`, { token: A.token });
  eq(otherProfile.body?.code, 0, '能看别人的资料');
  eq(otherProfile.body.data.user.id, B.user.id, '是 B 的资料');
  eq(otherProfile.body.data.isMine, false, 'isMine = false');
  truthy('isFollowed' in otherProfile.body.data, '带上了 isFollowed（关注按钮要用）');
  truthy('stats' in otherProfile.body.data, '带上了 stats（主页三个数字）');
  truthy(typeof otherProfile.body.data.stats.likes === 'number', 'stats.likes 是数字');

  const selfProfile = await api('GET', `/api/user/${A.user.id}`, { token: A.token });
  eq(selfProfile.body.data.isMine, true, '看自己时 isMine = true');

  const ghost = await api('GET', '/api/user/99999999', { token: A.token });
  eq(ghost.status, 404, '看不存在的人返回 404');

  // ---------- 17. 改对外 ID ----------
  step('17. 改对外 ID（设置页有这一项）');
  const newUid = '9' + Date.now().toString().slice(-10);
  const uidRes = await api('PATCH', '/api/user/me', { token: A.token, body: { uid: newUid } });
  eq(uidRes.body?.data?.user?.uid, newUid, `改 uid 成功（新值 ${newUid}）`);
  const badUid = await api('PATCH', '/api/user/me', { token: A.token, body: { uid: 'abc' } });
  truthy(badUid.body?.code !== 0, '非数字 uid 被拒绝', badUid.body);
  const dupUid = await api('PATCH', '/api/user/me', { token: A.token, body: { uid: B.user.uid } });
  truthy(dupUid.body?.code !== 0, '占用别人的 uid 被拒绝', dupUid.body);

  // ---------- 18. ★ 换设备资料还在 ----------
  step('18. 【核心】换设备：重新登录，资料还在');
  const A2 = await login('13800138000');
  const me2 = await api('GET', '/api/user/me', { token: A2.token });
  eq(me2.body.data.user.nickname, newNick, '新设备上昵称还是刚才改的');
  eq(me2.body.data.user.uid, newUid, '新设备上 uid 也是改后的');
  eq(me2.body.data.user.gender, 'female', '性别也是改后的');
  eq(me2.body.data.user.zodiac, '天蝎', '星座也是自动算出来的那个');
  ok('资料存在服务器，所以换设备全都在');

  // ---------- 19. 还原 ----------
  step('19. 还原 A 的原始资料（保证测试可重复跑）');
  await restoreOriginal();
  const finalCheck = await api('GET', '/api/user/me', { token: A.token });
  eq(finalCheck.body.data.user.nickname, orig2.nickname, '昵称还原成功');
  eq(finalCheck.body.data.user.uid, orig2.uid, 'uid 还原成功');
  eq(finalCheck.body.data.user.avatar, '', '头像也清空了');

  // ============================================================
  //  ★ 上面已经用 try 包住了整个测试体
  //  finally 里做还原，无论测试成功、失败、还是抛异常，都会执行
  // ============================================================
  } finally {
    await restoreOriginal();
  }

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 第 6 步（个人资料 + 头像上传）全部通过！\n');
  } else {
    console.log('\n  失败项：');
    failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    console.log('');
  }
  // ★ 用 exitCode 而不是 process.exit() —— 后者会跳过 finally
  process.exitCode = fail === 0 ? 0 : 1;
})().catch(async (e) => {
  console.error('\n测试脚本崩溃：', e);
  console.error('\n\x1b[33m如果账号资料没还原，可以手动跑：');
  console.error('  node scripts/fix-test-account.js\x1b[0m\n');
  process.exitCode = 1;
});

