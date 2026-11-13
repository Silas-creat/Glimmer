// ============================================================
//  浏览记录 / 举报
//
//  这两张表（view_logs、reports）在 schema.sql 里一直都有，
//  但从来没有接口用过——前端「浏览记录」「举报记录」点进去是空占位页。
//  这里把它们接上。
//
//  ★ 浏览记录为什么用"覆盖"而不是"追加" ★
//    view_logs 上有 UNIQUE(user_id, diary_id)，
//    同一个人看同一篇只保留最后一次时间。
//    否则反复刷同一篇会把列表刷满，看不出"我最近看过什么"。
// ============================================================
import express from 'express';
import { query, queryOne } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { int, str } from '../utils/validate.js';
import { auth } from '../middleware/auth.js';
import { avatarUrl } from '../middleware/upload.js';
import { DIARY_SELECT, serializeDiary, attachUserState } from '../utils/diaryHelper.js';

const router = express.Router();

// ============================================================
//  POST /api/view/:diaryId   记一条浏览记录
// ============================================================
router.post('/view/:diaryId', auth, wrap(async (req, res) => {
  const diaryId = int(req.params.diaryId, '日记ID', { min: 1 });

  // 只能记录"我能看到"的日记
  const diary = await queryOne(
    'SELECT id, user_id, is_public FROM diaries WHERE id = ?',
    [diaryId]
  );
  if (!diary) throw new ApiError('内容不存在', 404);
  if (!diary.is_public && Number(diary.user_id) !== Number(req.uid)) {
    throw new ApiError('内容不存在', 404);
  }

  // 看自己的日记不用记
  if (Number(diary.user_id) === Number(req.uid)) {
    return ok(res, { recorded: false, reason: '自己的日记不记浏览' });
  }

  await query(
    `INSERT INTO view_logs (user_id, diary_id, created_at)
     VALUES (?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE created_at = NOW(3)`,
    [req.uid, diaryId]
  );

  return ok(res, { recorded: true });
}));

// ============================================================
//  GET /api/view/mine   我最近看过的
// ============================================================
router.get('/view/mine', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM view_logs WHERE user_id = ?',
    [req.uid]
  );
  const total = Number(totalRow?.total) || 0;

  const rows = await query(
    `${DIARY_SELECT}
       JOIN view_logs v ON v.diary_id = d.id AND v.user_id = ?
      WHERE d.is_public = 1 OR d.user_id = ?
      ORDER BY v.created_at DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid, req.uid]
  );

  const withState = await attachUserState(rows, req.uid);

  return ok(res, {
    list: withState.map(serializeDiary),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// ============================================================
//  POST /api/report   举报
//  请求体：{ targetType: 'diary'|'comment'|'user'|'message', targetId, reason }
// ============================================================
const TYPES = ['diary', 'comment', 'user', 'message'];

// Creation and history use the same access rules. A report is not a permanent
// grant to read a diary that has since become private, or another user's DM.
async function visibleReportTarget(type, id, viewerId) {
  if (type === 'diary') {
    return queryOne(
      `SELECT d.text AS content, d.date_key, d.created_at, u.nickname, p.avatar
         FROM diaries d
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN user_profiles p ON p.user_id = d.user_id
        WHERE d.id = ? AND (d.is_public = 1 OR d.user_id = ?)`,
      [id, viewerId]
    );
  }
  if (type === 'comment') {
    return queryOne(
      `SELECT c.content, c.created_at, c.diary_id, u.nickname, p.avatar
         FROM comments c
         JOIN diaries d ON d.id = c.diary_id
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN user_profiles p ON p.user_id = c.user_id
        WHERE c.id = ? AND c.status = 'normal'
          AND (d.is_public = 1 OR d.user_id = ?)`,
      [id, viewerId]
    );
  }
  if (type === 'message') {
    return queryOne(
      `SELECT m.content, m.created_at, u.nickname, p.avatar
         FROM messages m
         JOIN conversations cv ON cv.id = m.conv_id
         LEFT JOIN users u ON u.id = m.from_user
         LEFT JOIN user_profiles p ON p.user_id = m.from_user
        WHERE m.id = ? AND m.to_user = ? AND m.from_user <> ?
          AND m.status = 'normal' AND m.is_sys = 0
          AND ((cv.user_a = m.to_user AND cv.user_b = m.from_user)
            OR (cv.user_b = m.to_user AND cv.user_a = m.from_user))`,
      [id, viewerId, viewerId]
    );
  }
  if (type === 'user') {
    return queryOne(
      `SELECT u.nickname, u.uid, p.avatar, p.signature AS content
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = ?`,
      [id]
    );
  }
  return null;
}

router.post('/report', auth, wrap(async (req, res) => {
  const targetType = str(req.body.targetType, '举报类型', { required: true, max: 16 });
  if (!TYPES.includes(targetType)) throw new ApiError('举报类型不对', 400);

  const targetId = int(req.body.targetId, '举报对象', { min: 1 });
  const reason = str(req.body.reason, '举报理由', { required: false, max: 255, def: '' });

  // 不许举报自己
  if (targetType === 'user' && Number(targetId) === Number(req.uid)) {
    throw new ApiError('不能举报自己', 400);
  }

  if (targetType === 'message') {
    const own = await queryOne('SELECT id FROM messages WHERE id = ? AND from_user = ?', [targetId, req.uid]);
    if (own) throw new ApiError('这是你自己发的消息', 400);
  }
  if (!await visibleReportTarget(targetType, targetId, req.uid)) {
    throw new ApiError('内容不存在或不可见', 404);
  }

  // 不能重复举报同一个对象（还在 pending 的）
  const dup = await queryOne(
    "SELECT id FROM reports WHERE user_id = ? AND target_type = ? AND target_id = ? AND status = 'pending'",
    [req.uid, targetType, targetId]
  );
  if (dup) throw new ApiError('你已经举报过了，我们会尽快处理', 409);

  const info = await query(
    'INSERT INTO reports (user_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)',
    [req.uid, targetType, targetId, reason]
  );

  return ok(res, { id: Number(info.insertId) }, '已提交，我们会尽快处理');
}));

// ============================================================
//  GET /api/report/mine   我的举报记录
// ============================================================
router.get('/report/mine', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM reports WHERE user_id = ?',
    [req.uid]
  );
  const total = Number(totalRow?.total) || 0;

  const rows = await query(
    `SELECT id, target_type, target_id, reason, status, created_at
       FROM reports WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  const STATUS_TEXT = { pending: '处理中', handled: '已处理', rejected: '不予处理' };

  const list = [];
  for (const r of rows) {
    const target = await visibleReportTarget(r.target_type, r.target_id, req.uid);
    let targetInfo = null;
    if (target) {
      targetInfo = {
        nick: target.nickname || '已注销用户',
        avatar: avatarUrl(target.avatar),
        content: String(target.content || '').slice(0, 300),
      };
      if (r.target_type === 'user') targetInfo.uid = target.uid;
      else targetInfo.createdAt = target.created_at;
      if (r.target_type === 'diary') targetInfo.dateKey = target.date_key;
      if (r.target_type === 'comment') targetInfo.diaryId = Number(target.diary_id);
    }
    list.push({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason || '',
      status: r.status,
      statusText: STATUS_TEXT[r.status] || r.status,
      createdAt: r.created_at,
      targetInfo,
    });
  }

  return ok(res, {
    list,
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

export default router;
