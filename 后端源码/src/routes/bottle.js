// ============================================================
//  漂流瓶模块
//
//  对应前端：weiguang.html（海面上漂着瓶子，点开是留言）
//
//  ★ 数据模型的关键决定 ★
//    没有用"瓶子被捞走就归某人"的设计，而是"一个瓶子可以被多人捞到"。
//    理由：这个功能是"把心愿扔进海里，随机推送给别人"。
//      一条温暖的留言被 10 个人看到，比只被 1 个人看到要好。
//    所以：
//      bottles       一个瓶子一行，status 只表示"还在不在海里"
//      bottle_picks  每被捞到一次记一行，唯一索引保证同一人不会重复捞到
//
//  ★ 另一个关键决定：名单不能一次全给 ★
//    如果 sea 接口返回海里全部瓶子，前端随机挑几个显示，
//    那么用户刷新几次就会反复看到同样那几条。
//    所以 sea 接口用 NOT EXISTS 排除"我已经捞过的"，
//    每次给的都是我没见过的瓶子。
// ============================================================
import express from 'express';
import { query, queryOne, insert, execute, transaction } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, int, relativeTime } from '../utils/validate.js';
import { auth, authOptional } from '../middleware/auth.js';
import { moderate, detectCrisis, HELP_LINES } from '../utils/moderation.js';
import { avatarUrl } from '../middleware/upload.js';

const router = express.Router();

function careFor(text) {
  return detectCrisis(text) ? {
    message: '看到你写下的这些。如果你现在需要有人听，可尝试联系以下支持渠道。',
    lines: HELP_LINES,
  } : null;
}

/** 一个瓶子能被捞多少次（超过就自动沉底，不再推送） */
const MAX_PICKS = 30;
/** 同一个人扔瓶子的最短间隔（秒），防刷屏 */
const TOSS_COOLDOWN = 20;

/**
 * 序列化一个瓶子
 *
 * ★ 匿名处理 ★
 *   is_anon=1 时不返回作者信息。漂流瓶本来就不该有署名压力 ——
 *   很多话就是因为"没人知道是我说的"才敢说出口。
 *   但对自己扔的瓶子例外（"我扔的"列表里当然要知道是自己的）。
 *
 * @param {object} row
 * @param {object} opts
 *   showAuthor  是否强制显示作者（自己看自己的瓶子时传 true）
 *   viewerId    当前登录用户 id，用来算 isMine
 */
function serializeBottle(row, { showAuthor = false, viewerId = null } = {}) {
  const anon = Boolean(row.is_anon);
  const expose = showAuthor || !anon;
  const isMine = viewerId !== null && Number(row.user_id) === Number(viewerId);

  return {
    id: row.id,
    content: row.content,
    isAnon: anon,
    time: relativeTime(row.created_at),
    createdAt: row.created_at,
    pickCount: Number(row.pick_count) || 0,

    // 匿名且不是自己看 → 不给作者信息
    userId: expose ? row.user_id : null,
    nick: expose ? row.nickname : '一个陌生人',
    avatar: expose ? avatarUrl(row.avatar) : '',
    uid: expose ? row.uid : '',

    // ★ isMine 必须由 viewerId 显式算出来
    //   我第一版写的是 `row.isMine === undefined ? undefined : ...`，
    //   但查询语句里从来没查过 row.isMine —— 整个判断是死代码，
    //   结果前端拿到的是 undefined，做不了"这是我自己扔的"提示。
    isMine,
  };
}

