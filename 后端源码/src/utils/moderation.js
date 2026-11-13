// ============================================================
//  内容安全检测（"机器人判断语言是否违规"）
//
//  对应需求：
//    第 1 条：群聊要有机器人管理（判断是否语言违规）
//    第 7 条：评论区的"善语结善缘，恶语伤人心"提示
//
//  ★ 三层设计 ★
//    1. 本地词库（这里的实现）—— 零成本、零延迟、可离线
//    2. 长度/重复刷屏检测       —— 这个用规则比用 AI 更准
//    3. 以后可以接 AI 复核      —— 本地先过一遍，可疑的再送 AI
//
//  为什么不直接全交给 AI：
//    每条评论都调一次大模型，成本和延迟都受不了，而且对"刷屏"
//    "广告链接"这类问题，规则比 AI 判断得更准也更稳定。
//    正确做法是规则先过滤，AI 只处理真正需要理解的边界情况。
// ============================================================

/**
 * 违规词库
 *
 * ★ 重要说明 ★
 *  这里放的都是"明显有害"的词类，不是普通脏话。
 *  一个陪伴类产品的底线是：
 *    - 不能有人在上面骗钱（诈骗/刷单/加微信）
 *    - 不能有人在上面卖东西（广告/代购/微商）
 *    - 不能有人诱导自伤（这是最需要拦的）
 *    - 不能有人对别人施暴（人身攻击）
 *
 *  每个词配一个类别，方便前端显示不同的提示语。
 */
export const BANNED_PATTERNS = [
  // ---- 诈骗 / 导流（最常见的）----
  { re: /加\s*(?:(?:我|我的)\s*)?(微信|威信|薇信|weixin|wx|v|QQ)/i, cat: '广告导流', msg: '这里不能留联系方式哦' },
  { re: /(微信|QQ|企鹅|V信|威信)\s*[:：]?\s*[a-zA-Z0-9_-]{5,}/, cat: '广告导流', msg: '这里不能留联系方式哦' },
  { re: /(刷单|刷好评|兼职日结|日入过百|躺赚|无门槛兼职|代打字)/, cat: '诈骗', msg: '这类信息可能是骗局，已经拦下了' },
  { re: /(包过|套现|信用卡代还)|(?:网贷|贷款|办卡).{0,12}(?:私信我|私聊我|联系我|找我)|(?:提供|办理|代办).{0,8}(?:网贷|贷款|办卡)/, cat: '诈骗', msg: '这类信息可能是骗局，已经拦下了' },
  { re: /(加群|进群|私聊我发|点我头像|主页有)/, cat: '广告导流', msg: '这里不能打广告哦' },
  { re: /https?:\/\/|www\.\w+\.(com|cn|net)/, cat: '外链', msg: '这里不能发链接哦' },

  // ---- 自伤 / 危机信号（最需要小心处理的）----
  // 注意：这一类不是"删掉就完事"。
  // 检测到之后应该【保留内容】并给出关怀提示 + 热线，
  // 删掉反而会让人更孤立。所以单独给个类别，调用处区别对待。
  { re: /(自杀|自残|结束生命|不想活|活着没意思|想死|割腕|跳楼|烧炭|轻生|自尽|上吊|跳河|吞药|活不下去|想结束这一切)/, cat: '危机信号', msg: '我们注意到你可能不太好受' },
  { re: /(安眠药.*(吃|吞)|怎么死|死法)/, cat: '危机信号', msg: '我们注意到你可能不太好受' },

  // ---- 人身攻击 ----
  { re: /(去死|死全家|垃圾东西|废物|傻子|脑残|贱人|滚出去)/, cat: '人身攻击', msg: '善语结善缘，换种说法好吗' },
  // 补充明确辱骂；疾病名称和普通情绪表达不单独作为违规词。
  { re: /(傻逼|傻[比bB]|煞笔|沙比|装逼|有病吧|脑子进水|脑子进屎|吃屎|屎糊|一嘴屎|满嘴喷粪|喷粪|狗东西|狗屎|贱货|婊子|骚货|操你|我操|草泥马|尼玛|他妈的|你妈的|去你妈|蠢猪|猪脑子|死一户口本|全家死光|你妈死了|断子绝孙|去你大爷)/, cat: '人身攻击', msg: '善语结善缘，换种说法好吗' },
  { re: /(?<![A-Za-z])sb(?![A-Za-z])/i, cat: '人身攻击', msg: '善语结善缘，换种说法好吗' },

  // ---- 违法 ----
  // 注意：这里只列"发票"两个字，不要写成"发票代开"。
  // 我第一版写成 /发票代开/，结果 "代开增值税发票" 这种语序就漏了 ——
  // 同一个意思有好几种说法，词库要按【关键词】而不是【短语】来写。
  { re: /(毒品|冰毒|大麻|枪支|弹药|办证|假证|假发票|发票)/, cat: '违法', msg: '这类内容不能发布' },

  // ---- 色情 ----
  { re: /(约炮|一夜情|裸聊|卖淫|嫖娼|色情)/, cat: '色情', msg: '这类内容不能发布' },
  { re: /(黄片|裸照|援交|口交|制服诱惑|约啪)/, cat: '色情', msg: '这类内容不能发布' },

  // 只匹配明确招揽或索取信息，不把转账、验证码、麻醉等日常词一律拦截。
  { re: /(代购|微商|一手货源|招代理|招下家|月入过万|加好友聊)/, cat: '广告导流', msg: '这里不能发广告或留联系方式哦' },
  { re: /(?:扫码|转账|汇款).{0,8}(?:领奖|返利|稳赚|包赚)|(?:稳赚|包赚).{0,8}(?:投资|理财)|验证码.{0,6}(?:发给我|告诉我|提供给我)|(?:发给我|告诉我|提供给我).{0,6}验证码/, cat: '诈骗', msg: '这类信息可能是骗局，已经拦下了' },
  { re: /(六合彩|时时彩|百家乐|博彩套利)/, cat: '诈骗', msg: '这类信息可能是骗局，已经拦下了' },
  { re: /(代考|替考|迷药|办假证|代办证件)/, cat: '违法', msg: '这类内容不能发布' },
  { re: /(?<!\d)\d{17}[\dXx](?!\d)/, cat: '隐私', msg: '这串号码像是身份证号，别发出来哦' },
];

