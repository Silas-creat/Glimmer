// ============================================================
//  JWT 令牌工具
//  作用：用户登录成功后发一张"电子门票"（token）给前端，
//  之后每次请求带上它，后端就知道"你是谁"，不用再输密码。
// ============================================================
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/**
 * 签发令牌
 * @param {{id:number, phone:string}} user
 */
export function signToken(user) {
  return jwt.sign(
    // sv = session_version：每次登录都会 +1，
    // 旧设备的 token 带着旧的 sv，校验时就对不上 → 自动掉线。
    { uid: user.id, phone: user.phone, sv: user.session_version || 0 },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

/**
 * 校验令牌
 * @returns {object|null} 解出来的 { uid, phone, iat, exp }，非法返回 null
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch {
    return null;
  }
}

/** 从请求头里把 token 抠出来（支持 Authorization: Bearer xxx） */
export function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  // 也允许 ?token=xxx（浏览器直接打开图片之类不方便带 header 的场景）
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}
