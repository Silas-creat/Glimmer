// 一键安装：默认只创建独立实例；已有配置须显式 --use-existing 才执行建表/迁移。
// node setup/install.js --check                         仅检查文件，不连接/修改数据库
// node setup/install.js --private-port 3310             新独立实例，端口必须空闲
// MYSQL_BASEDIR / MYSQL_DATA_DIR 可指定安装目录和全新数据目录。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { pipeline } = require('node:stream/promises');

function portNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口必须为 1 到 65535 的整数');
  return n;
}
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--check', '--force-private', '--use-existing', '--download'].includes(a)) options[a.slice(2)] = true;
    else if (a === '--private-port' || a.startsWith('--private-port=')) {
      if (options.port !== undefined) throw new Error('重复的 private-port 参数');
      options.port = portNumber(a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]);
    } else throw new Error('未知安装参数：' + a);
  }
  if (options['use-existing'] && (options['force-private'] || options.port !== undefined)) throw new Error('已有实例与独立实例参数不能同时使用');
  return options;
}
function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    const finish = value => { clearTimeout(timer); s.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(false), 800);
    s.once('connect', () => finish(true)); s.once('error', () => finish(false));
  });
}
async function download(url, dest, depth = 0) {
  if (depth > 5 || !url.startsWith('https://')) throw new Error('下载地址或重定向无效');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('下载超时'))); req.on('error', reject);
  });
  if ([301, 302, 307, 308].includes(response.statusCode)) {
    response.resume(); return download(new URL(response.headers.location, url).href, dest, depth + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new Error('下载 HTTP ' + response.statusCode); }
  await pipeline(response, fs.createWriteStream(dest, { flags: 'wx' }));
}

