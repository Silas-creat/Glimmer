import { randomUUID } from 'node:crypto';
import { query, queryOne, transaction } from '../db/index.js';
import { ApiError } from './response.js';
import { isValidDateKey } from './validate.js';
import { detectCrisis, HELP_LINES } from './moderation.js';
import { draftDiary } from './llm.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRAFT_SELECT = `SELECT *, expires_at <= UTC_TIMESTAMP(3) AS is_expired,
  DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_iso
  FROM ai_diary_drafts`;

// Do not use validate.str here: that helper silently truncates overlong inputs.
export function requiredText(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(`${name}必须是非空文字`, 400);
  if (value.length > max) throw new ApiError(`${name}不能超过${max}字`, 400);
  return value.trim();
}

export function careFor(text) {
  return detectCrisis(text) ? {
    message: '看到你现在可能很难受。先陪你停在这里；如果有立即伤害自己的危险，请联系身边可信任的人或当地急救服务。也可以联系这些援助热线。',
    lines: HELP_LINES,
  } : null;
}

function diaryUrl(date) {
  return `diary-write.html?date=${encodeURIComponent(date)}`;
}

function serializeDraft(row) {
  return {
    id: row.id,
    date: row.date_key,
    text: row.text,
    sources: typeof row.sources_json === 'string' ? JSON.parse(row.sources_json) : row.sources_json,
    provider: row.provider,
    status: row.status === 'pending' && row.is_expired ? 'expired' : row.status,
    expiresAt: row.expires_iso,
  };
}

function assertId(id) {
  if (!UUID.test(id)) throw new ApiError('草稿不存在', 404);
}

export async function getDraft(uid, id) {
  assertId(id);
  const row = await queryOne(`${DRAFT_SELECT} WHERE id = ? AND user_id = ?`, [id, uid]);
  if (!row) throw new ApiError('草稿不存在', 404);
  return serializeDraft(row);
}

export async function prepareDraft(uid, body = {}) {
  const message = requiredText(body.message, '想记录的话', 2000);
  if (!isValidDateKey(body.date)) throw new ApiError('日期必须是有效的 YYYY-MM-DD', 400);
  const date = body.date;
  const trace = [{ step: 'validate', status: 'ok', message: '已检查文字长度和日期。' }];
  const care = careFor(message);
  if (care) {
    trace.push({ step: 'care', status: 'stopped', message: '已提供关怀信息，未调用模型、读取日记或创建草稿。' });
    return { draft: null, trace, provider: 'local', care };
  }

  // Consent is deliberately strict. Values such as "true" and 1 never authorize access.
  const rows = body.includeRecentDiaries === true
    ? await query(`SELECT id, date_key, text FROM diaries
        WHERE user_id = ? AND date_key <= ? AND date_key > DATE_FORMAT(DATE_SUB(?, INTERVAL 7 DAY), '%Y-%m-%d')
        ORDER BY date_key DESC, id DESC LIMIT 3`, [uid, date, date])
    : [];
  const sources = rows.map(r => ({ id: r.id, date: r.date_key, url: diaryUrl(r.date_key) }));
  trace.push({
    step: 'sources', status: body.includeRecentDiaries === true ? 'ok' : 'skipped',
    message: body.includeRecentDiaries === true ? `经本人授权，读取目标日期往前7天内的${rows.length}篇本人日记。` : '未获明确授权，未读取近期日记。',
    sourceIds: sources.map(s => s.id),
  });
  const generated = await draftDiary({ message, date, sources: rows.map(r => ({ id: r.id, date: r.date_key, text: r.text })) });
  const text = requiredText(generated.text, '草稿内容', 5000);
  const id = randomUUID();
  await query(`INSERT INTO ai_diary_drafts
    (id, user_id, date_key, text, sources_json, provider, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE))`,
  [id, uid, date, text, JSON.stringify(sources), generated.provider]);
  trace.push({ step: 'draft', status: generated.fallback ? 'fallback' : 'ok',
    message: generated.provider === 'local'
      ? '已用本地规则保留原话；这不是大模型生成。草稿待本人确认，尚未保存为日记。'
      : '已整理为待确认草稿，尚未保存为日记。' });
  return { draft: await getDraft(uid, id), trace, provider: generated.provider, care: null };
}

async function lockedDraft(conn, uid, id) {
  const [rows] = await conn.execute(`${DRAFT_SELECT} WHERE id = ? AND user_id = ? FOR UPDATE`, [id, uid]);
  if (!rows[0]) throw new ApiError('草稿不存在', 404);
  return rows[0];
}

function confirmResult(row, diaryId, text, isPublic = false) {
  return { draftId: row.id, diaryId, date: row.date_key, url: diaryUrl(row.date_key),
    status: 'confirmed', isPublic, care: careFor(text) };
}

export async function confirmDraft(uid, id, body = {}) {
  assertId(id);
  const edited = Object.hasOwn(body, 'text') ? requiredText(body.text, '日记内容', 5000) : undefined;
  try {
    return await transaction(async conn => {
      const row = await lockedDraft(conn, uid, id);
      if (row.status === 'confirmed') {
        const [diaries] = await conn.execute('SELECT id, text, is_public FROM diaries WHERE id = ? AND user_id = ?', [row.diary_id, uid]);
        if (!diaries[0]) throw new ApiError('已确认的日记已不存在', 410);
        return confirmResult(row, diaries[0].id, diaries[0].text, Boolean(diaries[0].is_public));
      }
      if (row.status === 'cancelled') throw new ApiError('草稿已取消', 409);
      if (row.is_expired) throw new ApiError('草稿已过期，请重新准备', 410);

      // Serialize different drafts from the same owner. The diary unique key is
      // still the final safeguard against writers using other diary endpoints.
      await conn.execute('SELECT id FROM users WHERE id = ? FOR UPDATE', [uid]);
      const [existing] = await conn.execute('SELECT id FROM diaries WHERE user_id = ? AND date_key = ?', [uid, row.date_key]);
      if (existing.length) throw new ApiError('这一天已经有日记，请打开原日记查看；草稿不会覆盖它', 409);
      const text = edited ?? row.text;
      const [result] = await conn.execute('INSERT INTO diaries (user_id, date_key, text, is_public) VALUES (?, ?, ?, 0)', [uid, row.date_key, text]);
      await conn.execute("UPDATE ai_diary_drafts SET status = 'confirmed', diary_id = ?, text = ?, confirmed_at = UTC_TIMESTAMP(3) WHERE id = ? AND user_id = ?", [result.insertId, text, id, uid]);
      return confirmResult(row, result.insertId, text);
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new ApiError('这一天已经有日记，未覆盖原日记', 409);
    throw e;
  }
}

export async function cancelDraft(uid, id) {
  assertId(id);
  await transaction(async conn => {
    const row = await lockedDraft(conn, uid, id);
    if (row.status === 'confirmed') throw new ApiError('草稿已经确认，不能取消', 409);
    if (row.status === 'cancelled') return;
    if (row.is_expired) throw new ApiError('草稿已过期', 410);
    await conn.execute("UPDATE ai_diary_drafts SET status = 'cancelled' WHERE id = ? AND user_id = ?", [id, uid]);
  });
  return getDraft(uid, id);
}