// ============================================================
//  POST /api/bottle/toss        扔一个瓶子
//
//  请求体: { content: "希望明天是个晴天", isAnon: true }
// ============================================================
router.post('/toss', auth, wrap(async (req, res) => {
  const content = str(req.body.content, '心愿内容', { required: true, max: 1000 });
  // 默认匿名（不传就是匿名）
  const isAnon = req.body.isAnon === undefined ? 1 : (req.body.isAnon ? 1 : 0);

  // ---- 频控：同一个人不能连着扔 ----
  // 和私信一样用 UNIX_TIMESTAMP 算差，两边精度一致，不会算偏
  const recent = await queryOne(
    `SELECT id,
            UNIX_TIMESTAMP(NOW(3)) - UNIX_TIMESTAMP(created_at) AS ago_sec
       FROM bottles
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 1`,
    [req.uid]
  );
  if (recent && Number(recent.ago_sec) < TOSS_COOLDOWN) {
    // 负数（时间偏差）时别给出荒唐的提示
    const wait = Math.max(1, Math.ceil(TOSS_COOLDOWN - Number(recent.ago_sec)));
    throw new ApiError(`歇一会儿再扔吧，还有 ${wait} 秒`, 429);
  }

  // ---- 内容检测 ----
  const mod = moderate(content);
  const care = careFor(content);
  if (!mod.ok && mod.cat !== '危机信号') {
    console.log(`  🤖 拦截漂流瓶 [${mod.cat}] user=${req.uid} 内容="${content.slice(0, 30)}"`);
    return res.status(400).json({ code: 40000,
      msg: mod.msg || '这句话不太合适，换种说法吧', data: { care } });
  }

  // ---- 完全一样的内容不要重复扔 ----
  const dup = await queryOne(
    'SELECT id FROM bottles WHERE user_id = ? AND content = ? AND status = "floating"',
    [req.uid, content]
  );
  if (dup) {
    throw new ApiError('这个瓶子里已经装着同样的话了', 409);
  }

  const id = await insert(
    'INSERT INTO bottles (user_id, content, is_anon) VALUES (?, ?, ?)',
    [req.uid, content, isAnon]
  );

  const row = await queryOne(
    `SELECT b.*, u.nickname, u.uid, p.avatar
       FROM bottles b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN user_profiles p ON p.user_id = b.user_id
      WHERE b.id = ?`,
    [id]
  );

  console.log(`  🍾 ${req.user.nickname} 扔了一个瓶子：${content.slice(0, 24)}`);

  return ok(res, {
    // ★ 必须传 viewerId，否则 isMine 会是 false
    //   serializeBottle 的 viewerId 默认是 null，不传就永远算不出"这是我的"
    bottle: serializeBottle(row, { showAuthor: true, viewerId: req.uid }),
    care,
  }, '瓶子已经扔进海里了');
}));

// ============================================================
//  GET /api/bottle/sea        海里随机捞几个瓶子
//
//  查询参数：
//    size   要几个（默认 6，最多 20）
//
//  ★ 关键：排除我已经捞过的 ★
//    用 NOT EXISTS 过滤掉 bottle_picks 里我记录过的瓶子，
//    所以每次刷新看到的都是我还没见过的。
//    不用担心"海里的瓶子被我捞完" —— 捞完时返回空数组，
//    前端会显示"海里暂时没有新的瓶子"。
// ============================================================
router.get('/sea', authOptional, wrap(async (req, res) => {
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 6, 1), 20);
  const viewerId = req.uid ?? null;

  let rows;

  if (viewerId) {
    // 登录了：排除自己扔的、以及自己已经捞过的
    rows = await query(
      `SELECT b.*, u.nickname, u.uid, p.avatar
         FROM bottles b
         JOIN users u ON u.id = b.user_id
         LEFT JOIN user_profiles p ON p.user_id = b.user_id
        WHERE b.status = 'floating'
          AND b.pick_count < ?
          AND b.user_id <> ?
          AND NOT EXISTS (
                SELECT 1 FROM bottle_picks bp
                 WHERE bp.bottle_id = b.id AND bp.user_id = ?
              )
        ORDER BY RAND()
        LIMIT ${size}`,
      [MAX_PICKS, viewerId, viewerId]
    );
  } else {
    // 没登录：只给公开的（匿名瓶子），也排除不了"捞过"，
    // 但未登录本来也不会记录捞取，所以随便给
    rows = await query(
      `SELECT b.*, u.nickname, u.uid, p.avatar
         FROM bottles b
         JOIN users u ON u.id = b.user_id
         LEFT JOIN user_profiles p ON p.user_id = b.user_id
        WHERE b.status = 'floating'
          AND b.pick_count < ?
        ORDER BY RAND()
        LIMIT ${size}`,
      [MAX_PICKS]
    );
  }

  // 顺便告诉前端海里还有多少没捞过的（可以用来显示"海里还有 N 个"）
  let remaining = null;
  if (viewerId) {
    const r = await queryOne(
      `SELECT COUNT(*) AS n FROM bottles b
        WHERE b.status = 'floating'
          AND b.pick_count < ?
          AND b.user_id <> ?
          AND NOT EXISTS (
                SELECT 1 FROM bottle_picks bp
                 WHERE bp.bottle_id = b.id AND bp.user_id = ?
              )`,
      [MAX_PICKS, viewerId, viewerId]
    );
    remaining = Number(r.n) || 0;
  }

  return ok(res, {
    list: rows.map(r => serializeBottle(r, { showAuthor: false, viewerId })),
    count: rows.length,
    remaining,
    // 前端据此显示不同的空状态文案
    emptyReason: rows.length === 0
      ? (remaining === 0 ? '你已经把海里没见过的瓶子都捞完了' : '海里暂时没有新的瓶子')
      : null,
  });
}));

