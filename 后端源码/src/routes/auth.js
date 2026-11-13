// ============================================================
//  登录模块
//
//  流程：
//    1. 前端调 POST /api/auth/send-code  传手机号
//       后端生成6位验证码，存数据库，开发期直接打在控制台
//    2. 前端调 POST /api/auth/login  传手机号 + 验证码
//       后端校验通过 → 如果是新号就自动注册 → 发一张 token 给前端
//    3. 之后所有请求带上这个 token，后端就知道你是谁
//
//  换设备继续聊天的原理：token 存在浏览器 localStorage，
//  换个设备重新登录拿到新 token，但 user_id 是同一个，
//  聊天记录/日记/点赞全在服务器上按 user_id 存，所以都还在。
// ============================================================
import express from 'express';
import { config } from '../config/index.js';
import { query, queryOne, transaction } from '../db/index.js';
import { ok, wrap, ApiError } from '../utils/response.js';
import { isPhone, isCode } from '../utils/validate.js';
import { signToken } from '../utils/jwt.js';
import { auth } from '../middleware/auth.js';
import { serializeUser } from '../utils/userHelper.js';

const router = express.Router();

// ------------------------------------------------------------
//  工具：生成对外展示的 uid
//  前端 data.js 里的 uid 长这样：'34954130101'（11位数字）
//  我们沿用这个风格，随机生成，撞了就重试
// ------------------------------------------------------------
async function generateUid() {
  for (let i = 0; i < 20; i++) {
    // 第一位 3-9，后面 10 位随机，凑够 11 位
    let uid = String(3 + Math.floor(Math.random() * 7));
    for (let j = 0; j < 10; j++) uid += Math.floor(Math.random() * 10);
    const exists = await queryOne('SELECT id FROM users WHERE uid = ?', [uid]);
    if (!exists) return uid;
  }
  throw new ApiError('生成用户ID失败，请重试', 500);
}

