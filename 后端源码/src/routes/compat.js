// ============================================================
//  前端契约路由
//
//  ★ 这份文件存在的意义 ★
//    新前端（十九稿）是按一套简洁的接口写的：
//      GET  /diary/public      GET  /diary/mine
//      GET  /diary/by-day      POST /diary / PUT /diary/:id
//      POST /bless             POST /bottle  POST /bottle/pick
//    而后端原来那套叫法不一样（/diary/feed?feed=all、/diary/save…）。
//
//    以前是在前端 api.js 里做一层翻译（适配层）。现在改成后端直接提供
//    这些路径，前端 api.js 变回一个干净的 fetch 封装 —— 浏览器里没有任何转换。
//
//  ★ 实现方式：转发给已有路由，不复制业务逻辑 ★
//    内部把 req.url 改成老路径，再交给那个子路由处理。
//    这样内容审核、通知、计数、事务这些全都还是原来那一份代码。
// ============================================================
import express from 'express';
import { query, queryOne, insert } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { int } from '../utils/validate.js';
import { auth, authOptional } from '../middleware/auth.js';

import { DIARY_SELECT, serializeDiary, attachUserState } from '../utils/diaryHelper.js';
import diaryRouter from './diary.js';
import blessRouter from './bless.js';
import bottleRouter from './bottle.js';

const router = express.Router();

/** 把这次请求改写路径后交给子路由 */
function forward(sub, newUrl, req, res, next) {
  const orig = req.url;
  req.url = newUrl;
  sub.handle(req, res, (err) => {
    req.url = orig;
    if (err) next(err);
  });
}

// ------------------------------------------------------------
//  GET /diary/public   所有人的公开日记
//  GET /diary/mine     我自己的（含私密）
//
//  这两条直接查库，不走转发 —— 转发时 req.url 改写后 req.query 不会重新解析，
//  实测会退化成 feed=all（返回所有人的日记）。直接查最稳。
// ------------------------------------------------------------
async function listDiaries(req, res, onlyMine) {
  const { page, size, offset } = parsePage(req, 20, 50);

  const where = [];
  const params = [];

  if (onlyMine) {
    if (!req.uid) throw new ApiError('请先登录', 401);
    where.push('d.user_id = ?');
    params.push(req.uid);
  } else {
    where.push('d.is_public = 1');

    // ★ 发现页（推荐流）要排除自己 ★
    //   /diary/public 默认是"公开墙"，但前端拿它当推荐流用，
    //   不排除的话，自己刚写的日记会立刻出现在自己的推荐里。
    if (req.query.excludeMine === '1' && req.uid) {
      where.push('d.user_id <> ?');
      params.push(req.uid);
    }
  }

  const whereSql = 'WHERE ' + where.join(' AND ');

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM diaries d ' + whereSql,
    params
  );
  const total = Number(totalRow?.total) || 0;

  const rows = await query(
    // 发现页的「换一批」用随机顺序；默认还是按日期倒序
    DIARY_SELECT + ' ' + whereSql
      // seed 只是给 RAND() 一个种子。注意：MySQL 的 RAND(seed)
      // 在不同次执行里顺序并不稳定（行处理顺序会变），所以
      // "发现页和详情页顺序一致"没有走这条路，改成前端存 id 顺序了。
      // 这里保留 seed 参数只是留个口子。
      + (req.query.sort === 'random'
          ? (req.query.seed ? ' ORDER BY RAND(' + (parseInt(req.query.seed, 10) || 1) + ')' : ' ORDER BY RAND()')
          : ' ORDER BY d.date_key DESC, d.id DESC')
      + ' LIMIT ' + Number(size) + ' OFFSET ' + Number(offset),
    params
  );

  const withState = await attachUserState(rows, req.uid);

  return ok(res, {
    list: withState.map(serializeDiary),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}

router.get('/diary/public', authOptional, wrap((req, res) => listDiaries(req, res, false)));
router.get('/diary/mine', auth, wrap((req, res) => listDiaries(req, res, true)));

// ------------------------------------------------------------
//  GET /diary/by-day?day=YYYY-MM-DD  →  /diary/date/:date
// ------------------------------------------------------------
router.get('/diary/by-day', (req, res, next) => {
  const day = String(req.query.day || '');
  forward(diaryRouter, '/date/' + encodeURIComponent(day), req, res, next);
});

// ------------------------------------------------------------
//  POST /diary 和 PUT /diary/:id  →  /diary/save
//  前端字段：{ content, visibility, cover, day }
//  后端字段：{ text, isPublic, img, date }
// ------------------------------------------------------------
function toSaveBody(body) {
  const b = body || {};
  return {
    date: b.day,
    text: b.content,
    img: b.cover || '',
    isPublic: b.visibility === 'public' ? 1 : 0,
  };
}

router.post('/diary', (req, res, next) => {
  req.body = toSaveBody(req.body);
  forward(diaryRouter, '/save', req, res, next);
});

router.put('/diary/:id', (req, res, next) => {
  req.body = toSaveBody(req.body);
  // ★ 必须把方法也改成 POST ★
  //   /diary/save 是 POST 路由，只改路径不改方法的话，
  //   子路由匹配不到，直接掉到 404 —— 前端拿到空响应，
  //   表现就是「保存了但没生效」。
  req.method = 'POST';
  forward(diaryRouter, '/save', req, res, next);
});

// ------------------------------------------------------------
//  POST /bless  { toId, content }  →  /bless/send { toUserId, content }
// ------------------------------------------------------------
router.post('/bless', (req, res, next) => {
  const b = req.body || {};
  req.body = { toUserId: b.toId, content: b.content };
  forward(blessRouter, '/send', req, res, next);
});

// ------------------------------------------------------------
//  POST /bottle  { content }  →  /bottle/toss
// ------------------------------------------------------------
router.post('/bottle', (req, res, next) => {
  forward(bottleRouter, '/toss', req, res, next);
});

// ------------------------------------------------------------
//  POST /bottle/pick   随机捞一个（前端不带 id）
//  后端原来的 /pick/:id 是"捞指定的那只"，这里补一个随机的
// ------------------------------------------------------------
router.post('/bottle/pick', auth, wrap(async (req, res) => {
  // 随机捞一个：不是自己扔的、自己还没捞过的、还在海上的
  const row = await queryOne(`
    SELECT b.id, b.content, b.created_at, u.nickname
      FROM bottles b JOIN users u ON u.id = b.user_id
     WHERE b.status = 'floating' AND b.user_id <> ?
       AND NOT EXISTS (SELECT 1 FROM bottle_picks p WHERE p.bottle_id = b.id AND p.user_id = ?)
     ORDER BY RAND() LIMIT 1`,
    [req.uid, req.uid]
  );

  if (!row) return ok(res, null, '海面上暂时没有新的瓶子');

  // 记一次捞取 + 计数 +1（和 /pick/:id 保持一致）
  await query('INSERT IGNORE INTO bottle_picks (bottle_id, user_id) VALUES (?, ?)', [row.id, req.uid]);
  // 计数以 bottle_picks 为准：并发捞同一只时，INSERT IGNORE 没插进去就不该 +1
  await query(
    'UPDATE bottles SET pick_count = (SELECT COUNT(*) FROM bottle_picks WHERE bottle_id = ?) WHERE id = ?',
    [row.id, row.id]
  );

  return ok(res, {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    authorNick: row.nickname,
  });
}));

export default router;
