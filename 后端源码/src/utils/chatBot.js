// ============================================================
//  违规处理策略（机器人的"惩罚尺度"）
//
//  对应需求："有机器人管理（判断是否语言违规）"
//
//  ★ 核心设计：分级处理，而不是一律处罚 ★
//
//    微信群那种"发广告直接踢"的做法，对一个陪伴类产品是错的。
//    这里很多人本来就处在低落状态，一次误判把人踢走，
//    可能就再也回不来了。
//
//    所以分三档：
//      第 1 次违规  → 内容不发出 + 温和提醒（不禁言）
//      第 2 次违规  → 内容不发出 + 禁言 30 秒（让人冷静一下）
//      第 3 次及以后 → 内容不发出 + 禁言 5 分钟
//    窗口是 10 分钟：过了 10 分钟没再犯，记录清空重新算。
//
//  ★ 另一条更重要的规则：单独的危机信号不处罚 ★
//    有人在群里说"我不想活了"，那是求救，不是违规。
//    这时候应该做的是接住他（发关怀提示 + 热线），
//    而不是把他的话删掉再禁他的言。
//    混有广告、攻击或刷屏时仍拦截这些违规，同时返回关怀。
// ============================================================
import { checkContent, checkSpam, detectCrisis } from './moderation.js';

/** 违规计数窗口（分钟）：超过这个时间没再违规，记录作废 */
const VIOLATION_WINDOW_MIN = 10;

/**
 * 分档表
 * 每一项：{ count: 达到第几次, muteSeconds: 禁言多少秒, note: 提示语 }
 */
const TIERS = [
  { count: 1, muteSeconds: 0, note: '第一次先提醒一下' },
  { count: 2, muteSeconds: 30, note: '禁言 30 秒让他缓一下' },
  { count: 3, muteSeconds: 300, note: '禁言 5 分钟' },
];

/**
 * 内存里的违规记录
 *
 * 结构：{ 'roomId:userId': { count, firstAt, lastAt } }
 *
 * ★ 为什么放内存而不是数据库 ★
 *   这只是短时间的频次控制，重启后清空完全可以接受。
 *   真正的"永久禁言/封号"应该由管理员在后台操作（users.status），
 *   不该由机器人自动做。机器人只负责"这一会儿你先别说了"。
 *
 * ★ 缺点也说清楚 ★
 *   多进程部署时各进程的记录不共享。
 *   现在单进程跑，够了。真要多进程就换成 Redis。
 */
const violations = new Map();

function keyOf(roomId, userId) {
  return `${roomId}:${userId}`;
}

/** 清掉过期记录（每次用之前顺手清一下，不用定时器） */
function pruneExpired(now) {
  const limit = VIOLATION_WINDOW_MIN * 60 * 1000;
  for (const [k, v] of violations.entries()) {
    if (now - v.lastAt > limit) violations.delete(k);
  }
}

/** 供禁言/频控前检查；与正式审核共用同一套独立危机识别。 */
export function isCrisisText(content) {
  return detectCrisis(content);
}

/**
 * 检查一条群消息是否违规
 *
 * @param {number} roomId
 * @param {number} userId
 * @param {string} content
 * @param {object} room 房间信息（用于让提示语更具体）
 * @returns {{
 *   allow: boolean,          // 内容能不能发出去
 *   hardBlock: boolean,      // 是不是硬性违规（广告/辱骂等）
 *   crisis: boolean,         // 是不是危机信号
 *   category: string,
 *   userNotice: string,      // 给发消息的人看（私密提示）
 *   botNotice: string,       // 发到群里让大家看到的机器人消息（可为空）
 *   muteSeconds: number,     // 本次禁言多少秒
 *   violationCount: number,  // 这是窗口内第几次违规
 * }}
 */
