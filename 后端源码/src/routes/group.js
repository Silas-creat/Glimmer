// ============================================================
//  群聊模块（4 个房间 + 违规检测机器人）
//
//  对应前端：index.html 首页的四个格子
//    同龄群 / 拾趣 / 同省群 / 星迹
//
//  ★ 房间是固定的 4 个 ★
//    存在 chat_rooms 表里，code 分别是 age / interest / province / zodiac。
//    用户不用"创建房间"，直接进去说就行 —— 这是需求里
//    "类微信群聊"的意思：像群一样，点进去就在里面。
//
//  ★ 机器人的职责 ★
//    1. 判断语言是否违规（复用 moderation.js）
//    2. 分级处理：提醒 → 禁言30秒 → 禁言5分钟（见 utils/chatBot.js）
//    3. 危机信号特殊照顾：不处罚，发关怀提示
//
//  ★ 未读数怎么算 ★
//    chat_members.last_read_id 记着"我读到哪条消息了"，
//    未读数 = 这个房间比我读到的位置更新的消息条数。
//    每次进房间自动把 last_read_id 推到最新。
// ============================================================
import express from 'express';
import { query, queryOne, insert, execute } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, int, relativeTime } from '../utils/validate.js';
import { auth } from '../middleware/auth.js';
import { avatarUrl } from '../middleware/upload.js';
import { HELP_LINES } from '../utils/moderation.js';
import { reviewGroupMessage, checkMuted, resetViolations, isCrisisText } from '../utils/chatBot.js';
import { config } from '../config/index.js';

const router = express.Router();

// ------------------------------------------------------------
//  序列化一条群消息
// ------------------------------------------------------------
function serializeMessage(row, viewerId = null) {
  const isSys = row.type === 'sys';
  return {
    id: row.id,
    roomId: row.room_id,
    type: row.type,
    isSys,
    content: row.content,
    time: relativeTime(row.created_at),
    createdAt: row.created_at,
    // 系统消息没有作者
    userId: isSys ? null : row.user_id,
    nick: isSys ? '' : (row.nickname || ''),
    uid: isSys ? '' : (row.uid || ''),
    avatar: isSys ? '' : avatarUrl(row.avatar),
    isMine: !isSys && viewerId !== null && Number(row.user_id) === Number(viewerId),
  };
}

/**
 * 算当前用户在某类群里的标签
 *
 *   age      → 年龄段（按出生年份分 5 岁一档）
 *   province → 省份
 *   zodiac   → 星座
 *   interest / custom → 不分组
 *
 * 资料没填全就返回 null，调用方按"不过滤"处理。
 */
async function myTagOf(kind, uid) {
  if (kind !== 'age' && kind !== 'province' && kind !== 'zodiac') return null;

  const p = await queryOne(
    'SELECT province, zodiac, birth_year FROM user_profiles WHERE user_id = ?',
    [uid]
  );
  if (!p) return null;

  if (kind === 'province') {
    return p.province ? { kind, value: p.province, label: p.province } : null;
  }
  if (kind === 'zodiac') {
    return p.zodiac ? { kind, value: p.zodiac, label: p.zodiac + '座' } : null;
  }
  // age：按出生年份算 5 岁一档
  if (p.birth_year) {
    const now = new Date().getFullYear();
    const age = now - Number(p.birth_year);
    const band = Math.floor(age / 5);
    const lo = band * 5;
    return {
      kind,
      value: band,
      label: lo + '-' + (lo + 4) + ' 岁',
    };
  }
  return null;
}

