// ============================================================
//  日记模块
//
//  对应前端：
//    diary-write.html   写/改日记（按日期，一天一篇）
//    diary-mine.html    日历，标出哪些天写过
//    diary-public.html  全屏滑动的日记流（feed）
//    discover.html      发现页瀑布流
//    mine.html          我的主页里的"我公开的日记"
//    data.js            原来硬编码的 11 条假数据 → 改成本模块的接口
//
//  三个核心设计决定：
//    1. 一天一篇：靠 diaries 表的唯一索引 (user_id, date_key) 保证，
//       所以保存用"有则改、无则增"（upsert），和前端行为一致
//    2. 私密日记只有作者本人能看，列表/详情都做了权限过滤
//    3. 列表按 id 倒序。id 单调递增，等价于按创建顺序倒序，比按
//       时间字段排序更快且不会出现同一秒的乱序
// ============================================================
import express from 'express';
import { query, queryOne, insert, execute } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { str, int, isValidDateKey, todayKey } from '../utils/validate.js';
import { auth, authOptional } from '../middleware/auth.js';
import { DIARY_SELECT, serializeDiary, attachUserState } from '../utils/diaryHelper.js';
import { moderate, detectCrisis, HELP_LINES } from '../utils/moderation.js';

const router = express.Router();

/** 查一篇日记的归属信息（用于权限判断），找不到返回 null */
async function findDiaryOwner(diaryId) {
  return queryOne('SELECT id, user_id, is_public, date_key, text FROM diaries WHERE id = ?', [diaryId]);
}

function careFor(text) {
  return detectCrisis(text) ? {
    message: '看到你写的这些。你愿意写下来，已经很不容易了。'
      + '如果现在很难受，可尝试联系以下支持渠道。',
    lines: HELP_LINES,
  } : null;
}

// ============================================================
//  POST /api/diary/save        保存日记（有则改、无则增）
//
//  请求体:
//    { date: "2026-10-16", text: "今天...", img: "https://...", isPublic: false }
//    date 不传就默认今天
//
//  为什么用"保存"而不是分开的 POST/PUT：
//    前端 diary-write.html 只有一个"保存"按钮，它自己不知道是新建还是修改。
//    让后端来判断更简单，也不会出现重复插入。
// ============================================================
router.post('/save', auth, wrap(async (req, res) => {
  const date = req.body.date ? str(req.body.date, '日期', { max: 10 }) : todayKey();
  if (!isValidDateKey(date)) {
    throw new ApiError('日期格式不对，应该是 2026-10-16 这样，而且必须是真实存在的日期', 400);
  }

  // 日记正文：必填，最多 5000 字
  const text = str(req.body.text, '日记内容', { required: true, max: 5000 });
  const img = str(req.body.img, '配图', { required: false, max: 255, def: '' });
  const isPublic = req.body.isPublic ? 1 : 0;
  const care = careFor(text);

  // ---- 内容检测（只对公开日记做硬拦截）----
  // ★ 为什么私密日记不拦：
  //   私密日记是用户写给自己的。这个产品叫"陪着"，
  //   它的意义就是让人有个地方能说真话。在私密日记里拦内容，
  //   等于把最后一块安全的地方也堵上了。
  //   公开的内容才需要为"别人会看到"负责。
  if (isPublic) {
    const mod = moderate(text);
    if (!mod.ok && mod.cat !== '危机信号') {
      console.log(`  🤖 拦截公开日记 [${mod.cat}] user=${req.uid} 内容="${text.slice(0, 30)}"`);
      return res.status(400).json({ code: 40000,
        msg: mod.msg || '这段内容不太适合公开，可以存成私密日记', data: { care } });
    }
  }

  const existing = await queryOne(
    'SELECT id FROM diaries WHERE user_id = ? AND date_key = ?',
    [req.uid, date]
  );

  let diaryId;
  let action;

  if (existing) {
    // 已有这天的日记 → 更新
    // 注意：img 为空字符串时不覆盖原有配图，避免前端没传图就把图弄丢了
    if (img) {
      await query(
        'UPDATE diaries SET text = ?, img = ?, is_public = ? WHERE id = ?',
        [text, img, isPublic, existing.id]
      );
    } else {
      await query(
        'UPDATE diaries SET text = ?, is_public = ? WHERE id = ?',
        [text, isPublic, existing.id]
      );
    }
    diaryId = existing.id;
    action = 'updated';
  } else {
    // 新建
    diaryId = await insert(
      `INSERT INTO diaries (user_id, text, img, is_public, date_key)
       VALUES (?, ?, ?, ?, ?)`,
      [req.uid, text, img, isPublic, date]
    );
    action = 'created';
  }

  const row = await queryOne(`${DIARY_SELECT} WHERE d.id = ?`, [diaryId]);

  // ★ 单篇日记也要补互动状态！
  //   否则前端打开某篇日记时，明明点过赞却显示空心 ♡。
  //   attachUserState 收数组，这里只有一篇，包一层即可。
  const [withState] = await attachUserState([row], req.uid ?? null);

  return ok(res, {
    action,
    diary: serializeDiary(withState),
    // 检测到危机信号时返回关怀提示（不拦截内容，只是温柔地多问一句）
    care,
  }, action === 'created' ? '日记已保存' : '日记已更新');
}));

