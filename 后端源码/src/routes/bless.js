// ============================================================
//  祝福模块
//
//  对应前端：
//    bless.html        从个人主页点"去祝福一下ta叭"进来，
//                      写一句鼓励的话送给对方
//    bless-sent.html   "我送出去的祝福"列表
//    mine.html         "我收到的祝福"入口
//
//  ★ 要解决的核心问题：前端只传了个昵称 ★
//    bless.html 原来的写法是 `location.href = 'bless.html?to=' + 昵称`，
//    存储时也只记了个名字字符串。
//    接后端就必须把它变成"真实的 user_id"，否则重名就送错人了。
//    所以接口同时接受 toUserId / toUid / toNick 三种定位方式：
//      - 前端已经知道 id 就直接传 id（最准）
//      - 只有昵称就传昵称，后端帮忙查（查不到或重名会明确报错）
//
//  ★ 产品调性 ★
//    这个是"鼓励"功能，不是私信。所以：
//      - 内容做检测（不能拿来打广告或骂人）
//      - 不能给自己发（自己鼓励自己有点怪，也防止刷数据）
//      - 对方能看到是谁送的（这是温暖的一部分）
// ============================================================
import express from 'express';
import { query, queryOne, insert, execute } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, int, relativeTime } from '../utils/validate.js';
import { auth } from '../middleware/auth.js';
import { moderate, detectCrisis, HELP_LINES } from '../utils/moderation.js';
import { avatarUrl } from '../middleware/upload.js';
import { trySendDirectMessage } from '../utils/dm.js';

const router = express.Router();

// ------------------------------------------------------------
//  查询语句：把送祝福的人和收祝福的人都 JOIN 出来
//  因为两个列表都要显示对方信息：
//    "我送出去的" → 要显示收件人是谁
//    "我收到的"   → 要显示送件人是谁
// ------------------------------------------------------------
const BLESS_SELECT = `
  SELECT b.id, b.from_user, b.to_user, b.content, b.is_read, b.created_at,
         fu.nickname AS from_nick, fu.uid AS from_uid,
         fp.avatar   AS from_avatar,
         tu.nickname AS to_nick,   tu.uid AS to_uid,
         tp.avatar   AS to_avatar
    FROM blessings b
    JOIN users fu ON fu.id = b.from_user
    JOIN users tu ON tu.id = b.to_user
    LEFT JOIN user_profiles fp ON fp.user_id = b.from_user
    LEFT JOIN user_profiles tp ON tp.user_id = b.to_user
`;

/** 统一序列化 */
function serializeBlessing(row) {
  return {
    id: row.id,
    content: row.content,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
    time: relativeTime(row.created_at),
    // 谁送的
    from: {
      userId: row.from_user,
      nick: row.from_nick,
      uid: row.from_uid,
      avatar: avatarUrl(row.from_avatar),
    },
    // 送给谁
    to: {
      userId: row.to_user,
      nick: row.to_nick,
      uid: row.to_uid,
      avatar: avatarUrl(row.to_avatar),
    },
  };
}

/**
 * 把"给谁"解析成真实的 user_id
 *
 * 支持三种传法，优先级从高到低：
 *   1. toUserId  内部 id（最准，前端有就用这个）
 *   2. toUid     对外 uid
 *   3. toNick    昵称（前端 bless.html 只有昵称）
 *
 * 为什么昵称要严格处理：
 *   昵称在改资料时是禁止重名的，但历史数据或手工改库可能出现重名。
 *   重名时宁可报错，也不要随便挑一个送 —— 送错人比送不到更糟。
 */
