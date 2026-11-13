// ============================================================
//  校验工具
// ============================================================
import { ApiError } from './response.js';

/** 中国手机号：1 开头，第二位 3-9，共 11 位 */
export function isPhone(v) {
  return typeof v === 'string' && /^1[3-9]\d{9}$/.test(v);
}

/** 6 位数字验证码 */
export function isCode(v) {
  return typeof v === 'string' && /^\d{6}$/.test(v);
}

/**
 * 取一个必填字符串（会 trim）
 * 太长的自动截断，防止有人塞 10 万字的字符串进来
 */
export function str(v, fieldName, { required = true, max = 500, min = 0, def = '' } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new ApiError(`${fieldName}不能为空`, 400);
    return def;
  }
  let s = String(v).trim();
  if (s.length === 0) {
    if (required) throw new ApiError(`${fieldName}不能为空`, 400);
    return def;
  }
  if (s.length < min) throw new ApiError(`${fieldName}太短了`, 400);
  if (s.length > max) s = s.slice(0, max);
  return s;
}

/** 取整数 */
export function int(v, fieldName, { required = true, min = null, max = null, def = 0 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(`${fieldName}不能为空`, 400);
    return def;
  }
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new ApiError(`${fieldName}必须是数字`, 400);
  if (min !== null && n < min) throw new ApiError(`${fieldName}不能小于${min}`, 400);
  if (max !== null && n > max) throw new ApiError(`${fieldName}不能大于${max}`, 400);
  return n;
}

/** 日期字符串 YYYY-MM-DD */
export function isDateKey(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * 严格校验日期，并且拒绝不存在的日期（比如 2026-02-30）
 * isDateKey 只检查格式对不对，这个函数还检查日期是否真实存在
 */
export function isValidDateKey(v) {
  if (!isDateKey(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // 用 Date 反查：如果 2026-02-30 会被自动进位成 3-02，就不一致了
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 今天的日期 key，和前端 diary-write.html 的算法保持一致 */
export function todayKey(d = new Date()) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

/** 数据库 DATETIME -> '2026-10-16' */
export function datePart(datetime) {
  if (!datetime) return '';
  if (typeof datetime === 'string') return datetime.slice(0, 10);
  return todayKey(new Date(datetime));
}

/**
 * 把数据库时间变成前端友好的相对时间（和 data.js 里的 '3分钟前' 风格一致）
 * 前端现在还不会用，但列表接口顺手带上，以后换掉硬编码的 time 字段就能用
 */
export function relativeTime(datetime, now = new Date()) {
  if (!datetime) return '';
  const t = typeof datetime === 'string'
    ? new Date(datetime.replace(' ', 'T'))
    : new Date(datetime);
  if (Number.isNaN(t.getTime())) return '';

  const diff = Math.floor((now.getTime() - t.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';

  const days = Math.floor(diff / 86400);
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days < 7) return days + '天前';
  if (days < 30) return Math.floor(days / 7) + '周前';
  return datePart(datetime);
}
