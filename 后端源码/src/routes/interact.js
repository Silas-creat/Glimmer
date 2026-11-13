// ============================================================
//  互动模块：点赞 / 收藏 / 关注
//
//  对应前端：
//    diary-public.html  卡片右下角的 ♡ ☆ ＋ 三个按钮
//    my-list.html       我的喜欢 / 我的收藏
//    mine.html          我的主页（关注/粉丝数）
//    data.js            原来存在浏览器的 my_likes/my_saves/my_follows
//
//  ★ 这一步解决的核心问题 ★
//    以前点赞存在浏览器 localStorage 里：
//      - 换个设备，你的点赞全没了
//      - 换个账号（同一浏览器），能看到上一个人的点赞
//      - 别人看不到你的点赞数
//    现在存 MySQL，按 user_id 存，这些毛病全好。
//
//  设计要点：
//    1. 点赞数和收藏数在 diaries 表里有冗余字段（like_count / comment_count），
//       列表页就不需要每篇都去 COUNT 一次，快很多
//    2. 计数增减用 GREATEST(0, x-1)，绝不让它变成负数
//       （万一有脏数据或并发，也不会出现"负数点赞"这种荒唐显示）
//    3. 用唯一索引 + INSERT IGNORE / DELETE，天然幂等：
//       重复点两次赞不会报错，也不会加两次数
// ============================================================
import express from 'express';
import { query, queryOne, insert } from '../db/index.js';
import { ok, wrap, ApiError, parsePage } from '../utils/response.js';
import { int, str } from '../utils/validate.js';
import { auth, authOptional } from '../middleware/auth.js';
// 和 diary.js 共用同一套"加工日记行"的工具，避免两边字段不一致
import { DIARY_SELECT, serializeDiary, attachUserState } from '../utils/diaryHelper.js';
// ★ 头像必须经 avatarUrl 转成完整 URL ★
//   数据库里存的是文件名（demo_1.svg），直接返回给前端的话，
//   浏览器会把它当相对路径解析到前端目录，头像就碎了。
import { avatarUrl } from '../middleware/upload.js';
import { pushNotification } from '../utils/notify.js';

const router = express.Router();

// ============================================================
//  点赞
// ============================================================

// POST /api/interact/like/:diaryId    点赞/取消赞（切换）

// ============================================================
//  加好友后的系统问候
//
//  产品上叫"加好友自动打招呼"：双方互相关注后，两人会话里出现一条
//  灰色居中的系统提示，双方都能看到，点进去就能接着聊。
//  只发一次（会话里已经有见面记录就不再发）。
// ============================================================
const FRIEND_GREETING = '你们已经成为好友啦，去打个招呼吧';

async function syncFriendGreeting(meId, otherId, followed) {
  try {
    if (followed) {
      const mutual = await queryOne('SELECT id FROM follows WHERE user_id = ? AND target_id = ?', [otherId, meId]);
      if (mutual) return sendFriendGreeting(meId, otherId);
      return;
    }
    // 取消关注：把会话里那条问候删掉，免得聊天里还写着"已经成为好友"
    const [a, b] = Number(meId) < Number(otherId) ? [meId, otherId] : [otherId, meId];
    const conv = await queryOne(
      'SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', [a, b]
    );
    if (!conv) return;
    await query('DELETE FROM messages WHERE conv_id = ? AND is_sys = 1', [conv.id]);

    // 会话里要是没有别的消息了，把摘要也清空（否则列表里留一条点进去是空的会话）
    const leftRow = await queryOne(
      'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?', [conv.id]
    );
    if (!leftRow || Number(leftRow.n) === 0) {
      await query(
        // last_msg 是 NOT NULL，清空要用空串；last_time 置空，会话就不出现在列表里了
        "UPDATE conversations SET last_msg = '', last_time = NULL WHERE id = ?", [conv.id]
      );
    }
  } catch (e) {
    console.log('  ⚠️ 同步好友问候失败：' + e.message);
  }
}