export function reviewGroupMessage(roomId, userId, content, room = {}) {
  const now = Date.now();
  pruneExpired(now);

  const text = typeof content === 'string' ? content.trim() : '';

  // 危机单独检测；只对纯危机不处罚，其他违规仍按原档位处理。
  const crisis = detectCrisis(text);
  const c = checkContent(text);

  // ---- 2. 普通违规检测 ----
  let category = '';
  let reason = '';

  if (!c.ok && c.cat !== '危机信号') {
    category = c.cat;
    reason = c.msg;
  } else {
    const spam = checkSpam(text);
    if (!spam.ok) {
      category = '刷屏';
      reason = spam.msg;
    }
  }

  if (!category) {
    return {
      allow: true,
      hardBlock: false,
      crisis,
      category: crisis ? '危机信号' : '',
      userNotice: '',
      botNotice: '',
      muteSeconds: 0,
      violationCount: 0,
    };
  }

  // ---- 3. 记一次违规，算出现在是第几次 ----
  const k = keyOf(roomId, userId);
  const rec = violations.get(k) || { count: 0, firstAt: now, lastAt: now };
  rec.count += 1;
  rec.lastAt = now;
  violations.set(k, rec);

  // ---- 4. 按次数决定禁言时长 ----
  // 找到"不超过当前次数"的最后一档
  let tier = TIERS[0];
  for (const t of TIERS) {
    if (rec.count >= t.count) tier = t;
  }
  // 第 3 次以上都按最后一档（5 分钟）
  const muteSeconds = tier.muteSeconds;

  // ---- 5. 组装提示语 ----
  const nick = room.nick || '这位朋友';
  let botNotice = '';
  if (muteSeconds === 0) {
    botNotice = `@${nick} 这句话不太合适，我先不发了。${reason}`;
  } else if (muteSeconds < 60) {
    botNotice = `@${nick} 又出现不合适的内容，先安静 ${muteSeconds} 秒吧。`;
  } else {
    botNotice = `@${nick} 多次出现不合适的内容，先安静 ${Math.round(muteSeconds / 60)} 分钟。`
      + '这里想留个能好好说话的地方。';
  }

  return {
    allow: false,              // 内容不发出去
    hardBlock: true,
    crisis,
    category,
    userNotice: reason || '这句话不太合适',
    botNotice,
    muteSeconds,
    violationCount: rec.count,
  };
}

/**
 * 查某人现在是否被禁言
 *
 * ★ 强烈建议传 remainSecondsFromDb（让数据库算好剩余秒数）★
 *
 *  为什么：`new Date('2026-10-16 16:51:31')` 在 JS 里被当作【本地时间】
 *  解析。而 MySQL 里的 DATETIME 也是本地时间，看起来对得上 ——
 *  但只要服务器时区配置一变（或者代码跑在别的地方），就会差几个小时。
 *  我在这上面踩过：测试里用 toISOString() 造了个 UTC 时间字符串，
 *  结果和本地时间差了 8 小时，禁言判断直接失效。
 *
 *  正确做法是让 MySQL 自己算：
 *    SELECT TIMESTAMPDIFF(SECOND, NOW(3), muted_until) AS remain_seconds
 *  然后把结果传给这个函数。这样完全不经过 JS 的时区解析。
 *
 *  ★ 注意用 NOW(3) 而不是 NOW() ★
 *    muted_until 是 DATETIME(3)（毫秒精度）。如果另一边写 NOW()，
 *    就是秒级，两边精度不对称，差值会莫名偏掉。
 *    这条规则对整个项目都适用：**时间比较两边精度必须一致**，
 *    否则改成 NOW(3)，否则两边都用秒。混用一定出问题。
 *
 * @param {object} opts
 *   remainSecondsFromDb  数据库算好的剩余秒数（推荐，最准）
 *   mutedUntil           数据库里的时间字符串（兜底用，有隐患）
 */
export function checkMuted(roomId, userId, mutedUntil) {
  // 允许调用处直接把数字传进来（新写法）
  if (typeof mutedUntil === 'number') {
    if (mutedUntil <= 0) return { muted: false, until: 0, remainSeconds: 0 };
    return {
      muted: true,
      until: 0,   // 不再返回绝对时间戳，避免调用处误用它做时区运算
      remainSeconds: mutedUntil,
    };
  }

  // 兜底：老写法，从时间字符串解析（有时区隐患，只用于兼容）
  if (!mutedUntil) return { muted: false, until: 0, remainSeconds: 0 };

  const until = new Date(String(mutedUntil).replace(' ', 'T')).getTime();
  const now = Date.now();
  if (Number.isNaN(until) || until <= now) {
    return { muted: false, until: 0, remainSeconds: 0 };
  }
  return {
    muted: true,
    until,
    remainSeconds: Math.ceil((until - now) / 1000),
  };
}

/** 把"禁言到什么时候"存进数据库（复用 chat_members.muted_until） */
export function secondsToSql(muteSeconds) {
  // MySQL 的 DATE_ADD 用得上，这里只做个转换
  return Math.max(0, Math.floor(muteSeconds));
}

/** 给管理员用的：清掉某人的违规记录（比如误判后人工纠正） */
export function clearViolations(roomId, userId) {
  violations.delete(keyOf(roomId, userId));
  return true;
}

/** 给测试用的：看当前记录（不暴露给接口） */
export function peekViolations() {
  return violations;
}

/** 给测试用的：清空全部记录 */
export function resetViolations() {
  violations.clear();
}
