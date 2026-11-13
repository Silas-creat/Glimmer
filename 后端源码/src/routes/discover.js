// ============================================================
//  发现页推荐流
//
//  对应前端：discover.html
//  需求原文："公开的可被好友看见和在自己主页展示，
//             还能像小红书一样随机推荐陌生人的公开"
//
//  ★ 关键区别：这不是"时间线"，是"推荐" ★
//    原来的实现是按时间倒序取全部公开日记 —— 那等于一个时间线，
//    不叫推荐。真正的"像小红书一样随机推荐"要做到：
//
//    1. 是陌生人的（不是你已经关注的人 —— 那些在关注流里）
//    2. 是随机的，但**翻页时不能重复**
//       → 用"按时间变化的固定种子"做随机排序。
//         同一个种子下顺序稳定，翻页就有意义；
//         种子每 10 分钟变一次，所以过一会儿再刷会有新面孔。
//    3. 混着给：只给日记会单调，所以把"人"和"漂流瓶"也混进来
//
//  ★ 为什么不用 ORDER BY RAND() ★
//    每次调用都是全新随机顺序，翻页必然重复、必然漏 ——
//    第 1 页和第 2 页可能包含同一条内容。
//    用固定种子就没这个问题。
// ============================================================
import express from 'express';
import { query, queryOne } from '../db/index.js';
import { ok, wrap } from '../utils/response.js';
import { relativeTime } from '../utils/validate.js';
import { authOptional } from '../middleware/auth.js';
import { avatarUrl } from '../middleware/upload.js';
import { DIARY_SELECT, attachUserState, serializeDiary } from '../utils/diaryHelper.js';

const router = express.Router();

/** 推荐种子多久换一次（秒） */
const SEED_ROTATE_SECONDS = 600;   // 10 分钟

/**
 * 算当前的"时间种子"
 *
 * 把当前时间按 10 分钟取整，得到一个固定的整数。
 * 同一个 10 分钟内这个数不变 → 排序稳定 → 翻页正确。
 */
function currentSeed() {
  return Math.floor(Date.now() / 1000 / SEED_ROTATE_SECONDS);
}

/**
 * 把 (id, 种子) 混成一个乱序的排名
 *
 * ★ 为什么不用 `MOD(id * 种子, 质数)` ★
 *   我第一版就是这么写的，结果它**几乎不随机**：
 *   因为 id 都远小于那个质数（1000003），所以 id*种子 是单调递增的，
 *   排出来就是"按 id 排"——效果等于按时间倒序，又绕回了时间线。
 *
 *   实测（5 篇日记 + 3 个瓶子 + 2 个人，id 在 127~131 之间）：
 *     顺序排出来是 131,130,129,128,127   ← 基本就是 id 倒序
 *     类型是 diary×5, bottle×3, user×2    ← 全部分组连在一起
 *   完全不是"刷到什么看什么"的推荐流。
 *
 * ★ 正确做法：真正的哈希混合（MurmurHash3 的收尾函数）★
 *   它把输入的所有二进制位充分打散，让相邻 id 的排名天差地别；
 *   同时种子参与第一轮运算，所以换种子 = 整批重排。
 *
 * ★ 为什么在应用层算，而不是让 MySQL 算 ★
 *   在 SQL 里复现这个哈希要用位移 + 异或 + 大数相乘，
 *   MySQL 的 BIGINT UNSIGNED 还容易溢出，写出来又长又难验证。
 *   而推荐池的数据量很小（几百条内容），一次全取回内存排序完全没问题 ——
 *   那就选能保证正确的那条路。
 */
