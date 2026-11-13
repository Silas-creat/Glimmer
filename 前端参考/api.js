// 统一请求封装：所有页面都通过它调后端
// 好处：token 只在这里维护，401 只在一个地方处理
//
// 关于地址：页面可能从 file:// 打开、也可能被 Live Server 之类的工具跑在 5500 端口，
// 这些情况下 location.origin 都不是后端地址。所以下面按“候选地址”依次尝试，
// 哪个返回 JSON 就用哪个，并记住结果。

const TOKEN_KEY = 'wg_token';
const USER_KEY = 'wg_user';

const API_CANDIDATES = (function () {
  const list = [];
  const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  // 1) 同源：用后端自己托管页面时就是这个（http://localhost:3000/login.html）
  if (isHttp) list.push(location.origin + '/api');
  // 2) 后端默认端口
  list.push('http://localhost:3000/api');
  list.push('http://127.0.0.1:3000/api');
  // 去重
  return list.filter((v, i) => list.indexOf(v) === i);
})();

let API_BASE = API_CANDIDATES[0];

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (e) {}
}

function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
}

function setUser(user) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user || null)); } catch (e) {}
}

// 需要登录的页面开头调这个：没有 token 直接回登录页
function requireLogin() {
  if (!getToken()) {
    location.href = 'login.html';
    return false;
  }
  return true;
}

async function rawFetch(base, path, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(base + path, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return { __notJson: true, status: res.status, text: text.slice(0, 80) };
  }
  return { status: res.status, payload };
}

/**
 * api('/diary/public')
 * api('/diary', { method: 'POST', body: { content: '...' } })
 * 返回：{ code, msg, data }
 */
async function api(path, options = {}) {
  const { method = 'GET', body = null, silent401 = false } = options;

  // 先试当前记住的地址，不行再换候选地址
  const order = [API_BASE].concat(API_CANDIDATES.filter((b) => b !== API_BASE));
  let lastError = null;

  for (const base of order) {
    let r;
    try {
      r = await rawFetch(base, path, method, body);
    } catch (e) {
      lastError = { code: -1, msg: '连不上后端服务（' + base + '）', data: null };
      continue;
    }

    if (r.__notJson) {
      // 说明这个地址背后不是我们的后端（比如 Live Server 返回了 404 页面）
      lastError = { code: -1, msg: '接口地址不对：' + base + ' 返回的不是接口数据', data: null };
      continue;
    }

    API_BASE = base; // 记住能用的地址
    const payload = r.payload;

    if (r.status === 401 && !silent401) {
      clearToken();
      // 记住原因（比如「你的账号在另一台设备登录了」），登录页会读出来
      try { sessionStorage.setItem('wg_401', (payload && payload.msg) || ''); } catch (e) {}
      location.href = 'login.html';
      return payload;
    }
    return payload;
  }

  return lastError || { code: -1, msg: '网络不太好，请稍后再试', data: null };
}

// 调试用：在控制台执行 apiBase() 能看到当前用的是哪个地址
function apiBase() {
  return API_BASE;
}