// ============================================================
//  GET /api/diary/feed        日记流（列表）
//
//  查询参数:
//    feed=all       所有公开日记（发现页 / 看 ta 的）
//    feed=follow    我关注的人 + 我自己的公开日记
//    feed=mine      我的全部日记（含私密，仅本人可见）
//    nick=林小满    指定某个人的公开日记
//    userId=3       指定某个人的公开日记（按内部 id）
//    page=1&size=20 分页
//
//  权限规则（重要）：
//    feed=mine 只有登录用户能用，且只能看自己的（私密日记靠这条保护）
//    其他 feed 只返回 is_public=1 的日记
// ============================================================
router.get('/feed', authOptional, wrap(async (req, res) => {
  const feed = String(req.query.feed || 'all');
  const { page, size, offset } = parsePage(req, 20, 50);

  const where = [];
  const params = [];

  if (feed === 'mine') {
    // 我的日记：必须登录
    if (!req.uid) throw new ApiError('请先登录', 401);
    where.push('d.user_id = ?');
    params.push(req.uid);
    // 自己的私密日记也能看到，所以不加 is_public 条件
  } else if (feed === 'follow') {
    // 我关注的人 + 我自己
    if (!req.uid) throw new ApiError('请先登录', 401);
    where.push(`(
      d.user_id = ?
      OR d.user_id IN (SELECT target_id FROM follows WHERE user_id = ?)
    )`);
    params.push(req.uid, req.uid);
    // 别人没公开的日记不能看；自己的私密日记要保留
    where.push('(d.is_public = 1 OR d.user_id = ?)');
    params.push(req.uid);
  } else {
    // 公开流：只能看公开的
    where.push('d.is_public = 1');
  }

  // 按某个人筛选
  if (req.query.nick) {
    const nick = str(req.query.nick, '昵称', { max: 32 });
    where.push('u.nickname = ?');
    params.push(nick);
    // 看别人的主页只能看公开的（自己的除外）
    if (req.uid) {
      where.push('(d.is_public = 1 OR d.user_id = ?)');
      params.push(req.uid);
    } else {
      where.push('d.is_public = 1');
    }
  }
  if (req.query.userId) {
    const targetId = int(req.query.userId, 'userId', { min: 1 });
    where.push('d.user_id = ?');
    params.push(targetId);
    if (req.uid) {
      where.push('(d.is_public = 1 OR d.user_id = ?)');
      params.push(req.uid);
    } else {
      where.push('d.is_public = 1');
    }
  }
  // 按日期筛选（我的日记页点某一天）
  if (req.query.date) {
    const date = str(req.query.date, '日期', { max: 10 });
    if (!isValidDateKey(date)) throw new ApiError('日期格式不对', 400);
    where.push('d.date_key = ?');
    params.push(date);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const totalRow = await queryOne(
    `SELECT COUNT(*) AS total
       FROM diaries d
       JOIN users u ON u.id = d.user_id
       ${whereSql}`,
    params
  );
  const total = Number(totalRow?.total) || 0;

  // 注意 limit/offset 用模板拼接：mysql2 的 execute 对 LIMIT ? 支持不好，
  // 而这两个值已经过 parsePage 强制转成整数并限幅，不存在注入风险
  const limit = Number(size);
  const off = Number(offset);

  const rows = await query(
    `${DIARY_SELECT}
     ${whereSql}
     ORDER BY d.date_key DESC, d.id DESC
     LIMIT ${limit} OFFSET ${off}`,
    params
  );

  // 补上"当前用户是否点过赞/收藏过/关注了作者"
  // 这一步让前端卡片能直接显示正确的 ♥/♡ 状态，不用再逐张卡去问后端
  const withState = await attachUserState(rows, req.uid ?? null);

  return ok(res, {
    list: withState.map(serializeDiary),
    page,
    size,
    total,
    hasMore: off + rows.length < total,
  });
}));

// ============================================================
//  GET /api/diary/calendar?year=2026&month=10
//
//  给 diary-mine.html 用：返回有日记的日期列表
//  原来前端是从 localStorage 的 diary_entries 里读 key 来判断的，
//  现在改成问后端。month 是 1-12（和前端一致，不是 0-11）
// ============================================================
router.get('/calendar', auth, wrap(async (req, res) => {
  const now = new Date();
  const year = req.query.year ? int(req.query.year, '年份', { min: 1970, max: 2100 }) : now.getFullYear();
  const month = req.query.month ? int(req.query.month, '月份', { min: 1, max: 12 }) : now.getMonth() + 1;

  const rows = await query(
    `SELECT date_key, is_public
       FROM diaries
      WHERE user_id = ?
        AND date_key >= ?
        AND date_key < ?
      ORDER BY date_key`,
    [
      req.uid,
      `${year}-${String(month).padStart(2, '0')}-01`,
      // 用下个月 1 号作为开区间上界，比用 LAST_DAY 更省事也更快
      month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`,
    ]
  );

  return ok(res, {
    year,
    month,
    // 前端原来用 entries[k] 判断"这天写过没"，这个数组就是那些 k
    dates: rows.map(r => r.date_key),
    // 额外给个详细版，以后要显示公开/私密小图标时能用
    detail: rows.map(r => ({ dateKey: r.date_key, isPublic: Boolean(r.is_public) })),
    total: rows.length,
  });
}));

// ============================================================
//  GET /api/diary/date/:date     按日期拿我自己的日记
//
//  给 diary-write.html 用：打开某天时回填已有内容
//  一定要放在 /:id 之前，否则 'date' 会被当成 id 匹配掉
// ============================================================
router.get('/date/:date', auth, wrap(async (req, res) => {
  const date = req.params.date;
  if (!isValidDateKey(date)) throw new ApiError('日期格式不对', 400);

  const row = await queryOne(
    `${DIARY_SELECT} WHERE d.user_id = ? AND d.date_key = ?`,
    [req.uid, date]
  );

  if (!row) return ok(res, { diary: null });

  // 同样补上互动状态（写日记页也会显示这些）
  const [withState] = await attachUserState([row], req.uid);

  // 同 GET /:id：字段铺顶层 + 保留 diary 层
  const one = serializeDiary(withState);
  return ok(res, { ...one, diary: one });
}));

// ============================================================
//  GET /api/diary/:id        取单篇日记
//
//  权限：私密日记只有作者能看，别人访问返回 404
//        （返回 404 而不是 403，是不想让人知道"这里有一篇私密日记"）
// ============================================================
router.get('/:id', authOptional, wrap(async (req, res) => {
  const id = int(req.params.id, '日记ID', { min: 1 });

  const row = await queryOne(`${DIARY_SELECT} WHERE d.id = ?`, [id]);
  if (!row) throw new ApiError('日记不存在', 404);

  const isOwner = req.uid && Number(row.user_id) === Number(req.uid);
  if (!row.is_public && !isOwner) {
    throw new ApiError('日记不存在', 404);
  }

  // 浏览数 +1，同时记浏览历史（同一人同一篇只记一次）
  // 作者看自己的日记不计数，不然刷自己主页就把数字刷上去了
  if (!isOwner) {
    await query('UPDATE diaries SET view_count = view_count + 1 WHERE id = ?', [id]);
    if (req.uid) {
      await query(
        `INSERT INTO view_logs (user_id, diary_id) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE created_at = NOW(3)`,
        [req.uid, id]
      );
    }
    // ★ 关键：上面的 SELECT 是在自增之前读的，那行数据里的 view_count 是旧值。
    //   如果直接返回 row，前端拿到的浏览数会永远比数据库少 1，
    //   刷新一下才跳对 —— 这就是"脏读"。
    //   这里手工把返回值补上，保证返回给前端的就是自增后的真实值。
    row.view_count = Number(row.view_count) + 1;
  }

  // 补互动状态：这样前端打开单篇日记时，点赞/收藏的图标状态就是对的
  const [withState] = await attachUserState([row], req.uid ?? null);

  // ★ 两种读法都支持 ★
  //   老调用方（测试脚本）：data.diary.text
  //   新前端（十九稿） ：data.content —— 它把 data 直接当日记对象用
  //   所以字段铺一层到顶层，同时保留 diary 这一层。
  const one = serializeDiary(withState);
  return ok(res, { ...one, diary: one });
}));

// ============================================================
//  DELETE /api/diary/:id     删除日记（仅作者）
// ============================================================
router.delete('/:id', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '日记ID', { min: 1 });

  const diary = await findDiaryOwner(id);
  if (!diary) throw new ApiError('日记不存在', 404);
  if (Number(diary.user_id) !== Number(req.uid)) {
    throw new ApiError('只能删自己的日记', 403);
  }

  // likes / favorites / comments / view_logs 都设了 ON DELETE CASCADE，
  // 删日记时数据库会自动清理这些关联数据，不用手写一堆 DELETE
  await query('DELETE FROM diaries WHERE id = ?', [id]);

  return ok(res, { id }, '日记已删除');
}));

// ============================================================
//  PATCH /api/diary/:id/visibility    切换公开/私密
//
//  给 diary-write.html 的锁按钮用
//  （保存时也能直接带 isPublic，这个接口是给"列表里快速切换"用的）
// ============================================================
router.patch('/:id/visibility', auth, wrap(async (req, res) => {
  const id = int(req.params.id, '日记ID', { min: 1 });

  const diary = await findDiaryOwner(id);
  if (!diary) throw new ApiError('日记不存在', 404);
  if (Number(diary.user_id) !== Number(req.uid)) {
    throw new ApiError('只能改自己的日记', 403);
  }

  // 不传就取反，传了就按传的来
  const isPublic = req.body.isPublic === undefined
    ? (diary.is_public ? 0 : 1)
    : (req.body.isPublic ? 1 : 0);

  const care = careFor(diary.text);
  if (isPublic) {
    const mod = moderate(diary.text);
    if (!mod.ok && mod.cat !== '危机信号') {
      return res.status(400).json({ code: 40000,
        msg: mod.msg || '这段内容不太适合公开，可以保留为私密日记', data: { care } });
    }
  }

  // 绑定刚审核的正文及可见性，避免并发 /save 改写后沿用旧审核结果。
  // BINARY 比较避免数据库排序规则把大小写或尾部空格不同的正文视为相同。
  const updated = await execute(
    `UPDATE diaries SET is_public = ? WHERE id = ?
       AND user_id = ? AND BINARY text = BINARY ? AND is_public = ?`,
    [isPublic, id, req.uid, diary.text, diary.is_public]
  );
  if (!updated) {
    const latest = await findDiaryOwner(id);
    const latestCare = latest && Number(latest.user_id) === Number(req.uid)
      ? careFor(latest.text) : care;
    return res.status(409).json({ code: 40900,
      msg: '日记已发生变化，请重新查看后再设置公开或私密', data: { care: latestCare } });
  }

  return ok(res, { id, isPublic: Boolean(isPublic), care },
    isPublic ? '已设为公开' : '已设为私密');
}));

export default router;