async function sendFriendGreeting(meId, otherId) {
  try {
    const [a, b] = Number(meId) < Number(otherId) ? [meId, otherId] : [otherId, meId];

    let conv = await queryOne(
      'SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', [a, b]
    );
    if (!conv) {
      try {
        const cid = await insert('INSERT INTO conversations (user_a, user_b) VALUES (?, ?)', [a, b]);
        conv = { id: cid };
      } catch (e) {
        conv = await queryOne(
          'SELECT id FROM conversations WHERE user_a = ? AND user_b = ?', [a, b]
        );
      }
    }
    if (!conv) return;

    // 同一对人只发一次问候
    const exists = await queryOne(
      'SELECT id FROM messages WHERE conv_id = ? AND is_sys = 1 LIMIT 1', [conv.id]
    );
    if (exists) return;

    await insert(
      'INSERT INTO messages (conv_id, from_user, to_user, content, is_sys) VALUES (?, ?, ?, ?, 1)',
      [conv.id, meId, otherId, FRIEND_GREETING]
    );

    // ★ 必须同步会话摘要 ★
    //   会话列表的查询条件是 last_time IS NOT NULL，
    //   只往 messages 里插、不更新 last_time，两个人在消息页都看不到这条会话，
    //   只能从「好友 → 私信」直接点进去才有 —— 看着像"问候没发出去"。
    //   系统提示不增加未读，也不能清空双方已有消息的未读数。
    await query(
      `UPDATE conversations
          SET last_msg = ?, last_from = ?, last_time = NOW(3),
              deleted_by_a = NULL, deleted_by_b = NULL
        WHERE id = ?`,
      [FRIEND_GREETING, meId, conv.id]
    );
  } catch (e) {
    // 问候发不出去不该影响"关注成功"本身
    console.log('  ⚠️ 好友问候发送失败：' + e.message);
  }
}

router.post('/like/:diaryId', auth, wrap(async (req, res) => {
  const diaryId = int(req.params.diaryId, '日记ID', { min: 1 });

  const diary = await queryOne('SELECT id, user_id, like_count FROM diaries WHERE id = ?', [diaryId]);
  if (!diary) throw new ApiError('日记不存在', 404);

  const already = await queryOne(
    'SELECT id FROM likes WHERE user_id = ? AND diary_id = ?',
    [req.uid, diaryId]
  );

  // ★ 点赞的写入和计数都要抗并发 ★
  //   以前是先 DELETE 再 like_count-1：连点两下时，
  //   第二次 DELETE 影响 0 行但照样减 1，计数就比实际少了。
  //   现在改成：写操作本身幂等，计数直接以 likes 表为准重算。
  if (already) {
    await query('DELETE FROM likes WHERE user_id = ? AND diary_id = ?', [req.uid, diaryId]);
  } else {
    await query('INSERT IGNORE INTO likes (user_id, diary_id) VALUES (?, ?)', [req.uid, diaryId]);
  }

  const nowLiked = await queryOne('SELECT id FROM likes WHERE user_id = ? AND diary_id = ?', [req.uid, diaryId]);
  const liked = !!nowLiked;

  // 计数重算：不管并发多少次，结果都等于表里的真实行数
  await query(
    'UPDATE diaries SET like_count = (SELECT COUNT(*) FROM likes WHERE diary_id = ?) WHERE id = ?',
    [diaryId, diaryId]
  );

  if (!already && liked) {
    // 只有真的从"没赞"变成"赞了"才发通知
    await pushNotification({ toUserId: diary.user_id, fromUserId: req.uid, type: 'like', diaryId });
  }

  const fresh = await queryOne('SELECT like_count FROM diaries WHERE id = ?', [diaryId]);

  return ok(res, {
    diaryId,
    liked,
    likes: Number(fresh.like_count),
  }, liked ? '已点赞' : '已取消');
}));

// ============================================================
//  收藏
// ============================================================

// POST /api/interact/save/:diaryId    收藏/取消收藏（切换）
router.post('/save/:diaryId', auth, wrap(async (req, res) => {
  const diaryId = int(req.params.diaryId, '日记ID', { min: 1 });

  const diary = await queryOne('SELECT id, user_id FROM diaries WHERE id = ?', [diaryId]);
  if (!diary) throw new ApiError('日记不存在', 404);

  const already = await queryOne(
    'SELECT id FROM favorites WHERE user_id = ? AND diary_id = ?',
    [req.uid, diaryId]
  );

  let saved;
  if (already) {
    await query('DELETE FROM favorites WHERE id = ?', [already.id]);
    saved = false;
  } else {
    await insert('INSERT INTO favorites (user_id, diary_id) VALUES (?, ?)', [req.uid, diaryId]);
    saved = true;

    await pushNotification({ toUserId: diary.user_id, fromUserId: req.uid, type: 'favorite', diaryId });
  }

  // 收藏数不放在 diaries 里冗余（前端没显示这个数），
  // 需要的时候直接 COUNT 就行
  return ok(res, { diaryId, saved }, saved ? '已收藏' : '已取消收藏');
}));