// ------------------------------------------------------------
//  工具：生成 6 位数字验证码
// ------------------------------------------------------------
function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============================================================
//  POST /api/auth/send-code    发送验证码
//  请求体: { phone: "13800138000" }
// ============================================================
router.post('/send-code', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').trim();

  if (!isPhone(phone)) {
    throw new ApiError('手机号格式不对，要 11 位数字', 400);
  }

  // 频控：同一手机号 60 秒内只能发一次，防止被人刷短信
  const recent = await queryOne(
    `SELECT created_at,
            UNIX_TIMESTAMP(NOW(3)) - UNIX_TIMESTAMP(created_at) AS ago
       FROM sms_codes
      WHERE phone = ?
      ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  if (recent && recent.ago < config.sms.sendInterval) {
    const wait = config.sms.sendInterval - recent.ago;
    throw new ApiError(`太频繁了，请 ${wait} 秒后再试`, 429);
  }

  const code = randomCode();

  await query(
    `INSERT INTO sms_codes (phone, code, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND))`,
    [phone, code, config.sms.codeTtl]
  );

  // ===== 开发期：不发真短信，直接打印在控制台 =====
  // 以后接阿里云/腾讯云短信，就把这里换成调用他们的 SDK
  if (config.sms.enabled) {
    // TODO: 真实短信通道
    console.log(`[短信] 给 ${phone} 发送验证码 ${code}（真实通道还没接）`);
  } else {
    console.log('');
    console.log('  ┌─────────────────────────────────────┐');
    console.log(`  │  📱 手机号 ${phone}`);
    console.log(`  │  🔑 验证码 ${code}`);
    console.log(`  │  （万能码 ${config.sms.devCode} 也能登录）`);
    console.log('  └─────────────────────────────────────┘');
    console.log('');
  }

  // 注意：开发期把 code 返回给前端方便测试；
  // 上线前要把 devCode 这段删掉，绝不能把验证码返回给前端！
  const data = { sent: true, ttl: config.sms.codeTtl };
  if (config.isDev) {
    data.devCode = config.sms.devCode;
    data.code = code;
  }

  return ok(res, data, '验证码已发送');
}));

// ============================================================
//  POST /api/auth/login    验证码登录（新号自动注册）
//  请求体: { phone: "13800138000", code: "123456" }
//  返回:   { token, user }
// ============================================================
router.post('/login', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  // 兼容两种叫法：
  //   后端原生 ：{ phone, code }
  //   新前端   ：{ phone, password }   ← 界面上的输入框叫"密码"
  // 开发环境里万能码就是 123456，所以两者等价；正式环境接短信后
  // 只认 code，password 这条会被 isCode 校验挡掉。
  const code = String(req.body.code || req.body.password || '').trim();

  if (!isPhone(phone)) throw new ApiError('手机号格式不对', 400);
  if (!isCode(code)) throw new ApiError('验证码要 6 位数字', 400);

  // ---- 校验验证码 ----
  let pass = false;

  // 1) 万能码（开发期用，正式环境自动失效）
  if (config.isDev && code === config.sms.devCode) {
    pass = true;
  }

  // 2) 数据库里真实发出去的码
  if (!pass) {
    const row = await queryOne(
      `SELECT id FROM sms_codes
        WHERE phone = ? AND code = ? AND used = 0 AND expires_at > NOW(3)
        ORDER BY id DESC LIMIT 1`,
      [phone, code]
    );
    if (row) {
      pass = true;
      await query('UPDATE sms_codes SET used = 1 WHERE id = ?', [row.id]);
    }
  }

  if (!pass) throw new ApiError('验证码不对或已过期', 400);

  // ---- 查用户，没有就注册 ----
  let user = await queryOne('SELECT * FROM users WHERE phone = ?', [phone]);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const uid = await generateUid();
    // 新用户默认昵称用"微光+uid后4位"
    // （原来是"陪着"，那是项目早期的名字；现在全站叫微光同行，
    //   新注册的人顶着旧品牌一进来就露馅，验收清单里也要求不出现"陪着"）
    const nickname = '微光' + uid.slice(-4);

    const newId = await transaction(async (conn) => {
      const [r] = await conn.execute(
        `INSERT INTO users (phone, uid, nickname, last_login)
         VALUES (?, ?, ?, NOW(3))`,
        [phone, uid, nickname]
      );
      const id = r.insertId;
      // 同时建一条空资料，后面改头像/签名就是 UPDATE 这条
      await conn.execute(
        'INSERT INTO user_profiles (user_id) VALUES (?)',
        [id]
      );
      return id;
    });

    user = await queryOne('SELECT * FROM users WHERE id = ?', [newId]);
    console.log(`  🎉 新用户注册: ${nickname} (uid=${uid}, phone=${phone})`);
  } else {
    if (user.status === 'banned') throw new ApiError('这个账号已被封禁', 403);
  }

  // ---- 单点登录：换设备就把旧的顶下线 ----
  //
  //  每条 token 里带着 session_version（签发那一刻的值）。
  //    · 换一台设备登录 → 版本号 +1 → 旧设备那张票立刻失效
  //      （旧设备下一次请求收到 401「账号已在别处登录」）
  //    · 同一台设备再登录 → 不动版本号
  //      （刷新页面、重复登录都属于这种情况，不该把自己踢下线）
  //    · 没带 deviceId 的调用（curl / 自动化测试）→ 不做限制
  //
  //  设备标识由前端生成（localStorage 里的随机串），登录时带上来。
  const deviceId = String(req.body.deviceId || req.headers['x-device-id'] || '').trim().slice(0, 64);

  if (deviceId && user.session_device && user.session_device !== deviceId) {
    // 换设备了：作废之前的票
    await query(
      'UPDATE users SET last_login = NOW(3), session_version = session_version + 1, session_device = ? WHERE id = ?',
      [deviceId, user.id]
    );
    user = await queryOne('SELECT * FROM users WHERE id = ?', [user.id]);
  } else {
    // 同设备 / 没带设备标识：只更新登录时间，顺便记住设备
    await query(
      'UPDATE users SET last_login = NOW(3), session_device = COALESCE(?, session_device) WHERE id = ?',
      [deviceId || null, user.id]
    );
  }

  // ---- 签发 token ----
  const token = signToken(user);
  const profile = await queryOne(
    'SELECT avatar, signature, addr, gender, birth_year, zodiac, province FROM user_profiles WHERE user_id = ?',
    [user.id]
  );

  console.log(`  ✅ 登录成功: ${user.nickname} (uid=${user.uid})${isNewUser ? ' [新注册]' : ''}`);

  // ★ 用统一的 serializeUser，保证和 /api/auth/me 返回的字段一模一样。
  //   以前这里手写了一遍字段列表，结果和 /me 漂移了（/me 少了 uid）。
  const merged = { ...user, ...(profile || {}) };

  return ok(res, {
    token,
    isNewUser,
    user: serializeUser(merged),
  }, isNewUser ? '注册并登录成功' : '登录成功');
}));

// ============================================================
//  POST /api/auth/register    显式创建账号
//  请求体: { phone, code, nickname }
//  返回:   { token, user }
//
//  和 /login 的区别：
//    /login 是"新号自动注册，昵称是系统给的微光XXXX"；
//    这里是用户自己填昵称，而且要求手机号【没注册过】——
//    已经存在的号直接 409，提示他去登录，避免"以为注册了其实是登录"。
// ============================================================
router.post('/register', wrap(async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const code = String(req.body.code || req.body.password || '').trim();
  const nickname = String(req.body.nickname || '').trim();

  if (!isPhone(phone)) throw new ApiError('手机号格式不对', 400);
  if (!isCode(code)) throw new ApiError('验证码要 6 位数字', 400);
  if (nickname.length < 2 || nickname.length > 16) {
    throw new ApiError('昵称长度要在 2 到 16 个字之间', 400);
  }

  // ---- 校验验证码（和登录同一套规则）----
  let pass = false;
  if (config.isDev && code === config.sms.devCode) pass = true;
  if (!pass) {
    const row = await queryOne(
      `SELECT id FROM sms_codes
        WHERE phone = ? AND code = ? AND used = 0 AND expires_at > NOW(3)
        ORDER BY id DESC LIMIT 1`,
      [phone, code]
    );
    if (row) {
      pass = true;
      await query('UPDATE sms_codes SET used = 1 WHERE id = ?', [row.id]);
    }
  }
  if (!pass) throw new ApiError('验证码不对或已过期', 400);

  // ---- 手机号必须没注册过 ----
  const exists = await queryOne('SELECT id FROM users WHERE phone = ?', [phone]);
  if (exists) throw new ApiError('这个手机号已经注册过了，直接登录就行', 409);

  // ---- 昵称不能和别人重名（@ 是按昵称找人的，重名会认错人）----
  const dupNick = await queryOne('SELECT id FROM users WHERE nickname = ? LIMIT 1', [nickname]);
  if (dupNick) throw new ApiError('这个昵称已经有人用了，换一个吧', 409);

  // ---- 建账号 ----
  const uid = await generateUid();
  const newId = await transaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO users (phone, uid, nickname, last_login)
       VALUES (?, ?, ?, NOW(3))`,
      [phone, uid, nickname]
    );
    const id = r.insertId;
    await conn.execute('INSERT INTO user_profiles (user_id) VALUES (?)', [id]);
    return id;
  });

  const regDevice = String(req.body.deviceId || req.headers['x-device-id'] || '').trim().slice(0, 64);
  if (regDevice) {
    await query('UPDATE users SET session_device = ? WHERE id = ?', [regDevice, newId]);
  }

  const user = await queryOne('SELECT * FROM users WHERE id = ?', [newId]);
  const profile = await queryOne(
    'SELECT avatar, signature, addr, gender, birth_year, zodiac, province FROM user_profiles WHERE user_id = ?',
    [newId]
  );

  console.log(`  🎉 创建账号: ${nickname} (uid=${uid}, phone=${phone})`);

  return ok(res, {
    token: signToken(user),
    isNewUser: true,
    user: serializeUser({ ...user, ...(profile || {}) }),
  }, '账号创建成功');
}));

// ============================================================
//  GET /api/auth/me    用 token 换当前用户信息
//  作用：前端刷新页面后，拿本地存的 token 来问"我还是谁吗"
// ============================================================
router.get('/me', auth, wrap(async (req, res) => {
  // ★ 和 /api/auth/login 共用同一个 serializeUser，
  //   保证两个接口返回的用户字段完全一致（以前这里漏了 uid）
  return ok(res, { user: serializeUser(req.user) });
}));

// ============================================================
//  POST /api/auth/logout    退出登录
//  说明：JWT 是无状态的，服务端删不掉已发的 token，
//  真正的"退出"是前端把 localStorage 里的 token 删掉。
//  这个接口存在只是让前端有个明确动作，顺便记个日志。
// ============================================================
router.post('/logout', auth, wrap(async (req, res) => {
  console.log(`  👋 用户退出: ${req.user.nickname}`);
  return ok(res, null, '已退出登录');
}));

export default router;