/** 检测用副本；保留用户原文，同时识别空格和零宽字符拆词。 */
function contentTargets(text) {
  const original = text.trim();
  const compact = original.replace(/[\s\u200b-\u200f\u2060\ufeff]+/g, '');
  return compact !== original ? [original, compact] : [original];
}

/**
 * 检测一段文本
 *
 * @param {string} text
 * @returns {{ok:boolean, cat:string, msg:string, matched:string}}
 *   ok=true 表示通过；ok=false 时 cat/msg/matched 说明原因
 */
export function checkContent(text) {
  if (typeof text !== 'string') return { ok: true, cat: '', msg: '', matched: '' };

  const s = text.trim();
  if (!s) return { ok: true, cat: '', msg: '', matched: '' };
  const targets = contentTargets(s);

  // 危机与普通违规独立：先报告其他违规，避免危机词遮住后面的攻击等规则。
  // 仍保留纯危机时的原分类返回，兼容现有调用者。
  let crisisMatch = null;
  for (const p of BANNED_PATTERNS) {
    const m = targets.map(target => target.match(p.re)).find(Boolean);
    if (m) {
      const result = {
        ok: false,
        cat: p.cat,
        msg: p.msg,
        matched: m[0],
      };
      if (p.cat === '危机信号') {
        crisisMatch ??= result;
      } else {
        return result;
      }
    }
  }

  return crisisMatch || { ok: true, cat: '', msg: '', matched: '' };
}

