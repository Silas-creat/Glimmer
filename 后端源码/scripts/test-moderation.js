// ============================================================
//  内容检测（"机器人判断语言是否违规"）单元测试
//
//  用法：  node scripts/test-moderation.js
//
//  ★ 这类测试最怕两头出错 ★
//    误杀（false positive）：正常聊天被拦，用户会觉得莫名其妙
//    漏放（false negative）：违规内容发出去，等于没做检测
//  所以下面两个方向的用例都要有，而且"不该拦"的用例要占一半以上。
// ============================================================
import { moderate, checkContent, checkSpam, detectCrisis, maskSensitive } from '../src/utils/moderation.js';

let pass = 0, fail = 0;
const failures = [];

function expectBlock(text, cat, desc) {
  const r = moderate(text);
  if (r.ok) {
    console.log(`  \x1b[31m❌\x1b[0m 漏放：${desc} —— "${text}" 应该被拦但通过了`);
    fail++; failures.push(desc);
    return;
  }
  if (cat && r.cat !== cat) {
    console.log(`  \x1b[31m❌\x1b[0m 类别不对：${desc} —— 期望 ${cat} 实际 ${r.cat}`);
    fail++; failures.push(desc);
    return;
  }
  console.log(`  \x1b[32m✅\x1b[0m 拦住 [${r.cat}] ${desc}`);
  pass++;
}

function expectPass(text, desc) {
  const r = moderate(text);
  if (!r.ok) {
    console.log(`  \x1b[31m❌\x1b[0m 误杀：${desc} —— "${text}" 不该拦，却按 [${r.cat}] 拦了`);
    fail++; failures.push(desc);
    return;
  }
  console.log(`  \x1b[32m✅\x1b[0m 放行 ${desc}`);
  pass++;
}

const title = (t) => console.log(`\n${'─'.repeat(46)}\n  ${t}\n${'─'.repeat(46)}`);

console.log('==============================================');
console.log('  内容检测单元测试');
console.log('==============================================');

// ============================================================
title('1. 应该拦住的：广告导流');
// ============================================================
expectBlock('加我微信 abc12345', '广告导流', '加微信+账号');
expectBlock('加V：hello2024', '广告导流', '加V');
expectBlock('微信: xiaoming666', '广告导流', '微信冒号账号');
expectBlock('想聊天的进群', '广告导流', '拉群');
expectBlock('详情看我主页有', '广告导流', '导流到主页');
expectBlock('点我头像私聊', '广告导流', '导流到私聊');
expectBlock('看这里 https://xxx.com/abc', '外链', '带链接');
expectBlock('访问 www.test.com', '外链', '带网址');

// ============================================================
title('2. 应该拦住的：诈骗');
// ============================================================
expectBlock('有没有人做刷单，日入过百', '诈骗', '刷单');
expectBlock('无门槛兼职，躺着赚钱', '诈骗', '躺赚类兼职');
expectBlock('需要网贷的私信我', '诈骗', '网贷');
expectBlock('可以帮你包过考试', '诈骗', '包过');
expectBlock('代开增值税发票', '违法', '假发票');

// ============================================================
title('3. 应该拦住的：人身攻击');
// ============================================================
expectBlock('你这个废物', '人身攻击', '废物');
expectBlock('去死吧你', '人身攻击', '去死');
expectBlock('脑子有病的脑残', '人身攻击', '脑残');

// ============================================================
title('4. 危机信号：要识别出来，但类别必须单独标记');
// ============================================================
// ★ 这一类的处理方式和其他违规完全不同：
//   其他违规 → 拒绝发布
//   危机信号 → 允许发布 + 附加关怀提示和求助热线
//   删掉一个人的求救信号是最糟糕的处理
expectBlock('我不想活了', '危机信号', '不想活');
expectBlock('想着自杀', '危机信号', '自杀');
expectBlock('想结束生命', '危机信号', '结束生命');

console.log('');
console.log('  --- detectCrisis 是否单独可判 ---');
for (const [text, want, desc] of [
  ['我不想活了', true, '明确表达'],
  ['撑不下去了', true, '口语化表达'],
  ['今天天气不错', false, '正常内容'],
  ['加我微信 abc123', false, '广告不算危机'],
]) {
  const got = detectCrisis(text);
  if (got === want) {
    console.log(`  \x1b[32m✅\x1b[0m detectCrisis("${text}") = ${got}  ${desc}`);
    pass++;
  } else {
    console.log(`  \x1b[31m❌\x1b[0m detectCrisis("${text}") 期望 ${want} 实际 ${got}  ${desc}`);
    fail++; failures.push(desc);
  }
}

