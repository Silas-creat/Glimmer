// ============================================================
//  评论模块
//
//  对应前端：
//    diary-public.html   日记卡片里的 💬 按钮 → 弹出评论面板
//                        （现在只在本地假加一条，写着"评论暂未真正发送"）
//
//  ★ 设计决定 ★
//    1. 只支持两级：直接评论 + 回复评论（parent_id）。
//       无限嵌套在手机上根本没法看，而且实现复杂度陡增。
//       回复的回复，仍然挂在最初那条评论下面。
//    2. 只有能看到日记的人才能评论（私密日记别人压根看不到）
//    3. 用数据库事务保证"插评论"和"更新评论数"要么都成、要么都不成
//    4. 危机信号特殊处理：不拦截，但返回关怀提示（见 moderation.js）
// ============================================================
import express from 'express';
import { query, queryOne, insert, execute, transaction } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, int } from '../utils/validate.js';
import { auth, authOptional } from '../middleware/auth.js';
import { moderate, detectCrisis, HELP_LINES } from '../utils/moderation.js';
import { avatarUrl } from '../middleware/upload.js';
import { relativeTime } from '../utils/validate.js';
import { pushNotification } from '../utils/notify.js';
import { trySendDirectMessage } from '../utils/dm.js';


/**
 * 从评论内容里找出 @昵称
 *
 * 只认 @ 后面连续的、不是空格/标点的字符（最多 20 个）。
 * 中文昵称、英文昵称都能匹配；
 * 「回复 @小海：谢谢」这种前端拼出来的前缀不会被存进库，所以不用担心误伤。
 */
function extractMentions(text) {
  const out = new Set();
  const re = /@([^\s@：:，,。.！!?？、\/\\]{1,20})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const nick = m[1].trim();
    if (nick) out.add(nick);
  }
  return Array.from(out);
}

const router = express.Router();

function careFor(text) {
  return detectCrisis(text) ? {
    message: '看到你写的这些，你愿意说出来，已经很难得了。'
      + '如果你现在很难受，可尝试联系以下支持渠道。',
    lines: HELP_LINES,
  } : null;
}

// ------------------------------------------------------------
//  评论查询：把评论者和被回复者的昵称头像一起带出来
//  为什么要带"被回复者的昵称"：前端要显示"回复 @某某"
// ------------------------------------------------------------
const COMMENT_SELECT = `
  SELECT c.id, c.diary_id, c.user_id, c.parent_id, c.content,
         c.like_count, c.status, c.created_at,
         u.nickname, u.uid,
         p.avatar,
         pu.nickname AS parent_nick,
         pu.uid      AS parent_uid
    FROM comments c
    JOIN users u        ON u.id = c.user_id
    LEFT JOIN user_profiles p  ON p.user_id = c.user_id
    LEFT JOIN comments pc      ON pc.id = c.parent_id
    LEFT JOIN users pu         ON pu.id = pc.user_id
`;

/** 转成前端要的形状 */
function serializeComment(row, viewerId = null) {
  return {
    id: row.id,
    diaryId: row.diary_id,
    parentId: row.parent_id || null,
    content: row.content,
    createdAt: row.created_at,
    time: relativeTime(row.created_at),

    // 评论者
    userId: row.user_id,
    nick: row.nickname,
    uid: row.uid,
    avatar: avatarUrl(row.avatar),

    // 回复的是谁（一级评论为 null）
    replyTo: row.parent_nick
      ? { nick: row.parent_nick, uid: row.parent_uid }
      : null,

    likes: Number(row.like_count) || 0,
    isMine: viewerId !== null && Number(row.user_id) === Number(viewerId),

    // ★ 统一带上 replies 字段
    //   刚发布的评论当然是空的，但也要给个 []。
    //   原因：list 接口返回的评论带 replies（可能非空），
    //   如果 add 接口不返回这个字段，前端就得写
    //   `(c.replies || [])` 来防御 —— 同一个对象两种形状很容易出 bug。
    //   （我在前端契约测试里就是被这个坑到的）
    replies: row.replies || [],
    replyCount: (row.replies || []).length,
  };
}

/** 查一篇日记的归属和可见性，用于评论权限判断 */
async function loadDiaryForComment(diaryId) {
  return queryOne(
    'SELECT id, user_id, is_public, comment_count FROM diaries WHERE id = ?',
    [diaryId]
  );
}

