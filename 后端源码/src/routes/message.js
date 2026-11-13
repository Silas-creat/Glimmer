// ============================================================
//  私信模块（一对一）
//
//  对应前端：
//    diary-public.html 的个人主页 → "✈ 发私信" 按钮
//    index.html 的"好友"页 → 会话列表
//
//  ★ 数据模型的关键约束：一对人只能有一行会话 ★
//    conversations 表用 (user_a, user_b) 唯一索引，并且约定
//      user_a < user_b
//    这就是为什么每次都要先"排序"再查 ——
//    A→B 和 B→A 必须落到同一行，否则两个人会各自看到一半的对话。
//
//  ★ 未读数怎么存 ★
//    会话行上有 unread_a 和 unread_b 两个字段，
//    谁的未读就用哪个。比每次 COUNT 快，也便于列表排序。
//
//  ★ 被机器人拦下的消息怎么处理 ★
//    不发给对方，但存进数据库并标 status='blocked'。
//    理由：①用户自己能看到"这句话没发出去"
//          ②管理员能看到"这个人试图发广告"
//    只拦不存的话，出了问题没法追溯。
// ============================================================
import express from 'express';
import { query, queryOne, insert, execute, transaction } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, int, relativeTime } from '../utils/validate.js';
import { auth } from '../middleware/auth.js';
import { moderate, detectCrisis, HELP_LINES } from '../utils/moderation.js';
import { reviewGroupMessage } from '../utils/chatBot.js';
import { avatarUrl } from '../middleware/upload.js';

const router = express.Router();

/** 一次会话最多能发多长的内容 */
const MAX_MSG_LEN = 2000;

/**
 * 同一会话两条消息之间的最短间隔（毫秒），防连点刷屏
 *
 * ★ 做成可配置的，是为了测试 ★
 *   生产环境要 1.2 秒（防连点），但测试里如果也这样，
 *   一个测试要跑十几秒，而且每处发送都得手动 sleep ——
 *   漏一处就失败，失败信息还容易误导（"期望 0 实际 42900"）。
 *   所以允许用环境变量覆盖，测试时设 0。
 *
 *   放在 .env 里：
 *     MESSAGE_SEND_INTERVAL_MS=0     （测试）
 *     不填                            （默认 1200，生产）
 */
const SEND_INTERVAL_MS = (() => {
  const v = process.env.MESSAGE_SEND_INTERVAL_MS;
  if (v === undefined || v === '') return 1200;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
})();

// ------------------------------------------------------------
//  工具
// ------------------------------------------------------------

/**
 * 把两个 user_id 排成 (小, 大)
 *
 * ★ 这个约定是整个私信模块的基础 ★
 *   A 给 B 发消息、B 给 A 发消息，必须落在同一行会话上。
 *   如果不排序，会变成两行（A,B）和（B,A），
 *   两个人各自只看到一半对话 —— 这是很常见的实现错误。
 */
function orderPair(x, y) {
  const a = Number(x);
  const b = Number(y);
  return a < b ? [a, b] : [b, a];
}

/** 我是这段会话的 a 还是 b？ */
function sideOf(conv, me) {
  return Number(conv.user_a) === Number(me) ? 'a' : 'b';
}

/** 取我的未读数 */
function unreadOf(conv, me) {
  return sideOf(conv, me) === 'a' ? Number(conv.unread_a) : Number(conv.unread_b);
}

/** 对方是谁 */
function partnerIdOf(conv, me) {
  return sideOf(conv, me) === 'a' ? Number(conv.user_b) : Number(conv.user_a);
}

/**
 * 找到（或创建）我和某人的会话
 * @returns {object} 会话行
 */