// ============================================================
//  关注
// ============================================================

// POST /api/interact/follow/:userId   关注/取关（切换）
// userId 是内部 id；也可以直接传对外 uid（见下面的 /follow-uid/:uid）
// ============================================================
//  GET /api/interact/friend-stats    好友(互关)数 / 粉丝数 / 我关注数
//  给「好友」页的角标用，一次拿全。
// ============================================================
router.get('/friend-stats', auth, wrap(async (req, res) => {
  const row = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM follows f JOIN follows b
          ON b.user_id = f.target_id AND b.target_id = f.user_id
        WHERE f.user_id = ?) AS friends,
       (SELECT COUNT(*) FROM follows WHERE target_id = ?) AS fans,
       (SELECT COUNT(*) FROM follows WHERE user_id = ?) AS following`,
    [req.uid, req.uid, req.uid]
  );

  return ok(res, {
    friends: Number(row?.friends) || 0,
    fans: Number(row?.fans) || 0,
    following: Number(row?.following) || 0,
  });
}));

router.post('/follow/:userId', auth, wrap(async (req, res) => {
  const targetId = int(req.params.userId, '用户ID', { min: 1 });

  if (targetId === Number(req.uid)) {
    throw new ApiError('不能关注自己', 400);
  }

  const target = await queryOne('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target) throw new ApiError('这个人不存在', 404);

  const already = await queryOne(
    'SELECT id FROM follows WHERE user_id = ? AND target_id = ?',
    [req.uid, targetId]
  );

  let followed;
  if (already) {
    await query('DELETE FROM follows WHERE id = ?', [already.id]);
    followed = false;
  } else {
    await insert('INSERT INTO follows (user_id, target_id) VALUES (?, ?)', [req.uid, targetId]);
    followed = true;
  }

  // 顺便把对方的粉丝数、我的关注数算出来返回，前端好更新界面
  const [myFollowing, hisFans] = await Promise.all([
    queryOne('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?', [req.uid]),
    queryOne('SELECT COUNT(*) AS n FROM follows WHERE target_id = ?', [targetId]),
  ]);

  // 加了关注 → 发一条系统问候；取消了 → 把那条问候删掉
  await syncFriendGreeting(req.uid, targetId, followed);

  return ok(res, {
    userId: targetId,
    followed,
    myFollowing: Number(myFollowing.n),
    hisFans: Number(hisFans.n),
  }, followed ? '已关注' : '已取消关注');
}));

// POST /api/interact/follow-uid/:uid   按对外 uid 关注
// 方便前端：它拿到的是日记里的 uid（如 60933725737），不是内部 id
router.post('/follow-uid/:uid', auth, wrap(async (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (!/^\d{6,16}$/.test(uid)) throw new ApiError('uid 格式不对', 400);

  const target = await queryOne('SELECT id FROM users WHERE uid = ?', [uid]);
  if (!target) throw new ApiError('这个人不存在', 404);

  if (Number(target.id) === Number(req.uid)) throw new ApiError('不能关注自己', 400);

  const already = await queryOne(
    'SELECT id FROM follows WHERE user_id = ? AND target_id = ?',
    [req.uid, target.id]
  );

  let followed;
  if (already) {
    await query('DELETE FROM follows WHERE id = ?', [already.id]);
    followed = false;
  } else {
    await insert('INSERT INTO follows (user_id, target_id) VALUES (?, ?)', [req.uid, target.id]);
    followed = true;
  }

  await syncFriendGreeting(req.uid, target.id, followed);

  return ok(res, { userId: target.id, uid, followed }, followed ? '已关注' : '已取消关注');
}));

// ============================================================
//  列表查询
// ============================================================

// GET /api/interact/likes     我的喜欢
router.get('/likes', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM likes WHERE user_id = ?',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  // 按点赞时间倒序（最近喜欢的排前面），而不是按日记时间
  const rows = await query(
    `${DIARY_SELECT}
       JOIN likes l ON l.diary_id = d.id
      WHERE l.user_id = ?
      ORDER BY l.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  const withState = await attachUserState(rows, req.uid);

  return ok(res, {
    list: withState.map(serializeDiary),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// GET /api/interact/favorites     我的收藏
router.get('/favorites', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?',
    [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  const rows = await query(
    `${DIARY_SELECT}
       JOIN favorites f ON f.diary_id = d.id
      WHERE f.user_id = ?
      ORDER BY f.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    [req.uid]
  );

  const withState = await attachUserState(rows, req.uid);

  return ok(res, {
    list: withState.map(serializeDiary),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// GET /api/interact/my-follows     我关注的人
router.get('/my-follows', auth, wrap(async (req, res) => {
  const { page, size, offset } = parsePage(req, 20, 50);

  const onlyMutual = String(req.query.mutual || '') === '1';

  const totalRow = await queryOne(
    `SELECT COUNT(*) AS total FROM follows f WHERE f.user_id = ?${onlyMutual ? ' AND EXISTS (SELECT 1 FROM follows back WHERE back.user_id = f.target_id AND back.target_id = ?)' : ''}`,
    onlyMutual ? [req.uid, req.uid] : [req.uid]
  );
  const total = Number(totalRow.total) || 0;

  // ★ DISTINCT 不能省 ★
  //   老版本的 follows 表没有 (user_id, target_id) 唯一索引，
  //   同一个人可以被关注两次，列表里就出现两行一模一样的「小海」。
  //   这里先去重，保证一人一行；唯一索引在迁移脚本里补。
  // ?mutual=1 → 只看互相关注（好友）；默认看我关注的所有人
  const rows = await query(
    `SELECT DISTINCT u.id, u.uid, u.nickname,
            p.avatar, p.signature, p.province,
            f.id AS follow_id, f.created_at AS followed_at,
            (SELECT COUNT(*) FROM follows x WHERE x.target_id = u.id) AS fans,
            (SELECT COUNT(*) FROM follows x WHERE x.user_id = u.id) AS following,
            (SELECT COUNT(*) FROM diaries d WHERE d.user_id = u.id AND d.is_public = 1) AS diary_count,
            -- 对方有没有回关：有回关就是"好友"（双向关注）
            (SELECT COUNT(*) FROM follows y WHERE y.user_id = u.id AND y.target_id = ?) AS is_mutual
       FROM follows f
       JOIN users u ON u.id = f.target_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE f.user_id = ?${onlyMutual ? ' AND EXISTS (SELECT 1 FROM follows y2 WHERE y2.user_id = u.id AND y2.target_id = ?)' : ''}
      ORDER BY f.id DESC
      LIMIT ${Number(size)} OFFSET ${Number(offset)}`,
    onlyMutual ? [req.uid, req.uid, req.uid] : [req.uid, req.uid]
  );

  return ok(res, {
    list: rows.map(r => ({
      userId: r.id,
      uid: r.uid,
      nick: r.nickname,
      // ★ 必须转成完整 URL，否则前端拿到的是裸文件名 ★
      avatar: avatarUrl(r.avatar),
      signature: r.signature || '',
      province: r.province || '',
      fans: Number(r.fans),
      following: Number(r.following),
      diaryCount: Number(r.diary_count),
      followedAt: r.followed_at,
      isFollowed: true,   // 在这个列表里的，当然都关注了
      // 双向关注 = 好友：对方也关注了我
      isMutual: Number(r.is_mutual) > 0,
    })),
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// GET /api/interact/my-fans     关注我的人
router.get('/my-fans', auth, wrap(async (req, res) => {
  const rows = await query(
    `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province,
            f.created_at AS fan_at,
            (SELECT COUNT(*) FROM follows x WHERE x.user_id = ? AND x.target_id = u.id) AS i_follow_back,
            (SELECT COUNT(*) FROM follows x WHERE x.target_id = u.id) AS fans,
            (SELECT COUNT(*) FROM diaries d WHERE d.user_id = u.id AND d.is_public = 1) AS diary_count
       FROM follows f
       JOIN users u ON u.id = f.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE f.target_id = ?
      ORDER BY f.id DESC
      LIMIT 50`,
    [req.uid, req.uid]
  );

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS n FROM follows WHERE target_id = ?', [req.uid]
  );

  return ok(res, {
    list: rows.map(r => ({
      userId: r.id,
      uid: r.uid,
      nick: r.nickname,
      avatar: avatarUrl(r.avatar),
      signature: r.signature || '',
      province: r.province || '',
      fans: Number(r.fans) || 0,
      diaryCount: Number(r.diary_count) || 0,
      // "我有没有回关他" —— 前端可以显示"互相关注"
      isFollowed: Number(r.i_follow_back) > 0,
      isFollowedBack: Number(r.i_follow_back) > 0,
      fanAt: r.fan_at,
    })),
    total: Number(totalRow?.n) || 0,
  });
}));

// ============================================================
//  状态查询：某篇日记我点过赞/收藏没
//  （前端进页面时可以批量问，也可以直接用 feed 接口返回的 isLiked）
// ============================================================
router.get('/state/:diaryId', authOptional, wrap(async (req, res) => {
  const diaryId = int(req.params.diaryId, '日记ID', { min: 1 });

  if (!req.uid) {
    return ok(res, { diaryId, liked: false, saved: false, followed: false, likes: 0 });
  }

  const diary = await queryOne(
    `SELECT d.like_count, d.user_id,
            EXISTS(SELECT 1 FROM likes     WHERE user_id = ? AND diary_id = d.id) AS liked,
            EXISTS(SELECT 1 FROM favorites WHERE user_id = ? AND diary_id = d.id) AS saved
       FROM diaries d WHERE d.id = ?`,
    [req.uid, req.uid, diaryId]
  );
  if (!diary) throw new ApiError('日记不存在', 404);

  const followed = await queryOne(
    'SELECT EXISTS(SELECT 1 FROM follows WHERE user_id = ? AND target_id = ?) AS f',
    [req.uid, diary.user_id]
  );

  // ★ 字段两套名字都给 ★
  //   十九稿的前端读 likeCount / favorited，
  //   老的叫法是 likes / saved —— 两边都留着，谁读都不空。
  const likeCount = Number(diary.like_count) || 0;
  return ok(res, {
    diaryId,
    liked: Boolean(diary.liked),
    saved: Boolean(diary.saved),
    favorited: Boolean(diary.saved),
    followed: Boolean(followed.f),
    likes: likeCount,
    likeCount,
  });
}));

// ============================================================
//  用户对外统计（个人主页顶部那三个数字）
// ============================================================
router.get('/stats/:userId', authOptional, wrap(async (req, res) => {
  const userId = int(req.params.userId, '用户ID', { min: 1 });

  const user = await queryOne(
    `SELECT u.id, u.uid, u.nickname, p.avatar, p.signature, p.province, p.zodiac,
            (SELECT COUNT(*) FROM follows WHERE target_id = u.id) AS fans,
            (SELECT COUNT(*) FROM follows WHERE user_id = u.id)   AS following,
            (SELECT COALESCE(SUM(like_count),0) FROM diaries WHERE user_id = u.id AND is_public = 1) AS total_likes,
            (SELECT COUNT(*) FROM diaries WHERE user_id = u.id AND is_public = 1) AS diary_count
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
    [userId]
  );
  if (!user) throw new ApiError('这个人不存在', 404);

  let isFollowed = false;
  if (req.uid) {
    const f = await queryOne(
      'SELECT EXISTS(SELECT 1 FROM follows WHERE user_id = ? AND target_id = ?) AS f',
      [req.uid, userId]
    );
    isFollowed = Boolean(f.f);
  }

  return ok(res, {
    userId: user.id,
    uid: user.uid,
    nick: user.nickname,
    avatar: user.avatar || '',
    signature: user.signature || '',
    ip: user.province || '',
    zodiac: user.zodiac || '',
    // 前端个人主页模板里的三个数字：获赞 / 关注 / 粉丝
    likes: Number(user.total_likes),
    follows: Number(user.following),
    fans: Number(user.fans),
    diaryCount: Number(user.diary_count),
    isFollowed,
    isMine: req.uid ? Number(req.uid) === Number(userId) : false,
  });
}));

// ============================================================
//  十九稿用的新接口
//    前端把"点赞/收藏"统一成了 toggle，列表统一成了 mine，
//    另外加了互动消息。这里按前端给的契约实现。
//  （这段会被脚本注入到 routes/interact.js 的 export 之前）
// ============================================================

// POST /api/interact/toggle   { diaryId, type: 'like' | 'favorite' }
router.post('/toggle', auth, wrap(async (req, res) => {
  const diaryId = int(req.body.diaryId, '日记ID', { min: 1 });
  const type = str(req.body.type, '类型', { required: true, max: 16 });

  if (type !== 'like' && type !== 'favorite') {
    throw new ApiError('类型只能是 like 或 favorite', 400);
  }

  const diary = await queryOne('SELECT id, user_id, like_count FROM diaries WHERE id = ?', [diaryId]);
  if (!diary) throw new ApiError('日记不存在', 404);

  const table = type === 'like' ? 'likes' : 'favorites';
  const already = await queryOne(
    'SELECT id FROM ' + table + ' WHERE user_id = ? AND diary_id = ?',
    [req.uid, diaryId]
  );

  // ★ 同 /like/:diaryId：写操作幂等 + 计数以表为准 ★
  if (already) {
    await query('DELETE FROM ' + table + ' WHERE user_id = ? AND diary_id = ?', [req.uid, diaryId]);
  } else {
    await query('INSERT IGNORE INTO ' + table + ' (user_id, diary_id) VALUES (?, ?)', [req.uid, diaryId]);
  }

  const nowRow = await queryOne('SELECT id FROM ' + table + ' WHERE user_id = ? AND diary_id = ?', [req.uid, diaryId]);
  const active = !!nowRow;

  if (type === 'like') {
    await query(
      'UPDATE diaries SET like_count = (SELECT COUNT(*) FROM likes WHERE diary_id = ?) WHERE id = ?',
      [diaryId, diaryId]
    );
  }

  if (!already && active) {
    await pushNotification({
      toUserId: diary.user_id,
      fromUserId: req.uid,
      type,
      diaryId,
    });
  }

  const fresh = await queryOne('SELECT like_count FROM diaries WHERE id = ?', [diaryId]);

  return ok(res, {
    active,
    likeCount: Number(fresh.like_count) || 0,
  }, active ? '已' + (type === 'like' ? '点赞' : '收藏') : '已取消');
}));

// GET /api/interact/mine?type=like|favorite   我的喜欢 / 我的收藏
router.get('/mine', auth, wrap(async (req, res) => {
  const type = (req.query.type === 'favorite') ? 'favorite' : 'like';
  const { page, size, offset } = parsePage(req, 20, 50);

  const table = type === 'like' ? 'likes' : 'favorites';

  const totalRow = await queryOne(
    'SELECT COUNT(*) AS total FROM ' + table + ' WHERE user_id = ?',
    [req.uid]
  );
  const total = Number(totalRow?.total) || 0;

  const rows = await query(
    DIARY_SELECT
    + ' JOIN ' + table + ' t ON t.diary_id = d.id AND t.user_id = ?'
    + ' WHERE (d.is_public = 1 OR d.user_id = ?)'
    + ' ORDER BY t.id DESC'
    + ' LIMIT ' + Number(size) + ' OFFSET ' + Number(offset),
    [req.uid, req.uid]
  );

  const withState = await attachUserState(rows, req.uid);

  return ok(res, {
    list: withState.map(serializeDiary),
    type,
    page, size, total,
    hasMore: offset + rows.length < total,
  });
}));

// GET /api/interact/notifications?limit=20   互动消息
router.get('/notifications', auth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  const unreadRow = await queryOne(
    'SELECT COUNT(*) AS n FROM notifications WHERE to_user_id = ? AND is_read = 0',
    [req.uid]
  );

  const rows = await query(
    'SELECT n.id, n.type, n.diary_id, n.content, n.is_read, n.created_at,'
    + ' u.id AS from_id, u.nickname AS from_nick,'
    + ' LEFT(d.text, 20) AS diary_title'
    + ' FROM notifications n'
    + ' JOIN users u ON u.id = n.from_user_id'
    + ' LEFT JOIN diaries d ON d.id = n.diary_id'
    + ' WHERE n.to_user_id = ?'
    + ' ORDER BY n.id DESC'
    + ' LIMIT ' + limit,
    [req.uid]
  );

  return ok(res, {
    unread: Number(unreadRow?.n) || 0,
    list: rows.map(r => ({
      id: r.id,
      type: r.type,
      from: { id: r.from_id, nickname: r.from_nick, avatar: '' },
      diaryId: r.diary_id,
      diaryTitle: r.diary_title || '',
      content: r.content || '',
      createdAt: r.created_at,
      read: !!r.is_read,
    })),
  });
}));

// POST /api/interact/notifications/read   { ids: [...] } 或 { all: true }
router.post('/notifications/read', auth, wrap(async (req, res) => {
  if (req.body && req.body.all) {
    await query('UPDATE notifications SET is_read = 1 WHERE to_user_id = ? AND is_read = 0', [req.uid]);
  } else {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const clean = ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0);
    if (clean.length) {
      await query(
        'UPDATE notifications SET is_read = 1 WHERE to_user_id = ? AND id IN (' + clean.map(() => '?').join(',') + ')',
        [req.uid].concat(clean)
      );
    }
  }

  const left = await queryOne(
    'SELECT COUNT(*) AS n FROM notifications WHERE to_user_id = ? AND is_read = 0',
    [req.uid]
  );
  return ok(res, { unread: Number(left?.n) || 0 });
}));

export default router;