/** 判断某人能不能看到这篇日记 */
function canView(diary, viewerId) {
  if (diary.is_public) return true;
  return viewerId !== null && Number(diary.user_id) === Number(viewerId);
}

// ============================================================
//  POST /api/comment           发表评论 / 回复
//
//  请求体:
//    { diaryId: 12, content: "加油", parentId: null }
//    parentId 传了就表示"回复某条评论"
// ============================================================
router.post('/', auth, wrap(async (req, res) => {
  const diaryId = int(req.body.diaryId ?? req.body.diary_id, '日记ID', { min: 1 });
  const content = str(req.body.content, '评论内容', { required: true, max: 500 });
  const parentId = req.body.parentId ?? req.body.parent_id ?? null;

  // ---- 日记存在吗？能看到吗？----
  const diary = await loadDiaryForComment(diaryId);
  if (!diary) throw new ApiError('日记不存在', 404);
  if (!canView(diary, req.uid)) throw new ApiError('日记不存在', 404);

  // ---- 回复的话，父评论必须存在，而且属于同一篇日记 ----
  let finalParentId = null;
  if (parentId !== null && parentId !== undefined && parentId !== '') {
    const pid = int(parentId, '父评论ID', { min: 1 });
    const parent = await queryOne(
      'SELECT id, diary_id, parent_id, user_id FROM comments WHERE id = ? AND status = "normal"',
      [pid]
    );
    if (!parent) throw new ApiError('要回复的评论不存在', 404);
    if (Number(parent.diary_id) !== Number(diaryId)) {
      throw new ApiError('评论和日记对不上', 400);
    }
    // ★ 只保留两级：如果父评论本身也是回复，就挂到它的顶层父级上
    //   这样回复的回复不会越嵌越深，手机上还是两列结构
    finalParentId = parent.parent_id ? parent.parent_id : parent.id;
  }

  // ---- 内容检测（"机器人判断语言是否违规"）----
  const mod = moderate(content);
  const care = careFor(content);
  if (!mod.ok && mod.cat !== '危机信号') {
    console.log(`  🤖 拦截评论 [${mod.cat}] user=${req.uid} 内容="${content.slice(0, 30)}"`);
    return res.status(400).json({ code: 40000,
      msg: mod.msg || '这句话不太合适，换种说法吧', data: { care } });
  }

  // ---- 入库（事务：插评论 + 更新计数）----
  const commentId = await transaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO comments (diary_id, user_id, parent_id, content)
       VALUES (?, ?, ?, ?)`,
      [diaryId, req.uid, finalParentId, content]
    );
    await conn.execute(
      'UPDATE diaries SET comment_count = comment_count + 1 WHERE id = ?',
      [diaryId]
    );
    return r.insertId;
  });

  const row = await queryOne(`${COMMENT_SELECT} WHERE c.id = ?`, [commentId]);
  const fresh = await queryOne('SELECT comment_count FROM diaries WHERE id = ?', [diaryId]);

  // ============================================================
  //  通知谁？按"谁最该知道"的顺序，每人最多收到一条
  //
  //    1. 被回复的人（parentId 那条评论的作者）        → reply
  //    2. 被 @ 的好友                                  → mention
  //    3. 日记作者                                     → comment
  //
  //  ★ 为什么要排优先级 ★
  //    同一条评论可能同时命中好几种关系：
  //    你回复了 A 的评论，正文里又 @ 了 A，而这篇日记也是 A 写的 ——
  //    三条都发的话，A 会收到三遍同样的提醒。
  //    所以按上面的顺序，先命中谁就只给谁发一条，后面跳过。
  // ============================================================
  const notified = new Set();
  const selfId = Number(req.uid);

  async function notifyOnce(toUserId, type) {
    const id = Number(toUserId);
    if (!id || id === selfId) return;        // 自己动自己不打扰
    if (notified.has(id)) return;            // 已经通知过了
    notified.add(id);
    await pushNotification({
      toUserId: id,
      fromUserId: req.uid,
      type,
      diaryId,
      commentId,
      content,
    });
  }

  // ---- 1. 被回复的人 ----
  if (finalParentId) {
    const parent = await queryOne(
      'SELECT user_id FROM comments WHERE id = ?',
      [finalParentId]
    );
    if (parent) await notifyOnce(parent.user_id, 'reply');
  }

  // ---- 2. 正文里 @ 的好友 ----
  const mentionNicks = extractMentions(content).filter(function (n) {
    return n !== (req.user && req.user.nickname);
  });

  for (const nick of mentionNicks) {
    const u = await queryOne(
      'SELECT id FROM users WHERE nickname = ? AND status = "normal" LIMIT 1',
      [nick]
    );
    if (!u) continue;

    // 只能 @ 好友（= 我关注的人）。前端选择列表也只列好友，
    // 但手动在正文里敲 @某人 能绕过前端，这里必须再拦一道。
    const isFriend = await queryOne(
      'SELECT id FROM follows WHERE user_id = ? AND target_id = ? LIMIT 1',
      [req.uid, u.id]
    );
    if (!isFriend) continue;

    if (notified.has(Number(u.id))) continue;
    // Do not copy diary/ comment text into a lasting private-message preview:
    // the diary may later become private, and its link rechecks visibility.
    const delivered = await trySendDirectMessage(req.uid, u.id,
      '在一条日记的评论里 @ 了你，点击查看。\n[跳转] diary-public.html?id=' + diaryId,
      { diaryId });
    if (delivered) notified.add(Number(u.id));
  }

  // ---- 3. 日记作者 ----
  await notifyOnce(diary.user_id, 'comment');

  return ok(res, {
    comment: serializeComment(row, req.uid),
    commentCount: Number(fresh.comment_count),
    // 只有危机信号时才有这个字段
    care,
  }, '评论已发布');
}));

// ============================================================
//  GET /api/comment/diary/:diaryId     取某篇日记的评论
//
//  查询参数：
//    page / size   分页（一级评论分页，回复全部带出）
//    withReplies   是否带回复，默认 1
//
//  ★ 为什么一级评论分页、回复全带：
//    评论多的时候，回复通常也很多。但如果只分页一级评论、
//    把它们的回复一次性带出来（用一条 IN 查询），
//    前端只需要请求很少的几次就能显示完整。
// ============================================================
router.get('/diary/:diaryId', authOptional, wrap(async (req, res) => {
  const diaryId = int(req.params.diaryId, '日记ID', { min: 1 });
  const { page, size, offset } = parsePage(req, 20, 50);
  const withReplies = req.query.withReplies !== '0';

  // 权限：看不到日记就看不到评论
  const diary = await loadDiaryForComment(diaryId);
  if (!diary) throw new ApiError('日记不存在', 404);
  if (!canView(diary, req.uid ?? null)) throw new ApiError('日记不存在', 404);

  // 一级评论总数
  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM comments WHERE diary_id = ? AND parent_id IS NULL AND status = "normal"',
    [diaryId]
  );
  const total = Number(totalRow.total) || 0;

  // 一级评论
  const topRows = await query(
    `${COMMENT_SELECT}
      WHERE c.diary_id = ? AND c.parent_id IS NULL AND c.status = 'normal'
      ORDER BY c.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [diaryId]
  );

  const list = topRows.map(r => serializeComment(r, req.uid ?? null));

  // 回复：一条 IN 查询全带出来（不要 N+1）
  if (withReplies && list.length > 0) {
    const ids = list.map(c => c.id);
    const ph = ids.map(() => '?').join(',');
    const replyRows = await query(
      `${COMMENT_SELECT}
        WHERE c.parent_id IN (${ph}) AND c.status = 'normal'
        ORDER BY c.id ASC`,
      ids
    );

    // 按 parent_id 分组挂上去
    const byParent = {};
    for (const r of replyRows) {
      const c = serializeComment(r, req.uid ?? null);
      if (!byParent[r.parent_id]) byParent[r.parent_id] = [];
      byParent[r.parent_id].push(c);
    }
    list.forEach(c => {
      c.replies = byParent[c.id] || [];
      c.replyCount = c.replies.length;
    });
  } else {
    list.forEach(c => { c.replies = []; c.replyCount = 0; });
  }

  const totalComments = Number(diary.comment_count) || 0;

  return ok(res, {
    list,
    page,
    size,
    total,                       // 一级评论数
    totalComments,               // 含回复的总数（和日记上的 comment_count 一致）
    hasMore: offset + topRows.length < total,
  });
}));

