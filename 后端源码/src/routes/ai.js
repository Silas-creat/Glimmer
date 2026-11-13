// ============================================================
//  AI 聊天（对应 chat.html）
//
//  需求原文："接入 deepseek 的 ai 做一个聊天机器人，
//             能读取记忆（同一个号换一个设备还能继续聊天）"
//
//  ★ "记忆"拆成两层，这是这一步的核心 ★
//
//    第一层：短期记忆 = 最近 N 条对话
//      直接从 ai_messages 表按时间取。换设备登录就能拉回来，
//      所以"同一个号换一个设备还能继续聊天"这一条靠它实现。
//
//    第二层：长期记忆 = 一段摘要（ai_profiles.summary）
//      如果每次都把全部历史发给模型，token 会越滚越多、越来越贵。
//      所以消息攒到一定数量后，把旧对话压成一段摘要，
//      之后只带"摘要 + 最近几轮"。
//      这样聊一年，每次请求的大小也是恒定的。
//
//  ★ 关于未登录 ★
//    聊天可以不登录（谁都能找个地方说说话），但那样记录只在内存里，
//    刷新就没了。登录之后才落库、才有记忆、才能换设备续聊。
//    未登录时接口会明确告诉前端"这次不保存"。
// ============================================================
import express from 'express';
import { query, queryOne, insert, transaction } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, relativeTime } from '../utils/validate.js';
import { auth, authOptional } from '../middleware/auth.js';
import { chat as llmChat, providerInfo, summarize } from '../utils/llm.js';
import { detectCrisis, HELP_LINES } from '../utils/moderation.js';
import { withAiSession, startAiSummary } from '../utils/aiSession.js';

const router = express.Router();

/** 每次发给模型的最近对话条数（一对 user+assistant 算 2 条） */
const RECENT_LIMIT = 16;

/**
 * 摘要之后保留多少条不压缩（保证上下文连贯）
 *
 * ★ 不需要额外的"攒够 N 条才压"阈值 ★
 *   只要"游标之后还有超过 KEEP_RECENT 条"就可以压。
 *   （我一开始另设了一个 SUMMARY_TRIGGER=20 的阈值，
 *     但改用 id 游标之后它就没意义了 —— 阈值本身就等价于
 *     "保留 KEEP_RECENT 条"这个条件。）
 */
const KEEP_RECENT = 8;

/** 单条消息最大长度 */
const MAX_LEN = 2000;

// ------------------------------------------------------------
//  序列化
// ------------------------------------------------------------
function serializeAiMessage(row) {
  return {
    id: row.id,
    role: row.role,          // 'user' | 'assistant'
    content: row.content,
    isMine: row.role === 'user',
    time: relativeTime(row.created_at),
    createdAt: row.created_at,
  };
}

/** 取用户的记忆摘要行（没有就建一个空的） */
async function getMemoryRow(userId) {
  let row = await queryOne('SELECT * FROM ai_profiles WHERE user_id = ?', [userId]);
  if (!row) {
    await insert('INSERT IGNORE INTO ai_profiles (user_id, summary, msg_count) VALUES (?, "", 0)', [userId]);
    row = await queryOne('SELECT * FROM ai_profiles WHERE user_id = ?', [userId]);
  }
  return row;
}

/**
 * 取最近 N 条对话（送给模型的格式）
 */
