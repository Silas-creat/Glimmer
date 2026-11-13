// ============================================================
//  星座 / 省份 的小工具
//
//  为什么单独抽出来：
//    「星迹」群按星座分房间，「同省群」按省份分房间。
//    这两个值都在 user_profiles 表里，且都有索引（idx_zodiac / idx_province），
//    用来快速筛出"和我同星座/同省的人"。
//
//  星座不能让用户自己选 —— 那样会乱填，群聊就分不干净了。
//  正确做法：让用户填出生日期，后端算星座。
// ============================================================

/** 12 个星座，和前端聊天房间的用词保持一致 */
export const ZODIACS = [
  '白羊', '金牛', '双子', '巨蟹', '狮子', '处女',
  '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼',
];

/**
 * 根据月日算星座
 * @param {number} month 1-12
 * @param {number} day   1-31
 * @returns {string} 例如 '天蝎'，输入不合法返回 ''
 */
export function zodiacOf(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';

  // 每个星座的起始日期（星座是按"从这天开始"划分的）
  // 注意：这里用的是常见的近似分界日（不考虑具体年份的精确交接时刻），
  // 对群聊分组来说完全够用。
  const starts = [
    [1, 20, '水瓶'], [2, 19, '双鱼'], [3, 21, '白羊'], [4, 20, '金牛'],
    [5, 21, '双子'], [6, 22, '巨蟹'], [7, 23, '狮子'], [8, 23, '处女'],
    [9, 23, '天秤'], [10, 24, '天蝎'], [11, 23, '射手'], [12, 22, '摩羯'],
  ];

  // 找"起始日期 <= 我的日期"里最晚的那个
  let result = '';
  for (const [m, d, name] of starts) {
    if (month > m || (month === m && day >= d)) {
      result = name;
    }
  }
  // 1月1日~1月19日 落在最后一个分界（12/22 摩羯）之后，归摩羯
  if (!result) result = '摩羯';

  return result;
}

/**
 * 从出生年份算年龄
 * @returns {number|null}
 */
export function ageOf(birthYear) {
  if (!Number.isInteger(birthYear)) return null;
  const age = new Date().getFullYear() - birthYear;
  if (age < 0 || age > 130) return null;
  return age;
}

/**
 * 把年龄映射到"同龄群"的年龄段标签
 * 前端首页有"同龄群"，按年代分比按具体岁数分更自然
 */
export function ageGroupOf(birthYear) {
  const age = ageOf(birthYear);
  if (age === null) return '';
  if (age < 18) return '未成年';
  if (age < 25) return '18-24';
  if (age < 30) return '25-29';
  if (age < 35) return '30-34';
  if (age < 40) return '35-39';
  if (age < 50) return '40-49';
  if (age < 60) return '50-59';
  return '60以上';
}

// ============================================================
//  省份
// ============================================================

/** 中国省级行政区（含简称到全称的映射，方便从用户填的地址里识别） */
const PROVINCES = [
  '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江',
  '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南',
  '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州',
  '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆',
  '香港', '澳门', '台湾',
];

/**
 * 从一段地址文本里尽量识别出省份
 *
 * 比如用户填 "陕西省西安市雁塔区" → '陕西'
 *             "广东深圳"          → '广东'
 *             乱填的            → ''（宁可为空，也不要瞎猜）
 *
 * 为什么要这么做：同省群靠这个字段分房间。让用户自己选省份容易选错，
 * 从地址里提取更自然 —— 用户本来就填了地址。
 */
export function provinceOf(addr) {
  if (!addr || typeof addr !== 'string') return '';
  const s = addr.trim();

  // 先找最长的匹配（"内蒙古" 必须比 "内蒙" 优先，避免歧义）
  const sorted = [...PROVINCES].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    if (s.includes(p)) return p;
  }

  // 常见简称/别称
  const aliases = {
    '豫': '河南', '鲁': '山东', '冀': '河北', '晋': '山西', '陕': '陕西',
    '甘': '甘肃', '宁': '宁夏', '新': '新疆', '藏': '西藏', '川': '四川',
    '渝': '重庆', '贵': '贵州', '云': '云南', '桂': '广西', '粤': '广东',
    '湘': '湖南', '鄂': '湖北', '赣': '江西', '皖': '安徽', '苏': '江苏',
    '浙': '浙江', '闽': '福建', '沪': '上海', '京': '北京', '津': '天津',
    '辽': '辽宁', '吉': '吉林', '黑': '黑龙江', '琼': '海南',
  };
  for (const [k, v] of Object.entries(aliases)) {
    if (s.includes(k)) return v;
  }

  return '';
}

/** 校验省份是否在已知列表里（允许空） */
export function isValidProvince(p) {
  if (!p) return true;
  return PROVINCES.includes(p);
}