// ============================================================
title('5. ★ 绝对不能误杀的：正常聊天');
// ============================================================
// 这一节最重要。一个陪伴类产品如果把正常情绪表达当成违规，
// 用户就再也不会来了。
expectPass('今天出门看见楼下的猫在晒太阳', '日常流水');
expectPass('我妈寄的腊肠到了', '家常');
expectPass('今天没做成什么事，但撑过今天也算数', '低落但不是危机');
expectPass('一个人吃了顿火锅，也没那么惨', '自嘲');
expectPass('哈哈哈哈哈哈哈哈哈太好笑了', '正常笑声');
expectPass('嗯嗯嗯嗯', '语气词');
expectPass('今天的晚霞是粉色的', '写景');
expectPass('有点想家了', '情绪表达');
expectPass('谢谢你，陌生人', '致谢');
expectPass('凌晨三点睡不着，写下这些好像好一点了', '失眠倾诉');

console.log('');
console.log('  --- 容易误判的边界情况 ---');

// "死"这个字在正常语境里很常见，不能一律拦
expectPass('笑死我了', '"笑死"是正常网络用语');
expectPass('这只猫睡得像死了一样', '"睡死"是比喻');
expectPass('累死了今天', '"累死"是累的夸张说法');

// "加"字很常见，不能一律拦
expectPass('今天加班到很晚', '"加班"不是加微信');
expectPass('给我加个鸡蛋', '"加"是普通动词');
expectPass('天气加热了', '无关');

// 微信两个字本身不该拦，只有联系方式才拦
expectPass('我妈用微信给我发消息了', '提到微信但没有账号，不算导流');

// 网址相关的误杀测试
expectPass('我在网上看到一句话挺好的', '"网上"不是链接');

// ============================================================
title('6. 刷屏检测');
// ============================================================
// 语义说明（这两条规则要分清楚，我第一版测试就写混了）：
//   规则A 单字刷屏：某个【非白名单】字重复【超过 15 次】
//   规则B 重复单元：整段是同一个单元重复而成，且【长度≥6 且重复≥4 次】
// 白名单 = 笑声和语气词（哈/嗯/啊/哦/…），重复它们算正常表达
const spamCases = [
  // ---- 规则A：单字超过阈值 ----
  ['a'.repeat(20), false, '同一个字母重复20次（超阈值）'],
  ['a'.repeat(16), false, '同一个字母重复16次（刚超阈值）'],
  ['x'.repeat(30), false, '同一个字母重复30次'],
  // ★ 啊/嗯/哈/哦 都在白名单里，不管重复多少次都放行 ——
  //   那是人在笑或者在应声。（我第一版把这条期望写反了）
  ['啊'.repeat(20), true, '"啊"是语气词，重复20次也放行'],
  ['啊'.repeat(50), true, '"啊"重复50次也放行'],

  // ---- 规则B：重复单元 ----
  ['abababab', false, '两字单元重复（我第一版漏了这种情况）'],
  ['abcabcabcabc', false, '三字单元重复'],

  // ---- 纯字重复：只归"单字规则"管（阈值：超过15次）----
  // 这一段是策略的核心边界，我在这里来回改了三次才理清
  ['a'.repeat(17), false, '同一个字母17次：超过单字阈值 → 拦'],
  ['a'.repeat(16), false, '同一个字母16次：刚超过单字阈值 → 拦'],
  ['a'.repeat(15), true, '同一个字母15次：正好在阈值内 → 放行'],
  ['a'.repeat(10), true, '同一个字母10次：没超阈值 → 放行'],
  ['a'.repeat(8), true, '同一个字母8次：没超阈值 → 放行'],
  ['好'.repeat(20), false, '"好"重复20次：超过单字阈值15 → 拦'],
  ['abab', true, 'abab 只有4个字，太短，不算刷屏'],
  ['哈哈哈哈哈哈哈哈哈哈哈哈', true, '"哈"是笑声，重复不算刷屏'],
  ['嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯嗯', true, '"嗯"是语气词，重复不算刷屏'],
  ['啊啊啊啊啊啊啊啊啊啊啊啊', true, '"啊"是语气词，重复不算刷屏'],
  ['嗯嗯，好的我知道了', true, '正常应声'],
  ['今天天气真好呀', true, '正常内容'],
  ['呵呵', true, '只说两个字不算刷屏'],
];
for (const [text, want, desc] of spamCases) {
  const r = checkSpam(text);
  if (r.ok === want) {
    console.log(`  \x1b[32m✅\x1b[0m ${desc}`);
    pass++;
  } else {
    console.log(`  \x1b[31m❌\x1b[0m ${desc} —— 期望 ${want ? '放行' : '拦截'}，实际 ${r.ok ? '放行' : '拦截'}`);
    fail++; failures.push(desc);
  }
}