/** 把标签条件拼成 SQL（sys 消息和"我自己说的"永远可见） */
function tagFilterSql(tag, uid, params) {
  if (!tag) return '';
  if (tag.kind === 'province') {
    params.push(uid, tag.value);
    return ' AND (m.type = \'sys\' OR m.user_id = ? OR EXISTS (' +
      'SELECT 1 FROM user_profiles q WHERE q.user_id = m.user_id AND q.province = ?))';
  }
  if (tag.kind === 'zodiac') {
    params.push(uid, tag.value);
    return ' AND (m.type = \'sys\' OR m.user_id = ? OR EXISTS (' +
      'SELECT 1 FROM user_profiles q WHERE q.user_id = m.user_id AND q.zodiac = ?))';
  }
  // age
  params.push(uid, tag.value);
  return ' AND (m.type = \'sys\' OR m.user_id = ? OR EXISTS (' +
    'SELECT 1 FROM user_profiles q WHERE q.user_id = m.user_id AND q.birth_year IS NOT NULL ' +
    'AND FLOOR((YEAR(CURDATE()) - q.birth_year) / 5) = ?))';
}

/** 消息查询（把作者信息带出来） */
const MSG_SELECT = `
  SELECT m.id, m.room_id, m.user_id, m.type, m.content, m.created_at,
         u.nickname, u.uid, p.avatar
    FROM chat_messages m
    LEFT JOIN users u        ON u.id = m.user_id
    LEFT JOIN user_profiles p ON p.user_id = m.user_id
`;

/** 机器人发一条系统消息 */
async function botSay(roomId, content) {
  return insert(
    'INSERT INTO chat_messages (room_id, user_id, type, content) VALUES (?, NULL, "sys", ?)',
    [roomId, content]
  );
}

/**
 * ★ 让 MySQL 自己算禁言剩余秒数 ★
 *
 *  为什么要这么绕：如果把 muted_until 这个时间字符串拿到 JS 里做
 *  `new Date(...)` 比较，就会被卷进时区解析的坑里
 *  （JS 按本地时间解析，而 DATETIME 也是本地时间，看着对得上，
 *    但服务器时区一变或者代码跑在别处就会差几小时）。
 *
 *  写成 SQL 让数据库算，结果就是一个纯数字，不经过任何时区转换：
 *    TIMESTAMPDIFF(SECOND, NOW(3), muted_until)
 *  正数表示还在禁言中，NULL 或负数表示没禁言。
 *
 *  ★ 用 NOW(3) 而不是 NOW() ★
 *    muted_until 是 DATETIME(3)（毫秒精度），两边精度必须一致，
 *    否则差值会偏掉（这个坑踩过，见 README 的坑 10）。
 *
 *  ★ 注意这个函数是个 SQL 片段，要拼进 SELECT 里，
 *    并且必须保证外层查询里有 chat_members 的别名 `me` ★
 */
const MUTE_REMAIN_SQL = `
  CASE
    WHEN me.muted_until IS NULL THEN 0
    ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(3), me.muted_until))
  END AS mute_remain_seconds
`;

/**
 * 查我在某个房间的禁言剩余秒数
 *
 * 返回的是一个纯数字（数据库算好的），所以不需要任何 JS 时区解析。
 * 没有成员记录、或者 muted_until 是 NULL、或者已经过期，都返回 0。
 */
async function myMuteSeconds(roomId, userId) {
  const row = await queryOne(
    `SELECT CASE
              WHEN muted_until IS NULL THEN 0
              ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(3), muted_until))
            END AS s
       FROM chat_members WHERE room_id = ? AND user_id = ?`,
    [roomId, userId]
  );
  return row ? Number(row.s) || 0 : 0;
}

/** 查一个房间（按 id 或 code） */
async function findRoom(key) {
  const s = String(key);
  if (/^\d+$/.test(s)) {
    return queryOne('SELECT * FROM chat_rooms WHERE id = ?', [Number(s)]);
  }
  return queryOne('SELECT * FROM chat_rooms WHERE code = ?', [s]);
}

