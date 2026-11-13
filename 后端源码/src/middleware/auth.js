// ============================================================
//  登录校验中间件
//  auth       —— 必须登录，没登录直接 401
//  authOptional —— 登录了就把 req.user 填上，没登录也放行
// ============================================================
import { extractToken, verifyToken } from '../utils/jwt.js';
import { queryOne } from '../db/index.js';
import { ApiError } from '../utils/response.js';

/** 根据 token 里的 uid 去数据库捞最新用户信息 */
async function loadUser(uid) {
  return queryOne(
    // ★ 别漏字段！这里漏了 u.uid 就会导致 /me 返回的用户没有 uid，
    //   而 /login 里是从 users 表直接查的、有 uid —— 两个接口字段不一致，
    //   前端登录后显示 "ID: undefined"，刷新一下才对。
    //   （undefined 字段会被 JSON.stringify 整个丢掉，所以不是 null 而是"没有这个键"）
    `SELECT u.id, u.uid, u.phone, u.nickname, u.status, u.created_at, u.session_version,
            p.avatar, p.signature, p.addr, p.gender, p.birth_year, p.zodiac, p.province
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
    [uid]
  );
}

export async function auth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw new ApiError('还没登录，请先登录', 401);

    const payload = verifyToken(token);
    if (!payload) throw new ApiError('登录已过期，请重新登录', 401);

    const user = await loadUser(payload.uid);
    if (!user) throw new ApiError('这个账号不存在了', 401);
    if (user.status === 'banned') throw new ApiError('账号已被封禁', 403);

    // ★ 单点登录：账号在别处登录过，这张票就作废了 ★
    //   session_version 每次登录 +1；token 里带的是签发那一刻的值。
    //   老 token 的 sv 比库里的旧 → 判定"被踢下线"。
    if (Number(payload.sv || 0) !== Number(user.session_version || 0)) {
      throw new ApiError('账号已在别处登录，请重新登录', 401);
    }

    req.user = user;
    req.uid = user.id;
    next();
  } catch (e) {
    next(e);
  }
}

export async function authOptional(req, res, next) {
  try {
    const token = extractToken(req);
    if (token) {
      const payload = verifyToken(token);
      if (payload) {
        const user = await loadUser(payload.uid);
        const svOk = user && Number(payload.sv || 0) === Number(user.session_version || 0);
        if (svOk && user.status !== 'banned') {
          req.user = user;
          req.uid = user.id;
        }
      }
    }
  } catch {
    // 可选登录：出错就当没登录，不打断请求
  }
  next();
}