/**
 * 刷屏检测：重复内容
 *
 * 为什么单独做：这种内容词库拦不住，而且它是群聊里最烦人的问题。
 *  AI 也能判断，但用规则算重复率又快又准。
 *
 * ★ 设计要点（我在这段代码上栽过三次，都记在这里）★
 *
 *  错法一：只检查"整段等于前半段的两次重复"
 *          `s === s.slice(0, s.length/2).repeat(2)`
 *    问题1：长度为奇数时永远不成立
 *    问题2：和"单字重复"规则完全重叠，等于死代码
 *    问题3：`哈哈` 这种两字重复的刷屏反而漏了
 *
 *  错法二：单字重复规则没和白名单配合好
 *    "哈哈哈哈哈哈哈哈" 本来是正常笑声，却因为被"整段重复"命中而拦下
 *
 *  错法三：同一件事写了两条互相矛盾的规则
 *    单字规则已经是"超过 15 次"，却又加了条"≥8 次就算刷屏"，
 *    结果 aaaaaaaaaa（10个a）被后一条拦下，和规则1 的语义冲突。
 *
 *  正确做法（两条规则，互不重叠）：
 *    规则1 单字：非白名单字重复【超过 maxRepeat(15) 次】
 *    规则2 重复单元：同一个 2~3 字单元重复 ≥4 次，总长 ≥6，单元非无害字
 *
 *    "哈哈哈哈"           → '哈' 在白名单 → 放过
 *    "aaa电池"            → 只有 3 个 a，没到任何阈值 → 放过
 *    "aaaaaaaaaa"         → 10 个 a，没超 15 → 放过
 *    "aaaaaaaaaaaaaaaaa"  → 17 个 a，超 15 → 拦
 *    "abababab"           → 单元 'ab' 重复 4 次 → 拦
 *    "abab"               → 太短（<6）→ 放过
 *
 * @param {string} text
 * @param {object} opts { maxRepeat: 单字重复多少次算刷屏，默认 15 }
 * @returns {{ok:boolean, msg:string}}
 */
export function checkSpam(text, opts = {}) {
  const { maxRepeat = 15 } = opts;
  if (typeof text !== 'string') return { ok: true, msg: '' };

  const s = text.trim();
  if (!s) return { ok: true, msg: '' };

  // 语气词/笑声：重复它们不算刷屏，那是人在笑或者在应声
  const HARMLESS = new Set([
    '哈', '嘿', '嘻', '呵', '嗯', '啊', '哦', '呜', '诶', '呀',
    '。', '…', '!', '！', '~', '？', '?', '、',
  ]);

  // 单个字符重复（不在白名单里的）
  const counter = {};
  for (const ch of s) counter[ch] = (counter[ch] || 0) + 1;
  for (const [ch, n] of Object.entries(counter)) {
    // ★ 用 > 而不是 >=：说"最多重复15次"就该允许正好15次
    if (n > maxRepeat && !HARMLESS.has(ch)) {
      return { ok: false, msg: '同样的字太多了，说点别的吧' };
    }
  }

  // ============================================================
  //  重复内容检测
  //
  //  ★ 完整策略（一次写清，不再有两套规则打架）★
  //
  //    规则1 单字刷屏：某个【非白名单】字重复【超过 maxRepeat(15) 次】
  //                     → "aaaaaaaaaaaaaaaaa"（17个）拦
  //                     → "aaaaaaaaaa"（10个）放行
  //    规则2 重复单元：整段由同一个 2~3 字单元重复而成，且重复 ≥4 次，
  //                     且总长度 ≥6，且单元不是无害字
  //                     → "abababab"(ab×4) 拦、  "abcabcabcabc"(abc×4) 拦
  //                     → "abab"(太短) 放行、   "哈哈哈哈"(笑声) 放行
  //
  //  ★ 我在这段代码上栽了三次，都记在这里 ★
  //    第一次：注释写"单字不够次数就结束"，代码却写 continue，
  //            于是循环继续到 unit=2，把 aaaaaaaaaa 当成"aa重复5次"拦了。
  //    第二次：把两个阈值一起调高，结果 abababab（重复4次）漏了。
  //    第三次：单字规则已经有了（maxRepeat=15），我却又加了条
  //            "单字≥8次就算刷屏"，两条规则互相矛盾，
  //            aaaaaaaaaa 被后一条拦下，和规则1的语义冲突。
  //
  //  教训：同一件事只能有一条规则；阈值和语义要一次写清楚，别边试边改。
  // ============================================================
  const MIN_REPEAT_MULTI = 4;
  const MIN_LEN = 6;
  const MAX_UNIT = 3;   // 只检查 2~3 字的重复单元，更长的重复没有实际意义
  const chars = [...s];

  if (chars.length >= MIN_LEN) {
    // ---- 先判断是不是"整段同一个字" ----
    // ★ 这一层守卫很关键 ★
    //   整段都是同一个字时，只归规则1管（单字刷屏），不要再走规则2。
    //   否则 "aaaaaaaa"（8个a）会被规则2 当成"aa 重复4次"拦住，
    //   而规则1 的语义是"超过15次才算刷屏" —— 两条规则又打架了。
    //   一句话：纯字重复只由单字规则裁决。
    const first = chars[0];
    const allSame = chars.every(c => c === first);

    if (allSame) {
      // 已经由上面的单字规则处理过了（超过 maxRepeat 才会走到这里，
      // 但走到这里说明没超），所以直接放行
      return { ok: true, msg: '' };
    }

    // ---- 规则2：重复单元（2~3 字，且整段不是同一个字）----
    for (let unit = 2; unit <= Math.min(MAX_UNIT, Math.floor(chars.length / 2)); unit++) {
      if (chars.length % unit !== 0) continue;

      const times = chars.length / unit;
      if (times < MIN_REPEAT_MULTI) continue;

      const piece = chars.slice(0, unit).join('');

      // 整个单元都是无害字（比如 '哈哈'）→ 放行
      if ([...piece].every(c => HARMLESS.has(c))) continue;

      if (piece.repeat(times) === s) {
        return { ok: false, msg: '重复的内容发一次就好啦' };
      }
    }
  }

  return { ok: true, msg: '' };
}