// ============================================================
//  POST /api/bottle/pick/:id     标记"我捞到了这个瓶子"
//
//  前端点开瓶子详情时调用，记一笔（这样下次不会再推给我）。
//  重复调用不会报错（唯一索引 + INSERT IGNORE 的效果）。
// ============================================================
router.post('/pick/:id', auth, wrap(async (req, res) => {
  const bottleId = int(req.params.id, '瓶子ID', { min: 1 });

  const bottle = await queryOne(
    'SELECT id, user_id, pick_count, status FROM bottles WHERE id = ?',
    [bottleId]
  );
  if (!bottle) throw new ApiError('这个瓶子不在了', 404);
  if (bottle.status !== 'floating') throw new ApiError('这个瓶子已经被收回去了', 404);

  // 捞自己的瓶子没意义
  if (Number(bottle.user_id) === Number(req.uid)) {
    return ok(res, { bottleId, alreadyPicked: true, isMine: true }, '这是你自己扔的瓶子');
  }

  // 已经捞过就什么都不做
  const exist = await queryOne(
    'SELECT id FROM bottle_picks WHERE bottle_id = ? AND user_id = ?',
    [bottleId, req.uid]
  );
  if (exist) {
    return ok(res, { bottleId, alreadyPicked: true }, '你已经捞过这个瓶子了');
  }

  // ★ 事务：记捞取 + 计数 +1
  //   用事务保证不会出现"记了捞取但没加计数"
  // ★ 并发安全 ★
  //   INSERT 用 IGNORE 防重复，计数以 bottle_picks 为准重算，
  //   连点两下也不会把 pick_count 加两次。
  await transaction(async (conn) => {
    await conn.execute(
      'INSERT IGNORE INTO bottle_picks (bottle_id, user_id) VALUES (?, ?)',
      [bottleId, req.uid]
    );
    await conn.execute(
      'UPDATE bottles SET pick_count = (SELECT COUNT(*) FROM bottle_picks WHERE bottle_id = ?) WHERE id = ?',
      [bottleId, bottleId]
    );
  });

  const fresh = await queryOne('SELECT pick_count FROM bottles WHERE id = ?', [bottleId]);

  return ok(res, {
    bottleId,
    alreadyPicked: false,
    pickCount: Number(fresh.pick_count),
  }, '捞到了');
}));

