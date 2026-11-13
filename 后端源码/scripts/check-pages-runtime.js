// ============================================================
//  页面运行时检查：用假 DOM 在 Node 里真跑一遍每个页面的脚本
//
//  用法：  node scripts/check-pages-runtime.js <前端目录>
//
//  ★ 为什么需要这个 ★
//    check-frontend.js 只做"语法检查"和"API 方法是否存在"。
//    它能保证"不会因为语法错而白屏"，但抓不到运行时的错，比如：
//      · getElementById 返回 null 然后 .textContent = xxx
//      · 调用一个不存在的函数
//      · 顶层代码里访问了未定义的变量
//    这些错误在浏览器里就是"页面卡住/空白"，而且只有打开页面才看得到。
//
//  ★ 怎么做的 ★
//    造一个"什么都接受"的假 DOM（任何属性、任何方法调用都不报错），
//    加上真实的 fetch（真的打后端），然后把页面里的内联脚本跑一遍。
//    只要脚本没抛异常，就说明"至少能跑起来"。
//
//  ★ 它的局限（必须说清楚）★
//    假 DOM 不会真的渲染，所以：
//      · 拿不到"页面长得对不对"
//      · 列表为空时，渲染循环不会执行，里面的 bug 抓不到
//    它只回答一个问题：**这个页面的脚本能不能跑起来、不被异常打断**。
//    真正的视觉和交互还是要人打开浏览器看。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FRONTEND = process.argv[2] || 'D:/Study/Match/2026-2027.up/chat/九稿';
const BASE = process.argv[3] || 'http://127.0.0.1:3000';

// 预置的登录态（跑页面脚本前会真的登录一次拿 token）
//
// ★ 为什么必须预置 ★
//   大多数页面开头有 `if (!API.requireLogin()) throw new Error('未登录')`。
//   假 localStorage 是空的 → 这些页面直接抛异常 → 全部被计为"失败"。
//   但这不是页面坏了，是"没登录时的正常行为"。
//   所以先真登录一次，把 token 放进假 localStorage，页面按已登录状态跑。
let SEED_TOKEN = '';
let SEED_USER = null;

if (!fs.existsSync(FRONTEND)) {
  console.error('找不到前端目录: ' + FRONTEND);
  process.exit(1);
}

// ------------------------------------------------------------
//  假 DOM
//
//  用 Proxy 让任何属性访问、任何方法调用都返回"另一个假元素"，
//  这样页面里的 document.xxx / el.yyy / el.classList.add(...) 都不会崩。
//  innerHTML / textContent 赋值会被记录下来，方便事后看有没有内容。
// ------------------------------------------------------------
function makeEl(tag = 'div') {
  const store = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '',
    textContent: '',
    value: '',
    src: '',
    className: '',
    style: {},
    dataset: {},
    children: [],
    _listeners: {},
  };

  const classList = {
    _set: new Set(),
    add(...c) { c.forEach(x => this._set.add(x)); },
    remove(...c) { c.forEach(x => this._set.delete(x)); },
    toggle(c, force) {
      if (force === undefined) {
        this._set.has(c) ? this._set.delete(c) : this._set.add(c);
      } else if (force) this._set.add(c);
      else this._set.delete(c);
    },
    contains(c) { return this._set.has(c); },
  };
  store.classList = classList;

  const handler = {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'appendChild') return (child) => { t.children.push(child); return child; };
      if (prop === 'append') return (...cs) => { t.children.push(...cs); };
      if (prop === 'removeChild') return () => {};
      if (prop === 'remove') return () => {};
      if (prop === 'insertBefore') return (c) => c;
      if (prop === 'replaceChild') return (c) => c;
      if (prop === 'addEventListener' || prop === 'removeEventListener') {
        return (ev, fn) => { (t._listeners[ev] = t._listeners[ev] || []).push(fn); };
      }
      if (prop === 'querySelector' || prop === 'querySelectorAll') {
        // querySelector 返回一个假元素（不是 null，避免页面崩）；
        // querySelectorAll 返回空数组（循环体不执行）
        if (prop === 'querySelector') return () => makeEl();
        return () => [];
      }
      if (prop === 'getAttribute') return () => null;
      if (prop === 'setAttribute') return () => {};
      if (prop === 'focus' || prop === 'blur' || prop === 'click'
        || prop === 'scrollIntoView' || prop === 'removeAttribute') {
        return () => {};
      }
      if (prop === 'closest') return () => makeEl();
      if (prop === 'insertAdjacentHTML') return () => {};
      if (prop === 'cloneNode') return () => makeEl(t.tagName);
      // 其它未知属性一律返回另一个假元素，避免 undefined.xxx 崩掉
      return makeEl();
    },
    set(t, prop, v) { t[prop] = v; return true; },
    has() { return true; },
  };

  return new Proxy(store, handler);
}

