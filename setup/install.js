// ============================================================
//  一键安装/初始化（给前端同学用）
//
//  用法：双击「一键安装.bat」，或在本目录执行：
//      node setup/install.js
//      node setup/install.js --check     只检查环境，不做任何修改
//
//  ★ 它会做这些事，每一步都会告诉你在干嘛 ★
//    1. 检查 Node（要求 18+）
//    2. 找 MySQL
//         · 3306 已经在跑，而密码试得出来 → 直接用
//         · 密码试不出来（别人电脑上装的 MySQL）→ 让你二选一：
//             [1] 手动输入 root 密码
//             [2] 另装一个独立实例（端口 3307，密码脚本自己设）
//                 —— 不碰你已有的 MySQL，也不用知道它的密码
//         · 没在跑 → 本机有 mysql 目录就启动，没有就下载
//    3. 建数据库 peizhe（已存在就跳过，不会删你的数据）
//    4. 补建缺失的表（CREATE TABLE IF NOT EXISTS，重复执行安全）
//    5. 灌演示数据
//    6. 生成 后端源码/.env（密码随机生成，端口按上面选的写）
//    7. npm install
//
//  装完之后用「一键启动.bat」启动，浏览器打开 http://localhost:3000
// ============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const https = require('node:https');
const readline = require('node:readline');

// ---------- 路径约定 ----------
const PKG_ROOT = path.resolve(__dirname, '..');           // 项目根目录/
const SERVER_DIR = path.join(PKG_ROOT, '后端源码');
const ENV_PATH = path.join(SERVER_DIR, '.env');
const IS_WIN = process.platform === 'win32';

// MySQL 装哪：优先 D 盘（跟你一样），没有 D 盘就装到用户目录
const MYSQL_HOME = process.env.MYSQL_DIR || (fs.existsSync('D:\\') ? 'D:\\mysql' : path.join(os.homedir(), 'mysql'));
const MYSQL_ZIP_NAME = 'mysql-8.0.28-winx64';
const MYSQL_BASEDIR = path.join(MYSQL_HOME, MYSQL_ZIP_NAME);
const MYSQL_BIN = path.join(MYSQL_BASEDIR, 'bin');
const MYSQLD = path.join(MYSQL_BIN, 'mysqld.exe');
const MYSQL_CLI = path.join(MYSQL_BIN, 'mysql.exe');
const DOWNLOAD_URL = 'https://mirrors.aliyun.com/mysql/MySQL-8.0/mysql-8.0.28-winx64.zip';

const DEFAULT_PORT = 3306;
// 另装实例的端口：默认 3307，被占就往后找（3308/3309…）
// 也支持命令行指定：--private-port=3310
const PRIVATE_PORT_ARG = (() => {
  const a = process.argv.find(x => x.startsWith('--private-port'));
  if (!a) return 0;
  const v = Number(a.includes('=') ? a.split('=')[1] : process.argv[process.argv.indexOf(a) + 1]);
  return Number.isFinite(v) && v > 0 ? v : 0;
})();
const FORCE_PRIVATE = process.argv.includes('--force-private');
let PRIVATE_PORT = PRIVATE_PORT_ARG || 3307;

const CHECK_ONLY = process.argv.includes('--check');

// 最终用哪个端口（pickCredentials 里可能会改）
let MYSQL_PORT = Number(process.env.MYSQL_PORT || DEFAULT_PORT);

/** 数据目录：3306 用默认的 data/，别的端口用 data-<端口>/，两套互不干扰 */
function dataDirOf(port) {
  return port === DEFAULT_PORT ? path.join(MYSQL_HOME, 'data') : path.join(MYSQL_HOME, 'data-' + port);
}

// ---------- 小工具 ----------
const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m',
};

