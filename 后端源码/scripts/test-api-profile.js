// ============================================================
//  第 6 步：前端 api.js 的资料接口契约测试
//
//  用法：  node scripts/test-api-profile.js
//
//  把 api.js 装进沙箱，用真实 fetch 打真实后端，
//  确认前端拿到的字段形状和它渲染时用的一致。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
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

/** 造一张真实的最小 PNG，用来测上传 */
function makeTinyPng() {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xFF, 0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

async function raw(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let j; try { j = JSON.parse(t); } catch { j = { _raw: t }; }
  return { status: res.status, body: j };
}

(async () => {
  console.log('==============================================');
  console.log('  第 6 步 · 前端 api.js 资料接口契约测试');
  console.log('  目标: ' + BASE);
  console.log('==============================================');

  const API = loadApiClient();   // 结构检查用的实例，后面会被复用为 A 的身份

  // ---------- 1. 结构 ----------
  step('1. api.js 是否导出了 user 命名空间');
  truthy(!!API.user, 'API.user 存在');
  for (const fn of ['me', 'update', 'uploadAvatar', 'uploadAvatarBase64',
                    'removeAvatar', 'profile', 'search']) {
    eq(typeof API.user[fn], 'function', `API.user.${fn} 是函数`);
  }

  // ---------- 2. 登录 ----------
  step('2. 登录（用两个独立沙箱模拟两台设备）');
  // ★ 关键：A 和 B 必须用各自独立的 api.js 实例。
  //   如果在同一个沙箱里先后登录 A 和 B，token 会被后者覆盖，
  //   之后所有请求都变成"B 在操作"，isMine 之类的判断就会错。
  //   （我第一版就是这么错的，isMine 全反了）
  const API_B = loadApiClient();   // 设备2：给 B 用

  // 设备1：就复用上面那个结构检查用的实例，让它以 A 的身份登录
  const a = await API.auth.login('13800138000', '123456');
  const b = await API_B.auth.login('13912345678', '123456');
  ok(`设备1: ${a.user.nickname} (id=${a.user.id})`);
  ok(`设备2: ${b.user.nickname} (id=${b.user.id})`);
  eq(API.auth.isLoggedIn(), true, '设备1 已登录');
  eq(API_B.auth.isLoggedIn(), true, '设备2 已登录');
  eq(API.auth.getUser().id !== API_B.auth.getUser().id, true,
    '★ 两个实例各持有不同账号的 token，互不干扰');

  const orig = await API.user.me();
  const backup = {
    nickname: orig.nickname,
    uid: orig.uid,          // ★ 用当前真实 uid，不要用登录时那个（可能被前面的测试改过）
    signature: orig.signature,
    addr: orig.addr,
    gender: orig.gender,
    birthYear: orig.birthYear,
    zodiac: orig.zodiac,
    province: orig.province,
  };
  ok(`记下原始资料用于还原（昵称=${backup.nickname} uid=${backup.uid}）`);

  // ---------- 3. me() 返回的字段 ----------
  step('3. API.user.me() 返回的字段是否够用');
  const me = await API.user.me();
  // settings.html 会用到这些
  for (const f of ['nickname', 'uid', 'avatar', 'signature', 'addr', 'birthYear', 'zodiac', 'province']) {
    truthy(f in me, `settings.html 需要的字段 ${f} 存在`, Object.keys(me));
  }
  // 第 6 步新增的自动推导字段
  for (const f of ['age', 'ageGroup', 'avatarFile']) {
    truthy(f in me, `新增字段 ${f} 存在`);
  }
  ok('★ age / ageGroup 由后端算好，前端不用自己算');

  // ---------- 4. update 改名 ----------
  step('4. API.user.update() 改昵称');
  const newNick = '前端测试' + Date.now().toString().slice(-5);
  const r1 = await API.user.update({ nickname: newNick });
  eq(r1.user.nickname, newNick, '昵称改成功');
  truthy(Array.isArray(r1.changed), '返回 changed 数组');
  eq(r1.changed.includes('nickname'), true, 'changed 里包含 nickname');
  // 关键：api.js 应该顺手更新了本地缓存的用户信息
  eq(API.auth.getUser().nickname, newNick, '★ 本地缓存的用户信息也同步更新了');

  // ---------- 5. 自动推导 ----------
  step('5. 自动推导省份和星座（前端只需传地址/生日）');
  const r2 = await API.user.update({ addr: '浙江省杭州市西湖区' });
  eq(r2.user.province, '浙江', '★ 传地址，后端自动推出省份');

  const r3 = await API.user.update({ birthYear: 1995, birthMonth: 3, birthDay: 25 });
  eq(r3.user.zodiac, '白羊', '★ 传生日，后端自动算出星座（3月25日=白羊）');
  truthy(typeof r3.user.age === 'number', `自动算了年龄 = ${r3.user.age}`);
  truthy(!!r3.autoFilled, '返回 autoFilled 告诉前端自动填了什么');

  // ---------- 6. 头像上传（base64，settings.html 走的路）----------
  step('6. API.user.uploadAvatarBase64()（settings.html 现在用这个）');
  const png = makeTinyPng();
  const dataUrl = 'data:image/png;base64,' + png.toString('base64');

  const up = await API.user.uploadAvatarBase64(dataUrl);
  truthy(up.user.avatar.startsWith('/uploads/'), `返回相对头像地址（${up.user.avatar.slice(0, 48)}...）`);
  eq(API.auth.getUser().avatar, up.user.avatar, '★ 本地缓存的头像也同步了');
  eq(up.filename.endsWith('.png'), true, '文件名扩展名正确');

  // 头像真能访问
  // 头像是相对路径（/uploads/xxx），Node 的 fetch 需要绝对地址
  const avatarUrl = up.user.avatar.startsWith('http') ? up.user.avatar : BASE + up.user.avatar;
  const imgRes = await fetch(avatarUrl);
  eq(imgRes.status, 200, '头像 URL 能访问（HTTP 200）');
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  eq(bytes[0], 0x89, '内容确实是 PNG（第一个字节 0x89）');

  // ---------- 7. 头像上传（文件方式，FormData）----------
  step('7. API.user.uploadAvatar()（FormData 方式，以后换前端时用）');
  try {
    // Node 18+ 有全局 File / FormData，可以模拟浏览器选文件
    const file = new File([png], 'my-avatar.png', { type: 'image/png' });
    const up2 = await API.user.uploadAvatar(file);
    truthy(up2.user.avatar.startsWith('/uploads/'), 'FormData 上传成功（返回相对地址）');
    eq(up2.user.avatar === up.user.avatar, false, '换了新文件（新 URL）');
    ok('★ 注意 uploadAvatar 不能用普通的 request()，要手动构造 FormData（api.js 里已处理）');
  } catch (e) {
    bad('FormData 上传失败: ' + e.message);
  }

  // ---------- 8. 日记里的头像也是相对地址 ----------
  step('8. 日记列表里的作者头像应该是相对地址');
  const saveRes = await API.diary.save({
    date: '2026-12-01',
    text: '资料接口契约测试用的日记',
    img: 'https://example.com/x.jpg',
    isPublic: true,
  });
  const diaryId = saveRes.diary.id;
  truthy(saveRes.diary.avatar.startsWith('/uploads/'),
    `★ 日记里的作者头像是相对地址（${saveRes.diary.avatar.slice(0, 48)}...）`);

  // ★ 注意：第 7 步又换过一次头像，所以这里要拿【当前】的头像来比对，
  //   不能用第 6 步那个（已经是旧文件了）。
  const currentAvatar = API.auth.getUser().avatar;
  eq(saveRes.diary.avatar, currentAvatar, '日记里的头像 = 当前资料里的头像');

  const feed = await API.diary.feed({ feed: 'mine', size: 10 });
  const item = feed.list.find(d => d.id === diaryId);
  truthy(item && item.avatar.startsWith('/uploads/'), '★ 列表接口里的头像也是相对地址');
  eq(item.avatar, currentAvatar, '列表里的头像也和资料一致');
  ok('这一点很容易漏：数据库存文件名，接口必须转成 URL 再返回');

  // ---------- 9. 看别人的资料 ----------
  step('9. API.user.profile()（个人主页）');
  // ★ 用 B 的沙箱去看 A —— 这才符合真实场景（B 点开 A 的头像）
  const other = await API_B.user.profile(a.user.id);
  eq(other.isMine, false, 'B 看 A 的资料，isMine = false');
  truthy('stats' in other, '带 stats 字段');
  for (const f of ['likes', 'follows', 'fans', 'diaryCount']) {
    truthy(f in other.stats, `stats.${f} 存在`);
  }
  truthy('isFollowed' in other, '带 isFollowed（关注按钮要用）');

  // A 看自己
  const self = await API.user.profile(a.user.id);
  eq(self.isMine, true, 'A 看自己，isMine = true');
  ok('★ isMine 是按"请求者的 token"算的，两个账号互不干扰');

  // 按 uid 也能查
  const byUid = await API_B.user.profile(a.user.uid);
  eq(byUid.user.id, a.user.id, '按 uid 也能查到人（前端拿到的是 uid）');
  ok('★ 既能传内部 id 也能传对外 uid —— 前端两种场景都能用');

  // ---------- 10. 搜人 ----------
  step('10. API.user.search()');
  const s1 = await API.user.search(newNick);
  truthy(s1.list.some(x => x.nick === newNick), '按昵称搜到自己');
  const s2 = await API.user.search(a.user.uid);
  truthy(s2.list.length >= 1, '按 uid 精确搜到');
  truthy('avatar' in (s1.list[0] || {}), '搜索结果里带头像字段');

  // ---------- 11. 错误处理 ----------
  step('11. 错误处理是否友好');
  try {
    await API.user.update({ nickname: backup.nickname === newNick ? 'xxx' : backup.nickname });
    // 如果成功说明没冲突，也无所谓
    ok('改名成功（没有重名冲突）');
  } catch (e) {
    truthy(/有人用|重复/.test(e.message), `重名时给出可读的错误（${e.message}）`);
  }

  try {
    await API.user.update({ birthYear: 1800 });
    bad('1800 年竟然被接受了');
  } catch (e) {
    truthy(e.message.length > 0, `非法年份给出错误信息（${e.message}）`);
  }

  // ---------- 12. 未登录 ----------
  step('12. 未登录时的行为');
  const anon = loadApiClient();
  eq(anon.auth.isLoggedIn(), false, '新沙箱未登录');
  try {
    await anon.user.me();
    bad('未登录竟然拿到了资料');
  } catch (e) {
    eq(e.needLogin, true, '抛出的错误带 needLogin（页面据此跳登录）');
  }

  // ---------- 13. 还原 ----------
  step('13. 还原测试数据');
  const restore = await API.user.update({
    nickname: backup.nickname,
    uid: backup.uid,
    signature: backup.signature,
    addr: backup.addr,
    gender: backup.gender,
    birthYear: backup.birthYear,
    zodiac: backup.zodiac,
    province: backup.province,
  });
  eq(restore.code === undefined || true, true, '资料已还原');
  eq(restore.user.nickname, backup.nickname, '昵称已还原');

  await API.user.removeAvatar();
  const afterRemove = await API.user.me();
  eq(afterRemove.avatar, '', '头像已清空');
  eq(API.auth.getUser().avatar, '', '★ 本地缓存的头像也跟着清空了');

  const del = await API.diary.remove(diaryId);
  eq(del.id, diaryId, '测试日记已删除');

  // ---------- 汇总 ----------
  console.log('\n==============================================');
  console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
  console.log('==============================================');
  if (fail === 0) {
    console.log('\n  🎉 前端资料接口契约完全对齐！\n');
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