/**
 * 把一段文本里的敏感部分打码（用于日志和后台展示）
 * 比如 "加我微信abc123" → "加我微**c123"
 */
export function maskSensitive(text, keep = 2) {
  if (typeof text !== 'string') return '';
  let s = text;
  for (const p of BANNED_PATTERNS) {
    const allMatches = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    s = s.replace(allMatches, (m) => {
      if (m.length <= keep * 2) return '*'.repeat(m.length);
      return m.slice(0, keep) + '*'.repeat(Math.min(m.length - keep * 2, 8)) + m.slice(-keep);
    });
  }
  return s;
}

/**
 * 综合检测（词库 + 刷屏），这是调用处最常用的入口
 *
 * @param {string} text
 * @returns {{ok:boolean, cat:string, msg:string}}
 */
export function moderate(text) {
  const spam = checkSpam(text);
  if (!spam.ok) return { ok: false, cat: '刷屏', msg: spam.msg, matched: '' };

  const c = checkContent(text);
  if (!c.ok) return c;

  return { ok: true, cat: '', msg: '', matched: '' };
}

/**
 * 危机信号专用检测
 *
 * 单独暴露一个函数，是因为处理方式完全不同：
 *   其他违规 → 拒绝发布
 *   危机信号 → 允许发布，但要附加关怀提示和求助渠道
 *
 * 删掉一个人的求救信号，是最糟糕的处理方式。
 */
export function detectCrisis(text) {
  if (typeof text !== 'string') return false;
  const targets = contentTargets(text);
  // 不依赖 checkContent 的首个分类：广告/攻击与危机可以同时成立。
  if (BANNED_PATTERNS.some(p => p.cat === '危机信号' && targets.some(target => p.re.test(target)))) return true;
  // 再宽松补几个口语化表达（上面词库里没有但很常见的）
  return targets.some(target => /(撑不下去|熬不住|没有意义了|想消失|解脱|不想醒)/.test(target));
}

/** 心理援助热线（按需补充，这些是公开信息） */
export const HELP_LINES = [
  { name: '全国24小时心理援助热线', phone: '12356' },
  { name: '北京心理危机研究与干预中心', phone: '010-82951332' },
  { name: '希望24热线', phone: '400-161-9995' },
];