function step(n, title) {
  console.log('\n' + c.bold + '──────────────────────────────────────────────' + c.reset);
  console.log(c.bold + '  ' + n + '. ' + title + c.reset);
  console.log(c.bold + '──────────────────────────────────────────────' + c.reset);
}
const ok = (m) => console.log('  ' + c.green + '✅' + c.reset + ' ' + m);
const warn = (m) => console.log('  ' + c.yellow + '⚠️ ' + c.reset + ' ' + m);
const bad = (m) => console.log('  ' + c.red + '❌' + c.reset + ' ' + m);
const info = (m) => console.log('  ' + c.dim + m + c.reset);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

function randomPassword(len = 16) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}

// ---------- 0. Node 版本 ----------
function checkNode() {
  step(0, '检查 Node');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    ok('Node ' + process.version);
    return true;
  }
  bad('Node 版本太旧：' + process.version + '，需要 18 或更高');
  info('去 https://nodejs.org 下载 LTS 版本重新安装');
  return false;
}

// ---------- 1. MySQL ----------
async function ensureMysql() {
  step(1, '检查 MySQL');

  if (await portOpen(MYSQL_PORT)) {
    ok('MySQL 已经在运行（127.0.0.1:' + MYSQL_PORT + '）');
    return { fresh: false };
  }

  if (fs.existsSync(MYSQLD)) {
    ok('本机已有 MySQL：' + MYSQL_HOME);
    await startMysql(MYSQL_PORT, dataDirOf(MYSQL_PORT));
    return { fresh: false };
  }

  warn('本机没有 MySQL，需要下载（约 222MB）');
  info('下载地址：' + DOWNLOAD_URL);
  info('安装位置：' + MYSQL_HOME);

  if (CHECK_ONLY) {
    warn('（--check 模式，不下载）');
    return { missing: true };
  }

  const ans = await ask('  现在下载并安装吗？(y/n) ');
  if (ans.toLowerCase() !== 'y') {
    bad('已取消。你也可以自己装好 MySQL 后重新运行本脚本。');
    process.exit(1);
  }

  await downloadAndExtract();
  const dataDir = dataDirOf(MYSQL_PORT);
  await initMysqlData(dataDir);
  await startMysql(MYSQL_PORT, dataDir);
  return { fresh: true };
}

async function downloadAndExtract() {
  fs.mkdirSync(MYSQL_HOME, { recursive: true });
  const zipPath = path.join(MYSQL_HOME, MYSQL_ZIP_NAME + '.zip');

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 200 * 1024 * 1024) {
    console.log('  ' + c.dim + '开始下载……（国内镜像，视网速 3~10 分钟）' + c.reset);
    await download(DOWNLOAD_URL, zipPath);
  }
  const sizeMb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  ok('下载完成：' + sizeMb + ' MB');

  if (fs.existsSync(MYSQL_BASEDIR)) {
    ok('已经解压过，跳过');
    return;
  }

  console.log('  ' + c.dim + '解压中（约 1 分钟）……' + c.reset);
  // Windows 10 1803+ 自带 tar，能解 zip；失败再退回 PowerShell
  let r = spawnSync('tar', ['-xf', zipPath, '-C', MYSQL_HOME], { stdio: 'ignore' });
  if (r.status !== 0) {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${MYSQL_HOME}' -Force`],
      { stdio: 'ignore' });
  }
  if (!fs.existsSync(MYSQLD)) {
    bad('解压失败，没找到 ' + MYSQLD);
    info('可以手动把 zip 解压到 ' + MYSQL_HOME + ' 再重跑');
    process.exit(1);
  }
  ok('解压完成');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let lastPct = -1;

    const go = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('重定向太多'));
      https.get(u, { timeout: 30000 }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          res.resume();
          return go(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        res.on('data', chunk => {
          got += chunk.length;
          file.write(chunk);
          if (total) {
            const pct = Math.floor(got / total * 100);
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct;
              process.stdout.write('\r  下载中 ' + pct + '%  ' + (got / 1048576).toFixed(0) + '/' + (total / 1048576).toFixed(0) + ' MB');
            }
          }
        });
        res.on('end', () => { process.stdout.write('\n'); file.end(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    };
    go(url);
  });
}

