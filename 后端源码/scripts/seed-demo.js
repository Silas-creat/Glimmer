// ============================================================
//  演示数据：给前端同事演示之前，先把库填成一个"看起来在用"的状态
//
//  用法：
//    node scripts/seed-demo.js            # 造演示数据
//    node scripts/seed-demo.js --clean    # 清掉演示数据（演示结束后）
//    node scripts/seed-demo.js --check    # 只看现在库里有什么，不改
//
//  ★ 为什么需要这个脚本 ★
//    数据库是空的，直接演示会满屏"还没有内容"，
//    前端同事看不出任何东西。演示需要有人、有日记、有评论、
//    有未读消息 —— 也就是"一个已经用了一阵子的产品"该有的样子。
//
//  ★ 怎么保证演示数据不会和真实数据混在一起 ★
//    演示用户用固定的手机号段（200000000xx），
//    清理时只删这些用户的全部关联数据（外键是级联的），
//    不会碰到 13800138000（你自己那个账号）的任何东西。
//    日记图片也在 uploads/ 里用 demo_ 前缀命名，清理时一起删。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { query, queryOne, execute, insert, pool } from '../src/db/index.js';
import { config, ROOT } from '../src/config/index.js';

const CLEAN = process.argv.includes('--clean');
const CHECK = process.argv.includes('--check');

/**
 * --reset-unread：把演示数据里的"未读"重新变回未读（为了演示时有红点）
 *
 * ★ 为什么需要这个单独的开关 ★
 *    seed 现在是幂等的（已存在就跳过），所以它**不会**破坏已读状态 ——
 *    这是好事（不会凭空冒红点），但也意味着"你看完一次之后，
 *    祝福的红点就永远不回来了"。
 *
 *    而演示时恰恰需要那个红点。所以拆成两个动作：
 *      node scripts/seed-demo.js                 → 只补齐数据，不动已读状态
 *      node scripts/seed-demo.js --reset-unread  → 顺便把未读重置回去
 *
 *    这样"正常使用"和"准备演示"不会互相干扰。
 */
const RESET_UNREAD = process.argv.includes('--reset-unread');

/**
 * 演示账号统一用这个号段，方便整体清理
 *
 * ★ 号段必须是"合法手机号" ★
 *    登录时后端用 /^1[3-9]\d{9}$/ 校验手机号。
 *    我第一版用的是 20000000001（以 2 开头），
 *    写库能成功、数据也都在，但**演示账号根本登录不了**——
 *    一登录就报"手机号格式不对"。
 *
 *    因为我是直接 INSERT 建的账号，绕过了注册时的手机号校验，
 *    所以这个错误当时一点提示都没有，直到演示登录才发现。
 *
 *    现在用 1990000 开头：以 1 开头、第二位 9，合法；
 *    而且和主账号 13800138000 不冲突，也不会被垃圾账号清理误删。
 */
const DEMO_PHONE_PREFIX = '1990000';

/** 图片 URL 前缀（和数据库里 img 字段存的格式一致） */
// ★ 封面存相对路径 ★
//   以前用 config.publicBaseUrl 拼成 http://旧IP:8080/uploads/x.svg，
//   换机器/换 IP 之后库里全是打不开的死链接。
//   前端和后端同源（start.js 会把 /uploads 转发给后端），存 /uploads/... 就行。

const log = (m) => console.log('  ' + m);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

// ============================================================
//  演示用图片：程序生成 SVG，不依赖外部网络
//
//  ★ 为什么不用真照片 ★
//    ① 从网上下载别人的照片当演示素材有版权问题
//    ② 演示时万一断网，外链图片全部裂开，非常尴尬
//    ③ 生成出来的渐变色块在手机上看起来其实挺好看
//  ★ 为什么要图片 ★
//    前端把 img 直接当背景图用（style.backgroundImage = url(...)），
//    图片为空时卡片是白底白字，演示时几乎看不清。
// ============================================================
const PALETTES = [
  ['#cfe0d8', '#9dbfae', '#eaf2ec'],   // 薄荷
  ['#e8d7cc', '#c9a68f', '#f5ece4'],   // 陶土
  ['#d6dfe9', '#93aec8', '#eef3f8'],   // 雾蓝
  ['#e9e1cd', '#c7b58c', '#f6f1e2'],   // 米杏
  ['#ded4e6', '#ad9bc0', '#f0eaf4'],   // 藕紫
  ['#d9e5d4', '#a3bf98', '#eff5ec'],   // 苔绿
  ['#e5dae0', '#c2a3b3', '#f4ecf0'],   // 藕粉
  ['#d3e3e6', '#8fb6bd', '#ecf4f5'],   // 青灰
];

