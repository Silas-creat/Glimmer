import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseMessageLink } = require('../../前端参考/message-links.js');

test('only the two supported local notification destinations become links', () => {
  assert.deepEqual(parseMessageLink('给你一条留言\n[跳转] diary-public.html?id=42'), {
    text: '给你一条留言', href: 'diary-public.html?id=42', label: '查看这条评论',
  });
  assert.equal(parseMessageLink('祝福\n[跳转] bless-sent.html?type=received').label, '去看看');
});

test('untrusted navigation remains plain text', () => {
  for (const href of ['javascript:alert(1)', 'https://example.com', '//example.com',
    'diary-public.html?id=1&redirect=https://example.com', 'diary-public.html?id=0',
    'diary-public.html?id=1#x', 'diary-public.html?id=1\n[跳转] javascript:alert(1)',
    '../diary-public.html?id=1', 'bless-sent.html?type=sent']) {
    const text = '内容\n[跳转] ' + href;
    assert.deepEqual(parseMessageLink(text), { text, href: null, label: null });
  }
});
