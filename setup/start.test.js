'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

async function listening(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function fixture(t, envText = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmer-start-'));
  fs.mkdirSync(path.join(dir, 'setup'));
  const backend = path.join(dir, '后端源码');
  fs.mkdirSync(path.join(backend, 'src'), { recursive: true });
  fs.mkdirSync(path.join(backend, 'scripts'));
  fs.mkdirSync(path.join(dir, '前端参考'));
  fs.cpSync(path.join(root, '后端源码/node_modules/dotenv'), path.join(backend, 'node_modules/dotenv'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'start.js'), path.join(dir, 'setup/start.js'));
  fs.writeFileSync(path.join(backend, '.env'), envText);
  fs.writeFileSync(path.join(dir, '前端参考/api.js'), '/* isolated static api */');
  fs.writeFileSync(path.join(backend, 'scripts/migrate.js'), "require('node:fs').writeFileSync('migrated.txt','yes');process.exit(Number(process.env.MIGRATE_EXIT || 0));");
  fs.writeFileSync(path.join(backend, 'src/app.js'), `
require('dotenv').config();
require('node:fs').writeFileSync('child.pid', String(process.pid));
require('node:http').createServer((req,res) => {
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify({code:0,data:{service:'陪着后端',db:{connected:process.env.DB_HEALTH !== 'false'},marker:'isolated-backend'}}));
}).listen(Number(process.env.PORT),'127.0.0.1');
`);
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    }
    const pidFile = path.join(backend, 'child.pid');
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch {} }
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, backend, children };
}