/** 生成一张柔和的渐变色图（抽象图形，不像占位符） */
function makeSvg(idx) {
  const [c1, c2, c3] = PALETTES[idx % PALETTES.length];
  // 每张图加几个位置不同的半透明圆形，让它们看起来不一样
  const circles = [];
  for (let i = 0; i < 3; i++) {
    const cx = ((idx * 37 + i * 61) % 100);
    const cy = ((idx * 53 + i * 29) % 100);
    const r = 18 + ((idx * 7 + i * 13) % 26);
    circles.push(
      `<circle cx="${cx}%" cy="${cy}%" r="${r}" fill="#ffffff" opacity="0.22"/>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="55%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" fill="url(#g)"/>
  ${circles.join('\n  ')}
  <rect width="400" height="400" fill="#000" opacity="0.06"/>
</svg>`;
}

function writeDemoImages() {
  const dir = path.join(ROOT, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const urls = [];
  for (let i = 1; i <= 8; i++) {
    const name = `demo_${i}.svg`;
    fs.writeFileSync(path.join(dir, name), makeSvg(i), 'utf8');
    urls.push(`/uploads/${name}`);
  }
  return urls;
}

function removeDemoImages() {
  const dir = path.join(ROOT, 'uploads');
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('demo_')) {
      fs.unlinkSync(path.join(dir, f));
      n++;
    }
  }
  return n;
}

// ============================================================
//  演示账号
//
//  ★ 人设要有差异 ★
//    如果四个人都是"积极向上阳光开朗"，演示评论和群聊时
//    看不出这个产品到底在解决什么问题。
//    所以故意让其中一个刚经历低谷（但不至于危机信号），
//    这样"善意提示"和"共情"才有东西可演。
// ============================================================
const DEMO_USERS = [
  {
    phone: '19900000001', nick: '阿棠', signature: '慢一点也没关系',
    addr: '浙江杭州', birthYear: 1997, birthMonth: 3, birthDay: 12,
    gender: 'female', avatarIdx: 1,
  },
  {
    phone: '19900000002', nick: '老周', signature: '养了只猫，叫它团子',
    addr: '江苏南京', birthYear: 1990, birthMonth: 11, birthDay: 5,
    gender: 'male', avatarIdx: 2,
  },
  {
    phone: '19900000003', nick: '小满的室友', signature: '今天也在努力睡觉',
    addr: '广东深圳', birthYear: 1999, birthMonth: 7, birthDay: 22,
    gender: 'female', avatarIdx: 3,
  },
  {
    phone: '19900000004', nick: '河边的树', signature: '',
    addr: '四川成都', birthYear: 1995, birthMonth: 1, birthDay: 30,
    gender: 'unknown', avatarIdx: 4,
  },
  // ★ 小海 / 小光：前端验收清单里的 A / B 账号 ★
  //   清单里写的手机号就是这两个，密码（万能验证码）123456。
  //   单独加它们是为了让前端同学拿到包之后，能直接照清单验收。
  {
    phone: '13900000001', nick: '小海', signature: '今天也要好好吃饭',
    addr: '浙江杭州', birthYear: 1998, birthMonth: 5, birthDay: 9,
    gender: 'male', avatarIdx: 5,
  },
  {
    phone: '13900000002', nick: '小光', signature: '',
    addr: '浙江杭州', birthYear: 1999, birthMonth: 9, birthDay: 18,
    gender: 'female', avatarIdx: 6,
  },
];

// ============================================================
//  日记内容
//
//  ★ 写这些内容时的两个原则 ★
//    1. 不要写成"鸡汤示例文本"。真实的人不会说"今天也要元气满满"。
//       要写成那种在朋友圈里刷到会停下来看两句的话。
//    2. 长度有长有短。如果每条都一样长，看起来就像占位数据。
// ============================================================
// 日记配图：前端 assets/diary-month 里的 12 张节气实拍图
//   （和"写日记"页可选的封面是同一套，风格统一，也不会像加载失败）
const MONTH_IMGS = Array.from({ length: 12 }, (_, i) =>
  'assets/diary-month/' + String(i + 1).padStart(2, '0') + '.jpg'
);

const DIARIES = [
  // 小海 / 小光 的日记（对应验收清单里的 A / B）
  {
    who: 5, daysAgo: 0, imgIdx: 8, isPublic: 1,
    text: '今天把拖了很久的那件事做完了。\n没有想象中那么难，难的是开始之前那几天。',
  },
  {
    who: 6, daysAgo: 1, imgIdx: 2, isPublic: 1,
    text: '楼下那家面馆关门了。\n老板总记得我不要葱，加个蛋。\n今天站在卷帘门前站了一会儿。',
  },
  {
    who: 5, daysAgo: 2, imgIdx: 5, isPublic: 1,
    text: '我妈打电话来，问我最近怎么样。\n我说挺好的。\n她说你别骗我。',
  },
  {
    who: 6, daysAgo: 3, imgIdx: 7, isPublic: 1,
    text: '养的多肉被晒蔫了一片。\n原来不是所有东西都能扛住阳光。',
  },
  {
    who: 5, daysAgo: 4, imgIdx: 3, isPublic: 1,
    text: '凌晨三点醒了，怎么也睡不着。\n干脆起来煮了碗面。\n吃完居然有点困了。',
  },
  {
    who: 0, daysAgo: 0, imgIdx: 1, isPublic: 1,
    text: '今天下班的路上突然很想吃小时候那种五毛钱一包的辣条，\n走了三家便利店都没找到。\n最后买了一包最贵的，站在小区门口吃完才上楼。\n好像也没那么好吃，但心里挺满足的。',
  },
  {
    who: 1, daysAgo: 1, imgIdx: 2, isPublic: 1,
    text: '团子今天把我的耳机线咬断了。\n我本来想凶它，结果它抬头看我一眼，我就什么也说不出来了。\n然后它趴在我腿上睡了两个小时，我腿都麻了也没敢动。',
  },
  {
    who: 2, daysAgo: 1, imgIdx: 3, isPublic: 1,
    text: '这周第四次失眠。\n躺着数羊数到三百多，越数越清醒。\n起来喝了杯热水，站在窗边看了会儿对面楼里还没关的灯，\n突然觉得没那么孤单了——原来这个点还有人也醒着。',
  },
  {
    who: 0, daysAgo: 2, imgIdx: 4, isPublic: 1,
    text: '妈妈打电话来问我最近吃得好不好。\n我说挺好的。\n她说那就好，然后又沉默了十几秒，说"要是累了就回家待几天"。\n我说好。\n挂了电话之后我在阳台上站了很久。',
  },
  {
    who: 3, daysAgo: 3, imgIdx: 5, isPublic: 1,
    text: '今天做了件很小的事：把阳台那盆快死的绿萝换了土。\n它叶子黄了一半，我也不确定还能不能活。\n但还是想试试。',
  },
  {
    who: 1, daysAgo: 4, imgIdx: 6, isPublic: 1,
    text: '同事说我最近话变少了。\n其实不是不高兴，就是不知道为什么不太想说。\n也可能是因为说出去的话都要解释一遍，太累了。',
  },
  {
    who: 0, daysAgo: 5, imgIdx: 7, isPublic: 1,
    text: '给自己煮了碗面，加了两个蛋。\n以前觉得一个人吃饭很随便，现在觉得能好好吃一顿就已经不错了。',
  },
  // 私密日记：演示"别人看不到"
  {
    who: 0, daysAgo: 1, imgIdx: 8, isPublic: 0,
    text: '（这条是私密的）\n其实这周被领导当众说了几句，回家之后哭了一场。\n不想让任何人知道。写在这里就够了。',
  },
];

// ============================================================
async function cleanDemo() {
  head('清理演示数据');

  // ★ 为什么先单独删群消息，而不是靠删用户级联 ★
  //   实测发现：chat_messages.user_id 上【没有外键约束】
  //   （只有 room_id → chat_rooms 有）。
  //   所以删掉用户之后，他发过的群消息会留下来变成孤儿——
  //   user_id 指向一个不存在的用户，昵称是 NULL，
  //   群里就会出现"没有作者名的消息"。演示时这是明显缺陷。
  //
  //   这是表结构上的疏漏（不是脚本的问题），
  //   所以脚本这里显式清理。
  // ★ 按"名单"删，而不是按手机号前缀 ★
  //   原来只认 199 开头的，小海/小光（139 开头）不会被清掉，
  //   重跑 --clean 就会留下两个孤零零的账号。
  const demoPhones = DEMO_USERS.map(u => u.phone);
  const demoRows = await query(
    'SELECT id FROM users WHERE phone IN (' + demoPhones.map(() => '?').join(',') + ')',
    demoPhones
  );
  const mainRow = await queryOne('SELECT id FROM users WHERE phone = ?', ['13800138000']);

  const delIds = demoRows.map(d => d.id);
  if (mainRow) delIds.push(mainRow.id);

  if (delIds.length > 0) {
    const ph = delIds.map(() => '?').join(',');
    const cm = await execute(`DELETE FROM chat_messages WHERE user_id IN (${ph})`, delIds);
    if (Number(cm) > 0) {
      log(`先删了 ${cm} 条演示群消息（这张表没外键级联，必须显式删）`);
    }
  }

  // 主账号那几篇演示日记也要删 —— 它们属于 13800138000，
  // 删用户删不掉，只能按内容认出来
  let diaryDeleted = 0;
  for (const d of DIARIES) {
    const r = await execute('DELETE FROM diaries WHERE text LIKE ?', [d.text.slice(0, 20) + '%']);
    diaryDeleted += Number(r) || 0;
  }
  if (diaryDeleted > 0) log(`删了 ${diaryDeleted} 篇演示日记（含主账号那几篇）`);

  // 主账号的演示 AI 对话和记忆也要清（否则演示完 AI 聊天页里
  // 还留着"我今天加班到很晚"这些假话）
  if (mainRow) {
    const aiMsgs = await execute('DELETE FROM ai_messages WHERE user_id = ?', [mainRow.id]);
    await execute(
      `UPDATE ai_profiles SET summary = '', msg_count = 0, summary_until_id = 0, last_chat = NULL
        WHERE user_id = ?`,
      [mainRow.id]
    );
    if (Number(aiMsgs) > 0) log(`删了 ${aiMsgs} 条演示 AI 对话，并清空了长期记忆`);
  }

  const users = await query(
    'SELECT id, nickname FROM users WHERE phone LIKE ?',
    [DEMO_PHONE_PREFIX + '%']
  );

  if (users.length > 0) {
    const ids = users.map(u => u.id);
    const ph = ids.map(() => '?').join(',');

    // 外键是 CASCADE 的会跟着删，但多方向的（blessings/messages/conversations）
    // 显式删更保险
    await execute(`DELETE FROM blessings WHERE from_user IN (${ph}) OR to_user IN (${ph})`, [...ids, ...ids]);
    await execute(`DELETE FROM messages WHERE from_user IN (${ph}) OR to_user IN (${ph})`, [...ids, ...ids]);
    await execute(`DELETE FROM conversations WHERE user_a IN (${ph}) OR user_b IN (${ph})`, [...ids, ...ids]);
    await execute(`DELETE FROM users WHERE id IN (${ph})`, ids);
    log(`删掉了 ${users.length} 个演示账号（${users.map(u => u.nickname).join('、')}）`);
  } else {
    log('演示账号已经清干净了');
  }

  const n = removeDemoImages();
  if (n > 0) log(`清了 ${n} 张演示图片`);
}

// ============================================================
async function checkState() {
  head('当前库里的内容');
  const rows = await query(`
    SELECT '用户' t, COUNT(*) n FROM users
    UNION ALL SELECT '日记', COUNT(*) FROM diaries
    UNION ALL SELECT '评论', COUNT(*) FROM comments
    UNION ALL SELECT '祝福', COUNT(*) FROM blessings
    UNION ALL SELECT '漂流瓶', COUNT(*) FROM bottles
    UNION ALL SELECT '私信会话', COUNT(*) FROM conversations
    UNION ALL SELECT '群消息', COUNT(*) FROM chat_messages
    UNION ALL SELECT 'AI 消息', COUNT(*) FROM ai_messages
  `);
  for (const r of rows) log(`${r.t}: ${r.n}`);

  const demo = await queryOne('SELECT COUNT(*) AS n FROM users WHERE phone LIKE ?', [DEMO_PHONE_PREFIX + '%']);
  log('');
  log(`演示账号: ${demo.n} 个${Number(demo.n) > 0 ? '（已经有演示数据了）' : '（还没有，跑一次不带参数的 seed-demo.js）'}`);
}

// ============================================================
async function seedDemo() {
  // ---------- 主账号（要先查，因为下面的清理要用到它的 id）----------
  // ★ 首次安装时主账号还不存在（安装流程里没人登录过）★
  //   以前这里直接返回，结果一键安装装完只有空库，演示数据一条都没有。
  //   这里改成：没有就先把账号建出来（和真实注册一致：手机号 + uid + 资料）。
  let main = await queryOne('SELECT id, nickname FROM users WHERE phone = ?', ['13800138000']);
  if (!main) {
    const uid = String(40000000000 + Math.floor(Math.random() * 9999999));
    const id = await insert(
      'INSERT INTO users (phone, uid, nickname) VALUES (?, ?, ?)',
      ['13800138000', uid, '林小满']
    );
    await insert(
      'INSERT INTO user_profiles (user_id, avatar, signature) VALUES (?, ?, ?)',
      [id, '', '今天也要好好的']
    );
    main = await queryOne('SELECT id, nickname FROM users WHERE phone = ?', ['13800138000']);
    log('主账号 13800138000 不存在，已自动创建（昵称 林小满）');
  }

  head('1. 造演示图片');
  // 渐变图不再生成：前端已经不用它们了（看着像"图片没加载出来"）
  // 老库里残留的 demo_*.svg 由清理步骤一并删掉

  // ---------- 清理上一轮 ----------
  //
  //  ★ 这里踩过两个坑，第二个更隐蔽 ★
  //
  //  【坑一：清得不够】
  //    我第一版只在插日记前做了去重，忘了祝福/漂流瓶/群消息。
  //    结果同一个脚本跑两次：祝福 4→8、漂流瓶 5→10、群消息 16→26，全都翻倍。
  //
  //  【坑二：清得太狠 —— 会导致"红点反复出现"】
  //    修完坑一之后，我的做法是"删掉旧的再重新插入"。
  //    数据条数是对了，但**每条消息/祝福的 id 都变了**
  //    （实测：同龄群的演示消息 id 从 353,354,355 变成 363,364,365）。
  //
  //    而"未读"是靠 `last_read_id`（我读到哪一条）算的。
  //    已读位置记的是旧 id，新 id 更大 → 对所有人来说都变成了"新消息"
  //    → 每次重跑脚本，所有人的红点都回来了。
  //    演示时看到"怎么又冒出红点"，就是这个原因。
  //
  //  【现在的做法：已经存在就不重复插，保持 id 稳定】
  //    祝福/漂流瓶/群消息都按"内容"判断是否已存在，存在就跳过。
  //    id 不变 → 已读位置继续有效 → 不会有无中生有的红点。
  //
  //  ⚠️ 如果你改了上面 DEMO_* 里的文案，想让旧内容消失，
  //     先跑 `node scripts/seed-demo.js --clean` 再跑一次。
  head('2. 清理上一轮的残留（只清必须重建的）');
  {
    const demoIds = await query(
      'SELECT id FROM users WHERE phone LIKE ?', [DEMO_PHONE_PREFIX + '%']
    );
    const ids = [main.id, ...demoIds.map(d => d.id)];
    const ph = ids.map(() => '?').join(',');

    // ★ 机器人消息要清 ★
    //   verify-all.js 或测试跑过之后会留下机器人说的话
    //   （比如"有人说了一句心里话…"的关怀消息）。
    //   如果那条的用户消息已经被删了，群里就只剩一句莫名其妙的关怀。
    //   种子欢迎语都以"这里是"开头，所以按这个特征保留它们。
    //   （这类消息本来就该是临时的，删掉不会造成红点问题。）
    const botLeft = await execute(
      `DELETE FROM chat_messages WHERE type = 'sys' AND content NOT LIKE '这里是%'`
    );
    if (Number(botLeft) > 0) log(`清了 ${botLeft} 条遗留的机器人消息`);

    // ★ 会话要重建 ★
    //   会话是"一对人一行"，里面的消息是新建的；
    //   重建会话不会影响群聊红点，只影响私信未读（演示需要重新出红点）。
    const cv = await execute(
      `DELETE FROM conversations WHERE user_a IN (${ph}) OR user_b IN (${ph})`,
      [...ids, ...ids]
    );
    if (Number(cv) > 0) log(`重建了 ${cv} 个私信会话`);

    log('祝福 / 漂流瓶 / 群消息 保留原来的 id（避免产生假红点）');
  }

  log(`主账号: ${main.nickname}（id=${main.id}，手机 13800138000）`);

  // ★ 主账号也要有标签 ★
  //   同龄群 / 同省群 / 星迹 是按标签匹配的，主账号没有省份/年龄/星座
  //   就会走"不过滤"的兜底，演示时看不到匹配效果。
  //   只在字段为空时填，不覆盖用户自己改过的资料。
  await execute(
    "UPDATE user_profiles SET province = \'浙江\' WHERE user_id = ? AND (province IS NULL OR province = \'\')",
    [main.id]
  );
  await execute(
    "UPDATE user_profiles SET birth_year = 1998 WHERE user_id = ? AND birth_year IS NULL",
    [main.id]
  );
  await execute(
    "UPDATE user_profiles SET zodiac = \'双鱼\' WHERE user_id = ? AND (zodiac IS NULL OR zodiac = \'\')",
    [main.id]
  );

  head('3. 造演示账号');
  const userIds = [main.id];   // 第 0 位是主账号
  for (let i = 0; i < DEMO_USERS.length; i++) {
    const d = DEMO_USERS[i];
    // ★ 先把"占着这个昵称的其它账号"改名 ★
    //   必须在"判断演示账号是否存在"之前做：
    //   演示账号已经有了（走复用分支）时，也要把别人占着的同名清掉。
    const clash = await query(
      'SELECT id, phone FROM users WHERE TRIM(nickname) = ? AND phone <> ?',
      [d.nick, d.phone]
    );
    for (const c of clash) {
      const renamed = d.nick + '·' + String(c.phone).slice(-4);
      await execute('UPDATE users SET nickname = ? WHERE id = ?', [renamed, c.id]);
      log(`  ⚠️ 昵称「${d.nick}」被 ${c.phone} 占着，已把那账号改名为「${renamed}」`);
    }

    const exist = await queryOne('SELECT id FROM users WHERE phone = ?', [d.phone]);
    if (exist) {
      // 已存在就复用（可重复运行）
      await execute(
        `UPDATE users SET nickname = ? WHERE id = ?`, [d.nick, exist.id]
      );
      await execute(
        `UPDATE user_profiles SET signature = ?, addr = ?, gender = ?,
            birth_year = ?, avatar = ?
          WHERE user_id = ?`,
        [d.signature, d.addr, d.gender, d.birthYear, '', exist.id]
      );
      userIds.push(exist.id);
      log(`  ${d.nick} 已存在，复用（id=${exist.id}）`);
    } else {
      // 直接写库（不走注册接口，省掉验证码流程）
      const uid = String(30000000000 + Math.floor(Math.random() * 9999999));
      const id = await insert(
        'INSERT INTO users (phone, uid, nickname) VALUES (?, ?, ?)',
        [d.phone, uid, d.nick]
      );
      await insert(
        `INSERT INTO user_profiles (user_id, avatar, signature, addr, gender, birth_year)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, '', d.signature, d.addr,
          d.gender, d.birthYear]
      );
      // 星座和省份要按资料推导（和真实注册路径保持一致）
      const { zodiacOf, provinceOf } = await import('../src/utils/zodiac.js');
      const zodiac = zodiacOf(d.birthMonth, d.birthDay) || '';
      const province = provinceOf(d.addr) || '';
      await execute(
        'UPDATE user_profiles SET zodiac = ?, province = ? WHERE user_id = ?',
        [zodiac, province, id]
      );
      userIds.push(id);
      log(`  ${d.nick}（id=${id}，uid=${uid}）`);
    }
  }

  // ★ 演示账号不再"借用"渐变图当头像 ★
  //   以前这里把日记封面的 demo_N.svg 写进 avatar，
  //   结果群里每个人的头像是块模糊色块，把昵称首字盖住了 ——
  //   跟"没设头像就用首字"的规则冲突，也很难看。
  //   现在留空，统一走首字兜底；想让某个人有头像，去设置页上传。

  // ---------- 日记 ----------
  head('4. 造日记');
  const dayKey = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    // 用本地日期拼 YYYY-MM-DD
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const diaryIds = [];
  for (const d of DIARIES) {
    const uid = userIds[d.who];
    const dateKey = dayKey(d.daysAgo);

    // (user_id, date_key) 是唯一键：同一个人同一天只能有一篇，
    // 所以先删掉旧的再插（可重复运行）
    await execute('DELETE FROM diaries WHERE user_id = ? AND date_key = ?', [uid, dateKey]);

    const id = await insert(
      `INSERT INTO diaries (user_id, text, img, is_public, date_key)
       VALUES (?, ?, ?, ?, ?)`,
      // 配图用「二十四节气」那套真实照片（前端 assets/diary-month/01~12.jpg），
      // 不再用 demo_*.svg 的渐变块 —— 那种色块会被当成"图片没加载出来"。
      [uid, d.text, MONTH_IMGS[(d.imgIdx - 1) % MONTH_IMGS.length], d.isPublic, dateKey]
    );
    diaryIds.push({ id, uid, isPublic: d.isPublic });
    log(`  ${dayKey(d.daysAgo)} ${d.isPublic ? '公开' : '私密'}  id=${id}`);
  }

  // ---------- 点赞 / 收藏 ----------
  head('5. 造点赞和收藏');
  let likeCount = 0;
  const publicDiaries = diaryIds.filter(d => d.isPublic);
  for (const d of publicDiaries) {
    // 除作者外的人随机点赞（用固定规则，保证可重复）
    for (const uid of userIds) {
      if (uid === d.uid) continue;
      if ((d.id + uid) % 3 !== 0) continue;   // 不是每个人都点
      await execute(
        'INSERT IGNORE INTO likes (user_id, diary_id) VALUES (?, ?)',
        [uid, d.id]
      );
      likeCount++;
    }
    // 同步 like_count（真实接口会维护这个冗余计数）
    const cnt = await queryOne('SELECT COUNT(*) AS n FROM likes WHERE diary_id = ?', [d.id]);
    await execute('UPDATE diaries SET like_count = ? WHERE id = ?', [Number(cnt.n) || 0, d.id]);
  }
  log(`造了 ${likeCount} 条点赞`);

  // 收藏几条
  let favCount = 0;
  for (const d of publicDiaries.slice(0, 3)) {
    for (const uid of userIds) {
      if (uid === d.uid) continue;
      if ((d.id + uid) % 4 !== 0) continue;
      await execute('INSERT IGNORE INTO favorites (user_id, diary_id) VALUES (?, ?)', [uid, d.id]);
      favCount++;
    }
  }
  log(`造了 ${favCount} 条收藏`);

  // ---------- 评论（含两级回复）----------
  head('6. 造评论（含两级结构）');
  const target = publicDiaries[2];   // 拿"失眠"那条当评论多的那条
  const c1 = await insert(
    'INSERT INTO comments (diary_id, user_id, content) VALUES (?, ?, ?)',
    [target.id, userIds[1], '这个点还醒着的人真的不少。我上周也是这样。']
  );
  const c2 = await insert(
    'INSERT INTO comments (diary_id, user_id, content) VALUES (?, ?, ?)',
    [target.id, userIds[3], '试试把手机放远一点？我之前这样有用。']
  );
  // 回复（parent_id 指向一级评论）
  await insert(
    'INSERT INTO comments (diary_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
    [target.id, target.uid, c1, '谢谢你，看到这句心里暖了一下。']
  );
  await insert(
    'INSERT INTO comments (diary_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)',
    [target.id, target.uid, c2, '我今天试试。']
  );
  // 同步 comment_count
  const cc = await queryOne('SELECT COUNT(*) AS n FROM comments WHERE diary_id = ?', [target.id]);
  await execute('UPDATE diaries SET comment_count = ? WHERE id = ?', [Number(cc.n) || 0, target.id]);
  log(`给日记 id=${target.id} 造了 ${cc.n} 条评论（2 条一级 + 2 条回复）`);

  // ---------- 祝福 ----------
  head('7. 造祝福（主页留言鼓励）');
  const blessings = [
    [userIds[1], main.id, '看到你写的这些，想说你已经很努力了。'],
    [userIds[3], main.id, '今天也要好好吃饭呀。'],
    [userIds[2], main.id, '路过留个脚印，祝你今晚睡个好觉。'],
    [main.id, userIds[2], '谢谢你上次的那句话，我记到现在。'],
  ];
  let blessSkipped = 0;
  for (const [from, to, content] of blessings) {
    // ★ 已存在就跳过，不要删了重建 ★
    //   删了重建会换新 id，而"未读"是按 id 算的 → 会凭空冒出红点。
    const exists = await queryOne(
      'SELECT id FROM blessings WHERE from_user = ? AND to_user = ? AND content = ?',
      [from, to, content]
    );
    if (exists) { blessSkipped++; continue; }
    await insert(
      'INSERT INTO blessings (from_user, to_user, content) VALUES (?, ?, ?)',
      [from, to, content]
    );
  }
  log(`祝福：新建 ${blessings.length - blessSkipped} 条，已存在跳过 ${blessSkipped} 条`);

  // ---------- 漂流瓶 ----------
  head('8. 造漂流瓶');
  const bottles = [
    [userIds[1], '希望明天早上不要那么难起床。', 1],
    [userIds[2], '今天在电梯里对陌生人笑了一下，他也笑了。', 0],
    [userIds[3], '想养一只狗，但是怕照顾不好它。', 1],
    [userIds[1], '有人在吗。就是随便说一句。', 1],
    [userIds[2], '愿看到这句话的人，今天能遇到一件小好事。', 1],
  ];
  let bottleSkipped = 0;
  for (const [uid, content, anon] of bottles) {
    // 同上：存在就跳过，保持 id 稳定
    const exists = await queryOne(
      'SELECT id FROM bottles WHERE user_id = ? AND content = ?',
      [uid, content]
    );
    if (exists) { bottleSkipped++; continue; }
    await insert(
      'INSERT INTO bottles (user_id, content, is_anon) VALUES (?, ?, ?)',
      [uid, content, anon]
    );
  }
  // 重算一次 pick_count，保证"计数 = 实际捞取记录数"
  // （pick_count 是冗余字段，历史上可能被测试改乱过）
  await execute(
    `UPDATE bottles b
        SET pick_count = (SELECT COUNT(*) FROM bottle_picks bp WHERE bp.bottle_id = b.id)`
  );
  log(`造了 ${bottles.length} 个漂流瓶（4 个匿名、1 个署名）`);

  // ---------- 群聊 ----------
  head('9. 造群聊消息');
  // ★ 四个固定的群要自己建 ★
  //   schema.sql 只建了 chat_rooms 表，没插数据；
  //   以前种子脚本只"读"房间，空库上就一条都没有 ——
  //   全新安装后点群聊会提示"这个群不存在"。
  const ROOMS_SPEC = [
    ['age', '同龄群', 'age', '差不多年纪的人', 10],
    ['interest', '拾趣', 'interest', '喜欢同个东西的人', 20],
    ['province', '同省群', 'province', '离得近的人', 30],
    ['zodiac', '星迹', 'zodiac', '同一个星座的人', 40],
  ];
  for (const [code, name, kind, desc, sort] of ROOMS_SPEC) {
    const has = await queryOne('SELECT id FROM chat_rooms WHERE code = ?', [code]);
    if (has) continue;
    await insert(
      'INSERT INTO chat_rooms (code, name, kind, `desc`, sort) VALUES (?, ?, ?, ?, ?)',
      [code, name, kind, desc, sort]
    );
    log('  补建群聊房间：' + name);
  }

  const rooms = await query('SELECT id, code, name FROM chat_rooms ORDER BY sort');
  const roomByCode = {};
  rooms.forEach(r => { roomByCode[r.code] = r; });

  const groupMsgs = [
    ['age', userIds[2], '有没有人和我一样，到了这个年纪反而不知道怎么交朋友了'],
    ['age', userIds[1], '我也是。以前觉得是没时间，后来发现是不知道说什么。'],
    ['age', userIds[2], '对，就是这种感觉。'],
    ['interest', userIds[1], '团子今天又把我的耳机咬了，这是第三副了'],
    ['interest', userIds[3], '哈哈哈哈猫都这样，我家的咬充电线'],
    ['interest', userIds[1], '那我平衡一点了'],
    ['province', userIds[3], '深圳今天下雨了，出门忘带伞'],
    ['province', userIds[2], '南京也是，这雨下得毫无预兆'],
    ['province', userIds[5], '杭州今天风好大，骑车差点骑不动'],
    ['province', userIds[6], '宁波也是，伞都撑不住'],
    ['zodiac', userIds[3], '有人也是那种，嘴上说不在意，其实特别在意的人吗'],
    ['zodiac', userIds[1], '我。而且事后会反复想。'],
  ];

  let msgSkipped = 0;
  for (const [code, uid, content] of groupMsgs) {
    const room = roomByCode[code];
    if (!room) continue;
    // 先确保这个人在群里
    await execute(
      'INSERT IGNORE INTO chat_members (room_id, user_id) VALUES (?, ?)',
      [room.id, uid]
    );
    // ★ 已存在就跳过 ★
    //   这一条最关键：如果删了重建，消息 id 会变，
    //   而每个成员的 last_read_id 记的是旧 id → 所有人都会出现"新消息"红点。
    //   （实测重跑一次 id 就从 353 变成 363，用户以为是"消息被重新发送了"。）
    //   按"房间 + 作者 + 内容"判断是否已经发过。
    const exists = await queryOne(
      'SELECT id FROM chat_messages WHERE room_id = ? AND user_id = ? AND content = ?',
      [room.id, uid, content]
    );
    if (exists) { msgSkipped++; continue; }
    await insert(
      'INSERT INTO chat_messages (room_id, user_id, type, content) VALUES (?, ?, "text", ?)',
      [room.id, uid, content]
    );
  }
  log(`在 4 个房间：新建 ${groupMsgs.length - msgSkipped} 条，已存在跳过 ${msgSkipped} 条`);

  // ---------- 私信（带未读）----------
  head('10. 造私信（带未读红点）');
  const [a, b] = main.id < userIds[1] ? [main.id, userIds[1]] : [userIds[1], main.id];
  await execute('DELETE FROM conversations WHERE user_a = ? AND user_b = ?', [a, b]);
  const convId = await insert(
    'INSERT INTO conversations (user_a, user_b) VALUES (?, ?)', [a, b]
  );
  const thread = [
    [userIds[1], '你好呀，看到你写的那篇了，写得很好。'],
    [main.id, '谢谢，其实那天有点难过，写着写着就好点了。'],
    [userIds[1], '能写出来就挺不容易的。'],
    [userIds[1], '有件事想问你，但又怕打扰你。'],
  ];
  let lastId = null;
  for (const [from, content] of thread) {
    const to = from === main.id ? userIds[1] : main.id;
    lastId = await insert(
      `INSERT INTO messages (conv_id, from_user, to_user, content, is_read)
       VALUES (?, ?, ?, ?, 0)`,
      [convId, from, to, content]
    );
    await execute('UPDATE conversations SET last_msg = ?, last_from = ?, last_time = NOW(3) WHERE id = ?',
      [content.slice(0, 100), from, convId]);
  }
  // 主账号这边有未读（最后两条是对方发的）
  const mainIsA = a === main.id;
  await execute(
    `UPDATE conversations SET unread_${mainIsA ? 'a' : 'b'} = 2 WHERE id = ?`,
    [convId]
  );
  log(`造了一个私信会话（conv id=${convId}，主账号有 2 条未读）`);

  // ---------- AI 聊天 + 记忆 ----------
  head('11. 造 AI 聊天记录和长期记忆');
  await execute('DELETE FROM ai_messages WHERE user_id = ?', [main.id]);
  const aiThread = [
    ['user', '今天加班到很晚，好累'],
    ['assistant', '听起来是真的很累了。累的时候不用勉强自己撑着。'],
    ['user', '最近总觉得自己在原地踏步'],
    ['assistant', '在原地待着的时候，人是会着急的。但也不是所有时候都得往前走。'],
  ];
  for (const [role, content] of aiThread) {
    await insert(
      'INSERT INTO ai_messages (user_id, role, content) VALUES (?, ?, ?)',
      [main.id, role, content]
    );
  }
  await execute(
    `INSERT INTO ai_profiles (user_id, summary, msg_count, summary_until_id, last_chat)
     VALUES (?, ?, ?, 0, NOW(3))
     ON DUPLICATE KEY UPDATE summary = VALUES(summary), msg_count = VALUES(msg_count), last_chat = VALUES(last_chat)`,
    [main.id,
      '最近长期加班，觉得累；感觉自己原地踏步，有点着急。',
      aiThread.length]
  );
  log(`造了 ${aiThread.length} 条 AI 对话 + 一段长期记忆`);

  // ---------- 可选：把未读重置回去（--reset-unread）----------
  if (RESET_UNREAD) {
    head('12. 重置未读（让演示时有红点）');

    // 祝福：给主账号的都标成未读
    const b = await execute(
      'UPDATE blessings SET is_read = 0 WHERE to_user = ?', [main.id]
    );
    log(`祝福：${b} 条标成未读`);

    // 私信：会话是每次重建的，未读本来就有 2 条，这里再确认一下
    const conv = await queryOne(
      'SELECT id, user_a, user_b FROM conversations WHERE user_a = ? OR user_b = ?',
      [main.id, main.id]
    );
    if (conv) {
      const mainIsA = Number(conv.user_a) === Number(main.id);
      await execute(
        `UPDATE conversations SET unread_${mainIsA ? 'a' : 'b'} = 2 WHERE id = ?`,
        [conv.id]
      );
      log('私信：主账号的未读设为 2 条');
    }

    // 群聊：
    //   主账号 → 已读到最新（演示时首页群聊没有红点，符合演示文档）
    //   演示账号 → 全部标成未读（这样"换个账号登录"能看到大量未读）
    await execute(
      `UPDATE chat_members cm
          SET cm.last_read_id = COALESCE(
                (SELECT MAX(m.id) FROM chat_messages m WHERE m.room_id = cm.room_id), 0)
        WHERE cm.user_id = ?`,
      [main.id]
    );
    await execute(
      `UPDATE chat_members cm
          SET cm.last_read_id = 0
        WHERE cm.user_id IN (SELECT id FROM users WHERE phone LIKE ?)`,
      [DEMO_PHONE_PREFIX + '%']
    );
    log('群聊：主账号标为已读，演示账号标为全部未读');
  }

  // ---------- 收尾 ----------
  head('演示数据准备完成');
  const summary = await query(`
    SELECT '用户' t, COUNT(*) n FROM users
    UNION ALL SELECT '日记', COUNT(*) FROM diaries
    UNION ALL SELECT '评论', COUNT(*) FROM comments
    UNION ALL SELECT '祝福', COUNT(*) FROM blessings
    UNION ALL SELECT '漂流瓶', COUNT(*) FROM bottles
    UNION ALL SELECT '私信会话', COUNT(*) FROM conversations
    UNION ALL SELECT '群消息', COUNT(*) FROM chat_messages
    UNION ALL SELECT 'AI 消息', COUNT(*) FROM ai_messages
  `);
  for (const r of summary) log(`${r.t}: ${r.n}`);

  console.log('');
  log('\x1b[32m现在打开前端就能看到一个"已经用了一阵子"的产品了\x1b[0m');
  log('登录用：13800138000 / 万能码 123456');
}

// ============================================================
(async () => {
  console.log('==============================================');
  console.log('  「陪着」演示数据');
  console.log('==============================================');

  try {
    await query('SELECT 1');
  } catch (e) {
    console.error('\n❌ 连不上数据库：' + e.message);
    process.exitCode = 1;
    await pool.end();
    return;
  }

  if (CHECK) {
    await checkState();
  } else if (CLEAN) {
    await cleanDemo();
    console.log('');
    await checkState();
  } else {
    await seedDemo();
  }

  await pool.end();
})().catch(async (e) => {
  console.error('\n脚本出错：', e);
  try { await pool.end(); } catch { /* 忽略 */ }
  process.exitCode = 1;
});