async function resolveTarget(body, myId) {
  // 1. 内部 id
  if (body.toUserId !== undefined && body.toUserId !== null && body.toUserId !== '') {
    const id = int(body.toUserId, '收件人ID', { min: 1 });
    const u = await queryOne('SELECT id, nickname FROM users WHERE id = ?', [id]);
    if (!u) throw new ApiError('找不到这个人', 404);
    return u;
  }

  // 2. 对外 uid
  if (body.toUid) {
    const uid = str(body.toUid, '收件人ID', { max: 16 });
    const u = await queryOne('SELECT id, nickname FROM users WHERE uid = ?', [uid]);
    if (!u) throw new ApiError('找不到这个人（ID 可能不对）', 404);
    return u;
  }

  // 3. 昵称
  if (body.toNick) {
    const nick = str(body.toNick, '收件人昵称', { max: 32 });

    // 先看是不是自己 —— "ta" 是前端没传参数时的默认值，也当自己处理
    if (nick === 'ta') {
      throw new ApiError('要指定送给谁哦', 400);
    }

    const rows = await query('SELECT id, nickname FROM users WHERE nickname = ? LIMIT 5', [nick]);
    if (rows.length === 0) {
      throw new ApiError(`找不到昵称是「${nick}」的人`, 404);
    }
    if (rows.length > 1) {
      throw new ApiError(`有 ${rows.length} 个人都叫「${nick}」，没法确定送给谁`, 409);
    }
    return rows[0];
  }

  throw new ApiError('要指定送给谁（传 toUserId / toUid / toNick 之一）', 400);
}

// ============================================================
//  POST /api/bless/send        送出祝福
//
//  请求体（三种定位方式，选一个）：
//    { toUserId: 3, content: "..." }
//    { toUid: "60933725737", content: "..." }
//    { toNick: "林小满", content: "..." }
// ============================================================
router.post('/send', auth, wrap(async (req, res) => {
  const content = str(req.body.content ?? req.body.text, '祝福内容', { required: true, max: 1000 });

  const target = await resolveTarget(req.body, req.uid);

  // 不能给自己发
  if (Number(target.id) === Number(req.uid)) {
    throw new ApiError('不能给自己送祝福哦', 400);
  }

  // 内容检测：祝福是温暖的功能，不能拿来打广告或骂人
  const mod = moderate(content);
  const care = detectCrisis(content) ? {
    message: '你写下的这些话，也请留一份给自己。'
      + '如果最近很难受，可尝试联系以下支持渠道。',
    lines: HELP_LINES,
  } : null;
  if (!mod.ok && mod.cat !== '危机信号') {
    console.log(`  🤖 拦截祝福 [${mod.cat}] from=${req.uid} 内容="${content.slice(0, 30)}"`);
    return res.status(400).json({ code: 40000,
      msg: mod.msg || '这句话不太合适，换种说法吧', data: { care } });
  }

  // 同一个内容不要短时间重复发（防手抖连点）
  const dup = await queryOne(
    `SELECT id FROM blessings
      WHERE from_user = ? AND to_user = ? AND content = ?
        AND created_at > DATE_SUB(NOW(3), INTERVAL 10 SECOND)`,
    [req.uid, target.id, content]
  );
  if (dup) {
    throw new ApiError('这条祝福刚发过了', 409);
  }

  const id = await insert(
    'INSERT INTO blessings (from_user, to_user, content) VALUES (?, ?, ?)',
    [req.uid, target.id, content]
  );

  const row = await queryOne(`${BLESS_SELECT} WHERE b.id = ?`, [id]);

  console.log(`  ✿ ${req.user.nickname} → ${target.nickname}：${content.slice(0, 24)}`);

  await trySendDirectMessage(req.uid, target.id,
    '给你送了一句祝福：' + content.slice(0, 80) + '\n[跳转] bless-sent.html?type=received');

  return ok(res, {
    blessing: serializeBlessing(row),
    // 危机信号：祝福里如果写了很消极的话，也同样给关怀提示
    care,
  }, `祝福已送到 ${target.nickname} 那里`);
}));

