// ============================================================
//  用户信息的统一序列化
//
//  ★ 为什么需要这个文件 ★
//  原本 /api/auth/login 和 /api/auth/me 各自手写了一遍返回哪些字段，
//  结果 /me 漏了 uid（更隐蔽的是 loadUser 的 SQL 里根本没查 uid），
//  前端登录后显示 "ID: undefined"，刷新一下才对 —— 这种 bug 极难发现。
//
//  跑一次测试才抓出来。根治办法就是：只有一个地方决定返回哪些字段，
//  所有接口都调这个函数，想漂移都漂移不了。
// ============================================================

/**
 * 把数据库的用户行，转成可以返回给前端的形状
 *
 * 注意字段来源有两处：
 *   - users 表：id / uid / phone / nickname / created_at
 *   - user_profiles 表（LEFT JOIN 来的）：avatar / signature / addr / ...
 * 所以传进来的行必须包含这两张表的字段。
 *
 * @param {object} row  数据库查询结果（users LEFT JOIN user_profiles）
 * @returns {object|null}
 */
import { avatarUrl } from '../middleware/upload.js';

export function serializeUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    uid: row.uid,
    phone: row.phone,
    nickname: row.nickname || '',
    // 数据库里存的是文件名，这里转成能直接用的地址（相对路径 /uploads/xxx.jpg）
    avatar: avatarUrl(row.avatar),
    signature: row.signature || '',
    addr: row.addr || '',
    gender: row.gender || 'unknown',
    // 数据库里是 birth_year，前端习惯叫 birthYear
    birthYear: row.birth_year ?? null,
    zodiac: row.zodiac || '',
    province: row.province || '',
    status: row.status || 'normal',
    createdAt: row.created_at || null,
  };
}

/**
 * 检查一个用户对象该有的字段是否都在
 *
 * 用途：在测试里断言"两个接口返回的用户字段完全一致"。
 * 如果哪天有人给 /login 加了字段却忘了给 /me 加，这个检查会报出来。
 */
export const USER_FIELDS = [
  'id', 'uid', 'phone', 'nickname', 'avatar', 'signature',
  'addr', 'gender', 'birthYear', 'zodiac', 'province',
];
