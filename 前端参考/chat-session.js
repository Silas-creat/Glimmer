(function (root) {
  'use strict';

  // Temporary context lives only in this page. The API is always told not to
  // load or persist personal memory, even when the user is signed in.
  function createTemporaryChat(request) {
    let history = [];
    let pending = false;

    return {
      async send(value) {
        if (pending) throw new Error('正在回复，请稍等一下');
        const message = typeof value === 'string' ? value.trim() : '';
        if (!message) throw new Error('先说点什么吧');
        if (message.length > 2000) throw new Error('一次最多 2000 字，可以分开说');
        pending = true;
        try {
          const result = await request('/ai/chat', {
            method: 'POST',
            body: { message, remember: false, history: history.slice(-16) },
          });
          if (!result || result.code !== 0) {
            const error = new Error(result?.msg || '暂时没有收到回复，请稍后重试');
            error.care = result?.data?.care || null;
            throw error;
          }
          const reply = result.data?.reply?.content;
          if (typeof reply !== 'string' || !reply.trim()) throw new Error('回复暂时为空，请稍后重试');
          // Display the full reply, but keep the next request within the API's
          // per-message history limit. Do not split a UTF-16 surrogate pair.
          const contextReply = reply.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, '');
          history.push({ role: 'user', content: message }, { role: 'assistant', content: contextReply });
          history = history.slice(-16);
          return result.data;
        } finally {
          pending = false;
        }
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createTemporaryChat };
  else root.createTemporaryChat = createTemporaryChat;
})(typeof globalThis === 'undefined' ? window : globalThis);