function hashRank(id, seed) {
  let h = (Number(id) ^ Math.imul(Number(seed), 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// ============================================================
//  GET /api/discover          推荐流
//
//  查询参数：
//    size   要几条（默认 20，最多 50）
//    page   第几页（从 1 开始）
//    type   只要某一类：diary / user / bottle
// ============================================================
router.get('/', authOptional, wrap(async (req, res) => {
  const viewerId = req.uid ?? null;
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 20, 1), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const offset = (page - 1) * size;
  const type = ['diary', 'user', 'bottle'].includes(req.query.type) ? req.query.type : null;

  const seed = currentSeed();
  const items = [];

  const ME = viewerId || 0;

  // ------------------------------------------------------------
  //  1. 陌生人的公开日记
  //
  //  排除：自己的、已关注的人的
  //
  //  ★ 这里不写 LIMIT / ORDER BY ★
  //    候选集必须【全部】取回来，再在内存里按 hashRank 排序、再分页。
  //    如果让 SQL 先截一段（比如 LIMIT 60），那只是"id 最小的 60 条"，
  //    内存里再随机排，结果永远是同一小撮内容在轮换 —— 不是真推荐。
  //    推荐池很小（个人应用几百条），全取回内存完全没压力。
  // ------------------------------------------------------------
  let totalDiaries = 0;
  if (!type || type === 'diary') {
    const cnt = await queryOne(
      `SELECT COUNT(*) AS n
         FROM diaries d
        WHERE d.is_public = 1
          AND d.user_id <> ?
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.user_id = ? AND f.target_id = d.user_id)`,
      [ME, ME]
    );
    totalDiaries = Number(cnt.n) || 0;

    const diaryRows = await query(
      `${DIARY_SELECT}
        WHERE d.is_public = 1
          AND d.user_id <> ?
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.user_id = ? AND f.target_id = d.user_id)`,
      [ME, ME]
    );

    if (diaryRows.length > 0) {
      // 批量补"我有没有点赞/收藏"（不要 N+1）
      //
      // ★ attachUserState 会顺手算好 isMine ★
      //   所以下面 serializeDiary 只传行本身就行。
      //   （我一开始写成 serializeDiary(d, { viewerId })，但那个函数
      //     只接受一个参数，第二个会被静默忽略 —— 这类错误不报错，
      //     只是字段值悄悄不对，所以调用前一定先看函数签名。）
      const decorated = viewerId ? await attachUserState(diaryRows, viewerId) : diaryRows;
      decorated.forEach(d => {
        items.push({
          kind: 'diary',
          id: d.id,
          rank: hashRank(d.id, seed),
          diary: serializeDiary(d),
        });
      });
    }
  }

  // ------------------------------------------------------------
  //  2. 漂流瓶（混进来，增加内容形态）
  // ------------------------------------------------------------
  if (!type || type === 'bottle') {
    const bottleRows = await query(
      `SELECT b.id, b.content, b.is_anon, b.created_at,
              u.nickname, u.uid, p.avatar
         FROM bottles b
         JOIN users u             ON u.id = b.user_id
         LEFT JOIN user_profiles p ON p.user_id = b.user_id
        WHERE b.status = 'floating'
          AND b.pick_count < 30
          AND b.user_id <> ?`,
      [ME]
    );

    bottleRows.forEach(b => {
      const anon = Boolean(b.is_anon);
      items.push({
        kind: 'bottle',
        id: b.id,
        rank: hashRank(b.id, seed),
        bottle: {
          id: b.id,
          content: b.content,
          isAnon: anon,
          nick: anon ? '一个陌生人' : b.nickname,
          avatar: anon ? '' : avatarUrl(b.avatar),
          time: relativeTime(b.created_at),
        },
      });
    });
  }

  // ------------------------------------------------------------
  //  3. 活跃的人（"像小红书"要有人味，只推内容太单调）
  //
  //  排除：自己、已关注的人、以及任何一方拉黑过对方的
  //  ★ 为什么拉黑也要排除 ★
  //    如果对方拉黑了我还推给我，点进去会发现发不出消息，体验很差。
  //    所以互不推荐。
  // ------------------------------------------------------------
  if (!type || type === 'user') {
    const userRows = await query(
      `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province, p.zodiac,
              (SELECT COUNT(*) FROM diaries d
                WHERE d.user_id = u.id AND d.is_public = 1) AS diary_count
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id <> ?
          AND u.status = 'normal'
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.user_id = ? AND f.target_id = u.id)
          AND NOT EXISTS (
                SELECT 1 FROM conversations c
                 WHERE c.blocked_by IS NOT NULL
                   AND ((c.user_a = ? AND c.user_b = u.id)
                     OR (c.user_b = ? AND c.user_a = u.id))
              )
        HAVING diary_count > 0`,
      [ME, ME, ME, ME]
    );

    userRows.forEach(u => {
      items.push({
        kind: 'user',
        id: u.id,
        rank: hashRank(u.id, seed),
        user: {
          userId: u.id,
          uid: u.uid,
          nick: u.nickname,
          avatar: avatarUrl(u.avatar),
          signature: u.signature || '',
          province: u.province || '',
          zodiac: u.zodiac || '',
          diaryCount: Number(u.diary_count) || 0,
        },
      });
    });
  }

  // ------------------------------------------------------------
  //  4. 打散合并（这是"推荐流"看起来像推荐流的关键一步）
  //
  //  ★ 只靠哈希排序是不够的 ★
  //    实测发现：即使每个 id 的排名是乱的，日记（5 篇）之间
  //    还是会连在一起，因为日记数量远多于瓶子（3 个）和人（2 个）——
  //    总会有几篇日记的排名挨在一起。
  //    结果页面长这样：日记,日记,日记,日记,日记,瓶子,瓶子,瓶子,人,人
  //    这明显是"三段拼起来"，不像"刷到什么看什么"。
  //
  //  ★ 所以再按类型轮流取（轮询）★
  //    先把每类各自按排名排好，然后 diary→bottle→user 轮流各取一个。
  //    数量多的类型会自然地被摊开。
  //
  //  ★ 起点随种子转动 ★
  //    每次从不同的类型开始（seed % 类型数），
  //    这样不同批次的第一张卡片类型也不一样，更有新鲜感。
  // ------------------------------------------------------------
  const byKind = { diary: [], bottle: [], user: [] };
  items.forEach(it => { byKind[it.kind].push(it); });

  // 每类内部按排名排（同分用 id 保证顺序确定）
  const sorter = (a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.id - b.id);
  byKind.diary.sort(sorter);
  byKind.bottle.sort(sorter);
  byKind.user.sort(sorter);

  const kinds = ['diary', 'bottle', 'user']
    .filter(k => byKind[k].length > 0 && (!type || k === type));
  const merged = [];
  if (kinds.length > 0) {
    const startAt = seed % kinds.length;
    const cursor = {};
    kinds.forEach(k => { cursor[k] = 0; });

    // 一直轮到所有类型都取完
    let exhausted = false;
    while (!exhausted) {
      exhausted = true;
      for (let i = 0; i < kinds.length; i++) {
        const k = kinds[(startAt + i) % kinds.length];
        if (cursor[k] < byKind[k].length) {
          merged.push(byKind[k][cursor[k]++]);
          exhausted = false;
        }
      }
    }
  }

  // ------------------------------------------------------------
  //  5. 分页
  //
  //  ★ 分页必须建立在【已经合并好的完整列表】上 ★
  //    不能"每类各取几个再分页"，那样翻页会重复、会漏。
  // ------------------------------------------------------------
  const pageItems = merged.slice(offset, offset + size);

  // 去掉内部排序用的字段，别让前端看到
  const list = pageItems.map(it => {
    if (it.kind === 'diary') return { type: 'diary', diary: it.diary };
    if (it.kind === 'bottle') return { type: 'bottle', bottle: it.bottle };
    return { type: 'user', user: it.user };
  });

  return ok(res, {
    list,
    page,
    size,
    hasMore: offset + pageItems.length < merged.length,
    // 冷启动提示：总共能推荐多少篇日记（前端可显示"人还不多"）
    totalDiaries,
    // 推荐池总数（三类加起来），前端可以据此判断"内容多不多"
    total: merged.length,
    // 还有多久换一批（秒），前端可以显示"10 分钟后再来看看"
    seedRefreshIn: SEED_ROTATE_SECONDS - (Math.floor(Date.now() / 1000) % SEED_ROTATE_SECONDS),
  });
}));

// ============================================================
//  GET /api/discover/stats     推荐池里有多少东西
// ============================================================
router.get('/stats', authOptional, wrap(async (req, res) => {
  const ME = req.uid ?? 0;

  const d = await queryOne(
    'SELECT COUNT(*) AS n FROM diaries WHERE is_public = 1 AND user_id <> ?',
    [ME]
  );
  const u = await queryOne(
    'SELECT COUNT(*) AS n FROM users WHERE id <> ? AND status = "normal"',
    [ME]
  );
  const b = await queryOne(
    'SELECT COUNT(*) AS n FROM bottles WHERE status = "floating" AND user_id <> ?',
    [ME]
  );

  return ok(res, {
    diaries: Number(d.n) || 0,
    users: Number(u.n) || 0,
    bottles: Number(b.n) || 0,
  });
}));

export default router;
