// Single-process, per-user ordering. In a multi-worker deployment replace this
// with shared locking/version storage before enabling persistent chat.
const sessions = new Map();

function retain(userId) {
  let session = sessions.get(userId);
  if (!session) {
    session = { tail: Promise.resolve(), references: 0, version: 0, summaryRunning: false };
    sessions.set(userId, session);
  }
  session.references++;
  return session;
}

function release(userId, session) {
  session.references--;
  if (session.references === 0 && sessions.get(userId) === session) sessions.delete(userId);
}

export async function withAiSession(userId, operation) {
  const session = retain(userId);
  const result = session.tail.then(() => operation(session));
  // A rejected request must not poison the following clear/chat operation.
  session.tail = result.catch(() => {});
  try { return await result; }
  finally { release(userId, session); }
}

// Keep the same version object alive while remote summarization runs outside
// the queue. Snapshot reads and conditional publication still enter the queue.
export function startAiSummary(userId, session, operation) {
  if (session.summaryRunning) return;
  session.summaryRunning = true;
  retain(userId);
  const version = session.version;
  setImmediate(() => {
    Promise.resolve().then(() => operation(version)).catch(() => {
      // Summaries are optional. Never log model bodies, keys or private text.
      console.warn('AI memory summary could not be updated');
    }).finally(() => {
      session.summaryRunning = false;
      release(userId, session);
    });
  });
}
