// ============================================================
//  用户资料查询
//
//  资料分散在两张表：
//    users          → id / uid / phone / nickname / status
//    user_profiles  → avatar / signature / addr / gender / birth_year / ...
//
//  所有需要"完整用户信息"的地方都调这里的函数，
//  避免像之前那样每个接口各写一条 SQL、字段来回漂移。
// ============================================================
import { queryOne, query } from '../db/index.js';
import { avatarUrl } from '../middleware/upload.js';
import { ageOf, ageGroupOf } from './zodiac.js';

/** 完整用户信息的 SELECT 片段（调用处自己接 WHERE） */
export const USER_SELECT = `
  SELECT u.id, u.uid, u.phone, u.nickname, u.status, u.created_at, u.last_login,
         p.avatar, p.signature, p.addr, p.gender, p.birth_year,
         p.zodiac, p.province, p.cover,
         (SELECT COUNT(*) FROM follows f WHERE f.target_id = u.id) AS fans,
         (SELECT COUNT(*) FROM follows f WHERE f.user_id   = u.id) AS following,
         (SELECT COUNT(*) FROM diaries d WHERE d.user_id = u.id AND d.is_public = 1) AS diary_count,
         (SELECT COALESCE(SUM(d.like_count), 0) FROM diaries d
           WHERE d.user_id = u.id AND d.is_public = 1) AS total_likes
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
`;

/** 按内部 id 取完整用户信息 */
export async function getUserById(id) {
  return queryOne(`${USER_SELECT} WHERE u.id = ?`, [id]);
}

/** 按对外 uid 取完整用户信息 */
export async function getUserByUid(uid) {
  return queryOne(`${USER_SELECT} WHERE u.uid = ?`, [uid]);
}

/** 按昵称取（可能重名，返回数组） */
export async function getUsersByNick(nick) {
  return query(`${USER_SELECT} WHERE u.nickname = ?`, [nick]);
}

/**
 * 把用户行转成前端要的形状
 *
 * 注意 avatar 会从"文件名"变成"完整 URL"：
 *   数据库存   avatar_171234_ab12.jpg
 *   前端收到   http://127.0.0.1:3000/uploads/avatar_171234_ab12.jpg
 */
export function serializeProfile(row) {
  if (!row) return null;

  const birthYear = row.birth_year ?? null;

  return {
    id: row.id,
    uid: row.uid,
    phone: row.phone,
    nickname: row.nickname || '',
    avatar: avatarUrl(row.avatar),
    avatarFile: row.avatar || '',     // 原始文件名，改头像时对照用
    signature: row.signature || '',
    addr: row.addr || '',
    gender: row.gender || 'unknown',
    birthYear,
    // 顺便算好年龄和年龄段，前端不用自己算
    age: ageOf(birthYear),
    ageGroup: ageGroupOf(birthYear),
    zodiac: row.zodiac || '',
    province: row.province || '',
    cover: avatarUrl(row.cover),
    status: row.status || 'normal',

    // 统计数字（个人主页顶部那三个）
    fans: Number(row.fans ?? 0),
    following: Number(row.following ?? 0),
    diaryCount: Number(row.diary_count ?? 0),
    totalLikes: Number(row.total_likes ?? 0),

    createdAt: row.created_at || null,
    lastLogin: row.last_login || null,
  };
}

/**
 * 确保用户有一条 user_profiles 记录
 *
 * 为什么需要：理论上登录时会自动建，但如果数据库是手工改过、
 * 或者老数据缺行，UPDATE 就会影响 0 行、静默失败。
 * 所以改资料前先确保这行存在。
 */
export async function ensureProfile(userId) {
  const exists = await queryOne('SELECT user_id FROM user_profiles WHERE user_id = ?', [userId]);
  if (exists) return false;

  await query('INSERT INTO user_profiles (user_id) VALUES (?)', [userId]);
  return true;   // 表示这次新建了
}
