// ============================================================
//  个人资料模块
//
//  对应前端：
//    settings.html       设置页：头像 / ID / 个性签名 / 地址
//    mine.html           我的页面顶部的头像昵称签名
//    diary-public.html   个人主页（别人的）
//
//  ★ 数据分散在两张表 ★
//    昵称 → users.nickname
//    其余 → user_profiles
//  这就是为什么"改个昵称"和"改个签名"要走不同分支。
//
//  ★ 星座和省份不让用户自己选 ★
//    因为「星迹」群按星座分房间、「同省群」按省份分房间。
//    让用户手选会乱填，群就分不干净。
//    正确做法：用户填出生年份和地址，后端自己算。
// ============================================================
import express from 'express';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { queryOne, query, insert, execute } from '../db/index.js';
import { ok, wrap, ApiError } from '../utils/response.js';
import { str, int } from '../utils/validate.js';
import { auth } from '../middleware/auth.js';
import { upload, verifyUploadedImage, saveDataUrlToFile, avatarUrl } from '../middleware/upload.js';
import { zodiacOf, provinceOf, ageOf, ZODIACS } from '../utils/zodiac.js';
import { config } from '../config/index.js';
import {
  getUserById, getUserByUid, serializeProfile, ensureProfile,
} from '../utils/profileHelper.js';

const router = express.Router();

// ============================================================
//  GET /api/user/me        拿自己的完整资料（个人主页 + 设置页用）
// ============================================================
router.get('/me', auth, wrap(async (req, res) => {
  // 老数据可能缺 profile 行，先确保存在
  await ensureProfile(req.uid);
  const row = await getUserById(req.uid);
  return ok(res, { user: serializeProfile(row) });
}));

