// ============================================================
//  检查前端所有 HTML 里的内联 <script> 语法
//
//  用法：  node scripts/check-frontend.js
//
//  为什么需要这个：
//    改完 HTML 不打开浏览器的话，JS 里少个括号、多了个逗号
//    根本发现不了，页面会静默白屏。这个脚本把每段内联脚本
//    抠出来交给 Node 做语法检查，几秒钟就能定位问题。
//
//  另外它也顺手做几件"体力活"检查：
//    - <script> 开闭标签是否配对
//    - 页面对后端接口的调用，是否都真的存在于 api.js
//    - 有没有残留的旧 localStorage 键（说明还没接后端）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// 前端目录可以用命令行参数指定（默认是八稿）
//   node scripts/check-frontend.js                 → 检查 前端八稿
//   node scripts/check-frontend.js ".../九稿"      → 检查 九稿
const FRONTEND = process.argv[2] || 'D:/Study/Match/2026-2027.up/chat/前端八稿';

let pass = 0, fail = 0, warn = 0;
const problems = [];

const ok = (m) => { console.log(`  \x1b[32m✅\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m❌\x1b[0m ${m}`); fail++; problems.push(m); };
const warnIt = (m) => { console.log(`  \x1b[33m⚠️\x1b[0m  ${m}`); warn++; };

if (!fs.existsSync(FRONTEND)) {
  console.error('找不到前端目录: ' + FRONTEND);
  process.exit(1);
}

const htmlFiles = fs.readdirSync(FRONTEND).filter(f => f.endsWith('.html')).sort();

console.log('==============================================');
console.log('  前端 HTML 内联脚本检查');
console.log('  目录: ' + FRONTEND);
console.log('  共 ' + htmlFiles.length + ' 个 html 文件');
console.log('==============================================');

// ============================================================
//  加载 api.js，拿到【真实的】API 对象结构
//
//  一开始我用正则去猜方法名，结果漏掉了 toast、handleError、
//  requireLogin 这些（它们在对象字面量里以 `toast: toast,` 这种
//  简写形式出现，正则匹配不到），导致误报一堆"方法不存在"。
//  检查器不准比没有更糟 —— 所以改成直接把 api.js 跑在沙箱里，
//  然后 Reflect.ownKeys 内省真实的键，这才是唯一可靠的来源。
// ============================================================
function loadApiObject() {
  const src = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8');

  const sandbox = {
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.reject(new Error('检查阶段不发请求')),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams,
    location: { href: '', pathname: 'x.html', search: '' },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {} }),
      body: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  new vm.Script(src, { filename: 'api.js' }).runInContext(ctx);
  return ctx.API;
}

/** 递归收集 API 对象上所有可调用的路径，如 auth.isLoggedIn */
function collectApiPaths(obj, prefix, out) {
  out = out || new Set();
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key !== 'string') continue;
    const val = obj[key];
    const full = prefix ? prefix + '.' + key : key;
    out.add(full);
    if (val && typeof val === 'object') {
      collectApiPaths(val, full, out);
    }
  }
  return out;
}

const apiObject = loadApiObject();
const apiPaths = collectApiPaths(apiObject);
// 顶层方法名也放进一个集合，方便判断 API.xxx 这种调用
const apiTopLevel = new Set(Object.keys(apiObject));

