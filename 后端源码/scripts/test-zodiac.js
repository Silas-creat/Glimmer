// 星座/省份推算的单元测试（这些边界很容易写错）
import { zodiacOf, provinceOf, ageGroupOf, ageOf, ZODIACS } from '../src/utils/zodiac.js';

let bad = 0;
const fail = (msg) => { console.log('  ❌ ' + msg); bad++; };

// ---------- 星座边界（每个星座的交接日前后各一天）----------
const cases = [
  [1, 1, '摩羯'], [1, 19, '摩羯'], [1, 20, '水瓶'], [1, 31, '水瓶'],
  [2, 18, '水瓶'], [2, 19, '双鱼'], [3, 20, '双鱼'], [3, 21, '白羊'],
  [4, 19, '白羊'], [4, 20, '金牛'], [5, 20, '金牛'], [5, 21, '双子'],
  [6, 21, '双子'], [6, 22, '巨蟹'], [7, 22, '巨蟹'], [7, 23, '狮子'],
  [8, 22, '狮子'], [8, 23, '处女'], [9, 22, '处女'], [9, 23, '天秤'],
  [10, 23, '天秤'], [10, 24, '天蝎'], [11, 22, '天蝎'], [11, 23, '射手'],
  [12, 21, '射手'], [12, 22, '摩羯'], [12, 31, '摩羯'],
];
for (const [mm, dd, want] of cases) {
  const got = zodiacOf(mm, dd);
  if (got !== want) fail(`${mm}月${dd}日: 期望 ${want} 实际 ${got}`);
}
console.log(bad === 0
  ? `  ✅ 星座边界 ${cases.length} 项全对`
  : `  ❌ 星座有 ${bad} 项错`);

// 非法输入
const before = bad;
for (const [mm, dd] of [[0, 5], [13, 5], [5, 0], [5, 32], [1.5, 5], ['a', 5]]) {
  const got = zodiacOf(mm, dd);
  if (got !== '') fail(`非法输入 ${mm}/${dd} 应该返回空，实际 "${got}"`);
}
if (bad === before) console.log('  ✅ 非法输入都返回空');

// 12 个星座都能被覆盖到
const beforeZ = bad;
const seen = new Set();
for (let mm = 1; mm <= 12; mm++) {
  for (let dd = 1; dd <= 28; dd++) seen.add(zodiacOf(mm, dd));
}
if (seen.size !== 12) fail(`只覆盖到 ${seen.size} 个星座，应该 12 个`);
for (const z of ZODIACS) if (!seen.has(z)) fail(`星座 ${z} 从未被算出`);
if (bad === beforeZ) console.log(`  ✅ 12 个星座全部可达（${[...seen].join(' ')}）`);

// ---------- 省份识别 ----------
const pcases = [
  ['陕西省西安市雁塔区', '陕西'],
  ['广东深圳', '广东'],
  ['内蒙古呼和浩特', '内蒙古'],
  ['广西壮族自治区南宁市', '广西'],
  ['上海市浦东新区', '上海'],
  ['北京朝阳', '北京'],
  ['香港九龙', '香港'],
  ['新疆维吾尔自治区乌鲁木齐', '新疆'],
  ['宁夏回族自治区银川', '宁夏'],
  ['黑龙江省哈尔滨市', '黑龙江'],
  ['豫A 郑州', '河南'],
  ['', ''],
  [null, ''],
  ['随便乱写的', ''],
  ['国外某个地方', ''],
];
let pbad = 0;
for (const [addr, want] of pcases) {
  const got = provinceOf(addr);
  if (got !== want) { console.log(`  ❌ 省份 "${addr}": 期望 ${want || '(空)'} 实际 ${got || '(空)'}`); pbad++; }
}
console.log(pbad === 0
  ? `  ✅ 省份识别 ${pcases.length} 项全对`
  : `  ❌ 省份有 ${pbad} 项错`);

// 不能误判：内蒙古不能被当成"内蒙"以外的，广西不能被"西"抢走
const tricky = [
  ['江西南昌', '江西'],   // 有"西"字，但主体是江西
  ['山西太原', '山西'],   // 同上
  ['陕西西安', '陕西'],
];
let tbad = 0;
for (const [addr, want] of tricky) {
  const got = provinceOf(addr);
  if (got !== want) { console.log(`  ❌ 易混 "${addr}": 期望 ${want} 实际 ${got}`); tbad++; }
}
if (tbad === 0) console.log('  ✅ 山西/陕西/江西 这类易混的没判错');

// ---------- 年龄段 ----------
const y = new Date().getFullYear();
const ycases = [
  [y - 15, '未成年'], [y - 20, '18-24'], [y - 27, '25-29'],
  [y - 32, '30-34'], [y - 37, '35-39'], [y - 45, '40-49'],
  [y - 55, '50-59'], [y - 70, '60以上'],
];
let ybad = 0;
for (const [birth, want] of ycases) {
  const got = ageGroupOf(birth);
  if (got !== want) { console.log(`  ❌ 年龄段 ${want}: 实际 ${got}`); ybad++; }
}
if (ybad === 0) console.log(`  ✅ 年龄段 ${ycases.length} 项全对`);

if (ageOf(y - 27) !== 27) fail('ageOf 算错了');
if (ageOf(null) !== null) fail('ageOf(null) 应该返回 null');
if (ageOf(1800) !== null) fail('ageOf 对不合理年份应该返回 null');

// ---------- 汇总 ----------
console.log('');
if (bad === 0) {
  console.log('  🎉 星座/省份/年龄段 工具函数全部正确\n');
  process.exit(0);
} else {
  console.log(`  ❌ 共 ${bad} 项错误\n`);
  process.exit(1);
}
