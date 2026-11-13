// ============================================================
//  一键启动（给前端同学用）
//
//  用法：双击「一键启动.bat」，或：
//      node setup/start.js
//      node setup/start.js --port 8081 --no-open
//
//  ★ 它做三件事 ★
//    1. MySQL 没跑就拉起来
//    2. 后端没跑就起（node src/app.js）
//    3. 起一个静态服务托管 前端参考/，并把 /api、/uploads 转发给后端
//
//  ★ 端口被占用会自动往后找 ★
//    8080 被别的程序占着很常见（比如你已经开着一份）。
//    以前会直接退出让人自己去换端口，现在自动试 8080→8081→…，
//    并在窗口里告诉你实际用的是哪个。
// ============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(PKG_ROOT, '后端源码');
const FRONTEND_DIR = path.join(PKG_ROOT, '前端参考');

const BACKEND_PORT = 3000;

// ★ MySQL 端口从 后端源码/.env 里读 ★
//   安装脚本可能没用 3306（另装了一个独立实例时是 3307），
//   这里写死 3306 的话，启动时会去拉错的那个实例。
function readDbPort() {
  try {
    const env = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
    const m = env.match(/^DB_PORT=(.*)$/m);
    const n = m ? Number(String(m[1]).trim()) : 0;
    return Number.isFinite(n) && n > 0 ? n : 3306;
  } catch (e) { return 3306; }
}
const DB_PORT = readDbPort();

/** 数据目录：3306 用 data/，别的端口用 data-<端口>/（和安装脚本一致） */
function dataDirOf(port) {
  return port === 3306 ? path.join(MYSQL_HOME, 'data') : path.join(MYSQL_HOME, 'data-' + port);
}

// 端口参数：--port 8081 或 --port=8081
function readPortArg() {
  const eq = process.argv.find(a => a.startsWith('--port='));
  if (eq) return Number(eq.split('=')[1]) || 8080;
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) return Number(process.argv[i + 1]) || 8080;
  return 8080;
}
const START_PORT = readPortArg();
const NO_OPEN = process.argv.includes('--no-open');

const MYSQL_HOME = process.env.MYSQL_DIR || (fs.existsSync('D:\\') ? 'D:\\mysql' : path.join(os.homedir(), 'mysql'));
const MYSQL_NAME = 'mysql-8.0.28-winx64';
const MYSQLD = path.join(MYSQL_HOME, MYSQL_NAME, 'bin', 'mysqld.exe');

const c = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m' };
const ok = m => console.log('  ' + c.green + '✅' + c.reset + ' ' + m);
const warn = m => console.log('  ' + c.yellow + '⚠️ ' + c.reset + ' ' + m);
const bad = m => console.log('  ' + c.red + '❌' + c.reset + ' ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

// 问后端一句"数据库通不通"。
// 只检查端口会漏掉一种情况：MySQL 进程还在，但连接被拒（密码错、实例换了）。
// 这时后端是活的、页面能打开，一点「我的」就报"连不上 MySQL"，很难看出根因。
function checkHealth() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: BACKEND_PORT, path: '/api/health', timeout: 4000 }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          resolve(j && j.data && j.data.db ? j.data.db : { connected: false, error: 'health 返回结构不对' });
        } catch (e) {
          resolve({ connected: false, error: 'health 不是 JSON' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ connected: false, error: 'health 超时' }); });
    req.on('error', e => resolve({ connected: false, error: e.message }));
  });
}

function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const a = ni.address;
      if (a.startsWith('192.168.33.') || a.startsWith('192.168.220.')) continue;
      if (/^(26|25)\./.test(a)) continue;
      return a;
    }
  }
  return '127.0.0.1';
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';

  const filePath = path.join(FRONTEND_DIR, urlPath);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 找不到 ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 开发期一律不缓存：改了页面按一下刷新就能看到，
      // 不然浏览器会抱着旧的 index.html / api.js 不放。
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(buf);
  });
}

