(function (root) {
  'use strict';

  const MAX_MESSAGE_LENGTH = 2000;
  const MAX_HISTORY_ITEMS = 16;

  function normalizeMessage(value) {
    const message = typeof value === 'string' ? value.trim() : '';
    if (!message) throw new Error('先说点什么吧');
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error('一次最多 2000 字，可以分开说');
    return message;
  }

  function createChat(request, remember) {
    let history = [];
    let pending = false;
    let generation = 0;
    const saved = remember === true;

    const session = {
      get generation() { return generation; },
      invalidate() { generation += 1; return generation; },
      isStale(token) { return token !== generation; },
      reset() { generation += 1; history = []; return session; },
      async send(value) {
        if (pending) throw new Error('正在回复，请稍等一下');
        const message = normalizeMessage(value);
        pending = true;
        const generationAtSend = generation;
        try {
          // Temporary mode sends this page's recent context; saved mode never
          // mixes the temporary page history into the account history.
          const body = saved
            ? { message, remember: true, history: [] }
            : { message, remember: false, history: history.slice(-MAX_HISTORY_ITEMS) };
          const options = { method: 'POST', body };
          if (saved) options.silent401 = true;
          const result = await request('/ai/chat', options);
          if (!result || result.code !== 0) {
            const error = new Error(result?.msg || '暂时没有收到回复，请稍后重试');
            error.code = result?.code;
            error.care = result?.data?.care || null;
            throw error;
          }
          const reply = result.data?.reply?.content;
          if (typeof reply !== 'string' || !reply.trim()) throw new Error('回复暂时为空，请稍后重试');
          if (!saved && generation === generationAtSend) {
            // Display the full reply, but keep the next request within the API's
            // per-message history limit. Do not split a UTF-16 surrogate pair.
            const contextReply = reply.slice(0, MAX_MESSAGE_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
            history.push({ role: 'user', content: message }, { role: 'assistant', content: contextReply });
            history = history.slice(-MAX_HISTORY_ITEMS);
          }
          return result.data;
        } finally {
          pending = false;
        }
      },
    };
    return session;
  }

  function createTemporaryChat(request) {
    return createChat(request, false);
  }

  function createSavedChat(request) {
    return createChat(request, true);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createTemporaryChat, createSavedChat };
  } else {
    root.createTemporaryChat = createTemporaryChat;
    root.createSavedChat = createSavedChat;
  }
})(typeof globalThis === 'undefined' ? window : globalThis);