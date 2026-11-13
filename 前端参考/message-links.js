(function (root) {
  'use strict';
  // Message text is untrusted, including the optional navigation marker.
  function parseMessageLink(value) {
    const text = String(value == null ? '' : value);
    const match = text.match(/^([\s\S]*)\n\[跳转\] (diary-public\.html\?id=[1-9]\d*|bless-sent\.html\?type=received)$/);
    if (!match) return { text, href: null, label: null };
    return { text: match[1].trim(), href: match[2],
      label: match[2].startsWith('bless-sent.html') ? '去看看' : '查看这条评论' };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseMessageLink };
  else root.parseMessageLink = parseMessageLink;
})(typeof globalThis === 'undefined' ? window : globalThis);