// ============================================================
//  GET /api/group/rooms        房间列表（含人数和未读数）
// ============================================================
router.get('/rooms', auth, wrap(async (req, res) => {
  const rows = await query(
    `SELECT r.id, r.code, r.name, r.kind, r.desc, r.sort,
            (SELECT COUNT(*) FROM chat_members cm WHERE cm.room_id = r.id) AS member_count,
            (SELECT COUNT(*) FROM chat_messages m WHERE m.room_id = r.id) AS message_count,
            (SELECT MAX(m2.id) FROM chat_messages m2 WHERE m2.room_id = r.id) AS last_message_id,
            me.last_read_id AS my_last_read,
            ${MUTE_REMAIN_SQL},
            (SELECT m3.content FROM chat_messages m3
              WHERE m3.room_id = r.id ORDER BY m3.id DESC LIMIT 1) AS last_content,
            (SELECT m4.created_at FROM chat_messages m4
              WHERE m4.room_id = r.id ORDER BY m4.id DESC LIMIT 1) AS last_time
       FROM chat_rooms r
       LEFT JOIN chat_members me ON me.room_id = r.id AND me.user_id = ?
      ORDER BY r.sort, r.id`,
    [req.uid]
  );

  const list = rows.map(r => {
    // ★ 用数据库算好的秒数，不做 JS 时区解析
    const mute = checkMuted(r.id, req.uid, Number(r.mute_remain_seconds) || 0);

    return {
      id: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      desc: r.desc || '',
      memberCount: Number(r.member_count) || 0,
      messageCount: Number(r.message_count) || 0,
      lastMessage: r.last_content
        ? { content: r.last_content, time: relativeTime(r.last_time) }
        : null,
      // 未读数在下面用一条 SQL 统一补上（避免 N+1）
      unread: 0,
      isMuted: mute.muted,
      muteRemainSeconds: mute.remainSeconds,
      // 在 chat_members 里有记录就说明进过这个群
      isJoined: r.my_last_read !== null && r.my_last_read !== undefined,
    };
  });

  // 补未读数：一条 SQL 查完所有房间，不要每个房间查一次
  // （我第一版在这里写了个 unread = null 的占位分支，等于留了段死代码，
  //   还不如直接写 0 然后在下面覆盖）
  if (list.length > 0) {
    const rows2 = await query(
      `SELECT r.id AS room_id,
              (SELECT COUNT(*) FROM chat_messages m
                WHERE m.room_id = r.id
                  AND me.user_id IS NOT NULL          -- 没进过这个群就不算未读
                  AND m.id > COALESCE(me.last_read_id, 0)) AS unread
         FROM chat_rooms r
         LEFT JOIN chat_members me ON me.room_id = r.id AND me.user_id = ?`,
      [req.uid]
    );
    const map = {};
    rows2.forEach(x => { map[x.room_id] = Number(x.unread) || 0; });

    // ★ 未读也要按标签算 ★
    //   否则红点显示有消息，点进去却看不到（别人的标签和我不一样）。
    for (const room of list) {
      let n = map[room.id] || 0;
      const tag = await myTagOf(room.kind, req.uid);
      if (tag) {
        const params = [room.id];
        let sql = 'SELECT COUNT(*) AS n FROM chat_messages m WHERE m.room_id = ?';
        sql += tagFilterSql(tag, req.uid, params);
        // 没进过这个群（chat_members 里没有记录）就不算未读：
        // 否则新注册的账号一进来，四个群全是"12 条未读"的历史消息。
        sql += ' AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.room_id = ? AND cm.user_id = ?)';
        sql += ' AND m.id > COALESCE((SELECT last_read_id FROM chat_members WHERE room_id = ? AND user_id = ?), 0)';
        params.push(room.id, req.uid, room.id, req.uid);
        const r2 = await queryOne(sql, params);
        n = Number(r2 && r2.n) || 0;
      }
      room.unread = n;
    }
  }

  const totalUnread = list.reduce((s, x) => s + x.unread, 0);

  return ok(res, { list, totalUnread });
}));