// ---------- 转发给后端 ----------
function proxyToBackend(req, res) {
  const opts = {
    hostname: '127.0.0.1',
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:' + BACKEND_PORT },
  };
  const up = http.request(opts, upRes => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 50000, msg: '后端没起来，先跑 一键安装.bat', data: null }));
  });
  req.pipe(up);
}

/**
 * 从一个端口开始试，被占用就 +1 继续试
 * resolve 真正监听成功的端口号
 */
function listenWithFallback(server, startPort, tries = 20) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryOnce = () => {
      const port = startPort + attempt;

      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < tries - 1) {
          attempt++;
          tryOnce();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    };

    tryOnce();
  });
}

// ---------- main ----------
(async () => {
  console.log(c.bold + '\n==============================================' + c.reset);
  console.log(c.bold + '  微光同行 · 启动' + c.reset);
  console.log(c.bold + '==============================================' + c.reset);

  // 1. MySQL
  if (!(await portOpen(DB_PORT))) {
    if (!fs.existsSync(MYSQLD)) {
      bad('找不到 MySQL，也没检测到 ' + DB_PORT + ' 端口');
      console.log('  先跑一次「一键安装.bat」');
      process.exit(1);
    }
    console.log('  ' + c.dim + '启动 MySQL……' + c.reset);
    const child = spawn(MYSQLD, [
      '--basedir=' + path.join(MYSQL_HOME, MYSQL_NAME),
      '--datadir=' + dataDirOf(DB_PORT),
      '--port=' + DB_PORT, '--console',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      if (await portOpen(DB_PORT)) break;
    }
    if (!(await portOpen(DB_PORT))) { bad('MySQL 启动失败（端口 ' + DB_PORT + '）'); process.exit(1); }
    ok('MySQL 已启动（' + DB_PORT + '）');
  } else {
    ok('MySQL 在运行（' + DB_PORT + '）');
  }

  // 2. 后端
  if (!(await portOpen(BACKEND_PORT))) {
    if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
      bad('后端依赖没装，先跑一次「一键安装.bat」');
      process.exit(1);
    }
    // ★ 没有 .env 就启动不了 ★
    //   包是故意不带 .env 的（里面是数据库密码），必须由「一键安装」生成。
    //   以前这里直接拉起后端，后端因为缺少 DB_PASSWORD 立刻退出，
    //   而 .bat 只看到"后端没起来"，用户完全不知道要先跑安装。
    if (!fs.existsSync(path.join(SERVER_DIR, '.env'))) {
      bad('还没生成 后端源码/.env（数据库密码在里面）');
      console.log('');
      console.log('  请先双击 ' + c.bold + '「一键安装.bat」' + c.reset + '，跑完再启动。');
      console.log('  ' + c.dim + '安装会问你 MySQL 密码，然后自动写 .env、建库、灌演示数据' + c.reset);
      process.exit(1);
    }
    // 启动前先把表结构对齐（幂等：老库缺字段会自动补上）
    //   以前不检查，前端同学用老库启动后一点登录就 500（缺 session_version），
    //   而窗口里只有一句"后端已启动"，根本看不出是数据库的问题。
    const migrateScript = path.join(SERVER_DIR, 'scripts', 'migrate.js');
    if (fs.existsSync(migrateScript)) {
      console.log('  ' + c.dim + '检查表结构……' + c.reset);
      const mr = spawnSync(process.execPath, ['scripts/migrate.js'], {
        cwd: SERVER_DIR, encoding: 'utf8', timeout: 120000,
      });
      if (mr.status === 0) {
        console.log('  ' + c.green + '✅ 表结构已是最新' + c.reset);
      } else {
        console.log('  ' + c.yellow + '⚠️  表结构检查有报错，继续启动（后端启动时会自动补）' + c.reset);
      }
    }

    console.log('  ' + c.dim + '启动后端……' + c.reset);
    // 把后端输出写进文件：起不来的时候能把真实原因打出来
    const LOG_PATH = path.join(SERVER_DIR, 'backend.log');
    let out = null;
    try { out = fs.openSync(LOG_PATH, 'w'); } catch (e) { /* 没权限就退回 ignore */ }
    const be = spawn(process.execPath, ['src/app.js'], {
      cwd: SERVER_DIR, detached: true, stdio: out === null ? 'ignore' : ['ignore', out, out],
    });
    be.unref();
    if (out !== null) { try { fs.closeSync(out); } catch (e) {} }
    for (let i = 0; i < 25; i++) {
      await sleep(800);
      if (await portOpen(BACKEND_PORT)) break;
    }
    if (!(await portOpen(BACKEND_PORT))) {
      bad('后端没起来（下面 后端日志 里有真实原因）');
      try {
        const tail = fs.readFileSync(path.join(SERVER_DIR, 'backend.log'), 'utf8')
          .split('\n').filter(l => l.trim()).slice(-12).join('\n');
        if (tail) {
          console.log('');
          console.log(c.dim + '  ── 后端日志 ──────────────────────────' + c.reset);
          tail.split('\n').forEach(l => console.log('  ' + l));
          console.log(c.dim + '  ──────────────────────────────────────' + c.reset);
        }
      } catch (e) { /* 没日志就算了 */ }
      console.log('');
      console.log('  也可以手动跑，看完整输出：' + c.dim + 'cd 后端源码 && node src/app.js' + c.reset);
      process.exit(1);
    }
    ok('后端已启动（3000）');
  } else {
    ok('后端在运行（3000）');
  }

  // 2.5 数据库到底通不通（后端活着不代表连得上 MySQL）
  const db = await checkHealth();
  if (db.connected) {
    ok('数据库连上了（MySQL ' + (db.version || '') + '）');
  } else {
    bad('后端起来了，但数据库没连上：' + (db.error || '未知原因'));
    console.log('');
    console.log('  ' + c.yellow + '页面能打开，但一点「我的」就会报"连不上 MySQL"。' + c.reset);
    console.log('  按顺序排查：');
    console.log('    1) MySQL 是否在跑：任务管理器里找 mysqld.exe');
    console.log('    2) 手动起：' + c.dim + 'D:\\mysql\\mysql-8.0.28-winx64\\bin\\mysqld.exe --datadir=D:/mysql/data --console' + c.reset);
    console.log('    3) 密码对不对：看 后端源码/.env 里的 DB_PASSWORD');
    console.log('    4) 端口对不对：看 后端源码/.env 里的 DB_PORT');
    console.log('');
    if (!NO_OPEN === false) { /* 仍然继续起静态服务，方便排查 */ }
  }

  // 3. 静态服务
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    // ★ 必须带斜杠：写成 startsWith('/api') 会把前端的 /api.js 也转给后端（404）
    if (u === '/api' || u.startsWith('/api/') || u === '/uploads' || u.startsWith('/uploads/')) {
      return proxyToBackend(req, res);
    }
    return serveStatic(req, res);
  });

  const port = await listenWithFallback(server, START_PORT);
  if (port !== START_PORT) {
    warn('端口 ' + START_PORT + ' 被占用，已改用 ' + port);
  }

  const ip = lanIp();
  console.log('');
  console.log(c.green + c.bold + '  🎉 可以开始测了' + c.reset);
  console.log('');
  console.log('  本机打开：' + c.bold + 'http://localhost:' + port + c.reset);
  console.log('  手机打开：' + c.bold + 'http://' + ip + ':' + port + c.reset + '  （同一 WiFi）');
  console.log('');
  console.log('  登录：13800138000    验证码：123456');
  console.log('  接口文档：接口文档.md');
  console.log('');
  console.log(c.dim + '  按 Ctrl+C 停止（MySQL 和后端会继续在后台跑）' + c.reset);
  console.log('');

  if (!NO_OPEN) {
    const url = 'http://localhost:' + port;
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  }
})();
