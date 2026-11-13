// ============================================================
//  日记行的通用加工工具
//
//  为什么要单独抽出来：
//    diary.js（日记流）和 interact.js（我的喜欢/收藏）都需要
//    「把一批日记补上当前用户是否点过赞/收藏/关注」和
//    「转成前端要的字段形状」。
//    如果各写一份，改一处忘另一处就会出现字段不一致的诡异 bug。
//
//  ★ 关键性能点：批量查，不要一条条查
//    假设列表有 20 篇日记：
//      ❌ 错误做法：for 每篇 → 查一次点赞表   => 20 次查询（N+1 问题）
//      ✅ 正确做法：WHERE diary_id IN (...)   => 1 次查询
//    数据量小时看不出差别，几百条时就是一秒和几十毫秒的差距。
// ============================================================
import { query } from '../db/index.js';
import { relativeTime } from './validate.js';
import { avatarUrl } from '../middleware/upload.js';

/** 从 SQL 里去掉，方便调用处做 IN 查询的占位符 */
function placeholders(n) {
  return Array(n).fill('?').join(',');
}

/**
 * 给一批日记补上"当前用户视角"的状态
 *
 * @param {Array} rows        数据库查出来的原始行（必须含 id 和 user_id）
 * @param {number|null} viewerId  当前登录用户 id，未登录传 null
 * @returns {Promise<Array>}  每行多了 isLiked/isSaved/isFollowed/isMine
 */
export async function attachUserState(rows, viewerId) {
  if (!rows || rows.length === 0) return rows || [];

  const ids = rows.map(r => r.id);
  const authorIds = [...new Set(rows.map(r => r.user_id))];

  let likedSet = new Set();
  let savedSet = new Set();
  let followedSet = new Set();

  if (viewerId) {
    // 三次查询搞定，而不是 3 × N 次
    const [liked, saved, followed] = await Promise.all([
      query(
        `SELECT diary_id FROM likes WHERE user_id = ? AND diary_id IN (${placeholders(ids.length)})`,
        [viewerId, ...ids]
      ),
      query(
        `SELECT diary_id FROM favorites WHERE user_id = ? AND diary_id IN (${placeholders(ids.length)})`,
        [viewerId, ...ids]
      ),
      query(
        `SELECT target_id FROM follows WHERE user_id = ? AND target_id IN (${placeholders(authorIds.length)})`,
        [viewerId, ...authorIds]
      ),
    ]);

    likedSet = new Set(liked.map(r => Number(r.diary_id)));
    savedSet = new Set(saved.map(r => Number(r.diary_id)));
    followedSet = new Set(followed.map(r => Number(r.target_id)));
  }

  return rows.map(r => ({
    ...r,
    isLiked: likedSet.has(Number(r.id)),
    isSaved: savedSet.has(Number(r.id)),
    isFollowed: followedSet.has(Number(r.user_id)),
    isMine: viewerId !== null && Number(r.user_id) === Number(viewerId),
  }));
}

/**
 * 把数据库的一行日记，转成前端期望的形状
 *
 * 字段名要和旧版 data.js 的假数据保持一致（nick/avatar/uid/ip/likes），
 * 这样前端模板几乎不用改：
 *   原来：{ id, nick, avatar, uid, ip, likes, time, text, img }
 *   现在：一模一样，只是数据来自数据库
 */
/**
 * 日记封图地址归一化
 *
 * 库里的 img 有三种历史存法：
 *   demo_5.svg                              ← 裸文件名（早先的种子数据）
 *   http://127.0.0.1:3000/uploads/demo_5.svg ← 绝对地址
 *   http://10.154.206.228:8080/uploads/…    ← 换过网络的旧 IP，已经访问不了
 *   assets/diary-month/07.jpg               ← 前端自带素材
 *
 * 统一成 /uploads/xxx 这种相对路径：
 *   - 换 IP、换端口都不会坏
 *   - 前端自带素材（assets/开头）原样保留
 */
function coverUrl(v) {
  if (!v) return '';
  const s = String(v);

  if (s.startsWith('data:')) return s;
  if (s.startsWith('assets/')) return s;

  // 绝对地址 → 只留 /uploads/ 后面那段（我们自己上传的图）
  const m = s.match(/^https?:\/\/[^/]+(\/uploads\/.+)$/i);
  if (m) return m[1];

  // ★ 其它绝对地址（外链图）原样保留 ★
  //   以前走到最后会被拼成 "/uploads/https://example.com/a.jpg"，整条链接就废了。
  if (/^https?:\/\//i.test(s)) return s;

  // 已经是 /uploads/ 开头
  if (s.startsWith('/')) return s;

  // 裸文件名
  return '/uploads/' + s;
}
export function serializeDiary(row) {
  return {
    id: row.id,
    text: row.text,
    img: coverUrl(row.img),
    isPublic: Boolean(row.is_public),
    dateKey: row.date_key,
    time: relativeTime(row.created_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    // 作者
    userId: row.user_id,
    nick: row.nickname,
    // ★ 必须经过 avatarUrl 转换！
    //   数据库里存的是文件名（avatar_171234_ab12.jpg），
    //   直接返回给前端的话，浏览器会把它当相对路径解析到前端自己的目录，
    //   头像就显示不出来。avatarUrl 会拼成 http://后端地址/uploads/xxx.jpg
    avatar: avatarUrl(row.avatar),
    uid: row.uid,
    ip: row.province || '',

    // 计数
    likes: Number(row.like_count) || 0,
    comments: Number(row.comment_count) || 0,
    saves: Number(row.favorite_count) || 0,     // 收藏数（实时数 favorites）
    views: Number(row.view_count) || 0,

    // 当前用户视角
    isLiked: Boolean(row.isLiked),
    isSaved: Boolean(row.isSaved),
    isFollowed: Boolean(row.isFollowed),
    isMine: Boolean(row.isMine),

    // ---- 前端契约别名 ----
    // 新前端（十九稿）用的是 content / cover / day / author / likeCount 这套名字，
    // 后端直接把两套字段一起返回，前端就不用再做转换了。
    content: row.text,
    cover: coverUrl(row.img),
    day: row.date_key,
    visibility: row.is_public ? 'public' : 'private',
    likeCount: Number(row.like_count) || 0,
    commentCount: Number(row.comment_count) || 0,
    liked: Boolean(row.isLiked),
    saved: Boolean(row.isSaved),
    followed: Boolean(row.isFollowed),
    author: {
      id: row.user_id,
      nickname: row.nickname,
      avatar: avatarUrl(row.avatar),
    },
  };
}

/**
 * 日记的基础查询语句（JOIN 出作者信息和资料）
 * 调用处只要在末尾接 WHERE / ORDER BY 就行
 */
export const DIARY_SELECT = `
  SELECT d.id, d.user_id, d.text, d.img, d.is_public, d.date_key,
         d.like_count, d.comment_count, d.view_count,
         -- 收藏数：没有冗余字段，直接数 favorites（量小，相关子查询够用）
         (SELECT COUNT(*) FROM favorites fv WHERE fv.diary_id = d.id) AS favorite_count,
         d.created_at, d.updated_at,
         u.nickname, u.uid,
         p.avatar, p.province
    FROM diaries d
    JOIN users u        ON u.id = d.user_id
    LEFT JOIN user_profiles p ON p.user_id = d.user_id
`;