// ============================================================
//  POST /api/group/rooms/:key/join     进房间
//
//  key 可以是房间 id 或 code（age/interest/province/zodiac）
//  进来就在 chat_members 里记一行。"进房间"和"开始聊天"是一回事，
//  不需要额外的加入动作 —— 这是"类微信群聊"的体验。
// ============================================================
router.post('/rooms/:key/join', auth, wrap(async (req, res) => {
  const room = await findRoom(req.params.key);
  if (!room) throw new ApiError('这个群不存在', 404);

  const exist = await queryOne(
    'SELECT id, muted_until FROM chat_members WHERE room_id = ? AND user_id = ?',
    [room.id, req.uid]
  );

  const mute = checkMuted(room.id, req.uid, await myMuteSeconds(room.id, req.uid));

  if (!exist) {
    // ★ 初始 last_read 要设成"当前最新一条" ★
    //   设 0 的话，刚进群那一刻整个历史都被算成未读（新账号一进来就是 12 条红点）。
    const maxRow = await queryOne(
      'SELECT COALESCE(MAX(id), 0) AS m FROM chat_messages WHERE room_id = ?', [room.id]
    );
    await insert(
      'INSERT INTO chat_members (room_id, user_id, last_read_id) VALUES (?, ?, ?)',
      [room.id, req.uid, Number(maxRow && maxRow.m) || 0]
    );
    console.log(`  👥 ${req.user.nickname} 进了「${room.name}」`);
  }

  const memberCount = await queryOne(
    'SELECT COUNT(*) AS n FROM chat_members WHERE room_id = ?',
    [room.id]
  );

  return ok(res, {
    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      kind: room.kind,
      desc: room.desc || '',
      memberCount: Number(memberCount.n) || 0,
      isMuted: mute.muted,
      muteRemainSeconds: mute.remainSeconds,
    },
    isNewMember: !exist,
  }, exist ? `回到「${room.name}」` : `欢迎来到「${room.name}」`);
}));

// ============================================================
//  GET /api/group/rooms/:key/messages      取消息
//
//  查询参数：
//    before  取这个 id 之前的消息（翻历史，默认取最新的）
//    limit   取几条（默认 30，最多 100）
//    markRead=0  不要自动标记已读
// ============================================================
router.get('/rooms/:key/messages', auth, wrap(async (req, res) => {
  const room = await findRoom(req.params.key);
  if (!room) throw new ApiError('这个群不存在', 404);

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const before = req.query.before ? int(req.query.before, 'before', { min: 1 }) : null;

  // ★ after：只取"比我手上这条更新"的消息，给前端做轮询用 ★
  //   没有它的话，前端刷新只能整屏重拉 30 条再自己比对 id；
  //   有了它，每次只传新增的几条，既省流量又能实时刷新。
  //   （这只是同一个接口多认一个参数，接口数量没变）
  const after = req.query.after ? int(req.query.after, 'after', { min: 0 }) : null;

  // 必须先进过房间（否则没有 last_read_id，未读数会乱）
  const member = await queryOne(
    'SELECT id, last_read_id, muted_until FROM chat_members WHERE room_id = ? AND user_id = ?',
    [room.id, req.uid]
  );

  const params = [room.id];
  let whereSql = 'WHERE m.room_id = ?';

  // ★ 按标签匹配：同类群里只看得到"和我同标签的人" ★
  //   同龄群按年龄段、同省群按省份、星迹按星座；
  //   资料没填全就不过滤（否则新用户进去一片空白）。
  const tag = await myTagOf(room.kind, req.uid);
  whereSql += tagFilterSql(tag, req.uid, params);
  if (before) {
    whereSql += ' AND m.id < ?';
    params.push(before);
  }
  if (after) {
    whereSql += ' AND m.id > ?';
    params.push(after);
  }

  // 倒序取 limit 条，再翻回正序显示
  const rows = await query(
    `${MSG_SELECT} ${whereSql} ORDER BY m.id DESC LIMIT ${limit}`,
    params
  );
  const list = rows.reverse().map(r => serializeMessage(r, req.uid));

  const mute = checkMuted(room.id, req.uid, await myMuteSeconds(room.id, req.uid));

  // 自动标记已读
  let lastReadId = member?.last_read_id || 0;
  const shouldMark = req.query.markRead !== '0';
  if (shouldMark && list.length > 0) {
    const newest = list[list.length - 1].id;
    if (Number(newest) > Number(lastReadId)) {
      if (member) {
        await execute(
          'UPDATE chat_members SET last_read_id = ? WHERE id = ?',
          [newest, member.id]
        );
      } else {
        // 没进过房间就直接看消息，顺手补一条成员记录
        await insert(
          'INSERT INTO chat_members (room_id, user_id, last_read_id) VALUES (?, ?, ?)',
          [room.id, req.uid, newest]
        );
      }
      lastReadId = newest;
    }
  }

  // 还有没有更早的消息（用来显示"加载更早的消息"）
  const oldest = list.length > 0 ? list[0].id : null;
  const hasMore = oldest
    ? !!(await queryOne('SELECT id FROM chat_messages WHERE room_id = ? AND id < ? LIMIT 1',
        [room.id, oldest]))
    : false;

  return ok(res, {
    tag,

    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      kind: room.kind,
      desc: room.desc || '',
      isMuted: mute.muted,
      muteRemainSeconds: mute.remainSeconds,
    },
    list,
    limit,
    hasMore,
    lastReadId: Number(lastReadId) || 0,
  });
}));