function run(f, extraEnv = {}, args = ['--no-open']) {
  const env = { ...process.env };
  for (const key of ['PORT', 'DB_PORT', 'DB_HOST', 'MYSQL_BASEDIR', 'MYSQL_DATA_DIR']) delete env[key];
  const child = spawn(process.execPath, [path.join(f.dir, 'setup/start.js'), ...args], {
    cwd: f.dir, windowsHide: true, env: { ...env, MYSQL_DIR: path.join(f.dir, 'missing-mysql'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  f.children.push(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise(resolve => child.once('exit', (code) => resolve({ code, output })));
  return { child, done, output: () => output };
}

async function finished(r) {
  const timer = setTimeout(() => r.child.kill(), 10000);
  try { return await r.done; } finally { clearTimeout(timer); }
}

test('occupied configured backend is refused before any database operation', async t => {
  const foreign = net.createServer(socket => socket.end());
  const port = await listening(foreign);
  t.after(() => foreign.close());
  const f = await fixture(t, `PORT=${port}\nDB_PORT=1\n`);
  const result = await finished(run(f));
  assert.equal(result.code, 1);
  assert.match(result.output, /后端端口.*已被占用/);
  assert.equal(fs.existsSync(path.join(f.backend, 'migrated.txt')), false);
});

test('invalid configured ports fail explicitly before starting services', async t => {
  const f = await fixture(t, 'PORT=0\nDB_PORT=1\n');
  const result = await finished(run(f));
  assert.equal(result.code, 1);
  assert.match(result.output, /PORT.*1.*65535/);
  assert.equal(fs.existsSync(path.join(f.backend, 'migrated.txt')), false);
});

test('unreachable remote database never triggers local MySQL startup', async t => {
  // A second loopback address avoids outbound proxy software accepting all remote TCP probes.
  const f = await fixture(t, 'PORT=49263\nDB_HOST=127.0.0.2\nDB_PORT=1\n');
  const result = await finished(run(f));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /远程数据库/);
});

test('migration failure stops before backend or frontend startup', async t => {
  const db = net.createServer(socket => socket.end());
  const dbPort = await listening(db);
  t.after(() => db.close());
  const f = await fixture(t, `PORT=49264\nDB_PORT=${dbPort}\n`);
  const result = await finished(run(f, { MIGRATE_EXIT: '2' }));
  assert.equal(result.code, 1);
  assert.match(result.output, /表结构.*失败/);
  assert.equal(fs.existsSync(path.join(f.backend, 'child.pid')), false);
});

test('configured backend is proxied while api.js stays static and malformed paths are rejected', async t => {
  const db = net.createServer(socket => socket.end());
  const dbPort = await listening(db);
  t.after(() => db.close());
  const f = await fixture(t, `PORT=49265\nDB_PORT=${dbPort}\n`);
  const r = run(f, { PORT: '49266' }, ['--no-open', '--port=49267']);
  t.after(() => r.child.kill());
  for (let i = 0; i < 80 && !r.output().includes('可以开始测了') && r.child.exitCode === null; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(r.output(), /可以开始测了/);
  const health = await fetch('http://127.0.0.1:49267/api/health');
  assert.equal((await health.json()).data.marker, 'isolated-backend');
  const api = await fetch('http://127.0.0.1:49267/api.js');
  assert.equal(await api.text(), '/* isolated static api */');
  const malformed = await fetch('http://127.0.0.1:49267/%E0%A4%A');
  assert.equal(malformed.status, 400);
  const nul = await fetch('http://127.0.0.1:49267/%00');
  assert.equal(nul.status, 400);
  assert.equal((await fetch('http://127.0.0.1:49267/api/health')).status, 200);
  const traversalStatus = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:49267/..%5c后端源码%5c.env', res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(traversalStatus, 403);
});

test('unhealthy backend does not publish frontend readiness', async t => {
  const db = net.createServer(socket => socket.end());
  const dbPort = await listening(db);
  t.after(() => db.close());
  const f = await fixture(t, `PORT=49268\nDB_PORT=${dbPort}\n`);
  const result = await finished(run(f, { DB_HEALTH: 'false' }));
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.output, /可以开始测了/);
  const backendPid = Number(fs.readFileSync(path.join(f.backend, 'child.pid'), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.throws(() => process.kill(backendPid, 0), { code: 'ESRCH' }, 'failed startup must stop its own backend');
});

test('MySQL launch uses configured initialized directory and ignores global option files', async t => {
  const f = await fixture(t, 'PORT=49269\nDB_PORT=3319\n');
  const basedir = path.join(f.dir, 'mysql-custom');
  const datadir = path.join(f.dir, 'data-custom');
  fs.mkdirSync(path.join(basedir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(datadir, 'mysql'), { recursive: true });
  fs.writeFileSync(path.join(datadir, 'auto.cnf'), '[auto]\nserver-uuid=synthetic\n');
  fs.writeFileSync(path.join(basedir, 'bin', process.platform === 'win32' ? 'mysqld.exe' : 'mysqld'), 'not executed');
  fs.appendFileSync(path.join(f.backend, '.env'), `MYSQL_BASEDIR="${basedir.replaceAll('\\', '/')}"\nMYSQL_DATA_DIR="${datadir.replaceAll('\\', '/')}"\n`);
  const child = spawn(process.execPath, ['-e', "const s=require('./setup/start.js'); s.loadConfig(); console.log(JSON.stringify(s.mysqlStartArgs()));"], {
    cwd: f.dir, windowsHide: true, env: { ...process.env, PORT: '49269', DB_PORT: '3319', DB_HOST: '127.0.0.1', MYSQL_BASEDIR: basedir, MYSQL_DATA_DIR: datadir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), ['--no-defaults', '--basedir=' + basedir, '--datadir=.',
    '--port=3319', '--bind-address=127.0.0.1', '--mysqlx=0', '--console']);
});

test('missing initialized MySQL data directory is rejected without migration', async t => {
  const f = await fixture(t, 'PORT=49270\nDB_PORT=1\n');
  const basedir = path.join(f.dir, 'mysql-custom');
  fs.mkdirSync(path.join(basedir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(basedir, 'bin', process.platform === 'win32' ? 'mysqld.exe' : 'mysqld'), 'not executed');
  const result = await finished(run(f, { MYSQL_BASEDIR: basedir, MYSQL_DATA_DIR: path.join(f.dir, 'absent-data') }));
  assert.equal(result.code, 1);
  assert.match(result.output, /数据目录尚未初始化/);
  assert.equal(fs.existsSync(path.join(f.backend, 'migrated.txt')), false);
});