async function initMysqlData(dataDir) {
  if (fs.existsSync(path.join(dataDir, 'mysql'))) {
    ok('数据目录已存在，跳过初始化');
    return;
  }
  console.log('  ' + c.dim + '初始化数据目录（' + dataDir + '）……' + c.reset);
  const r = spawnSync(MYSQLD, [
    '--initialize-insecure',
    '--basedir=' + MYSQL_BASEDIR,
    '--datadir=' + dataDir,
  ], { encoding: 'utf8' });
  if (!fs.existsSync(path.join(dataDir, 'mysql'))) {
    bad('初始化失败');
    if (r.stderr) info(r.stderr.slice(0, 500));
    process.exit(1);
  }
  ok('数据目录初始化完成（root 初始无密码）');
}

async function startMysql(port, dataDir) {
  if (await portOpen(port)) {
    ok('MySQL 已在运行（' + port + '）');
    return;
  }

  console.log('  ' + c.dim + '启动 MySQL（端口 ' + port + '）……' + c.reset);

  // ★ 两个细节，缺一个都会启动失败 ★
  //   1) --mysqlx-port：MySQL 8 默认还占一个 33060 给 X Plugin，
  //      机器上已经有一个 MySQL 时，第二个实例会和它抢 33060 直接起不来。
  //      这里按端口算一个偏移，保证不撞。
  //   2) --log-error：把错误写进文件，失败时能打印出来，
  //      而不是只给用户一句"启动失败"。
  const errLog = path.join(dataDir, 'startup.err');
  const child = spawn(MYSQLD, [
    '--basedir=' + MYSQL_BASEDIR,
    '--datadir=' + dataDir,
    '--port=' + port,
    '--mysqlx-port=' + (port + 30000),
    '--log-error=' + errLog,
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await portOpen(port)) { ok('MySQL 已启动（' + port + '）'); return; }
  }

  bad('MySQL 启动失败（端口 ' + port + '）');
  try {
    const tail = fs.readFileSync(errLog, 'utf8').split('\n').filter(Boolean).slice(-8);
    if (tail.length) {
      console.log('  ' + c.dim + '── MySQL 错误日志 ──────────────' + c.reset);
      tail.forEach(l => console.log('  ' + l));
      console.log('  ' + c.dim + '────────────────────────────────' + c.reset);
    }
  } catch (e) { /* 没有日志就算了 */ }
  process.exit(1);
}

// ---------- 2. 数据库账号 ----------
/**
 * 跑一次 mysql 命令行
 * @param {string[]} args  额外参数（如 '-e', 'SQL'）
 * @param {string} password  空字符串表示用 --skip-password
 * @param {number} port  连哪个端口
 */
function mysqlCli(args, password, port = MYSQL_PORT) {
  const base = ['-h127.0.0.1', '-P' + port, '-uroot', '--default-character-set=utf8mb4'];
  base.push(password ? '-p' + password : '--skip-password');
  return spawnSync(MYSQL_CLI, base.concat(args), { encoding: 'utf8' });
}

function testCredential(pw, port = MYSQL_PORT) {
  const r = spawnSync(MYSQL_CLI, ['-h127.0.0.1', '-P' + port, '-uroot',
    pw ? '-p' + pw : '--skip-password', '-e', 'SELECT 1;'], { encoding: 'utf8' });
  return r.status === 0;
}