// ============================================================
//  POST /api/group/rooms/:key/messages      发言
//
//  请求体: { content: "说点什么" }
//
//  ★ 这是机器人干活的地方 ★
//    1. 先看有没有被禁言
//    2. 再判内容是否违规 → 违规就不发出去，机器人出声提醒
//    3. 如果是危机信号 → 正常发出，机器人发一条关怀消息
// ============================================================
router.post('/rooms/:key/messages', auth, wrap(async (req, res) => {
  const room = await findRoom(req.params.key);
  if (!room) throw new ApiError('这个群不存在', 404);

  const content = str(req.body.content, '消息内容', { required: true, max: 1000 });

  // ---- 进群（没进过就自动进）----
  let member = await queryOne(
    'SELECT id, last_read_id, muted_until FROM chat_members WHERE room_id = ? AND user_id = ?',
    [room.id, req.uid]
  );
  if (!member) {
    const mid = await insert(
      'INSERT INTO chat_members (room_id, user_id, last_read_id) VALUES (?, ?, 0)',
      [room.id, req.uid]
    );
    member = { id: mid, last_read_id: 0, muted_until: null };
  }

  // ---- 1. 禁言检查 ----
  const mute = checkMuted(room.id, req.uid, await myMuteSeconds(room.id, req.uid));
  // 求助可进入审核并收到关怀，混合广告/攻击仍由后续审核拦截。
  if (mute.muted && !isCrisisText(content)) {
    throw new ApiError(
      `你正在被禁言，还有 ${mute.remainSeconds} 秒。先缓一下吧。`,
      429
    );
  }

  // ---- 2. 机器人审核 ----
  const review = reviewGroupMessage(room.id, req.uid, content, {
    nick: req.user.nickname,
  });

  // ---- 3. 危机信号：让他说，然后接住他 ----
  if (review.crisis && review.allow) {
    const msgId = await insert(
      'INSERT INTO chat_messages (room_id, user_id, type, content) VALUES (?, ?, "text", ?)',
      [room.id, req.uid, content]
    );

    // 机器人发一条关怀消息（不是处罚，是陪伴）
    const lines = HELP_LINES.map(l => `${l.name} ${l.phone}`).join('、');
    await botSay(
      room.id,
      `有人说了一句心里话。我不打断你，也不问你为什么。`
      + `只是想让你知道：如果这会儿特别难受，可尝试联系以下支持渠道 —— ${lines}`
    );

    await execute(
      'UPDATE chat_members SET last_read_id = ? WHERE id = ?',
      [msgId, member.id]
    );

    const row = await queryOne(`${MSG_SELECT} WHERE m.id = ?`, [msgId]);

    console.log(`  💚 群 ${room.code} 检测到危机信号，机器人已发关怀提示`);

    return ok(res, {
      message: serializeMessage(row, req.uid),
      blocked: false,
      care: {
        message: '你愿意说出来，已经很难得了。这些话不会被人拿来评判你。',
        lines: HELP_LINES,
      },
    }, '已发送');
  }

  // ---- 4. 普通违规：拦截 + 机器人提醒（可能附带禁言）----
  if (!review.allow) {
    // 发一条机器人消息到群里（不包含违规原文）
    await botSay(room.id, `🤖 ${review.botNotice}`);

    // 危机混合违规仍会进入此处；重启后的短处罚不能缩短原有禁言。
    let muteUntil = null;
    if (review.muteSeconds > 0) {
      await execute(
        'UPDATE chat_members SET muted_until = GREATEST(COALESCE(muted_until, NOW(3)), DATE_ADD(NOW(3), INTERVAL ? SECOND)) WHERE id = ?',
        [review.muteSeconds, member.id]
      );
      muteUntil = review.muteSeconds;
    }

    console.log(`  🤖 群 ${room.code} 拦截消息 [${review.category}] `
      + `user=${req.uid} 第${review.violationCount}次`
      + (muteUntil ? ` 禁言${muteUntil}秒` : ''));

    return ok(res, {
      blocked: true,
      category: review.category,
      reason: review.userNotice,
      violationCount: review.violationCount,
      muteSeconds: review.muteSeconds,
      botNotice: review.botNotice,
      care: review.crisis ? {
        message: '看到你说的这些。如果现在很难受，可尝试联系以下支持渠道。',
        lines: HELP_LINES,
      } : null,
    }, review.userNotice);
  }

  // ---- 5. 正常消息 ----
  const msgId = await insert(
    'INSERT INTO chat_messages (room_id, user_id, type, content) VALUES (?, ?, "text", ?)',
    [room.id, req.uid, content]
  );

  await execute('UPDATE chat_members SET last_read_id = ? WHERE id = ?', [msgId, member.id]);

  const row = await queryOne(`${MSG_SELECT} WHERE m.id = ?`, [msgId]);

  return ok(res, {
    message: serializeMessage(row, req.uid),
    blocked: false,
    care: null,
  }, '已发送');
}));

