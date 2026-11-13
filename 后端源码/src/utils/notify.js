// ============================================================
//  互动消息（通知）
//
//  前端在「好友」页顶部已经写好 UI，等的是这个接口：
//    GET  /api/interact/notifications?limit=20
//    POST /api/interact/notifications/read
//
//  ★ 三条规则（前端文档里定的）★
//    1. 自己给自己点赞/评论 → 不生成
//    2. 同一个人对同一篇的"赞/收藏"只保留一条（重复点只刷新时间）
//    3. 评论不去重：每条评论都是独立一条
// ============================================================
import { query, queryOne, insert } from '../db/index.js';

/**
 * 写一条互动消息
 * @param {object} o
 * @param {number} o.toUserId   被互动的人（收通知的）
 * @param {number} o.fromUserId 发起互动的人
 * @param {string} o.type       like | favorite | comment
 * @param {number} o.diaryId
 * @param {number} [o.commentId]
 * @param {string} [o.content]  评论正文
 */
// 注意：diaryId 默认 null —— 祝福类通知没有对应日记，
// 而 mysql2 的 execute 不接受 undefined（会直接抛错）。
export async function pushNotification({ toUserId, fromUserId, type, diaryId = null, commentId = null, content = '' }) {
  // 自己互动自己，不打扰
  if (Number(toUserId) === Number(fromUserId)) return null;

  // 赞 / 收藏：同一个人对同一篇只留一条，重复操作只把时间刷新
  if (type === 'like' || type === 'favorite') {
    const old = await queryOne(
      'SELECT id FROM notifications WHERE to_user_id = ? AND from_user_id = ? AND type = ? AND diary_id = ?',
      [toUserId, fromUserId, type, diaryId]
    );
    if (old) {
      await query(
        'UPDATE notifications SET is_read = 0, created_at = NOW(3) WHERE id = ?',
        [old.id]
      );
      return old.id;
    }
  }

  const id = await insert(
    `INSERT INTO notifications (to_user_id, from_user_id, type, diary_id, comment_id, content)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [toUserId, fromUserId, type, diaryId, commentId, String(content || '').slice(0, 255)]
  );
  return id;
}

export default { pushNotification };