// ============================================================
//  逐个文件检查
// ============================================================
for (const file of htmlFiles) {
  const full = path.join(FRONTEND, file);
  const html = fs.readFileSync(full, 'utf8');

  console.log(`\n─────────────  ${file}  ─────────────`);

  // ---- 1. script 标签配对 ----
  const openTags = (html.match(/<script\b[^>]*>/g) || []).length;
  const closeTags = (html.match(/<\/script>/g) || []).length;
  if (openTags === closeTags) {
    ok(`<script> 标签配对（${openTags} 个）`);
  } else {
    bad(`${file}: <script> 不配对 —— 开 ${openTags} 个，闭 ${closeTags} 个`);
  }

  // ---- 2. 抠出内联脚本（只要没有 src 属性的）----
  const inlineScripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;   // 外链脚本跳过
    if (body.trim()) inlineScripts.push(body);
  }

  // ---- 3. 逐个做语法检查 ----
  if (inlineScripts.length === 0) {
    warnIt(`${file}: 没有内联脚本`);
  } else {
    inlineScripts.forEach((code, i) => {
      try {
        // 只编译不执行：能抓语法错误，且不会真的跑起来
        new vm.Script(code, { filename: `${file}#inline${i + 1}` });
        ok(`内联脚本 #${i + 1} 语法正确（${code.split('\n').length} 行）`);
      } catch (e) {
        bad(`${file} 内联脚本 #${i + 1} 语法错误: ${e.message}`);
      }
    });
  }

  // ---- 4. 检查引用的外链脚本文件是否存在 ----
  for (const s of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) {
    const src = s[1];
    if (/^https?:/.test(src)) continue;
    if (fs.existsSync(path.join(FRONTEND, src))) {
      ok(`引用的 ${src} 文件存在`);
    } else {
      bad(`${file} 引用了不存在的文件: ${src}`);
    }
  }

  // ---- 5. 检查 API 调用是否真实存在 ----
  // 先把页面里所有 API.xxx( 和 API.xxx.yyy( 抠出来
  const apiCalls = new Set();
  for (const c of html.matchAll(/API\.(\w+)\.(\w+)\s*\(/g)) {
    apiCalls.add(`${c[1]}.${c[2]}`);
  }
  // API.xxx( 但要排除掉已经被上一条匹配过的（即后面有 .yyy 的）
  for (const c of html.matchAll(/API\.(\w+)\s*\(/g)) {
    const name = c[1];
    apiCalls.add(name);
  }
  if (apiCalls.size > 0) {
    const unknown = [];
    for (const call of apiCalls) {
      // 用内省出来的真实路径判断
      if (call.includes('.')) {
        if (!apiPaths.has(call)) unknown.push(call);
      } else {
        if (!apiTopLevel.has(call)) unknown.push(call);
      }
    }
    if (unknown.length === 0) {
      ok(`调用的 API 方法都存在（${[...apiCalls].join(', ')}）`);
    } else {
      bad(`${file} 调用了 api.js 里不存在的方法: ${unknown.join(', ')}`);
    }
  }

  // ---- 6. 是否已接入后端 ----
  const usesApi = /API\./.test(html);
  const hasApiScript = /src\s*=\s*["']api\.js["']/.test(html);
  if (usesApi && !hasApiScript) {
    bad(`${file} 用了 API.xxx 但没引入 api.js`);
  }
}

// ============================================================
//  全局检查：还没接后端的页面列出来
// ============================================================
console.log('\n==============================================');
console.log('  接入进度总览');
console.log('==============================================');

// ★ 判断"接入了没"不能只看有没有写 API.xxx。
//   有些页面是通过 data.js 的适配函数拿数据的（比如 discover.html 用 fetchData），
//   那也是接入了后端，只是没直接写 API. 前缀。
//   第一版就是只查 API.，结果把 discover.html 误报成"没接入"。
const DATA_LAYER_FNS = [
  'fetchData', 'getById', 'getByNick', 'getByUserId',
  'getLikedDiaries', 'getSavedDiaries', 'getFollowedDiaries',
  'getMyFollows', 'getMyFans', 'getUserStats',
  'toggleLike', 'toggleSave', 'toggleFollow', 'toggleFollowByUid',
];

function isWired(html) {
  if (/API\./.test(html)) return true;
  if (/src\s*=\s*["']api\.js["']/.test(html)) return true;
  // 用了 data.js 里的适配函数也算接入
  return DATA_LAYER_FNS.some(fn => new RegExp(`\\b${fn}\\s*\\(`).test(html));
}

const wired = [];
const notYet = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
  (isWired(html) ? wired : notYet).push(file);
}

console.log('\n已接入后端的页面：');
wired.forEach(f => console.log(`  ✅ ${f}`));
console.log(`\n还没接入的页面（后续步骤处理）：`);
if (notYet.length === 0) console.log('  （全部接完了）');
else notYet.forEach(f => console.log(`  ⬜ ${f}`));

// ============================================================
//  检查残留的旧 localStorage 键
// ============================================================
console.log('\n==============================================');
console.log('  残留的 localStorage（需要后续步骤替换）');
console.log('==============================================\n');

const oldKeys = [
  'diary_entries', 'user_profile', 'my_likes', 'my_saves',
  'my_follows', 'my_bottles', 'my_bless_sent',
];

let anyLeft = false;
for (const file of [...htmlFiles, 'data.js', 'api.js']) {
  const full = path.join(FRONTEND, file);
  if (!fs.existsSync(full)) continue;
  const content = fs.readFileSync(full, 'utf8');

  // ★ 必须先去掉注释再匹配。
  //   否则"原来：存在浏览器 localStorage 的 user_profile"这种
  //   说明性注释会被当成真实残留，造成误报（我踩过一次）。
  const codeOnly = content
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  const found = oldKeys.filter(k => codeOnly.includes(k));
  if (found.length) {
    anyLeft = true;
    console.log(`  ${file}: ${found.join(', ')}`);
  }
}
if (!anyLeft) console.log('  ✅ 没有残留（所有本地存储都已换成后端接口）');

// ============================================================
console.log('\n==============================================');
console.log(`  通过 \x1b[32m${pass}\x1b[0m   警告 \x1b[33m${warn}\x1b[0m   失败 \x1b[31m${fail}\x1b[0m`);
console.log('==============================================');

if (fail > 0) {
  console.log('\n必须修的问题：');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');
  process.exit(1);
}
console.log('');
process.exit(0);