// ============================================================
//  GET /api/bottle/mine       我扔过的瓶子
// ============================================================
router.get('/mine', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM bottles WHERE user_id = ? AND status = "floating"',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const rows = await query(
    `SELECT b.*, u.nickname, u.uid, p.avatar
       FROM bottles b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN user_profiles p ON p.user_id = b.user_id
      WHERE b.user_id = ? AND b.status = 'floating'
      ORDER BY b.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  // 我扔的瓶子被多少人捞到了 —— 这个数字有点温暖
  const pickStats = await queryOne(
    `SELECT COALESCE(SUM(pick_count), 0) AS total_picks,
            COUNT(*) AS bottle_count
       FROM bottles WHERE user_id = ? AND status = 'floating'`,
    [req.uid]
  );

  return ok(res, {
    list: rows.map(r => serializeBottle(r, { showAuthor: true, viewerId: req.uid })),
    page, size, total,
    hasMore: offset + rows.length < total,
    // 我扔的瓶子一共被捞了多少次
    totalPicks: Number(pickStats.total_picks) || 0,
  });
}));

// ============================================================
//  GET /api/bottle/picked     我捞到过的瓶子
// ============================================================
router.get('/picked', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM bottle_picks WHERE user_id = ?',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const rows = await query(
    `SELECT b.*, u.nickname, u.uid, p.avatar,
            bp.created_at AS picked_at
       FROM bottle_picks bp
       JOIN bottles b ON b.id = bp.bottle_id
       JOIN users u   ON u.id = b.user_id
       LEFT JOIN user_profiles p ON p.user_id = b.user_id
      WHERE bp.user_id = ?
      ORDER BY bp.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  return ok(res, {
    list: rows.map(r => ({
      ...serializeBottle(r, { showAuthor: false, viewerId: req.uid }),
      pickedAt: r.picked_at,
      pickedTime: relativeTime(r.picked_at),
    })),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// ============================================================
//  DELETE /api/bottle/:id      把自己的瓶子收回
// ============================================================
router.delete('/:id', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '瓶子ID', { min: 1 });

  const b = await queryOne('SELECT id, user_id FROM bottles WHERE id = ?', [id]);
  if (!b) throw new ApiError('这个瓶子不在了', 404);
  if (Number(b.user_id) !== Number(req.uid)) {
    throw new ApiError('只能收回自己扔的瓶子', 403);
  }

  // 不真删，改成 removed —— 保留数据便于以后做"被捞过的瓶子"记录
  await execute('UPDATE bottles SET status = "removed" WHERE id = ?', [id]);

  return ok(res, { id }, '瓶子已收回');
}));

// ============================================================
//  GET /api/bottle/stats       海里的统计（页面上可以显示）
// ============================================================
router.get('/stats', authOptional, wrap(async (req, res) => {
  const row = await queryOne(
    `SELECT COUNT(*) AS floating,
            COALESCE(SUM(pick_count), 0) AS total_picks
       FROM bottles WHERE status = 'floating'`
  );

  return ok(res, {
    floating: Number(row.floating) || 0,
    totalPicks: Number(row.total_picks) || 0,
  });
}));


// ============================================================
//  POST /api/bottle/:id/bless   给这个瓶子（的作者）送一句祝福
//
//  十九稿的「送 ta 一句祝福」走的就是这个路径。
//  实现上复用 blessings 表，额外记一个 bottle_id，方便追溯是哪只瓶子。
// ============================================================
router.post('/:id/bless', auth, wrap(async (req, res) => {
  const bottleId = int(req.params.id, '瓶子ID', { min: 1 });
  const content = str(req.body.content, '祝福内容', { required: true, max: 1000 });

  const bottle = await queryOne('SELECT id, user_id FROM bottles WHERE id = ?', [bottleId]);
  if (!bottle) throw new ApiError('这个瓶子不在了', 404);
  if (Number(bottle.user_id) === Number(req.uid)) {
    throw new ApiError('这是你自己扔的瓶子', 400);
  }

  // 和 /bless/send 一样要过内容检测：祝福功能不能拿来打广告或骂人
  const mod = moderate(content);
  const care = careFor(content);
  if (!mod.ok && mod.cat !== '危机信号') {
    console.log(`  🤖 拦截瓶子祝福 [${mod.cat}] from=${req.uid} 内容="${content.slice(0, 30)}"`);
    return res.status(400).json({ code: 40000,
      msg: mod.msg || '这句话不太合适，换种说法吧', data: { care } });
  }

  // 防手抖连点
  const dup = await queryOne(
    `SELECT id FROM blessings
      WHERE from_user = ? AND to_user = ? AND content = ?
        AND created_at > DATE_SUB(NOW(3), INTERVAL 10 SECOND)`,
    [req.uid, bottle.user_id, content]
  );
  if (dup) throw new ApiError('这条祝福刚发过了', 409);

  const id = await insert(
    'INSERT INTO blessings (from_user, to_user, content, bottle_id) VALUES (?, ?, ?, ?)',
    [req.uid, bottle.user_id, content, bottleId]
  );

  return ok(res, { id, toUserId: bottle.user_id, care }, '祝福已送出');
}));

export default router;