// ============================================================
//  POST /api/group/rooms/:key/read       手动标记已读
// ============================================================
router.post('/rooms/:key/read', auth, wrap(async (req, res) => {
  const room = await findRoom(req.params.key);
  if (!room) throw new ApiError('这个群不存在', 404);

  const newest = await queryOne(
    'SELECT MAX(id) AS m FROM chat_messages WHERE room_id = ?',
    [room.id]
  );
  const maxId = Number(newest.m) || 0;

  const member = await queryOne(
    'SELECT id FROM chat_members WHERE room_id = ? AND user_id = ?',
    [room.id, req.uid]
  );

  if (member) {
    await execute('UPDATE chat_members SET last_read_id = ? WHERE id = ?', [maxId, member.id]);
  } else {
    await insert(
      'INSERT INTO chat_members (room_id, user_id, last_read_id) VALUES (?, ?, ?)',
      [room.id, req.uid, maxId]
    );
  }

  return ok(res, { roomId: room.id, lastReadId: maxId }, '已标记为已读');
}));

// ============================================================
//  GET /api/group/rooms/:key/members      群里的人
// ============================================================
router.get('/rooms/:key/members', auth, wrap(async (req, res) => {
  const room = await findRoom(req.params.key);
  if (!room) throw new ApiError('这个群不存在', 404);

  const rows = await query(
    `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province, p.zodiac,
            cm.joined_at,
            CASE
              WHEN cm.muted_until IS NULL THEN 0
              ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(3), cm.muted_until))
            END AS mute_seconds
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE cm.room_id = ?
      ORDER BY cm.id DESC
      LIMIT 100`,
    [room.id]
  );

  return ok(res, {
    room: { id: room.id, code: room.code, name: room.name },
    list: rows.map(r => ({
      userId: r.id,
      uid: r.uid,
      nick: r.nickname,
      avatar: avatarUrl(r.avatar),
      signature: r.signature || '',
      province: r.province || '',
      zodiac: r.zodiac || '',
      joinedAt: r.joined_at,
      // 用数据库算好的秒数，不做 JS 时区解析
      isMuted: Number(r.mute_seconds) > 0,
      muteRemainSeconds: Number(r.mute_seconds) || 0,
    })),
    total: rows.length,
  });
}));

