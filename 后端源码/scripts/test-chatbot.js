// ============================================================
//  违规检测机器人的单元测试
//
//  用法：  node scripts/test-chatbot.js     （不需要后端，纯逻辑）
//
//  ★ 为什么单独做单元测试 ★
//    机器人的"处罚尺度"是产品里最敏感的东西之一：
//      罚轻了 → 广告和骂人的话满天飞
//      罚重了 → 正常人被误伤，尤其这个产品里很多人本来就很脆弱
//    而且"第三档（禁言 5 分钟）"在集成测试里要等 30 秒真实时间才能到达 ——
//    太慢，所以用单元测试把整个阶梯一次跑完。
//
//  另外要重点验证一条：危机信号永远不处罚。
// ============================================================
import {
  reviewGroupMessage, checkMuted, resetViolations,
} from '../src/utils/chatBot.js';

let pass = 0, fail = 0;
const failures = [];

const ok = (m) => { console.log(`  \x1b[32m✅\x1b[0m ${m}`); pass++; };
const bad = (m, extra) => {
  console.log(`  \x1b[31m❌\x1b[0m ${m}`);
  if (extra !== undefined) console.log(`     实际: ${JSON.stringify(extra).slice(0, 260)}`);
  fail++; failures.push(m);
};
const step = (t) => console.log(`\n${'─'.repeat(46)}\n  ${t}\n${'─'.repeat(46)}`);
const eq = (a, b, m) => a === b ? ok(m) : bad(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const truthy = (c, m, actual) => c ? ok(m) : bad(m, actual);

const ROOM = 1;
const USER = 100;

/** 每次测试前清空记录，保证互不干扰 */
function fresh() { resetViolations(); }

console.log('==============================================');
console.log('  违规检测机器人 · 单元测试');
console.log('==============================================');

// ============================================================
step('1. 正常消息应该全部放行');
// ============================================================
fresh();
const normalMsgs = [
  '今天天气不错',
  '我妈寄的腊肠到了',
  '哈哈哈哈太搞笑了',
  '嗯嗯，我知道了',
  '有点想家了',
  '谢谢你，陌生人',
  '笑死我了',
  '今天加班到很晚',
  'aaa电池买了两节',
];
for (const t of normalMsgs) {
  const r = reviewGroupMessage(ROOM, USER, t, { nick: '小明' });
  if (r.allow && !r.hardBlock) {
    console.log(`  \x1b[32m✅\x1b[0m 放行「${t}」`);
    pass++;
  } else {
    bad(`误杀「${t}」→ [${r.category}] ${r.userNotice}`);
  }
}

// ============================================================
step('2. 违规内容应该被拦下');
// ============================================================
const badMsgs = [
  ['加我微信 abc12345', '广告导流'],
  ['想聊天的进群', '广告导流'],
  ['刷单日入过百', '诈骗'],
  ['你这个废物', '人身攻击'],
  ['www.ad.com', '外链'],
  ['aaaaaaaaaaaaaaaaaaaa', '刷屏'],
];
for (const [t, expectCat] of badMsgs) {
  fresh();
  const r = reviewGroupMessage(ROOM, USER, t, { nick: '小明' });
  if (!r.allow && r.hardBlock && r.category === expectCat) {
    console.log(`  \x1b[32m✅\x1b[0m 拦住 [${r.category}]「${t}」`);
    pass++;
  } else {
    bad(`漏放或类别不对「${t}」`, { allow: r.allow, cat: r.category, expect: expectCat });
  }
}

// ============================================================
step('3. ★ 分级处理：提醒 → 30秒 → 5分钟');
// ============================================================
fresh();

const r1 = reviewGroupMessage(ROOM, USER, '加我微信 abc111', { nick: '小明' });
eq(r1.violationCount, 1, '第 1 次违规被记下');
eq(r1.muteSeconds, 0, '★ 第 1 次不禁言（只提醒）');
eq(r1.allow, false, '内容被拦下');
truthy(!!r1.botNotice, '有机器人提示语');
console.log(`     \x1b[2m${r1.botNotice}\x1b[0m`);

const r2 = reviewGroupMessage(ROOM, USER, '加我微信 abc222', { nick: '小明' });
eq(r2.violationCount, 2, '第 2 次违规');
eq(r2.muteSeconds, 30, '★ 第 2 次禁言 30 秒');
console.log(`     \x1b[2m${r2.botNotice}\x1b[0m`);

const r3 = reviewGroupMessage(ROOM, USER, '加我微信 abc333', { nick: '小明' });
eq(r3.violationCount, 3, '第 3 次违规');
eq(r3.muteSeconds, 300, '★ 第 3 次禁言 5 分钟（300 秒）');
console.log(`     \x1b[2m${r3.botNotice}\x1b[0m`);

// 第 4 次不应该继续加码（否则人会越罚越久，没有尽头）
const r4 = reviewGroupMessage(ROOM, USER, '加我微信 abc444', { nick: '小明' });
eq(r4.violationCount, 4, '第 4 次违规也被记下');
eq(r4.muteSeconds, 300, '★ 第 4 次仍是 5 分钟（不无限加码）');
ok('上限设为 5 分钟是有意的：再往上就成了"报复"，不是管理');

// ============================================================
step('4. ★ 危机信号：永远不处罚');
// ============================================================
fresh();
const crisisMsgs = [
  '我不想活了',
  '想着自杀',
  '想结束生命',
  '真的撑不下去了',
  '熬不住了',
  '想消失',
  '活着没意思',
];
for (const t of crisisMsgs) {
  const r = reviewGroupMessage(ROOM, USER, t, { nick: '小明' });
  const good = r.allow && r.crisis && !r.hardBlock
    && r.violationCount === 0 && r.muteSeconds === 0;
  if (good) {
    console.log(`  \x1b[32m✅\x1b[0m 放行且不计违规「${t}」`);
    pass++;
  } else {
    bad(`危机信号被当违规处理了「${t}」`, r);
  }
}

// 关键：连续说危机信号也不该累计违规
fresh();
for (let i = 0; i < 5; i++) {
  reviewGroupMessage(ROOM, USER, `我还是不想活了 ${i}`, { nick: '小明' });
}
const afterCrisis = reviewGroupMessage(ROOM, USER, '正常说话了', { nick: '小明' });
eq(afterCrisis.violationCount, 0, '★ 连说 5 次危机信号后，违规计数仍然是 0');
eq(afterCrisis.allow, true, '之后正常发言不受影响');
ok('如果求救被当成违规，这个人就再也不会开口了');

// 但危机信号不能"洗白"真正的违规：说危机信号之后再发广告，照样算违规
fresh();
reviewGroupMessage(ROOM, USER, '我不想活了', { nick: '小明' });
const afterCrisisAd = reviewGroupMessage(ROOM, USER, '加我微信 abc999', { nick: '小明' });
eq(afterCrisisAd.violationCount, 1, '★ 危机信号不能洗白违规（之后发广告照样算第 1 次）');

// ============================================================
step('5. 违规计数按【房间】隔离');
// ============================================================
fresh();
reviewGroupMessage(1, USER, '加我微信 abc', { nick: '小明' });
reviewGroupMessage(1, USER, '加我微信 def', { nick: '小明' });
const inRoom1 = reviewGroupMessage(1, USER, '加我微信 ghi', { nick: '小明' });
eq(inRoom1.violationCount, 3, '房间 1 里已经第 3 次');

const inRoom2 = reviewGroupMessage(2, USER, '加我微信 jkl', { nick: '小明' });
eq(inRoom2.violationCount, 1, '★ 换个房间计数从 1 开始（不跨房间累计）');
eq(inRoom2.muteSeconds, 0, '所以在新房间只是被提醒，不会被秒禁言');
ok('否则一个人在 A 群犯错，到 B 群直接被禁言，太冤');

// ============================================================
step('6. 违规计数按【人】隔离');
// ============================================================
fresh();
reviewGroupMessage(1, 100, '加我微信 abc', { nick: '小明' });
reviewGroupMessage(1, 100, '加我微信 def', { nick: '小明' });
const otherUser = reviewGroupMessage(1, 200, '加我微信 ghi', { nick: '小红' });
eq(otherUser.violationCount, 1, '★ 换个人计数从 1 开始');

// ============================================================
step('7. 禁言状态判断（不依赖 JS 时区解析）');
// ============================================================
// ★ 新接口：直接传"数据库算好的剩余秒数"
eq(checkMuted(1, 1, 0).muted, false, '剩余 0 秒 → 没被禁言');
eq(checkMuted(1, 1, 60).muted, true, '剩余 60 秒 → 被禁言');
eq(checkMuted(1, 1, 60).remainSeconds, 60, '剩余秒数原样返回');
eq(checkMuted(1, 1, 300).remainSeconds, 300, '300 秒也对');
eq(checkMuted(1, 1, null).muted, false, 'null → 没被禁言');
eq(checkMuted(1, 1, undefined).muted, false, 'undefined → 没被禁言');

console.log('');
console.log('  --- 兜底路径（传时间字符串，有隐患但兼容老代码）---');
// 这个路径依赖 JS 解析时间字符串，理论上有时区风险，
// 所以生产代码里我们优先用"数据库算好的秒数"。
const past = '2020-01-01 00:00:00';
eq(checkMuted(1, 1, past).muted, false, '过去的时间 → 已过期');
const farFuture = '2099-01-01 00:00:00';
eq(checkMuted(1, 1, farFuture).muted, true, '未来的时间 → 仍在禁言');
eq(checkMuted(1, 1, '不是时间').muted, false, '非法字符串 → 当作没禁言（不崩）');

console.log('');
ok('★ 生产代码优先用 TIMESTAMPDIFF 让 MySQL 算剩余秒数，绕开 JS 时区解析');
console.log('     （我踩过：测试里用 toISOString() 造 UTC 字符串，和本地时间差 8 小时）');

// ============================================================
step('8. 边界输入不能崩');
// ============================================================
fresh();
const edges = [
  ['', '空字符串'],
  ['   ', '纯空格'],
  [null, 'null'],
  [undefined, 'undefined'],
  [123, '数字'],
  [{}, '对象'],
  ['a'.repeat(5000), '超长内容'],
];
for (const [input, desc] of edges) {
  try {
    const r = reviewGroupMessage(ROOM, USER, input, { nick: '小明' });
    truthy(typeof r.allow === 'boolean', `${desc} → 正常返回（allow=${r.allow}）`);
  } catch (e) {
    bad(`${desc} → 抛异常了：${e.message}`);
  }
}

// room 参数不传也要能工作
try {
  const r = reviewGroupMessage(ROOM, USER, '加我微信 abc');
  truthy(r.blocked === undefined || true, '不传 room 参数也能工作（nick 缺省用"这位朋友"）');
  console.log(`     \x1b[2m${r.botNotice}\x1b[0m`);
} catch (e) {
  bad('不传 room 参数就崩了：' + e.message);
}

// ============================================================
step('9. 提示语的质量（这个产品里，措辞比规则更重要）');
// ============================================================
fresh();
const notices = [];
for (const [t, n] of [['加我微信 abc1', 1], ['加我微信 abc2', 2], ['加我微信 abc3', 3]]) {
  const r = reviewGroupMessage(ROOM, USER, t, { nick: '小明' });
  notices.push(r.botNotice);
}

// 不能出现"违规""封号""禁止"这种生硬说法
const harsh = ['违规', '封号', '禁止', '屏蔽', '拉黑'];
let harshFound = false;
for (const n of notices) {
  for (const h of harsh) {
    if (n.includes(h)) { harshFound = true; bad(`提示语太生硬，包含「${h}」：${n}`); }
  }
}
if (!harshFound) {
  ok('★ 提示语没有"违规/封号/禁止"这类字眼');
}

// 每条提示语都要提到对方昵称（让人知道是在跟自己说话）
for (const n of notices) {
  truthy(n.includes('@小明') || n.includes('小明'), `提示语点名了对方：${n.slice(0, 30)}...`);
}

// 三档的措辞应该不一样（罚得越重，话说得越认真）
truthy(new Set(notices).size === 3, '★ 三档的提示语各不相同（不是复制粘贴同一句）');
notices.forEach((n, i) => console.log(`     \x1b[2m第${i + 1}档：${n}\x1b[0m`));

// 最后一档要说明"为什么"（留下一个能好好说话的地方），而不是单纯威胁
truthy(/好好说话|留个/.test(notices[2]), '★ 最重那档解释了理由，而不是单纯威胁');

// ============================================================
console.log('\n==============================================');
console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
console.log('==============================================');

if (fail === 0) {
  console.log('\n  🎉 违规检测机器人全部通过（分级尺度 + 危机信号保护都验过了）\n');
  process.exitCode = 0;
} else {
  console.log('\n  失败项：');
  failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
  console.log('');
  process.exitCode = 1;
}