async function getOrCreateConversation(me, otherId) {
  const [a, b] = orderPair(me, otherId);

  let conv = await queryOne(
    'SELECT * FROM conversations WHERE user_a = ? AND user_b = ?',
    [a, b]
  );
  if (conv) return conv;

  // 用 INSERT IGNORE 语义：两个人同时点"发私信"时，
  // 唯一索引会让其中一个失败，这时重新查一次就行
  try {
    const id = await insert(
      'INSERT INTO conversations (user_a, user_b) VALUES (?, ?)',
      [a, b]
    );
    conv = await queryOne('SELECT * FROM conversations WHERE id = ?', [id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      conv = await queryOne(
        'SELECT * FROM conversations WHERE user_a = ? AND user_b = ?',
        [a, b]
      );
    } else {
      throw e;
    }
  }
  return conv;
}

/** 序列化一条私信 */
function serializeMessage(row, viewerId) {
  return {
    id: row.id,
    convId: row.conv_id,
    content: row.content,
    // ★ 被机器人拦下的消息只有发件人自己能看到（前端据此标灰显示）
    //   对方拿不到这条（在查询里已经过滤掉了）
    blocked: row.status === 'blocked',
    // 系统提示（加好友问候）前端渲染成灰色居中，不带头像
    isSys: Boolean(Number(row.is_sys)),
    isRead: Boolean(row.is_read),
    fromUserId: row.from_user,
    toUserId: row.to_user,
    isMine: Number(row.from_user) === Number(viewerId),
    time: relativeTime(row.created_at),
    createdAt: row.created_at,
    fromNick: row.from_nick || '',
    fromAvatar: avatarUrl(row.from_avatar),
    toNick: row.to_nick || '',
  };
}

/** 消息查询（带发件人/收件人信息） */
const MSG_SELECT = `
  SELECT m.id, m.conv_id, m.from_user, m.to_user, m.content,
         m.is_sys, m.is_read, m.status, m.created_at,
         fu.nickname AS from_nick, fp.avatar AS from_avatar,
         tu.nickname AS to_nick
    FROM messages m
    LEFT JOIN users fu        ON fu.id = m.from_user
    LEFT JOIN user_profiles fp ON fp.user_id = m.from_user
    LEFT JOIN users tu        ON tu.id = m.to_user
`;

// ============================================================
//  GET /api/message/conversations     会话列表
// ============================================================
router.get('/conversations', auth, wrap(async (req, res) => {
  // 一次 JOIN 把对方的信息带出来（不要 N+1）
  //
  // ★ 一条规则搞定"我删过这条会话"★
  //
  //   规则：会话显示给我，当且仅当
  //        最后一条消息的时间 > 我删除的时间（我没删过时按 0 算）
  //
  //   推导：
  //     · 我没删过（deleted=NULL → COALESCE 取 0）→ 只要说过话就显示 ✅
  //     · 我在最后一条消息之后删的 → last_time < deleted → 不显示 ✅
  //     · 我删完之后对方又发了新消息 → last_time > deleted → 重新显示 ✅
  //
  //   ★ 注意不要写成两个 AND 条件 ★
  //     我第一版写成 "deleted IS NULL" AND "last_time > deleted"，
  //     这两个条件互相抵消：第一个把"我又收到新消息"的情况也排除了，
  //     等于删了就永久收不到。一个条件表达清楚就够了。
  const rows = await query(
    `SELECT c.*,
            ua.nickname AS a_nick, ua.uid AS a_uid, pa.avatar AS a_avatar,
            ub.nickname AS b_nick, ub.uid AS b_uid, pb.avatar AS b_avatar
       FROM conversations c
       JOIN users ua        ON ua.id = c.user_a
       LEFT JOIN user_profiles pa ON pa.user_id = c.user_a
       JOIN users ub        ON ub.id = c.user_b
       LEFT JOIN user_profiles pb ON pb.user_id = c.user_b
      WHERE (c.user_a = ? OR c.user_b = ?)
        AND c.last_time IS NOT NULL        -- 还没说过话的空会话不显示
        AND UNIX_TIMESTAMP(c.last_time) > COALESCE(
              UNIX_TIMESTAMP(
                CASE WHEN c.user_a = ? THEN c.deleted_by_a ELSE c.deleted_by_b END
              ), 0)
      ORDER BY c.last_time DESC
      LIMIT 100`,
    [req.uid, req.uid, req.uid]
  );

  const list = rows.map(c => {
    const mine = sideOf(c, req.uid) === 'a';
    const partner = {
      userId: mine ? c.user_b : c.user_a,
      nick: mine ? c.b_nick : c.a_nick,
      uid: mine ? c.b_uid : c.a_uid,
      avatar: avatarUrl(mine ? c.b_avatar : c.a_avatar),
    };

    return {
      convId: c.id,
      partner,
      lastMessage: c.last_msg || '',
      // 最后一条是我发的吗（前端显示"我：xxx"还是"xxx：yyy"）
      lastIsMine: Number(c.last_from) === Number(req.uid),
      lastTime: relativeTime(c.last_time),
      lastTimeRaw: c.last_time,
      unread: unreadOf(c, req.uid),
      // 我有没有拉黑对方
      iBlocked: Number(c.blocked_by) === Number(req.uid),
      // 对方有没有拉黑我
      blockedByPartner: c.blocked_by !== null && Number(c.blocked_by) !== Number(req.uid),
    };
  });

  const totalUnread = list.reduce((s, x) => s + x.unread, 0);

  return ok(res, { list, totalUnread });
}));

// ============================================================
//  GET /api/message/total-unread      总未读（红点用，永不抛错）
// ============================================================
router.get('/total-unread', auth, wrap(async (req, res) => {
  const row = await queryOne(
    `SELECT COALESCE(SUM(
              CASE WHEN user_a = ? THEN unread_a ELSE unread_b END
            ), 0) AS n
       FROM conversations
      WHERE user_a = ? OR user_b = ?`,
    [req.uid, req.uid, req.uid]
  );
  return ok(res, { unread: Number(row.n) || 0 });
}));

// ============================================================
//  POST /api/message/open        打开和某人的会话（没有就创建）
//
//  请求体: { userId: 3 }  或  { uid: "60933725737" }
//  返回会话信息 + 对方资料，前端拿着就能渲染聊天界面
// ============================================================
router.post('/open', auth, wrap(async (req, res) => {
  let targetId = null;

  if (req.body.userId !== undefined && req.body.userId !== null && req.body.userId !== '') {
    targetId = int(req.body.userId, '对方ID', { min: 1 });
  } else if (req.body.uid) {
    const uidStr = str(req.body.uid, '对方ID', { max: 16 });
    const u = await queryOne('SELECT id FROM users WHERE uid = ?', [uidStr]);
    if (!u) throw new ApiError('找不到这个人', 404);
    targetId = u.id;
  } else {
    throw new ApiError('要指定和谁聊（传 userId 或 uid）', 400);
  }

  if (Number(targetId) === Number(req.uid)) {
    throw new ApiError('不能和自己私信哦', 400);
  }

  // 对方存在吗
  const target = await queryOne(
    `SELECT u.id, u.uid, u.nickname, u.status, p.avatar, p.signature, p.province
       FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
    [targetId]
  );
  if (!target) throw new ApiError('找不到这个人', 404);
  if (target.status === 'banned') throw new ApiError('这个人已经不在了', 404);

  const conv = await getOrCreateConversation(req.uid, targetId);

  // 对方有没有拉黑我 —— 拉黑了就不让发，但会话还是能打开（能看到历史）
  const blockedByPartner = conv.blocked_by !== null
    && Number(conv.blocked_by) !== Number(req.uid);

  return ok(res, {
    convId: conv.id,
    partner: {
      userId: target.id,
      uid: target.uid,
      nick: target.nickname,
      avatar: avatarUrl(target.avatar),
      signature: target.signature || '',
      province: target.province || '',
    },
    unread: unreadOf(conv, req.uid),
    iBlocked: Number(conv.blocked_by) === Number(req.uid),
    blockedByPartner,
    // 拉黑了就别让前端显示输入框
    canSend: !blockedByPartner && Number(conv.blocked_by) !== Number(req.uid),
  });
}));

// ============================================================
//  GET /api/message/with/:userId      取和某人的聊天记录
//
//  查询参数：
//    before  取这个 id 之前的消息（翻历史）
//    limit   几条（默认 30，最多 100）
//    markRead=0  不要自动标记已读
// ============================================================
router.get('/with/:userId', auth, wrap(async (req, res) => {
  const otherId = int(req.params.userId, '对方ID', { min: 1 });

  if (Number(otherId) === Number(req.uid)) {
    throw new ApiError('不能和自己私信', 400);
  }

  const [a, b] = orderPair(req.uid, otherId);
  const conv = await queryOne(
    'SELECT * FROM conversations WHERE user_a = ? AND user_b = ?',
    [a, b]
  );
  if (!conv) {
    // 还没聊过，返回空列表（前端显示"还没有消息"）
    return ok(res, { convId: null, list: [], hasMore: false, partner: null });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const before = req.query.before ? int(req.query.before, 'before', { min: 1 }) : null;

  // ★ after：只取"比我手上这条更新"的消息，给前端做轮询用 ★
  //   和群聊那边保持一致。没有它，私信也得整屏重拉才能看到对方新说的话。
  const after = req.query.after ? int(req.query.after, 'after', { min: 0 }) : null;

  const params = [conv.id];
  let whereSql = 'WHERE m.conv_id = ?';
  if (before) {
    whereSql += ' AND m.id < ?';
    params.push(before);
  }
  if (after) {
    whereSql += ' AND m.id > ?';
    params.push(after);
  }

  const rows = await query(
    `${MSG_SELECT} ${whereSql} ORDER BY m.id DESC LIMIT ${limit}`,
    params
  );

  // 倒序取完翻回正序（聊天记录要从上往下读）
  const list = rows.reverse()
    // ★ 被拦下的消息：只有发件人自己能看到，对方看不到
    .filter(m => m.status !== 'blocked' || Number(m.from_user) === Number(req.uid))
    .map(m => serializeMessage(m, req.uid));

  // 自动标记已读：把对方发给我的、还没读的都标掉
  if (req.query.markRead !== '0') {
    const mySide = sideOf(conv, req.uid);
    await transaction(async (conn) => {
      await conn.execute(
        'UPDATE messages SET is_read = 1 WHERE conv_id = ? AND to_user = ? AND is_read = 0',
        [conv.id, req.uid]
      );
      // 未读数清零
      await conn.execute(
        `UPDATE conversations SET unread_${mySide} = 0 WHERE id = ?`,
        [conv.id]
      );
    });
  }

  // 还有更早的吗
  const oldest = list.length > 0 ? list[0].id : null;
  const hasMore = oldest
    ? !!(await queryOne(
        'SELECT id FROM messages WHERE conv_id = ? AND id < ? LIMIT 1',
        [conv.id, oldest]
      ))
    : false;

  const partner = await queryOne(
    `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province
       FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
    [otherId]
  );

  const blockedByMe = Number(conv.blocked_by) === Number(req.uid);
  const blockedByPartner = conv.blocked_by !== null && Number(conv.blocked_by) !== Number(req.uid);

  return ok(res, {
    convId: conv.id,
    list,
    limit,
    hasMore,
    partner: partner ? {
      userId: partner.id,
      uid: partner.uid,
      nick: partner.nickname,
      avatar: avatarUrl(partner.avatar),
      signature: partner.signature || '',
      province: partner.province || '',
    } : null,
    iBlocked: blockedByMe,
    blockedByPartner,
    canSend: !blockedByMe && !blockedByPartner,
  });
}));

// ============================================================
//  POST /api/message/send       发私信
//
//  请求体: { toUserId: 3, content: "你好" }
//     或  { convId: 5, content: "你好" }
//
//  ★ 和群聊一样的处理：内容检测 + 危机信号关怀 ★
//    区别是私信只有两个人，所以：
//      违规 → 不发给对方，但给自己一个提示（存库留痕）
//      危机信号 → 正常发出，同时给自己关怀提示
// ============================================================
router.post('/send', auth, wrap(async (req, res) => {
  const content = str(req.body.content, '消息内容', { required: true, max: MAX_MSG_LEN });

  // ---- 定位会话 ----
  let conv = null;
  let toUserId = null;

  if (req.body.convId !== undefined && req.body.convId !== null && req.body.convId !== '') {
    const convId = int(req.body.convId, '会话ID', { min: 1 });
    conv = await queryOne('SELECT * FROM conversations WHERE id = ?', [convId]);
    if (!conv) throw new ApiError('会话不存在', 404);
    // 必须是我参与的会话
    if (Number(conv.user_a) !== Number(req.uid) && Number(conv.user_b) !== Number(req.uid)) {
      throw new ApiError('这不是你的会话', 403);
    }
    toUserId = partnerIdOf(conv, req.uid);
  } else if (req.body.toUserId !== undefined && req.body.toUserId !== null && req.body.toUserId !== '') {
    toUserId = int(req.body.toUserId, '收件人ID', { min: 1 });
    if (Number(toUserId) === Number(req.uid)) throw new ApiError('不能给自己发私信', 400);
    const target = await queryOne('SELECT id, status FROM users WHERE id = ?', [toUserId]);
    if (!target) throw new ApiError('找不到这个人', 404);
    if (target.status === 'banned') throw new ApiError('这个人已经不在了', 404);
    conv = await getOrCreateConversation(req.uid, toUserId);
  } else {
    throw new ApiError('要指定发给谁（传 toUserId 或 convId）', 400);
  }

  // ---- 拉黑检查 ----
  if (conv.blocked_by !== null) {
    if (Number(conv.blocked_by) === Number(req.uid)) {
      throw new ApiError('你把这个人拉黑了，先取消拉黑再聊', 403);
    }
    // 对方拉黑了我 —— 不要明说"你被拉黑了"，
    // 那样会让人反复试探。用一句含糊的话就行。
    throw new ApiError('消息发送失败，对方可能不想收到消息', 403);
  }

  // 独立识别求助，保证连续发出的求助也能得到关怀；后续仍审核混合违规。
  const crisis = detectCrisis(content);

  // ---- 频控：同一会话不能连点 ----
  // 间隔设为 0 时（测试环境）直接跳过这段检查
  if (SEND_INTERVAL_MS > 0 && !crisis) {
    // ★ 这里用 UNIX_TIMESTAMP(NOW(3)) 而不是 NOW(3) ★
    //
    //  为什么：created_at 是 DATETIME(3)（毫秒精度）。
    //  如果另一边写成 NOW()，那就是秒级，两边精度不对称，
    //  差值会莫名其妙地偏（我踩过：刚插入时算出 -902000 微秒，
    //  等 1.6 秒却只算出 1.098 秒，导致"明明等够了还说太快"）。
    //
    //  UNIX_TIMESTAMP() 返回的是数字（带小数部分），
    //  两边都当数字相减，完全不涉及 DATETIME 的字符串解析和精度截断。
    //  * 1000 得到毫秒，直接和 SEND_INTERVAL_MS 比，不用换算微秒。
    const lastMine = await queryOne(
      `SELECT id, created_at,
              (UNIX_TIMESTAMP(NOW(3)) - UNIX_TIMESTAMP(created_at)) * 1000 AS ago_ms
         FROM messages
        WHERE conv_id = ? AND from_user = ?
        ORDER BY id DESC LIMIT 1`,
      [conv.id, req.uid]
    );
    if (lastMine && Number(lastMine.ago_ms) < SEND_INTERVAL_MS) {
      // 负数说明时间有偏差，别给出"等 -3 秒"这种荒唐提示
      const remainMs = SEND_INTERVAL_MS - Number(lastMine.ago_ms);
      const wait = Math.max(1, Math.ceil(remainMs / 1000));
      throw new ApiError(`发得太快了，等 ${wait} 秒`, 429);
    }
  }

  // ---- 内容检测 ----
  const mod = moderate(content);

  // 危机信号：正常发出 + 关怀提示（和群聊一致）
  const care = crisis ? {
    message: '你愿意把这些说出来，已经很不容易了。'
      + '如果这会儿特别难受，可尝试联系以下支持渠道。',
    lines: HELP_LINES,
  } : null;

  if (!mod.ok && mod.cat !== '危机信号') {
    // 与群聊共用违规计数；私信只拦本条，不执行也不声称禁言。
    // 在频控之后计数，避免尚未进入审核的连点被累计处罚。
    const review = reviewGroupMessage('dm', req.uid, content);
    const botNotice = review.violationCount >= 2
      ? '这句话没有发出去。已经连续出现不合适的内容，请换一种表达方式。'
      : `这句话没有发出去。${mod.msg}`;
    // ★ 违规内容：不发给对方，但存库留痕（status='blocked'）★
    //   为什么要存：①用户下次进会话能看到"这句话没发出去"
    //              ②管理员能追溯"这个人试图发广告"
    //   只拦不存的话，出了问题查不到。
    const blockedId = await insert(
      `INSERT INTO messages (conv_id, from_user, to_user, content, is_read, status)
       VALUES (?, ?, ?, ?, 1, 'blocked')`,
      [conv.id, req.uid, toUserId, content]
    );

    console.log(`  🤖 拦截私信 [${mod.cat}] from=${req.uid} to=${toUserId}`);

    return ok(res, {
      blocked: true,
      category: mod.cat,
      reason: mod.msg,
      messageId: blockedId,
      bot: true,
      botNotice,
      violationCount: review.violationCount,
      notice: mod.msg || '这句话不太合适，没有发出去',
      care,
    }, botNotice);
  }

  // ---- 正常发送（含危机信号）----
  const mySide = sideOf(conv, req.uid);
  const otherSide = mySide === 'a' ? 'b' : 'a';

  const msgId = await transaction(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO messages (conv_id, from_user, to_user, content, is_read, status)
       VALUES (?, ?, ?, ?, 0, 'normal')`,
      [conv.id, req.uid, toUserId, content]
    );

    // 更新会话摘要 + 对方未读 +1 + 我自己的未读清零 + 清掉我的"已删除"标记
    //
    // ★ 必须清 deleted_by_我 ★
    //   否则：我删了会话 → 我又主动发消息 → 列表里还是看不到这条会话
    //   （因为 last_time 和 deleted_by 几乎同时，比较结果不确定）
    await conn.execute(
      `UPDATE conversations
          SET last_msg = ?, last_from = ?, last_time = NOW(3),
              unread_${otherSide} = unread_${otherSide} + 1,
              unread_${mySide} = 0,
              deleted_by_${mySide} = NULL
        WHERE id = ?`,
      // 列表里显示摘要，太长就截断
      [content.slice(0, 100), req.uid, conv.id]
    );

    return r.insertId;
  });

  // 私信通过会话未读数提示，不再向互动消息写入重复通知。

  const row = await queryOne(`${MSG_SELECT} WHERE m.id = ?`, [msgId]);

  return ok(res, {
    message: serializeMessage(row, req.uid),
    blocked: false,
    // 危机信号：消息发出去了，同时给自己关怀提示
    care,
  }, '已发送');
}));

// ============================================================
//  POST /api/message/read/:userId      标记和某人的会话已读
// ============================================================
router.post('/read/:userId', auth, wrap(async (req, res) => {
  const otherId = int(req.params.userId, '对方ID', { min: 1 });
  const [a, b] = orderPair(req.uid, otherId);

  const conv = await queryOne(
    'SELECT * FROM conversations WHERE user_a = ? AND user_b = ?',
    [a, b]
  );
  if (!conv) throw new ApiError('你们还没聊过', 404);

  const mySide = sideOf(conv, req.uid);

  const affected = await transaction(async (conn) => {
    const [r] = await conn.execute(
      'UPDATE messages SET is_read = 1 WHERE conv_id = ? AND to_user = ? AND is_read = 0',
      [conv.id, req.uid]
    );
    await conn.execute(
      `UPDATE conversations SET unread_${mySide} = 0 WHERE id = ?`,
      [conv.id]
    );
    return r.affectedRows;
  });

  return ok(res, { convId: conv.id, marked: affected }, '已标记为已读');
}));

// ============================================================
//  DELETE /api/message/conversation/:convId     删除会话（只从我这边消失）
//
//  ★ 不真删数据，也不动对方的东西 ★
//    只在自己的 deleted_by_a / deleted_by_b 上记一个时间戳。
//    列表查询会据此过滤。
//
//    我第一版是把 last_time 清成 NULL，结果**对方也看不到了** ——
//    因为清的是同一行数据。这是设计错误，不是实现细节。
//
//    对方之后如果又发消息，我会重新看到这条会话
//    （因为新消息的时间晚于我删除的时间）。
// ============================================================
router.delete('/conversation/:convId', auth, wrap(async (req, res) => {
  const convId = int(req.params.convId, '会话ID', { min: 1 });

  const conv = await queryOne('SELECT * FROM conversations WHERE id = ?', [convId]);
  if (!conv) throw new ApiError('会话不存在', 404);
  if (Number(conv.user_a) !== Number(req.uid) && Number(conv.user_b) !== Number(req.uid)) {
    throw new ApiError('这不是你的会话', 403);
  }

  const mySide = sideOf(conv, req.uid);

  // 只标记我这一侧 + 我的未读清零。对方的 last_msg / last_time / 未读都不动。
  await execute(
    `UPDATE conversations
        SET deleted_by_${mySide} = NOW(3), unread_${mySide} = 0
      WHERE id = ?`,
    [convId]
  );

  return ok(res, { convId }, '会话已删除（对方不受影响，他再发消息你会重新收到）');
}));

// ============================================================
//  POST /api/message/block         拉黑 / 取消拉黑
//
//  请求体: { userId: 3 }  —— 传了就切换拉黑状态
//
//  ★ 为什么必须有这个 ★
//    私信是最容易被骚扰的地方。没有拉黑功能，
//    用户遇到骚扰只能忍着 —— 这在陪伴类产品里是不可接受的。
// ============================================================
router.post('/block', auth, wrap(async (req, res) => {
  const targetId = int(req.body.userId, '对方ID', { min: 1 });
  if (Number(targetId) === Number(req.uid)) {
    throw new ApiError('不能拉黑自己', 400);
  }

  const [a, b] = orderPair(req.uid, targetId);
  const conv = await queryOne(
    'SELECT * FROM conversations WHERE user_a = ? AND user_b = ?',
    [a, b]
  );
  if (!conv) throw new ApiError('你们还没聊过，不需要拉黑', 404);

  const iBlocked = Number(conv.blocked_by) === Number(req.uid);

  if (iBlocked) {
    // 取消拉黑
    await execute('UPDATE conversations SET blocked_by = NULL WHERE id = ?', [conv.id]);
    console.log(`  🔓 ${req.user.nickname} 取消拉黑 user=${targetId}`);
    return ok(res, { blocked: false, convId: conv.id }, '已取消拉黑');
  }

  if (conv.blocked_by !== null && Number(conv.blocked_by) !== Number(req.uid)) {
    throw new ApiError('对方已经拉黑你了', 403);
  }

  await execute('UPDATE conversations SET blocked_by = ? WHERE id = ?', [req.uid, conv.id]);
  console.log(`  🚫 ${req.user.nickname} 拉黑了 user=${targetId}`);
  return ok(res, { blocked: true, convId: conv.id }, '已拉黑，对方不能再给你发消息');
}));

// ============================================================
//  GET /api/message/blocked-list       我拉黑过的人
// ============================================================
router.get('/blocked-list', auth, wrap(async (req, res) => {
  const rows = await query(
    `SELECT c.id AS conv_id, c.blocked_by,
            u.id AS user_id, u.uid, u.nickname, p.avatar
       FROM conversations c
       JOIN users u ON u.id = IF(c.user_a = ?, c.user_b, c.user_a)
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE c.blocked_by = ?`,
    [req.uid, req.uid]
  );

  return ok(res, {
    list: rows.map(r => ({
      convId: r.conv_id,
      userId: r.user_id,
      uid: r.uid,
      nick: r.nickname,
      avatar: avatarUrl(r.avatar),
    })),
    total: rows.length,
  });
}));

export default router;