async function pickCredentials(fresh) {
  step(2, '确认数据库账号');

  // --force-private：不管本机有没有现成的 MySQL，一律另装一个独立实例
  //   （主要是给自己/测试用：模拟"连不上本机 MySQL"的那种机器）
  if (FORCE_PRIVATE) {
    warn('（--force-private：跳过本机 MySQL，直接另装独立实例）');
    return await usePrivateInstance();
  }

  // 1) 已经生成过 .env → 用里面的密码和端口
  if (fs.existsSync(ENV_PATH)) {
    const env = fs.readFileSync(ENV_PATH, 'utf8');
    const pm = env.match(/^DB_PASSWORD=(.*)$/m);
    const pt = env.match(/^DB_PORT=(.*)$/m);
    const port = pt && pt[1].trim() ? Number(pt[1].trim()) : MYSQL_PORT;
    if (pm && pm[1] !== undefined) {
      const pw = pm[1].trim();
      if ((await portOpen(port)) && testCredential(pw, port)) {
        MYSQL_PORT = port;
        ok('.env 里的密码可用（端口 ' + port + '）');
        return pw;
      }
      warn('.env 里的账号连不上（端口 ' + port + '），继续尝试其它');
    }
  }

  // 2) 刚装好的（无密码）
  if (fresh && testCredential('')) {
    ok('检测到 MySQL 初始无密码，正在设置新密码……');
    const pw = randomPassword();
    const r = mysqlCli(['-e', `ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${pw}'; FLUSH PRIVILEGES;`], '');
    if (testCredential(pw)) { ok('root 密码已设置（会写进 .env）'); return pw; }
    bad('设置密码失败');
    info(r.stderr || '');
    process.exit(1);
  }

  // 3) 常见密码
  for (const pw of ['', '123456', 'root', '123456xx']) {
    if (testCredential(pw)) { ok('用密码连上了（' + (pw ? pw : '空密码') + '）'); return pw; }
  }

  // 4) 连不上 —— 别再用"猜三次密码"把人卡住，给两条明路
  warn('连不上这台机器上已有的 MySQL（不知道 root 密码）');
  info('  这台 MySQL 可能是以前别的项目装的，root 密码只有设它的人知道。');
  console.log('');
  console.log('    1) 我知道密码，手动输入');
  console.log('    2) 另装一个独立的 MySQL 实例（端口 ' + PRIVATE_PORT + '，密码脚本自己设）');
  console.log('       —— 不动你已有的 MySQL，也不用知道它的密码（推荐）');
  console.log('');

  if (FORCE_PRIVATE) {
    warn('（--force-private：直接走独立实例）');
    return await usePrivateInstance();
  }

  const choice = (await ask('  选哪个？(1/2，直接回车 = 2) ')) || '2';

  if (choice === '1') {
    for (let i = 0; i < 3; i++) {
      const pw = await ask('  请输入 MySQL root 密码（输入时不会显示字符；直接回车表示空密码）：');
      if (testCredential(pw)) { ok('连接成功'); return pw; }
      bad('连不上，再试一次');
    }
    bad('三次都失败。重新运行本脚本，选 2 另装一个独立实例即可。');
    process.exit(1);
  }

  return await usePrivateInstance();
}

/** 另起一个独立实例（端口 3307，自己的数据目录和密码） */
async function usePrivateInstance() {
  console.log('');
  warn('将另装一个独立实例：端口 ' + PRIVATE_PORT + '，位置 ' + dataDirOf(PRIVATE_PORT));

  if (CHECK_ONLY) {
    warn('（--check 模式，不做修改）');
    process.exit(1);
  }

  if (!fs.existsSync(MYSQLD)) {
    const ans = await ask('  需要先下载 MySQL（约 222MB），继续吗？(y/n) ');
    if (ans.toLowerCase() !== 'y') { bad('已取消'); process.exit(1); }
    await downloadAndExtract();
  }

  const dataDir = dataDirOf(PRIVATE_PORT);
  await initMysqlData(dataDir);
  await startMysql(PRIVATE_PORT, dataDir);

  // 新实例初始无密码，直接设一个随机密码
  // 端口被别的程序占着（或者那上面是别人的 MySQL，密码我们不知道）
  if (!testCredential('', PRIVATE_PORT)) {
    const first = PRIVATE_PORT;
    let found = 0;
    for (let p = first + 1; p <= first + 10; p++) {
      if (await portOpen(p)) continue;
      warn('端口 ' + first + ' 用不了，改试 ' + p);
      PRIVATE_PORT = p;
      found = p;
      break;
    }
    if (!found) { bad('连着 10 个端口都被占了，手动关掉一些程序再试'); process.exit(1); }
    await initMysqlData(dataDirOf(PRIVATE_PORT));
    await startMysql(PRIVATE_PORT, dataDirOf(PRIVATE_PORT));
    if (!testCredential('', PRIVATE_PORT)) {
      bad('新实例还是连不上（端口 ' + PRIVATE_PORT + '）');
      process.exit(1);
    }
  }
  const pw = randomPassword();
  mysqlCli(['-e', `ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${pw}'; FLUSH PRIVILEGES;`], '', PRIVATE_PORT);
  if (!testCredential(pw, PRIVATE_PORT)) {
    bad('设置密码失败');
    process.exit(1);
  }

  MYSQL_PORT = PRIVATE_PORT;
  ok('独立实例就绪：端口 ' + PRIVATE_PORT + '，密码已写入 .env');
  return pw;
}