// ============================================================
//  GET /api/group/my-rooms       我进过的群（带未读数）
//  给首页"好友"页或消息中心用
// ============================================================
router.get('/my-rooms', auth, wrap(async (req, res) => {
  const rows = await query(
    `SELECT r.id, r.code, r.name, r.kind,
            cm.last_read_id,
            CASE
              WHEN cm.muted_until IS NULL THEN 0
              ELSE GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(3), cm.muted_until))
            END AS mute_seconds,
            (SELECT COUNT(*) FROM chat_messages m
              WHERE m.room_id = r.id AND m.id > cm.last_read_id) AS unread,
            (SELECT m2.content FROM chat_messages m2
              WHERE m2.room_id = r.id ORDER BY m2.id DESC LIMIT 1) AS last_content,
            (SELECT m3.created_at FROM chat_messages m3
              WHERE m3.room_id = r.id ORDER BY m3.id DESC LIMIT 1) AS last_time
       FROM chat_members cm
       JOIN chat_rooms r ON r.id = cm.room_id
      WHERE cm.user_id = ?
      ORDER BY last_time DESC, r.sort`,
    [req.uid]
  );

  return ok(res, {
    list: rows.map(r => ({
      roomId: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      unread: Number(r.unread) || 0,
      lastMessage: r.last_content || '',
      lastTime: relativeTime(r.last_time),
      isMuted: Number(r.mute_seconds) > 0,
      muteRemainSeconds: Number(r.mute_seconds) || 0,
    })),
    totalUnread: rows.reduce((s, r) => s + (Number(r.unread) || 0), 0),
  });
}));

// ============================================================
//  GET /api/group/total-unread     所有群的总未读（红点用）
//  和 bless 的 unreadCount 一样，永不抛错，方便前端调用
// ============================================================
router.get('/total-unread', auth, wrap(async (req, res) => {
  const row = await queryOne(
    `SELECT COALESCE(SUM(cnt), 0) AS n FROM (
       SELECT (SELECT COUNT(*) FROM chat_messages m
                WHERE m.room_id = cm.room_id AND m.id > cm.last_read_id) AS cnt
         FROM chat_members cm WHERE cm.user_id = ?
     ) t`,
    [req.uid]
  );
  return ok(res, { unread: Number(row.n) || 0 });
}));

// ============================================================
//  POST /api/group/_test/reset      重置机器人的状态（仅开发环境）
//
//  ★ 为什么要同时清两样东西 ★
//    机器人的状态分散在两个地方：
//      1. 内存里的违规计数（utils/chatBot.js 的 Map）
//      2. 数据库里的禁言截止时间（chat_members.muted_until）
//
//    我第一版只清了内存那一半，结果测试跑完留下的 30 秒禁言还在，
//    下一次跑的时候一发言就被 429 挡住 ——
//    表现成"违规消息没被拦"，其实它根本发不出消息。
//    （禁言检查在内容审核之前，所以连"被拦"的机会都没有。）
//
//  ★ 安全 ★
//    只在 NODE_ENV != production 时开放。
//    上线后这个端点直接返回 404，不会成为后门。
// ============================================================
router.post('/_test/reset', auth, wrap(async (req, res) => {
  if (!config.isDev) {
    throw new ApiError('接口不存在', 404);
  }

  resetViolations();
  const cleared = await execute('UPDATE chat_members SET muted_until = NULL WHERE muted_until IS NOT NULL');

  console.log(`  🧪 [仅开发] 机器人状态已重置（违规计数 + ${cleared} 条禁言记录）`);
  return ok(res, { reset: true, clearedMutes: cleared },
    `已重置（违规计数 + ${cleared} 条禁言，仅开发环境可用）`);
}));

export default router;