// ============================================================
//  PATCH /api/user/me      修改自己的资料（只改传上来的字段）
//
//  可改字段：
//    nickname   昵称（1-32 字，不能和别人重名）
//    signature  个性签名（最多 255 字）
//    addr       地址（最多 64 字，会自动推断省份）
//    gender     unknown / male / female
//    birthYear  出生年份（会自动算星座和年龄段）
//    zodiac     星座（一般不用手传，改 birthYear 就自动算了）
//    province   省份（一般不用手传，改 addr 就自动算了）
//    cover      主页背景图
// ============================================================
router.patch('/me', auth, wrap(async (req, res) => {
  await ensureProfile(req.uid);

  const userUpdates = [];    // 要写 users 表的
  const userParams = [];
  const profUpdates = [];    // 要写 user_profiles 表的
  const profParams = [];
  const changed = [];        // 记一下改了哪些，返回给前端看

  // ---------- 昵称 ----------
  if (req.body.nickname !== undefined) {
    const nickname = str(req.body.nickname, '昵称', { required: true, max: 32 });
    if (nickname.length < 1) throw new ApiError('昵称不能为空', 400);

    // 昵称允许重复吗？这里不允许 —— 前端有按昵称跳个人主页的逻辑
    // （diary-public.html 的 openProfile(nick)），重名会跳错人。
    const dup = await queryOne(
      'SELECT id FROM users WHERE nickname = ? AND id <> ?',
      [nickname, req.uid]
    );
    if (dup) throw new ApiError('这个昵称已经有人用了，换一个吧', 409);

    userUpdates.push('nickname = ?');
    userParams.push(nickname);
    changed.push('nickname');
  }

  // ---------- 对外 ID（uid）----------
  // 前端设置页有"ID"这一项，允许用户改。
  // 必须保证唯一，且格式固定为 6-16 位数字（和现有 uid 风格一致）
  if (req.body.uid !== undefined) {
    const newUid = str(req.body.uid, 'ID', { required: true, max: 16 });
    if (!/^\d{6,16}$/.test(newUid)) {
      throw new ApiError('ID 只能是 6-16 位数字', 400);
    }
    const dup = await queryOne('SELECT id FROM users WHERE uid = ? AND id <> ?', [newUid, req.uid]);
    if (dup) throw new ApiError('这个 ID 已经被占用了，换一个吧', 409);

    userUpdates.push('uid = ?');
    userParams.push(newUid);
    changed.push('uid');
  }

  // ---------- 个性签名 ----------
  if (req.body.signature !== undefined) {
    const signature = str(req.body.signature, '个性签名', { required: false, max: 255, def: '' });
    profUpdates.push('signature = ?');
    profParams.push(signature);
    changed.push('signature');
  }

  // ---------- 地址（顺便推断省份）----------
  if (req.body.addr !== undefined) {
    const addr = str(req.body.addr, '地址', { required: false, max: 64, def: '' });
    profUpdates.push('addr = ?');
    profParams.push(addr);
    changed.push('addr');

    // ★ 自动推断省份：用户填 "陕西省西安市" 就能进"同省群"
    //
    //  这里要区分三种情况，不能一律照搬：
    //    1. 地址为空（用户主动清空）      → 省份也清空
    //    2. 地址能识别出省份              → 用识别结果
    //    3. 地址识别不出但非空（"某个说不清的地方"）
    //       → 保留原省份，别把之前对的冲掉
    //
    //  ★ 我第一版只写了"if (guessed) 才更新"，结果省份一旦填上
    //    就再也清不掉了（测试里发现 A 的省份一直残留着）。
    const guessed = provinceOf(addr);
    if (addr === '') {
      // 情况 1：主动清空
      profUpdates.push('province = ?');
      profParams.push('');
      changed.push('province');
    } else if (guessed) {
      // 情况 2：识别成功
      profUpdates.push('province = ?');
      profParams.push(guessed);
      changed.push('province');
    }
    // 情况 3：什么都不做，保留原值
  }

  // ---------- 性别 ----------
  if (req.body.gender !== undefined) {
    const gender = String(req.body.gender);
    if (!['unknown', 'male', 'female'].includes(gender)) {
      throw new ApiError('性别只能是 unknown / male / female', 400);
    }
    profUpdates.push('gender = ?');
    profParams.push(gender);
    changed.push('gender');
  }

  // ---------- 出生年份（顺便算星座）----------
  // ★ 这里要支持"清空"：传 null 或空字符串表示清掉出生年份，
  //   同时把自动算出来的星座也清掉。
  //   我第一版写成 `!== null && !== ''` 才处理，导致出生年份和星座
  //   一旦填过就永远清不掉 —— 测试里发现的。
  if ('birthYear' in req.body) {
    const raw = req.body.birthYear;

    if (raw === null || raw === '' || raw === undefined) {
      // 清空
      profUpdates.push('birth_year = ?');
      profParams.push(null);
      profUpdates.push('zodiac = ?');
      profParams.push('');
      changed.push('birthYear', 'zodiac');
    } else {
      const year = int(raw, '出生年份', { min: 1900, max: new Date().getFullYear() });
      profUpdates.push('birth_year = ?');
      profParams.push(year);
      changed.push('birthYear');

      // 如果同时给了月份和日期，就能算出精确星座
      if (req.body.birthMonth !== undefined && req.body.birthDay !== undefined) {
        const month = int(req.body.birthMonth, '出生月份', { min: 1, max: 12 });
        const day = int(req.body.birthDay, '出生日', { min: 1, max: 31 });
        const z = zodiacOf(month, day);
        if (z) {
          profUpdates.push('zodiac = ?');
          profParams.push(z);
          changed.push('zodiac');
        }
      }
    }
  }

  // ---------- 星座（一般不用手传，留给特殊场景）----------
  if (req.body.zodiac !== undefined && req.body.zodiac !== '') {
    const z = str(req.body.zodiac, '星座', { max: 8 });
    if (!ZODIACS.includes(z)) {
      throw new ApiError(`星座只能是：${ZODIACS.join(' / ')}`, 400);
    }
    profUpdates.push('zodiac = ?');
    profParams.push(z);
    changed.push('zodiac');
  }

  // ---------- 省份（一般不用手传）----------
  if (req.body.province !== undefined && req.body.province !== '') {
    const p = str(req.body.province, '省份', { max: 32 });
    profUpdates.push('province = ?');
    profParams.push(p);
    changed.push('province');
  }

  // ---------- 主页背景图 ----------
  if (req.body.cover !== undefined) {
    let cover = str(req.body.cover, '背景图', { required: false, max: 255, def: '' });
    // 如果是 base64 就落盘，避免数据库被撑大
    if (cover.startsWith('data:image/')) {
      const filename = saveDataUrlToFile(cover, 'cover');
      if (!filename) throw new ApiError('背景图格式不对', 400);
      cover = filename;
    } else if (/^https?:\/\//i.test(cover)) {
      // 外链原样保留
    } else if (cover && cover.includes('/uploads/')) {
      // 已经是本站路径，抽出文件名
      cover = cover.split('/uploads/').pop();
    }
    profUpdates.push('cover = ?');
    profParams.push(cover);
    changed.push('cover');
  }

  if (changed.length === 0) {
    throw new ApiError('没有要修改的内容', 400);
  }

  // ---------- 写库 ----------
  if (userUpdates.length) {
    await query(
      `UPDATE users SET ${userUpdates.join(', ')} WHERE id = ?`,
      [...userParams, req.uid]
    );
  }
  if (profUpdates.length) {
    // ★ 必须用 execute() 而不是 query()！
    //   query() 底层是 pool.execute()，对 UPDATE 返回的是
    //   { affectedRows, insertId, ... } 对象，不是数字。
    //   写成 `const n = await query('UPDATE ...'); if (n === 0)` 永远不成立。
    const affected = await execute(
      `UPDATE user_profiles SET ${profUpdates.join(', ')} WHERE user_id = ?`,
      [...profParams, req.uid]
    );
    // 影响 0 行说明 profile 行不存在（ensureProfile 在并发下可能刚好没建上），补一次 INSERT
    if (affected === 0) {
      await insert('INSERT INTO user_profiles (user_id) VALUES (?)', [req.uid]);
      console.log(`  ⚠️  user_profiles 缺行，已补建 (user_id=${req.uid})`);
    }
  }

  const row = await getUserById(req.uid);
  const result = serializeProfile(row);

  console.log(`  ✎ 用户 ${result.nickname} 改了资料: ${changed.join(', ')}`);

  return ok(res, {
    user: result,
    changed,
    // 顺便告诉前端"星座/省份被自动算了什么"
    autoFilled: {
      zodiac: changed.includes('zodiac') ? result.zodiac : undefined,
      province: changed.includes('province') ? result.province : undefined,
      ageGroup: changed.includes('birthYear') ? result.ageGroup : undefined,
    },
  }, '资料已保存');
}));

