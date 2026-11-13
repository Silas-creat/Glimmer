import { transaction } from '../db/index.js';

// For already-authorized comment/blessing actions only; this is not an HTTP
// send endpoint. Delivery and its unread counter form one transaction.
export async function sendDirectMessage(fromId, toId, content, { diaryId = null } = {}) {
  const a = Number(fromId), b = Number(toId);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a <= 0 || b <= 0 || a === b) return null;
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) return null;
  const [x, y] = a < b ? [a,b] : [b,a];
  return transaction(async conn => {
    if (diaryId !== null) {
      // Lock the source until delivery commits; private diaries never cause an
      // outbound mention to a recipient who cannot view them.
      const [sources] = await conn.execute('SELECT id, user_id, is_public FROM diaries WHERE id = ? FOR SHARE', [diaryId]);
      if (!sources[0] || (!sources[0].is_public && Number(sources[0].user_id) !== b)) return null;
    }
    await conn.execute('INSERT INTO conversations (user_a, user_b) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [x,y]);
    const [rows] = await conn.execute('SELECT id, blocked_by FROM conversations WHERE user_a = ? AND user_b = ? FOR UPDATE', [x,y]);
    const conv = rows[0];
    if (!conv || conv.blocked_by !== null) return null;
    await conn.execute("INSERT INTO messages (conv_id, from_user, to_user, content, is_read, status) VALUES (?, ?, ?, ?, 0, 'normal')", [conv.id,a,b,text]);
    const recipientSide = x === b ? 'a' : 'b';
    await conn.execute(`UPDATE conversations SET last_msg = ?, last_from = ?, last_time = NOW(3),
      unread_${recipientSide} = unread_${recipientSide} + 1,
      deleted_by_a = NULL, deleted_by_b = NULL WHERE id = ?`, [text.slice(0,100),a,conv.id]);
    // Automated activity does not mean the sender has read their inbox.
    return conv.id;
  });
}

// The originating comment/blessing is already committed; an optional delivery
// failure must not tell the client that it needs to submit that action again.
export async function trySendDirectMessage(...args) {
  try { return await sendDirectMessage(...args); }
  catch { console.warn('互动私信提示未送达，原操作已保存。'); return null; }
}