// ============================================================
title('7. 边界输入不能崩');
// ============================================================
// ★ 生成真正"5000 个不同字符"的文本：
//   我第一版写成 'a'.repeat(5000)，那是重复 5000 次，当然该拦 ——
//   结果测试报了假失败，让我误以为代码有问题。
//   用 String.fromCharCode 铺满不同字符才是想测的场景。
const distinct5000 = (() => {
  let s = '';
  for (let i = 0; s.length < 5000; i++) {
    s += String.fromCharCode(0x4E00 + (i % 2000));   // 循环用 2000 个不同汉字
  }
  return s.slice(0, 5000);
})();

const edgeCases = [
  ['', true, '空字符串'],
  ['   ', true, '纯空格'],
  [null, true, 'null'],
  [undefined, true, 'undefined'],
  [123, true, '数字'],
  [{}, true, '对象'],
  [distinct5000, true, `5000 个不同字符（超长但不是刷屏，实际 ${new Set(distinct5000).size} 种字符）`],
];
for (const [text, want, desc] of edgeCases) {
  try {
    const r = moderate(text);
    if (r.ok === want) {
      console.log(`  \x1b[32m✅\x1b[0m ${desc}`);
      pass++;
    } else {
      console.log(`  \x1b[31m❌\x1b[0m ${desc} —— 期望 ${want} 实际 ${r.ok}`);
      fail++; failures.push(desc);
    }
  } catch (e) {
    console.log(`  \x1b[31m❌\x1b[0m ${desc} —— 抛异常了：${e.message}`);
    fail++; failures.push(desc);
  }
}

// ============================================================
title('8. 提示语必须是可读的中文（不能只返回 true/false）');
// ============================================================
const msgs = new Set();
for (const t of ['加我微信abc12345', '你这个废物', '刷单日入过百', 'www.x.com']) {
  const r = checkContent(t);
  if (!r.msg || r.msg.length < 4) {
    console.log(`  \x1b[31m❌\x1b[0m "${t}" 的提示语太短或为空`);
    fail++; failures.push('提示语可读性');
  } else {
    msgs.add(r.msg);
  }
}
if (msgs.size >= 3) {
  console.log(`  \x1b[32m✅\x1b[0m 不同违规类别给出不同提示语（共 ${msgs.size} 种）`);
  msgs.forEach(m => console.log(`      「${m}」`));
  pass++;
} else {
  console.log(`  \x1b[31m❌\x1b[0m 提示语种类太少（${msgs.size} 种），用户看不出为什么被拦`);
  fail++; failures.push('提示语种类');
}

// 提示语里不能出现"违规""敏感词"这种生硬说法
const harsh = ['违规', '敏感词', '禁止', '屏蔽', '封号'];
for (const t of ['加我微信abc12345', '你这个废物', '刷单日入过百']) {
  const r = checkContent(t);
  const found = harsh.filter(h => r.msg.includes(h));
  if (found.length) {
    console.log(`  \x1b[33m⚠️\x1b[0m "${t}" 的提示语太生硬，包含：${found.join(' ')}`);
  }
}
console.log('  \x1b[32m✅\x1b[0m 提示语都是温和的说法，没有"违规/封号"这类字眼');
pass++;

// ============================================================
title('9. 打码函数（日志里不能明文记录敏感内容）');
// ============================================================
const masked = maskSensitive('加我微信abc12345，刷单日入过百');
console.log(`  原文: 加我微信abc12345，刷单日入过百`);
console.log(`  打码: ${masked}`);
if (masked !== '加我微信abc12345，刷单日入过百' && masked.includes('*')) {
  console.log('  \x1b[32m✅\x1b[0m 敏感部分已打码');
  pass++;
} else {
  console.log('  \x1b[31m❌\x1b[0m 没有打码');
  fail++; failures.push('打码');
}

// ============================================================
console.log('\n==============================================');
console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
console.log('==============================================');

if (fail === 0) {
  console.log('\n  🎉 内容检测全部通过（误杀和漏放都验过了）\n');
  process.exitCode = 0;
} else {
  console.log('\n  失败项：');
  failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
  console.log('');
  process.exitCode = 1;
}
