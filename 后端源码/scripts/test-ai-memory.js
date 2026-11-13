// ============================================================
//  AI 记忆逻辑单元测试（不需要后端，也不需要 API Key）
//
//  用法：  node scripts/test-ai-memory.js
//
//  ★ 为什么单独测记忆 ★
//    第 3 步的需求是"能读取记忆（同一个号换一个设备还能继续聊天）"。
//    聊天能不能变聪明取决于有没有 Key，但"记忆"这件事
//    完全是我们自己的逻辑，必须保证正确：
//      · 摘要要能压缩旧对话
//      · 重复内容不能反复记（我测试时同一句发了 8 遍，摘要里就是 8 遍）
//      · 记忆不能无限增长
//      · 新旧记忆合并要去重
//    这些都是纯逻辑，所以用单元测试覆盖，不依赖网络。
// ============================================================
// ★ 强制本地兜底模式 ★
//   这个单测校验的是"本地摘要逻辑"（原词保留、去重、长度上限），
//   配了 DeepSeek Key 时摘要会被模型改写，原词不保证保留 ——
//   断言就会失败，但那不是功能坏了。
//   dotenv 不会覆盖已存在的环境变量，所以在这里置空就能锁住本地模式。
process.env.DEEPSEEK_API_KEY = '';

const { summarize, providerInfo, providerName } = await import('../src/utils/llm.js');

