// ============================================================
//  页面运行时检查：用假 DOM 在 Node 里真跑一遍每个页面的脚本
//
//  用法：node scripts/check-pages-runtime.js [前端目录] --base http://127.0.0.1:3001 --phone <合成测试手机号> --code <验证码>
//  会登录并执行页面初始化请求；必须显式指定隔离后端和测试账号。
//
//  ★ 为什么需要这个 ★
//    check-frontend.js 只做"语法检查"和"API 方法是否存在"。
//    它能检查脚本语法，但抓不到运行时的错，比如：
//      · 调用一个不存在的函数
//      · 顶层代码里访问了未定义的变量
//    这些错误在浏览器里就是"页面卡住/空白"，而且只有打开页面才看得到。
//
//  ★ 怎么做的 ★
//    造一个"什么都接受"的假 DOM（任何属性、任何方法调用都不报错），
//    加上受限 fetch（只打指定后端），按 HTML 顺序执行本地与内联脚本。
//
//  ★ 它的局限（必须说清楚）★
//    假 DOM 不会真的渲染，所以：
//      · 拿不到"页面长得对不对"
//      · 列表为空时，渲染循环不会执行，里面的 bug 抓不到
//      · 缺少真实 DOM 元素和事件交互引起的错误可能被假 DOM 隐藏
//    它只检查已执行的初始化路径，不能保证整个页面运行正确。
//    真正的视觉和交互还是要人打开浏览器看。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!['--base', '--phone', '--code'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('参数无效: ' + arg);
    }
    if (options[arg]) throw new Error('参数重复: ' + arg);
    options[arg] = args[++i];
  }
  if (positional.length > 2 || (positional[1] && options['--base'])) throw new Error('后端地址只能指定一次');
  const rawBase = options['--base'] || positional[1];
  if (!rawBase || !options['--phone'] || !options['--code']) {
    throw new Error('必须显式指定 --base、--phone 和 --code；请使用隔离测试后端与合成账号，不会自动登录现有 3000 实例');
  }
  const base = new URL(rawBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('--base 必须是无凭证、路径和查询参数的 HTTP(S) origin');
  }
  if (!/^1\d{10}$/.test(options['--phone']) || !/^\d{6}$/.test(options['--code'])) throw new Error('测试手机号或验证码格式不正确');
  return { frontend: path.resolve(positional[0] || path.join(ROOT, '..', '前端参考')), base: base.origin, phone: options['--phone'], code: options['--code'] };
}
let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }
const FRONTEND = options.frontend;
const BASE = options.base;

// 禁止跨 origin 和自动重定向，API 的默认端口 fallback 也不能触碰另一实例。
async function targetFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, BASE);
  if (url.origin !== BASE || url.username || url.password) throw new Error('已阻止访问非测试后端: ' + url.origin);
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
}

// 预置的登录态（跑页面脚本前会真的登录一次拿 token）
//
// ★ 为什么必须预置 ★
//   页面会通过 requireLogin() 或 getToken() 检查登录状态。
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
//  按文档顺序抽取本地外链及内联脚本；远程脚本明确报未覆盖。
// ------------------------------------------------------------
function extractPageScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (src) {
      if (/^(?:https?:)?\/\//i.test(src[1])) throw new Error('假 DOM 检查不执行远程脚本: ' + src[1]);
      const full = path.resolve(FRONTEND, src[1]);
      const relative = path.relative(FRONTEND, full);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('脚本路径越出前端目录: ' + src[1]);
      out.push({ name: src[1], code: fs.readFileSync(full, 'utf8') });
    } else if (m[2].trim()) {
      out.push({ name: 'inline' + (out.length + 1), code: m[2] });
    }
  }
  return out;
}