// ============================================================
//  POST /api/user/avatar       上传头像（文件方式）
//  Content-Type: multipart/form-data，字段名 file
//
//  也可以用下面的 POST /api/user/avatar-base64（前端老代码用 base64）
// ============================================================
router.post(
  '/avatar',
  auth,
  (req, res, next) => { req.uploadKind = 'avatar'; next(); },
  upload.single('file'),
  verifyUploadedImage,
  wrap(async (req, res) => {
    if (!req.file) throw new ApiError('没有收到文件（字段名应该是 file）', 400);

    await ensureProfile(req.uid);

    // 删掉旧头像文件，别让 uploads 目录无限膨胀
    const old = await queryOne('SELECT avatar FROM user_profiles WHERE user_id = ?', [req.uid]);
    if (old && old.avatar && !/^https?:\/\//i.test(old.avatar) && !old.avatar.startsWith('data:')) {
      const oldPath = path.join(config.uploadDir, old.avatar);
      // 安全检查：确认解析后的路径确实在 uploads 目录里，防止路径穿越
      const resolved = path.resolve(oldPath);
      if (resolved.startsWith(path.resolve(config.uploadDir)) && fs.existsSync(resolved)) {
        try { fs.unlinkSync(resolved); console.log(`  🗑  删除旧头像 ${old.avatar}`); }
        catch { /* 删不掉就算了，不影响功能 */ }
      }
    }

    await query('UPDATE user_profiles SET avatar = ? WHERE user_id = ?',
      [req.file.filename, req.uid]);

    const row = await getUserById(req.uid);
    return ok(res, {
      user: serializeProfile(row),
      filename: req.file.filename,
      size: req.file.size,
    }, '头像已更新');
  })
);

// ============================================================
//  POST /api/user/avatar-base64     上传头像（base64 方式）
//  请求体: { image: "data:image/png;base64,xxxx" }
//
//  为什么保留这个：
//    前端 settings.html 现在是用 FileReader 读成 base64 的，
//    走这个接口可以不改前端就先用起来。
//    但服务端会把它落成文件，数据库里只存文件名 ——
//    绝不能把 base64 直接存进数据库（一张 200KB 的图会变成 270KB 字符串）
// ============================================================
router.post('/avatar-base64', auth, wrap(async (req, res) => {
  const image = req.body.image || req.body.avatar;
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    throw new ApiError('请传 image 字段，内容是 data:image/... 开头的 base64', 400);
  }

  await ensureProfile(req.uid);

  const filename = saveDataUrlToFile(image, 'avatar');
  if (!filename) throw new ApiError('图片解析失败，或者不是有效的图片格式', 400);

  // 删旧头像
  const old = await queryOne('SELECT avatar FROM user_profiles WHERE user_id = ?', [req.uid]);
  if (old && old.avatar && !/^https?:\/\//i.test(old.avatar) && !old.avatar.startsWith('data:')) {
    const resolved = path.resolve(path.join(config.uploadDir, old.avatar));
    if (resolved.startsWith(path.resolve(config.uploadDir)) && fs.existsSync(resolved)) {
      try { fs.unlinkSync(resolved); } catch { /* 忽略 */ }
    }
  }

  await query('UPDATE user_profiles SET avatar = ? WHERE user_id = ?', [filename, req.uid]);

  const row = await getUserById(req.uid);
  return ok(res, {
    user: serializeProfile(row),
    filename,
    size: fs.statSync(path.join(config.uploadDir, filename)).size,
  }, '头像已更新');
}));