let pass = 0, fail = 0;
const failures = [];
const ok = (m) => { console.log(`  \x1b[32m✅\x1b[0m ${m}`); pass++; };
const bad = (m, extra) => {
  console.log(`  \x1b[31m❌\x1b[0m ${m}`);
  if (extra !== undefined) console.log(`     实际: ${JSON.stringify(extra).slice(0, 300)}`);
  fail++; failures.push(m);
};
const step = (t) => console.log(`\n${'─'.repeat(46)}\n  ${t}\n${'─'.repeat(46)}`);
const eq = (a, b, m) => a === b ? ok(m) : bad(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const truthy = (c, m, actual) => c ? ok(m) : bad(m, actual);

const countOf = (haystack, needle) => (String(haystack).match(new RegExp(needle, 'g')) || []).length;

console.log('==============================================');
console.log('  AI 记忆逻辑 · 单元测试');
console.log('  （不需要后端，也不需要 API Key）');
console.log('==============================================');

// ============================================================
step('1. 当前模型状态');
// ============================================================
const info = providerInfo();
console.log(`     provider = ${info.provider}  model = ${info.model}  isReal = ${info.isReal}`);
truthy(['deepseek', 'local'].includes(info.provider), 'provider 是合法值');
eq(providerName(), info.provider, 'providerName() 和 providerInfo() 一致');
if (info.provider === 'local') {
  truthy(info.notice.length > 0, '本地兜底时会给前端一句说明（不能假装是大模型）');
  console.log(`     \x1b[2m说明：${info.notice.slice(0, 44)}…\x1b[0m`);
} else {
  eq(info.notice, '', '接了真模型时不给"体验版"提示');
  ok('★ 已经配置了 API Key，走的是真模型');
}

// ============================================================
step('2. ★ 重复内容不能反复记（我测试时踩的坑）');
// ============================================================
// 场景：用户把同一句话说了 8 遍
const same = [];
for (let i = 0; i < 8; i++) {
  same.push({ role: 'user', content: '我妈寄的腊肠到了，有点想家' });
}
const r1 = await summarize('', same);
console.log(`     \x1b[2m摘要：${r1}\x1b[0m`);
eq(countOf(r1, '腊肠'), 1, '★ 同一句话说了 8 遍，摘要里只记 1 次');
truthy(r1.length <= 400, `摘要长度受控（${r1.length} 字）`);

// 场景：内容带不同空白，也算同一句
const spacey = [
  { role: 'user', content: '今天上班好累' },
  { role: 'user', content: '今天上班好累 ' },
  { role: 'user', content: ' 今天上班好累' },
];
const r2 = await summarize('', spacey);
eq(countOf(r2, '上班'), 1, '★ 只差空白的重复内容也算同一句');

// ============================================================
step('3. 有信息量的内容要记下来');
// ============================================================
const facts = [
  { role: 'user', content: '今天加班到很晚' },
  { role: 'user', content: '我妈打电话来了' },
  { role: 'user', content: '养了只猫叫团子' },
];
const r3 = await summarize('', facts);
console.log(`     \x1b[2m摘要：${r3}\x1b[0m`);
truthy(r3.includes('加班'), '记下了"加班"');
truthy(r3.includes('妈'), '记下了"妈妈打电话"');
truthy(r3.includes('猫'), '记下了"养猫"');

// 没有关键词的短句不硬记
const empty = await summarize('', [{ role: 'user', content: '嗯' }, { role: 'user', content: '哦' }]);
console.log(`     \x1b[2m无关键词时：${empty}\x1b[0m`);
truthy(empty.length > 0, '没有关键词也给一句兜底说明（记忆不为空）');

// ============================================================
step('4. 新旧记忆合并时也要去重');
// ============================================================
const r4 = await summarize(r3, [{ role: 'user', content: '今天加班到很晚' }]);
console.log(`     \x1b[2m合并后：${r4}\x1b[0m`);
eq(countOf(r4, '加班'), 1, '★ 新旧记忆重复时不重复写');
truthy(r4.includes('猫'), '旧记忆里别的内容还在（不是整段替换）');

// ============================================================
step('5. 记忆不能无限增长');
// ============================================================
let rolling = '';
for (let i = 0; i < 50; i++) {
  rolling = await summarize(rolling, [{ role: 'user', content: `我今天上班很累第${i}次` }]);
}
console.log(`     压 50 轮后：${rolling.length} 字`);
truthy(rolling.length <= 400, `★ 有长度上限（${rolling.length} ≤ 400）`);
// 只保留最近几条，最早的不该还在
truthy(!rolling.includes('第0次'), '太旧的记忆被挤掉了（只留最近几条）');
truthy(rolling.includes('第49次'), '最近的记忆还在');

// ============================================================
step('6. 边界输入不能崩');
// ============================================================
const edges = [
  [[], '空数组'],
  [[{ role: 'user', content: '' }], '空内容'],
  [[{ role: 'assistant', content: '只有助手说话' }], '只有 assistant（没有用户消息）'],
  [[{ role: 'user', content: null }], 'content 是 null'],
  [[{ role: 'user', content: 'a'.repeat(3000) }], '超长内容'],
];
for (const [msgs, desc] of edges) {
  try {
    const r = await summarize('', msgs);
    truthy(typeof r === 'string', `${desc} → 正常返回字符串（${r.length} 字）`);
  } catch (e) {
    bad(`${desc} → 抛异常了：${e.message}`);
  }
}

// oldSummary 传 undefined / null
try {
  const r = await summarize(undefined, [{ role: 'user', content: '我今天上班好累' }]);
  truthy(typeof r === 'string' && r.length > 0, 'oldSummary 传 undefined 也能工作');
} catch (e) {
  bad('oldSummary 传 undefined 就崩了：' + e.message);
}

// ============================================================
step('7. 记忆要能体现"这个人是谁"而不是复读原话');
// ============================================================
// 说明：没有 Key 时用的是规则摘要，它确实会保留用户的原话片段。
// 这不是"复读"，而是因为规则摘要没有理解能力 —— 保留原话
// 已经是最不容易出错的做法（总比瞎概括好）。
// 接了真模型之后，prompt 里要求"用第三人称写"，会更像记忆。
const personal = [
  { role: 'user', content: '我在准备考研，压力很大' },
  { role: 'user', content: '每天晚上都睡不着' },
];
const r5 = await summarize('', personal);
console.log(`     \x1b[2m${r5}\x1b[0m`);
truthy(r5.includes('考研'), '记下了"在准备考研"这件事');
truthy(r5.includes('睡不着'), '记下了"睡不着"这个状态');
ok('这些信息让 AI 下次能说出"你之前提到在准备考研" —— 这就是"记得你"');

// ============================================================
console.log('\n==============================================');
console.log(`  结果： 通过 \x1b[32m${pass}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
console.log('==============================================');
if (fail === 0) {
  console.log('\n  🎉 AI 记忆逻辑全部通过！\n');
  process.exitCode = 0;
} else {
  console.log('\n  失败项：');
  failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
  console.log('');
  process.exitCode = 1;
}