// ------------------------------------------------------------
//  跑一个页面
// ------------------------------------------------------------
async function runPage(file) {
  const full = path.join(FRONTEND, file);
  const html = fs.readFileSync(full, 'utf8');

  let scripts;
  try { scripts = extractPageScripts(html); }
  catch (error) { return { file, ok: false, error: error.message }; }
  if (scripts.length === 0) return { file, skipped: true };

  const sandboxLocal = makeStorage();
  const sandboxSession = makeStorage();
  const elCache = new Map();

  // 把真实登录态塞进去，让需要登录的页面能跑
  if (SEED_TOKEN) {
    sandboxLocal.setItem('wg_token', SEED_TOKEN);
    sandboxLocal.setItem('wg_user', JSON.stringify(SEED_USER));
  }

  const asyncErrors = [];
  const pending = new Set();
  const timers = new Set();
  const captureError = error => asyncErrors.push(error instanceof Error ? error : new Error(String(error)));

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
      const t = setTimeout(() => {
        timers.delete(t);
        try { Promise.resolve(fn()).catch(captureError); } catch (error) { captureError(error); }
      }, Math.min(Number(ms) || 0, 30));
      timers.add(t);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    Promise, Error, JSON, Math, Date, Number, String, Array, Object, RegExp,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    fetch: (input, init) => {
      const request = targetFetch(input, init).then(async response => {
        // 等待响应体，不能只收到响应头就把初始化请求算作结束。
        const body = await response.arrayBuffer();
        return new Response([204, 205, 304].includes(response.status) ? null : body, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      }).catch(error => { captureError(error); throw error; });
      pending.add(request);
      request.then(() => pending.delete(request), () => pending.delete(request));
      return request;
    },
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
    location: { href: BASE + '/' + file, pathname: '/' + file, search: '', protocol: new URL(BASE).protocol, origin: BASE, replace: () => {} },
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

  process.on('unhandledRejection', captureError);
  try {
    for (const script of scripts) {
      new vm.Script(script.code, { filename: `${file}#${script.name}` }).runInContext(ctx, { timeout: 1000 });
    }

    // 有界等待初始化请求；失败不能被页面的兜底逻辑吞掉后算通过。
    const deadline = Date.now() + 6000;
    do {
      await new Promise(r => setTimeout(r, 120));
    } while ((pending.size || timers.size) && Date.now() < deadline);
    if (pending.size || timers.size) throw new Error('页面初始化超过 6 秒，检查未完成');
    if (asyncErrors.length) throw asyncErrors[0];

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

    return { file, ok: true, scripts: scripts.length, render };
  } catch (e) {
    return { file, ok: false, error: e.message, stack: String(e.stack || '').split('\n').slice(0, 4).join('\n') };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    process.removeListener('unhandledRejection', captureError);
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
    const res = await targetFetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: options.phone, code: options.code }),
    });
    const json = await res.json();
    if (res.ok && json.code === 0 && json.data?.token && json.data?.user) {
      SEED_TOKEN = json.data.token;
      SEED_USER = json.data.user;
      console.log('  合成测试账号登录成功\n');
    } else {
      throw new Error('测试账号登录失败（HTTP ' + res.status + '）');
    }
  } catch (e) {
    console.error('  检查未执行：' + e.message + '\n');
    process.exit(1);
  }

  let okCount = 0;
  const failed = [];
  const skipped = [];

  for (const f of files) {
    const r = await runPage(f);
    if (r.skipped) {
      console.log(`  \x1b[2m− ${f}（没有脚本）\x1b[0m`);
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

  if (failed.length === 0 && okCount > 0) {
    console.log('\n  已执行页面在假 DOM 下的初始化检查通过。\n');
    console.log('  未执行事件交互、真实渲染或浏览器验收；不能据此宣称端到端通过。\n');
    process.exit(0);
  } else {
    console.log('\n  失败的页面：');
    failed.forEach((f, i) => console.log(`    ${i + 1}. ${f.file} —— ${f.error}`));
    console.log('');
    process.exit(1);
  }
})();