// ============================================================
//  GET /api/bless/sent        我送出去的祝福
// ============================================================
router.get('/sent', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  // ★ 注意别名一致：BLESS_SELECT 里表别名是 b，
  //   所以 count 查询也必须写成 `FROM blessings b`，
  //   否则 `WHERE b.to_user` 会报 Unknown column（我踩过这个）。
  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM blessings b WHERE b.from_user = ?',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const rows = await query(
    `${BLESS_SELECT}
      WHERE b.from_user = ?
      ORDER BY b.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  return ok(res, {
    list: rows.map(serializeBlessing),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// ============================================================
//  GET /api/bless/received    我收到的祝福
//
//  查询参数：
//    unreadOnly=1   只看没读过的（做红点提醒用）
//    markRead=1     顺便全部标记为已读
// ============================================================
router.get('/received', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);
  const unreadOnly = req.query.unreadOnly === '1';

  // 同样注意：别名必须和 BLESS_SELECT 一致（b）
  const where = unreadOnly
    ? 'WHERE b.to_user = ? AND b.is_read = 0'
    : 'WHERE b.to_user = ?';

  const totalRow = await queryOne(
    `SELECT COUNT(*) AS total FROM blessings b ${where}`,
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const unreadRow = await queryOne(
    'SELECT COUNT(*) AS n FROM blessings b WHERE b.to_user = ? AND b.is_read = 0',
    [req.uid]
  );

  const rows = await query(
    `${BLESS_SELECT}
      ${where}
      ORDER BY b.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  // 顺便标记已读（前端进页面时带上 markRead=1 就行）
  if (req.query.markRead === '1' && !unreadOnly && rows.length > 0) {
    const ids = rows.map(r => r.id);
    const ph = ids.map(() => '?').join(',');
    await query(`UPDATE blessings SET is_read = 1 WHERE id IN (${ph})`, ids);
  }

  return ok(res, {
    list: rows.map(serializeBlessing),
    page, size, total,
    unread: Number(unreadRow.n) || 0,
    hasMore: offset + rows.length < total,
  });
}));

// ============================================================
//  GET /api/bless/unread-count      未读数（红点用）
// ============================================================
router.get('/unread-count', auth, wrap(async (req, res) => {
  const row = await queryOne(
    'SELECT COUNT(*) AS n FROM blessings WHERE to_user = ? AND is_read = 0',
    [req.uid]
  );
  return ok(res, { unread: Number(row.n) || 0 });
}));

// ============================================================
//  GET /api/bless/about/:userId     某个人收到过多少祝福
//  个人主页上可以显示"ta 收到过 12 份祝福"
// ============================================================
router.get('/about/:userId', auth, wrap(async (req, res) => {
  const key = String(req.params.userId);
  const user = /^\d{1,10}$/.test(key) && key.length <= 10
    ? await queryOne('SELECT id, nickname FROM users WHERE id = ?', [Number(key)])
    : await queryOne('SELECT id, nickname FROM users WHERE uid = ?', [key]);

  if (!user) throw new ApiError('这个人不存在', 404);

  const row = await queryOne(
    'SELECT COUNT(*) AS n FROM blessings WHERE to_user = ?',
    [user.id]
  );

  return ok(res, {
    userId: user.id,
    nick: user.nickname,
    receivedCount: Number(row.n) || 0,
  });
}));

// ============================================================
//  PATCH /api/bless/:id/read        标记单条已读
// ============================================================
router.patch('/:id/read', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '祝福ID', { min: 1 });

  const b = await queryOne('SELECT id, to_user FROM blessings WHERE id = ?', [id]);
  if (!b) throw new ApiError('祝福不存在', 404);
  if (Number(b.to_user) !== Number(req.uid)) {
    throw new ApiError('只能标记自己收到的祝福', 403);
  }

  await execute('UPDATE blessings SET is_read = 1 WHERE id = ?', [id]);
  return ok(res, { id, isRead: true }, '已标记为已读');
}));

// ============================================================
//  DELETE /api/bless/:id       删除祝福
//
//  规则：
//    - 收件人可以删（自己不想留着）
//    - 发件人也可以删（发错了想撤回）
// ============================================================
router.delete('/:id', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '祝福ID', { min: 1 });

  const b = await queryOne('SELECT id, from_user, to_user FROM blessings WHERE id = ?', [id]);
  if (!b) throw new ApiError('祝福不存在', 404);

  const isSender = Number(b.from_user) === Number(req.uid);
  const isReceiver = Number(b.to_user) === Number(req.uid);
  if (!isSender && !isReceiver) {
    throw new ApiError('这份祝福和你没关系', 403);
  }

  await execute('DELETE FROM blessings WHERE id = ?', [id]);

  return ok(res, { id, by: isSender ? 'sender' : 'receiver' }, '已删除');
}));

export default router;