function makeDocument(elCache) {
  return {
    // ★ 按 id 缓存元素 ★
    //   同一个 id 多次 getElementById 要拿到同一个元素，
    //   否则页面先 setInnerHTML 再 appendChild 会写到两个不同的假元素上，
    //   我们就没法检查"到底渲没渲染出东西"。
    getElementById: (id) => {
      if (!elCache.has(id)) elCache.set(id, makeEl());
      return elCache.get(id);
    },
    createElement: (tag) => makeEl(tag),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    title: '',
    readyState: 'complete',
  };
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}

// ------------------------------------------------------------
//  抽取页面里的内联脚本
//  只取 <script> 没有 src 的那些（有 src 的是外部文件，单独处理）
// ------------------------------------------------------------
function extractInlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// ------------------------------------------------------------
//  跑一个页面
// ------------------------------------------------------------
async function runPage(file) {
  const full = path.join(FRONTEND, file);
  const html = fs.readFileSync(full, 'utf8');

  const inline = extractInlineScripts(html);
  if (inline.length === 0) return { file, skipped: true };

  // 加载 api.js（页面里所有接口调用都要靠它）
  const apiSrc = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8')
    .replace(/var BASE = '[^']*';/, `var BASE = '${BASE}';`);

  const sandboxLocal = makeStorage();
  const sandboxSession = makeStorage();
  const elCache = new Map();

  // 把真实登录态塞进去，让需要登录的页面能跑
  if (SEED_TOKEN) {
    sandboxLocal.setItem('pz_token', SEED_TOKEN);
    sandboxLocal.setItem('pz_user', JSON.stringify(SEED_USER));
  }

  const sandbox = {
    console,
    // ★ 定时器要特别处理，否则进程退不出去 ★
    //   页面里会有 setInterval 做动画（比如漂流瓶的漂移），
    //   真实的 setInterval 会让 Node 的事件循环永远活着，
    //   整个检查脚本就卡死了（我第一版就是这样，超时被杀）。
    //   所以：
    //     setInterval → 返回假 id，永不执行（动画不影响检查）
    //     setTimeout  → 用真实定时器，但缩短延迟并 unref（不阻止退出）
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, Math.min(Number(ms) || 0, 30));
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Promise, Error, JSON, Math, Date, Number, String, Array, Object, RegExp,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    fetch: globalThis.fetch,
    URLSearchParams,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    File: globalThis.File,
    FileReader: class {
      readAsDataURL() { if (this.onload) this.onload({ target: { result: 'data:image/png;base64,AA==' } }); }
    },
    alert: () => {},
    confirm: () => true,
    prompt: () => '',
    location: { href: '', pathname: file, search: '', replace: () => {} },
    history: { length: 1, back: () => {}, pushState: () => {}, replaceState: () => {} },
    navigator: { userAgent: 'node-check' },
    localStorage: sandboxLocal,
    sessionStorage: sandboxSession,
    document: makeDocument(elCache),
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  try {
    new vm.Script(apiSrc, { filename: 'api.js' }).runInContext(ctx);

    for (let i = 0; i < inline.length; i++) {
      new vm.Script(inline[i], { filename: `${file}#script${i + 1}` }).runInContext(ctx);
    }

    // 给异步逻辑一点时间跑完（页面大多是 IIFE + await）
    await new Promise(r => setTimeout(r, 120));

    // 看看几个关键容器里到底有没有东西
    //   （不是所有页面都有这些 id，有才算）
    const render = [];
    for (const [id, el] of elCache.entries()) {
      const kids = Array.isArray(el.children) ? el.children.length : 0;
      const html = typeof el.innerHTML === 'string' ? el.innerHTML.length : 0;
      const text = typeof el.textContent === 'string' ? el.textContent.length : 0;
      if (kids > 0 || html > 0 || text > 0) {
        render.push({ id, kids, html, text });
      }
    }

    return { file, ok: true, scripts: inline.length, render };
  } catch (e) {
    return { file, ok: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4).join('\n') };
  }
}