// ============================================================
//  GET /api/comment/mine      我发过的评论（"我的"页面可以用）
// ============================================================
router.get('/mine', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM comments WHERE user_id = ? AND status = "normal"',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const rows = await query(
    `SELECT c.id, c.content, c.created_at, c.diary_id, c.parent_id,
            d.text AS diary_text, d.img AS diary_img, d.date_key,
            du.nickname AS diary_owner, du.uid AS diary_owner_uid
       FROM comments c
       JOIN diaries d ON d.id = c.diary_id
       JOIN users du  ON du.id = d.user_id
      WHERE c.user_id = ? AND c.status = 'normal'
      ORDER BY c.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  return ok(res, {
    list: rows.map(r => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      time: relativeTime(r.created_at),
      diaryId: r.diary_id,
      diaryText: (r.diary_text || '').slice(0, 60),
      diaryImg: r.diary_img,
      dateKey: r.date_key,
      diaryOwner: r.diary_owner,
      // 是回复别人还是直接评论
      isReply: Boolean(r.parent_id),
    })),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// ============================================================
//  DELETE /api/comment/:id       删评论
//
//  谁能删：
//    1. 评论作者自己
//    2. 日记作者（自己的地盘自己管）
// ============================================================
router.delete('/:id', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '评论ID', { min: 1 });

  const comment = await queryOne(
    'SELECT id, diary_id, user_id, parent_id FROM comments WHERE id = ?',
    [id]
  );
  if (!comment) throw new ApiError('评论不存在', 404);

  const diary = await queryOne('SELECT user_id FROM diaries WHERE id = ?', [comment.diary_id]);
  const isCommentAuthor = Number(comment.user_id) === Number(req.uid);
  const isDiaryOwner = diary && Number(diary.user_id) === Number(req.uid);

  if (!isCommentAuthor && !isDiaryOwner) {
    throw new ApiError('只能删自己的评论', 403);
  }

  // ★ 删一级评论时，它的回复也要一起删，并正确扣减计数
  //   否则会出现"评论数 5 但只看得到 1 条"的诡异现象
  await transaction(async (conn) => {
    let removed = 0;

    if (!comment.parent_id) {
      // 是一级评论：连回复一起删
      const [r1] = await conn.execute('DELETE FROM comments WHERE id = ?', [id]);
      const [r2] = await conn.execute('DELETE FROM comments WHERE parent_id = ?', [id]);
      removed = r1.affectedRows + r2.affectedRows;
    } else {
      // 是回复：只删它自己
      const [r1] = await conn.execute('DELETE FROM comments WHERE id = ?', [id]);
      removed = r1.affectedRows;
    }

    // 扣减计数，用 GREATEST 防负数
    await conn.execute(
      'UPDATE diaries SET comment_count = GREATEST(0, comment_count - ?) WHERE id = ?',
      [removed, comment.diary_id]
    );
  });

  const fresh = await queryOne('SELECT comment_count FROM diaries WHERE id = ?', [comment.diary_id]);

  return ok(res, {
    id,
    diaryId: comment.diary_id,
    commentCount: Number(fresh.comment_count),
  }, '评论已删除');
}));

// ============================================================
//  PATCH /api/comment/:id       改评论（只能改自己的）
// ============================================================
router.patch('/:id', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '评论ID', { min: 1 });
  const content = str(req.body.content, '评论内容', { required: true, max: 500 });

  const comment = await queryOne('SELECT id, user_id FROM comments WHERE id = ?', [id]);
  if (!comment) throw new ApiError('评论不存在', 404);
  if (Number(comment.user_id) !== Number(req.uid)) {
    throw new ApiError('只能改自己的评论', 403);
  }

  const mod = moderate(content);
  const care = careFor(content);
  if (!mod.ok && mod.cat !== '危机信号') {
    return res.status(400).json({ code: 40000,
      msg: mod.msg || '这句话不太合适', data: { care } });
  }

  await execute('UPDATE comments SET content = ? WHERE id = ?', [content, id]);

  const row = await queryOne(`${COMMENT_SELECT} WHERE c.id = ?`, [id]);
  return ok(res, { comment: serializeComment(row, req.uid), care }, '评论已修改');
}));

// ============================================================
//  说明：没有单独做"发之前预检"的接口
//
//  原因：那需要把同一个词库维护两份（后端一份、前端一份），
//  改一处忘另一处就会不一致。而且发评论本来就只有一次往返，
//  提前预检省不了什么，反而多一次请求。
//
//  前端要做即时提示的话，直接在 submit 失败时显示后端返回的 msg 就行
//  —— 消息文案已经在 moderation.js 里写好了，是可读的中文。
// ============================================================

export default router;