async function recentMessages(userId, limit = RECENT_LIMIT) {
  const rows = await query(
    `SELECT role, content FROM ai_messages
      WHERE user_id = ? AND role IN ('user','assistant')
      ORDER BY id DESC LIMIT ${Number(limit)}`,
    [userId]
  );
  // 倒序取完要翻回正序
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

/**
 * 攒够了就把旧对话压成摘要
 *
 * ★ 游标必须用"消息 id"，不能用"条数" ★
 *
 *  我最初的实现是"压完把 msg_count 重置成 KEEP_RECENT"，
 *  下次再攒到 20 就压"最早的 12 条"。
 *  结果是：第二次压的还是最早那 12 条（已经压过了！），
 *  而真正没压过的中间部分永远轮不到。
 *  实测：总共 20 条消息，摘要里只覆盖了 8 条，中间的丢了。
 *
 *  改成记住 summary_until_id（已压到哪条）之后，
 *  每次从这条之后开始，只压到"最近 KEEP_RECENT 条之前"。
 *  每条消息恰好被压一次。
 *
 * ★ 这个函数故意做成"不抛错"的 ★
 *   摘要只是优化（省 token），它失败绝不能让"用户发消息"失败。
 */
function maybeSummarize(userId, session) {
  startAiSummary(userId, session, async version => {
    const snapshot = await withAiSession(userId, async current => {
      if (current.version !== version) return null;
      const mem = await getMemoryRow(userId);
      const cursor = Number(mem.summary_until_id) || 0;
      const boundary = await queryOne(
        'SELECT id FROM ai_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
        [userId, KEEP_RECENT]
      );
      const untilId = Number(boundary?.id) || 0;
      if (untilId <= cursor) return null;
      const rows = await query(
        'SELECT id, role, content FROM ai_messages WHERE user_id = ? AND id > ? AND id <= ? ORDER BY id ASC LIMIT 200',
        [userId, cursor, untilId]
      );
      if (!rows.length) return null;
      return { summary: mem.summary || '', cursor, untilId: Number(rows.at(-1).id), rows };
    });
    if (!snapshot) return;
    const summary = await summarize(snapshot.summary, snapshot.rows, '');
    await withAiSession(userId, async current => {
      // DELETE invalidates every remote summary started before it returned.
      if (current.version !== version) return;
      await transaction(async conn => {
        await conn.execute(
          'UPDATE ai_profiles SET summary = ?, summary_until_id = ? WHERE user_id = ? AND summary_until_id = ?',
          [summary, snapshot.untilId, userId, snapshot.cursor]
        );
      });
    });
  });
}

// ============================================================
//  GET /api/ai/status        当前用的是哪个模型
// ============================================================
router.get('/status', authOptional, wrap(async (req, res) => {
  return ok(res, providerInfo());
}));

// ============================================================
//  GET /api/ai/messages      取历史记录（换设备续聊靠这个）
// ============================================================
router.get('/messages', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 30, 100);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM ai_messages WHERE user_id = ? AND role <> "system"',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const rows = await query(
    `SELECT * FROM ai_messages
      WHERE user_id = ? AND role <> 'system'
      ORDER BY id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  // 倒序取完翻回正序（聊天要从上往下读）
  const list = rows.reverse().map(serializeAiMessage);

  return ok(res, {
    list,
    page, size, total,
    hasMore: offset + rows.length < total,
    provider: providerInfo(),
  });
}));

// ============================================================
//  GET /api/ai/memory        我的长期记忆（用户有权看到）
//
//  ★ 为什么要把记忆暴露给用户 ★
//    这是他的数据，而且"AI 记得我什么"本身就是个有意思的功能。
//    更重要的是：他应该能删掉它。
//    一个陪伴产品偷偷记着你说的话却不让你知道，是不对的。
// ============================================================
router.get('/memory', auth, wrap(async (req, res) => {
  const mem = await getMemoryRow(req.uid);
  const countRow = await queryOne(
    'SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?',
    [req.uid]
  );

  // 还有多少条没进摘要（前端可以显示"记忆更新进度"）
  const pendingRow = await queryOne(
    'SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ? AND id > ?',
    [req.uid, Number(mem.summary_until_id) || 0]
  );

  return ok(res, {
    summary: mem.summary || '',
    hasMemory: Boolean(mem.summary),
    // 已经压进摘要的最后一条消息 id（游标）
    summaryUntilId: Number(mem.summary_until_id) || 0,
    totalMessages: Number(countRow.n) || 0,
    // 还没进摘要的条数（超过 KEEP_RECENT 就会自动压）
    pendingMessages: Number(pendingRow.n) || 0,
    keepRecent: KEEP_RECENT,
    lastChat: mem.last_chat,
    lastChatTime: mem.last_chat ? relativeTime(mem.last_chat) : '',
  });
}));

// ============================================================
//  DELETE /api/ai/memory      忘掉我（清空记忆 + 聊天记录）
// ============================================================
router.delete('/memory', auth, wrap(async (req, res) => {
  const deleted = await withAiSession(req.uid, async session => {
    const removed = await transaction(async conn => {
      const [result] = await conn.execute('DELETE FROM ai_messages WHERE user_id = ?', [req.uid]);
      await conn.execute(
        "UPDATE ai_profiles SET summary = '', msg_count = 0, summary_until_id = 0, last_chat = NULL WHERE user_id = ?",
        [req.uid]
      );
      return Number(result.affectedRows) || 0;
    });
    session.version++;
    return removed;
  });
  return ok(res, { deleted }, '已经忘掉了，从头开始吧');
}));

// ============================================================
//  POST /api/ai/chat         说一句话，拿一句回复
//
//  请求体: { message: "今天好累" }
// ============================================================
router.post('/chat', authOptional, wrap(async (req, res) => {
  const raw = req.body?.message;
  if (typeof raw !== 'string') throw new ApiError('内容必须是文字', 400);
  if (raw.trim().length > MAX_LEN) throw new ApiError('一次说得太长了（最多 2000 字）', 400);
  const message = str(raw, '内容', { required: true, max: MAX_LEN });
  const remember = req.body?.remember;
  if (remember !== undefined && typeof remember !== 'boolean') throw new ApiError('remember 必须为 true 或 false', 400);
  if (remember === true && !req.uid) throw new ApiError('保存聊天记忆需要先登录', 401);
  const providedHistory = req.body?.history;
  if (providedHistory !== undefined && (!Array.isArray(providedHistory) || providedHistory.length > RECENT_LIMIT)) {
    throw new ApiError('history 必须为数组，最多 16 条', 400);
  }
  const temporaryHistory = (providedHistory || []).map(item => {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string'
        || !item.content.trim() || item.content.length > MAX_LEN) {
      throw new ApiError('history 仅支持 user/assistant 文字消息，每条 1–2000 字', 400);
    }
    return { role: item.role, content: item.content.trim() };
  });
  const saved = Boolean(req.uid) && remember !== false;
  const crisis = detectCrisis(message);
  const care = crisis ? { message: '如果你正处在危险中，请先联系身边可信任的人或紧急救助，也可以拨打心理援助热线。', lines: HELP_LINES } : null;

  const respond = async session => {
    let memory = '';
    let history = temporaryHistory;
    if (saved) {
      const mem = await getMemoryRow(req.uid);
      memory = mem.summary || '';
      history = await recentMessages(req.uid, RECENT_LIMIT);
    }
    let reply;
    let provider = providerInfo();
    let degraded = !provider.isReal;
    try {
      reply = await llmChat([...history, { role: 'user', content: message }], { memory, nick: req.user?.nickname || '' });
    } catch {
      // Never expose upstream response bodies, keys or private prompt text.
      provider = { provider: 'local', isReal: false, model: 'local-companion', notice: '大模型暂时不可用，本次为本地关怀提示，未由大模型生成。' };
      degraded = true;
      reply = { content: crisis
        ? '我听到了你现在很难受。这里暂时无法连接大模型；如果有伤害自己的危险，请先到安全的地方，联系身边可信任的人或紧急救助。全国心理援助热线是 12356。'
        : '这会儿暂时无法连接大模型。这是一条本地提示；你可以稍后再试，也可以先找信任的人说说。', tokens: 0 };
    }
    let savedUser = null;
    let savedReply = null;
    if (saved) {
      [savedUser, savedReply] = await transaction(async conn => {
        const [userResult] = await conn.execute(
          "INSERT INTO ai_messages (user_id, role, content, token_count) VALUES (?, 'user', ?, 0)",
          [req.uid, message]
        );
        const [replyResult] = await conn.execute(
          "INSERT INTO ai_messages (user_id, role, content, token_count) VALUES (?, 'assistant', ?, ?)",
          [req.uid, reply.content, reply.tokens || 0]
        );
        await conn.execute('UPDATE ai_profiles SET msg_count = msg_count + 2, last_chat = NOW(3) WHERE user_id = ?', [req.uid]);
        const [rows] = await conn.execute('SELECT * FROM ai_messages WHERE id IN (?, ?) AND user_id = ? ORDER BY id', [userResult.insertId, replyResult.insertId, req.uid]);
        return rows;
      });
      maybeSummarize(req.uid, session);
    }
    return ok(res, {
      userMessage: savedUser ? serializeAiMessage(savedUser) : null,
      reply: savedReply ? serializeAiMessage(savedReply) : {
        id: null, role: 'assistant', content: reply.content, isMine: false, time: '刚刚', createdAt: null,
      },
      saved, provider, care, degraded,
      // Summary publication is asynchronous; GET /memory returns its latest state.
      memoryUpdated: false,
    });
  };
  // Temporary mode never loads, writes or summarizes long-term memory.
  return saved ? withAiSession(req.uid, respond) : respond(null);
}));

// ============================================================
//  GET /api/ai/greeting      打开聊天页时的开场白
//
//  ★ 为什么不写死一句"你好" ★
//    如果记忆里有东西，开场白应该体现出来 ——
//    "上次你说加班到很晚，今天好点了吗？"
//    这才是"记得我"的感觉。这是长期记忆最直接的用处。
// ============================================================
router.get('/greeting', authOptional, wrap(async (req, res) => {
  // 未登录：给一句普通的开场
  if (!req.uid) {
    return ok(res, {
      greeting: '我在这儿呢。今天过得怎么样？',
      fromMemory: false,
      provider: providerInfo(),
    });
  }

  const mem = await queryOne('SELECT * FROM ai_profiles WHERE user_id = ?', [req.uid]);
  const nick = req.user?.nickname || '';

  // 有没有聊过
  const countRow = await queryOne(
    'SELECT COUNT(*) AS n FROM ai_messages WHERE user_id = ?',
    [req.uid]
  );
  const hasChatted = (Number(countRow.n) || 0) > 0;

  // 第一次来
  if (!hasChatted) {
    return ok(res, {
      greeting: `${nick ? nick + '，' : ''}你好呀。我是小陪，你不用有压力，想说什么都行。`,
      fromMemory: false,
      isFirstTime: true,
      provider: providerInfo(),
    });
  }

  // 聊过，而且有长期记忆 → 用记忆做开场白
  if (mem && mem.summary) {
    return ok(res, {
      greeting: `${nick ? nick + '，' : ''}又见到你了。我一直记得你说过的一些事，你随时可以接着聊。`,
      // 把记忆本身也给前端（聊天页可以做一个"你记得我什么"的小入口）
      memory: mem.summary,
      fromMemory: true,
      isFirstTime: false,
      lastChatTime: mem.last_chat ? relativeTime(mem.last_chat) : '',
      provider: providerInfo(),
    });
  }

  // 聊过但还没攒出摘要
  return ok(res, {
    greeting: `${nick ? nick + '，' : ''}你回来了。上次聊到的地方，我都留着呢。`,
    fromMemory: false,
    isFirstTime: false,
    lastChatTime: mem?.last_chat ? relativeTime(mem.last_chat) : '',
    provider: providerInfo(),
  });
}));

export default router;