// ------------------------------------------------------------
(async () => {
  console.log('==============================================');
  console.log('  页面运行时检查（假 DOM，真 fetch）');
  console.log('  目录: ' + FRONTEND);
  console.log('  后端: ' + BASE);
  console.log('==============================================\n');

  const files = fs.readdirSync(FRONTEND).filter(f => f.endsWith('.html')).sort();

  // 先真登录一次，拿到 token —— 后面每个页面都按"已登录"跑
  try {
    const res = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', code: '123456' }),
    });
    const json = await res.json();
    if (json.code === 0) {
      SEED_TOKEN = json.data.token;
      SEED_USER = json.data.user;
      console.log(`  已登录：${SEED_USER.nickname}（token 长度 ${SEED_TOKEN.length}）\n`);
    } else {
      console.log(`  ⚠️  登录失败：${json.msg}\n`);
      console.log('     需要登录的页面会报"未登录"，这不算页面坏。\n');
    }
  } catch (e) {
    console.log('  ⚠️  连不上后端：' + e.message + '\n');
  }

  let okCount = 0;
  const failed = [];
  const skipped = [];

  for (const f of files) {
    const r = await runPage(f);
    if (r.skipped) {
      console.log(`  \x1b[2m− ${f}（没有内联脚本）\x1b[0m`);
      skipped.push(f);
    } else if (r.ok) {
      const detail = (r.render || [])
        .map(x => {
          const parts = [];
          if (x.kids > 0) parts.push(`子元素${x.kids}`);
          if (x.html > 0) parts.push(`innerHTML ${x.html}字`);
          if (x.text > 0) parts.push(`文本${x.text}字`);
          return `${x.id}(${parts.join('/')})`;
        })
        .slice(0, 5)
        .join('  ');

      console.log(`  \x1b[32m✅\x1b[0m ${f}（${r.scripts} 段脚本跑通）`);
      if (detail) console.log(`       \x1b[2m渲染: ${detail}\x1b[0m`);
      okCount++;
    } else {
      console.log(`  \x1b[31m❌\x1b[0m ${f} —— ${r.error}`);
      if (r.stack) console.log(`     \x1b[2m${r.stack.split('\n')[1] || ''}\x1b[0m`);
      failed.push({ file: f, error: r.error });
    }
  }

  console.log('\n==============================================');
  console.log(`  跑通 ${okCount} 个页面，失败 ${failed.length} 个，跳过 ${skipped.length} 个`);
  console.log('==============================================');

  if (failed.length === 0) {
    console.log('\n  🎉 所有页面都能跑起来（没有运行时异常）\n');
    console.log('  注意：这只证明"脚本不会崩"，不代表画面完美。');
    console.log('        视觉和交互还是要人打开浏览器看。\n');
    process.exit(0);
  } else {
    console.log('\n  失败的页面：');
    failed.forEach((f, i) => console.log(`    ${i + 1}. ${f.file} —— ${f.error}`));
    console.log('');
    process.exit(1);
  }
})();