// ============================================================
//  DELETE /api/user/avatar      恢复默认头像
// ============================================================
router.delete('/avatar', auth, wrap(async (req, res) => {
  const old = await queryOne('SELECT avatar FROM user_profiles WHERE user_id = ?', [req.uid]);
  if (old && old.avatar && !/^https?:\/\//i.test(old.avatar) && !old.avatar.startsWith('data:')) {
    const resolved = path.resolve(path.join(config.uploadDir, old.avatar));
    if (resolved.startsWith(path.resolve(config.uploadDir)) && fs.existsSync(resolved)) {
      try { fs.unlinkSync(resolved); } catch { /* 忽略 */ }
    }
  }
  await query('UPDATE user_profiles SET avatar = "" WHERE user_id = ?', [req.uid]);

  const row = await getUserById(req.uid);
  return ok(res, { user: serializeProfile(row) }, '头像已恢复默认');
}));

// ============================================================
//  GET /api/user/search?q=xxx       搜人（昵称 或 uid）
//  给"找朋友"用，也方便前端调试
// ============================================================
// ============================================================
//  GET /api/user/qrcode?text=xxx    生成二维码（SVG）
//
//  ★ 必须放在 /:id 这类通配路由之前 ★
//    否则 /user/qrcode 会被当成「id = qrcode」去查用户，直接 404。
//
//  为什么放后端：前端自己画二维码得塞十几 KB 的库，
//  而 qrcode 这个包纯本地计算，服务端几毫秒出一张 SVG，不依赖任何在线接口。
// ============================================================
router.get('/qrcode', auth, wrap(async (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) throw new ApiError('缺少要编码的内容', 400);
  if (text.length > 512) throw new ApiError('内容太长了（最多 512 字）', 400);

  const svg = await QRCode.toString(text, {
    type: 'svg',
    margin: 1,
    width: 240,
    color: { dark: '#3f4a38', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
}));

router.get('/search', auth, wrap(async (req, res) => {
  const q = str(req.query.q, '搜索词', { required: true, max: 32 });

  // 数字就当 uid 精确查，否则按昵称模糊查
  let rows;
  if (/^\d{4,16}$/.test(q)) {
    rows = await query(
      `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province, p.zodiac
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.uid = ? LIMIT 20`,
      [q]
    );
  } else {
    // 注意 LIKE 的通配符要防注入：% 和 _ 是 LIKE 特殊字符，
    // 用户搜 "100%" 时会变成通配符，要转义
    const escaped = q.replace(/[\\%_]/g, c => '\\' + c);
    rows = await query(
      `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province, p.zodiac
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.nickname LIKE ? ESCAPE '\\\\' LIMIT 20`,
      [`%${escaped}%`]
    );
  }

  return ok(res, {
    q,
    list: rows.map(r => ({
      userId: r.id,
      uid: r.uid,
      nick: r.nickname,
      avatar: avatarUrl(r.avatar),
      signature: r.signature || '',
      province: r.province || '',
      zodiac: r.zodiac || '',
    })),
    total: rows.length,
  });
}));

// ============================================================
//  GET /api/user/:userId       看别人的资料（个人主页）
//
//  注意：这个必须放在最后，否则 /search 会被当成 userId 匹配
// ============================================================
router.get('/:userId', auth, wrap(async (req, res) => {
  // 支持传内部 id 或对外 uid
  const key = String(req.params.userId);
  const row = /^\d{1,10}$/.test(key) && key.length <= 10
    ? await getUserById(Number(key))
    : await getUserByUid(key);

  if (!row) throw new ApiError('这个人不存在', 404);

  const profile = serializeProfile(row);

  // 给前端补上"我和他的关系"，个人主页的按钮要用
  const isMine = Number(row.id) === Number(req.uid);
  let isFollowed = false;
  if (!isMine) {
    const f = await queryOne(
      'SELECT EXISTS(SELECT 1 FROM follows WHERE user_id = ? AND target_id = ?) AS f',
      [req.uid, row.id]
    );
    isFollowed = Boolean(f.f);
  }

  return ok(res, {
    user: profile,
    isMine,
    isFollowed,
    // 前端个人主页模板要的字段名（获赞/关注/粉丝）
    stats: {
      likes: profile.totalLikes,
      follows: profile.following,
      fans: profile.fans,
      diaryCount: profile.diaryCount,
    },
  });
}));

export default router;