// ---------- 3. 建库 + 灌数据 ----------
/**
 * 把整个 .sql 文件执行掉。
 *
 * ★ 为什么不用 mysql 的 `source` 命令 ★
 *   source 是 mysql 客户端自己的命令，路径要经过命令行解析；
 *   路径里只要有中文或空格（Windows 用户桌面基本都带），就会报
 *   "Failed to open file '...schema.sql', error: 2"。
 *   改成把文件读进内存、走 stdin 喂进去，路径根本不参与解析。
 */
function runSqlFile(file, dbName, password, port = MYSQL_PORT) {
  const sql = fs.readFileSync(file, 'utf8');
  const base = ['-h127.0.0.1', '-P' + port, '-uroot', '--default-character-set=utf8mb4'];
  base.push(password ? '-p' + password : '--skip-password');
  base.push(dbName);
  return spawnSync(MYSQL_CLI, base, {
    input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

async function setupDatabase(password) {
  step(3, '建数据库');
  const sqlFile = path.join(SERVER_DIR, 'sql', 'schema.sql');

  if (!fs.existsSync(sqlFile)) {
    bad('找不到 ' + sqlFile);
    process.exit(1);
  }

  const dbName = 'peizhe';

  // 建库（存在就跳过，不删数据）
  const r1 = mysqlCli(['-e',
    `CREATE DATABASE IF NOT EXISTS ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`], password);
  if (r1.status !== 0) { bad('建库失败'); info(r1.stderr || ''); process.exit(1); }
  ok('数据库 ' + dbName + ' 就绪');

  // ★ 建表脚本是 CREATE TABLE IF NOT EXISTS，重复执行是安全的 ★
  //   以前这里是"表数 >= 20 就跳过"，问题是：老版本的库可能正好 20~21 张表，
  //   新加的表就永远建不出来，直到运行时才报 Unknown column。
  //   所以改成每次都跑一遍，缺什么补什么。
  const chk = mysqlCli(['-N', '-B', '-e',
    `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${dbName}';`], password);
  const tables = Number((chk.stdout || '0').trim()) || 0;
  if (tables > 0) info('已有 ' + tables + ' 张表，补建缺失的表（不会动数据）');

  console.log('  ' + c.dim + '执行建表脚本……' + c.reset);
  // ★ 不要用 source：中文/空格路径会报 Failed to open file ★
  const r2 = runSqlFile(sqlFile, dbName, password);
  if (r2.status !== 0) {
    bad('建表失败');
    info((r2.stderr || '').split('\n').slice(0, 6).join('\n'));
    console.log('');
    console.log('  提示：如果是路径里带中文/空格导致的，把项目挪到 D:\weiguang 这类纯英文路径再试');
    process.exit(1);
  }
  ok('建表完成');

}

// ---------- 5.5 升级表结构 ----------
//  ★ 必须在写完 .env、装完依赖之后跑 ★
//    migrate.js 要读 .env 里的密码和端口，还要 import mysql2；
//    放在建表之后立刻跑的话，两样都没有，必然失败（以前就是被当成"可选步骤"吞掉的）。
async function migrateSchema() {
  const mj = path.join(SERVER_DIR, 'scripts', 'migrate.js');
  if (!fs.existsSync(mj)) return;

  console.log('  ' + c.dim + '升级表结构（老库补字段）……' + c.reset);
  const r = spawnSync(process.execPath, ['scripts/migrate.js'], {
    cwd: SERVER_DIR, encoding: 'utf8', timeout: 120000,
  });

  if (r.status === 0) {
    const tail = (r.stdout || '').split('\n').filter(l => l.includes('迁移结束')).pop();
    ok('表结构已是最新' + (tail ? '（' + tail.trim() + '）' : ''));
  } else {
    warn('表结构升级有报错，但安装继续；需要时手动跑 node scripts/migrate.js');
    const msg = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    if (msg) info(msg);
  }
}

// ---------- 4. 写 .env ----------
async function writeEnv(password) {
  step(4, '生成配置文件');
  const tpl = path.join(SERVER_DIR, '.env.example');
  if (!fs.existsSync(tpl)) { bad('缺少 .env.example'); process.exit(1); }

  if (fs.existsSync(ENV_PATH)) {
    ok('.env 已存在，跳过（如需重写请先删掉它）');
    return;
  }

  let env = fs.readFileSync(tpl, 'utf8');
  env = env.replace(/^DB_PASSWORD=.*$/m, 'DB_PASSWORD=' + password);
  env = env.replace(/^DB_PORT=.*$/m, 'DB_PORT=' + MYSQL_PORT);
  env = env.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + crypto.randomBytes(32).toString('hex'));
  env = env.replace(/^DEEPSEEK_API_KEY=.*$/m, 'DEEPSEEK_API_KEY=');

  fs.writeFileSync(ENV_PATH, env, 'utf8');
  ok('已生成 后端源码/.env（密码随机，端口 ' + MYSQL_PORT + '）');
  info('AI 功能默认关闭（没填 Key）。需要的话在 .env 里填 DEEPSEEK_API_KEY');
}

// ---------- 5. npm install ----------
async function installDeps() {
  step(5, '安装后端依赖');
  if (fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
    ok('node_modules 已存在，跳过');
    return;
  }
  console.log('  ' + c.dim + 'npm install（约 1 分钟）……' + c.reset);
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: SERVER_DIR, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) { bad('npm install 失败'); process.exit(1); }
  ok('依赖安装完成');
}

// ---------- 6. 演示数据 ----------
async function seedData() {
  step(6, '灌演示数据');
  const r = spawnSync('node', ['scripts/seed-demo.js'], {
    cwd: SERVER_DIR, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) { warn('演示数据脚本报错，但不影响启动（可以手动跑 node scripts/seed-demo.js）'); return; }
  ok('演示数据已就绪');
}

// ---------- main ----------
(async () => {
  console.log(c.bold + '\n==============================================' + c.reset);
  console.log(c.bold + '  微光同行 · 一键安装' + c.reset);
  console.log(c.bold + '==============================================' + c.reset);
  if (CHECK_ONLY) console.log(c.yellow + '  （--check 模式：只检查，不做修改）' + c.reset);

  if (!checkNode()) process.exit(1);

  const mysqlState = await ensureMysql();
  if (CHECK_ONLY && mysqlState.missing) {
    console.log('\n' + c.yellow + '  环境检查结束：缺 MySQL，正式运行会下载安装。' + c.reset);
    return;
  }

  const password = await pickCredentials(mysqlState.fresh);
  if (CHECK_ONLY) { console.log('\n' + c.green + '  环境检查结束，一切正常。' + c.reset); return; }

  await setupDatabase(password);
  await writeEnv(password);
  await installDeps();
  await migrateSchema();     // 依赖装好、.env 就位之后再迁移
  await seedData();

  console.log('\n' + c.bold + '==============================================' + c.reset);
  console.log(c.green + c.bold + '  🎉 安装完成' + c.reset);
  console.log(c.bold + '==============================================' + c.reset);
  console.log('  下一步：双击「一键启动.bat」');
  console.log('  然后浏览器打开：' + c.bold + 'http://localhost:3000' + c.reset);
  console.log('  登录：13800138000 / 验证码 123456');
  console.log('');
})();