function createInstaller({ root = path.resolve(__dirname, '..'), args = process.argv.slice(2), env = process.env, io = {} } = {}) {
  const server = path.join(root, '后端源码');
  const envPath = path.join(server, '.env');
  const localRequire = createRequire(path.join(server, 'package.json'));
  const log = io.log || console.log;
  const runSync = io.spawnSync || spawnSync;
  const runChild = io.spawn || spawn;
  const isOpen = io.portOpen || portOpen;
  const sleep = io.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const home = path.resolve(env.MYSQL_DIR || (fs.existsSync('D:\\') ? 'D:\\mysql' : path.join(os.homedir(), 'mysql')));
  const base = path.resolve(env.MYSQL_BASEDIR || path.join(home, 'mysql-8.0.28-winx64'));
  const mysqld = path.join(base, 'bin', process.platform === 'win32' ? 'mysqld.exe' : 'mysqld');
  let ownedChild, bootstrap, installed = false;

  function dependencies() {
    return io.dependencies ? io.dependencies() : { dotenv: localRequire('dotenv'), mysql: localRequire('mysql2/promise') };
  }
  async function installDeps() {
    if (io.installDeps) return io.installDeps();
    try { dependencies(); return; } catch { /* clean checkout */ }
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const r = fs.existsSync(npmCli)
      ? runSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], { cwd: server, env, stdio: 'inherit', windowsHide: true })
      : runSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: server, env, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error('npm ci 失败；数据库尚未初始化');
  }
  async function ensureBinary(options) {
    if (fs.existsSync(mysqld)) return;
    if (!options.download) throw new Error('找不到 MySQL。请设置 MYSQL_BASEDIR；需要下载时显式添加 --download');
    if (env.MYSQL_BASEDIR || process.platform !== 'win32') throw new Error('自定义安装目录或非 Windows 环境请自行安装 MySQL');
    if (fs.existsSync(base)) throw new Error('MySQL 安装目录已存在但不完整；不会覆盖，请人工检查');
    fs.mkdirSync(home, { recursive: true });
    const archive = path.join(home, 'mysql-download-' + crypto.randomBytes(8).toString('hex') + '.zip');
    log('下载 MySQL 8.0.28；保持系统 TLS 校验');
    await download('https://mirrors.aliyun.com/mysql/MySQL-8.0/mysql-8.0.28-winx64.zip', archive);
    const r = runSync('tar', ['-xf', archive, '-C', home], { stdio: 'ignore', windowsHide: true });
    if (r.status !== 0 || !fs.existsSync(mysqld)) throw new Error('MySQL 解压失败，请手动安装后重试');
    fs.unlinkSync(archive);
  }
  function dbConfig(values) {
    const get = (key, fallback) => values[key] === undefined || values[key] === '' ? fallback : values[key];
    const config = { host: get('DB_HOST', '127.0.0.1'), port: portNumber(get('DB_PORT', '3306')), user: get('DB_USER', 'root'), password: get('DB_PASSWORD', ''), database: get('DB_NAME', 'peizhe') };
    portNumber(get('PORT', '3000'));
    if (!config.password) throw new Error('DB_PASSWORD 未配置；安装器不会猜密码或重置已有账号');
    if (!/^[A-Za-z0-9_]+$/.test(config.database)) throw new Error('DB_NAME 仅支持字母、数字和下划线');
    return config;
  }
  async function connect(mysql, config) {
    try { return await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, connectTimeout: 5000 }); }
    catch (error) { throw new Error('数据库连接失败（' + String(error.code || 'connection-error').replace(/[^A-Z0-9_-]/gi, '') + '）；不会尝试其他凭证或修改认证'); }
  }
  async function identity(connection, port, uuid) {
    const [[actual]] = await connection.query('SELECT @@port AS port, @@server_uuid AS uuid');
    if (Number(actual.port) !== port || (uuid && actual.uuid !== uuid)) throw new Error('MySQL 实例归属不匹配（端口/UUID），已停止');
    return actual.uuid;
  }
  function runScripts(values) {
    // Demo generation rebuilds chat content; installation only prepares schema and base rooms.
    for (const script of ['scripts/init-db.js', 'scripts/migrate.js']) {
      log('执行 ' + script);
      const r = runSync(process.execPath, [script], { cwd: server, env: values, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(script + ' 失败，安装中止；配置已保留，请修正后使用 --use-existing 重试');
      log(script + ' 完成');
    }
  }
  function serialize(values) {
    return Object.entries(values).map(([key, value]) => {
      const s = String(value);
      if (/[\r\n]/.test(s)) throw new Error('配置值不能包含换行');
      if (!s.includes('#') && !/\s/.test(s)) return key + '=' + s;
      const quote = ["'", '"', '`'].find(q => !s.includes(q));
      if (!quote) throw new Error('配置值无法安全保存，请使用不含混合引号的路径');
      return key + '=' + quote + s + quote;
    }).join('\n') + '\n';
  }
  async function stopOwned() {
    if (bootstrap) { try { await bootstrap.query('SHUTDOWN'); } catch { /* already exited */ } }
    if (ownedChild && ownedChild.exitCode === null && !ownedChild.killed) ownedChild.kill();
  }
  async function run() {
    const options = parseArgs(args);
    for (const key of ['PORT', 'DB_PORT', 'MYSQL_PORT']) if (env[key] !== undefined && env[key] !== '') portNumber(env[key]);
    if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('需要 Node.js 18 或更高');
    const existing = fs.existsSync(envPath);
    if (existing && (options['force-private'] || options.port !== undefined)) throw new Error('已有 .env，拒绝创建另一实例或覆盖配置；请使用独立项目目录');
    if (!existing && options['use-existing']) throw new Error('--use-existing 需要已有 .env；请先明确配置目标实例');
    if (options.check) {
      log('只读检查：Node ' + process.version + '；.env ' + (existing ? '已存在' : '未生成') + '；MySQL ' + (fs.existsSync(mysqld) ? '程序存在' : '程序未找到'));
      log('未连接数据库，未启动进程，未安装依赖，未验证认证。');
      return { mode: 'check' };
    }
    if (existing && !options['use-existing']) {
      log('.env 已存在，保持不变。需要建表/迁移时显式运行 node setup/install.js --use-existing；仅启动请使用一键启动。');
      return { mode: 'existing-preserved' };
    }
    if (existing) {
      await installDeps();
      const { dotenv, mysql } = dependencies();
      const values = { ...dotenv.parse(fs.readFileSync(envPath)), ...env };
      const config = dbConfig(values);
      const conn = await connect(mysql, config);
      try { await identity(conn, config.port, values.MYSQL_INSTANCE_UUID); } finally { await conn.end(); }
      log('已验证配置中的实例；不会修改账号认证或重写 .env');
      runScripts(values);
      return { mode: 'existing', port: config.port };
    }

    let port = options.port || 3307;
    let dataDir;
    for (let count = 0; count < 20 && port <= 65535; count++, port++) {
      dataDir = path.resolve(env.MYSQL_DATA_DIR || path.join(home, 'data-' + port));
      const occupied = await isOpen(port);
      const exists = fs.existsSync(dataDir);
      if (!occupied && !exists) break;
      if (options.port !== undefined || env.MYSQL_DATA_DIR) throw new Error(occupied ? '指定独立端口已被占用，拒绝连接或修改认证' : '独立数据目录已存在，拒绝初始化或重置认证');
      if (count === 19 || port === 65535) throw new Error('找不到同时空闲的端口与全新数据目录，请显式配置');
    }
    await ensureBinary(options);
    await installDeps();
    const { dotenv, mysql } = dependencies();
    const template = dotenv.parse(fs.readFileSync(path.join(server, '.env.example')));
    const newValues = { ...template, PORT: env.PORT || template.PORT || '3000', DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: 'root', DB_PASSWORD: crypto.randomBytes(24).toString('hex'), DB_NAME: env.DB_NAME || 'peizhe', JWT_SECRET: crypto.randomBytes(32).toString('hex'), DEEPSEEK_API_KEY: '', MYSQL_BASEDIR: base.replaceAll('\\', '/'), MYSQL_DATA_DIR: dataDir.replaceAll('\\', '/') };
    dbConfig(newValues);
    if (await isOpen(port)) throw new Error('独立端口已被占用，已停止初始化');
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    fs.mkdirSync(dataDir);
    try {
      const init = runSync(mysqld, ['--no-defaults', '--initialize-insecure', '--basedir=' + base, '--datadir=.'], { cwd: dataDir, encoding: 'utf8', timeout: 120000, windowsHide: true });
      if (init.status !== 0 || !fs.existsSync(path.join(dataDir, 'mysql'))) throw new Error('独立 MySQL 初始化失败；保留目录供排查，不会重置已有实例');
      const uuid = fs.readFileSync(path.join(dataDir, 'auto.cnf'), 'utf8').match(/^server-uuid=([a-f0-9-]+)\s*$/mi)?.[1];
      if (!uuid) throw new Error('新数据目录缺少有效 UUID');
      newValues.MYSQL_INSTANCE_UUID = uuid;
      if (await isOpen(port)) throw new Error('初始化后端口已被其他进程占用，拒绝认证操作');
      // On Windows target the server itself, not a monitor that can leave a child running.
      ownedChild = runChild(mysqld, ['--no-defaults', ...(process.platform === 'win32' ? ['--no-monitor'] : []), '--basedir=' + base, '--datadir=.', '--port=' + port, '--bind-address=127.0.0.1', '--mysqlx=0', '--console'], { cwd: dataDir, detached: true, windowsHide: true, stdio: 'ignore' });
      let spawnError;
      ownedChild.once('error', error => { spawnError = error; }); ownedChild.unref();
      for (let i = 0; i < 40; i++) {
        if (spawnError || ownedChild.exitCode !== null) throw new Error('本次独立 MySQL 启动失败');
        if (await isOpen(port)) break;
        if (i === 39) throw new Error('独立 MySQL 启动超时');
        await sleep(500);
      }
      const conn = await connect(mysql, { host: '127.0.0.1', port, user: 'root', password: '' });
      try { await identity(conn, port, uuid); }
      catch (error) { await conn.end(); throw error; }
      bootstrap = conn;
      fs.writeFileSync(envPath, serialize(newValues), { flag: 'wx', mode: 0o600 });
      await bootstrap.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [newValues.DB_PASSWORD]);
      const authenticated = await connect(mysql, dbConfig(newValues));
      try { await identity(authenticated, port, uuid); } finally { await authenticated.end(); }
      log('独立实例归属已验证，随机凭证已保存到 .env（不打印）');
      runScripts({ ...env, ...newValues });
      installed = true;
      log('安装完成；双击一键启动，前端从 8080 开始尝试，以实际输出为准。');
      return { mode: 'fresh', port, dataDir };
    } catch (error) {
      await stopOwned();
      if (error.code) throw new Error('安装失败（' + String(error.code).replace(/[^A-Z0-9_-]/gi, '') + '）；本轮实例已停止，配置/数据目录保留供恢复');
      throw error;
    } finally {
      if (bootstrap) { try { await bootstrap.end(); } catch {} bootstrap = undefined; }
    }
  }
  return { run, stop: async () => { if (!installed) await stopOwned(); } };
}

if (require.main === module) {
  const installer = createInstaller();
  const cancel = async () => { await installer.stop(); process.exit(130); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  installer.run().catch(error => { console.error('安装未完成：' + error.message); process.exitCode = 1; });
}
module.exports = { createInstaller };
