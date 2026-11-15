// 只使用临时前端夹具和本进程拥有的 HTTP 替身，不连接数据库或现有后端。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(scripts, '../../前端参考');
const apiSource = fs.readFileSync(path.join(frontend, 'api.js'), 'utf8');
function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmer-checker-'));
  for (const [name, value] of Object.entries({ 'api.js': apiSource, 'index.html': '<script src="api.js"></script><script>apiBase();</script>', ...files })) {
    fs.writeFileSync(path.join(dir, name), value);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(name, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scripts, name), ...args], { cwd: os.tmpdir(), windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('checker timed out')); }, 15000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); resolve({ code, output: output.replace(/\x1b\[[0-9;]*m/g, '') }); });
  });
}
async function server(t, handler) {
  const requests = [];
  const instance = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (handler?.(req, res)) return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/auth/login'
      ? { code: 0, data: { token: 'synthetic-token', user: { uid: 'synthetic', nickname: '合成账号' } } }
      : { code: 0, data: { ok: true } }));
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { base: 'http://127.0.0.1:' + instance.address().port, requests };
}
const runtimeArgs = (dir, base) => [dir, '--base', base, '--phone', '19900009999', '--code', '123456'];

test('frontend refuses an artifact containing API but no HTML pages', async t => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'index.html'));
  const result = await run('check-frontend.js', [dir]);
  assert.equal(result.code, 1);
});

test('默认前端路径不依赖工作目录，函数契约不再 SKIP', async () => {
  const result = await run('check-frontend.js');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /api.js 函数契约完整/);
  assert.doesNotMatch(result.output, /契约检查跳过|SKIP/);
});
test('缺失函数、缺失 api.js 和无语法效力的外链脚本均失败', async t => {
  for (const files of [
    { 'api.js': apiSource.replace('function requireLogin()', 'function removedRequireLogin()') },
    { 'bad.js': 'const = ;', 'index.html': '<script src="api.js"></script><script src="bad.js"></script>' },
  ]) {
    const result = await run('check-frontend.js', [fixture(t, files)]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /函数契约缺失|语法错误/);
  }
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'api.js'));
  const result = await run('check-frontend.js', [dir]);
  assert.equal(result.code, 1);
  assert.match(result.output, /api.js 加载失败/);
});
test('不存在的旧 API 方法及未引入函数依赖均失败', async t => {
  for (const html of [
    '<script src="api.js"></script><script>API.auth.nonexistent();</script>',
    '<script>api("/test");</script>',
    '<script>function optional() { if (typeof api !== "function") return; try { api("/auth/me"); } catch(e) {} } api("/unguarded");</script>',
  ]) {
    const result = await run('check-frontend.js', [fixture(t, { 'index.html': html })]);
    assert.equal(result.code, 1, result.output);
  }
});
test('安全扫描：缺失目录、空目录、合成 Key、第三方直连均失败', async t => {
  const missing = path.join(fixture(t), 'missing');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmer-checker-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  for (const dir of [missing, empty]) {
    const result = await run('smoke-test.js', [dir]);
    assert.equal(result.code, 1);
    assert.match(result.output, /无法完成 API Key 安全检查/);
  }
  const dir = fixture(t, { 'leak.js': '// sk-' + 'SYNTHETIC'.repeat(4) });
  let result = await run('smoke-test.js', [dir]);
  assert.equal(result.code, 1);
  assert.match(result.output, /leak.js 里有明文/);
  fs.writeFileSync(path.join(dir, 'leak.js'), 'fetch("https://api.deepseek.com/test")');
  result = await run('smoke-test.js', [dir]);
  assert.equal(result.code, 1);
  assert.match(result.output, /leak.js 里前端直接调了/);
  fs.unlinkSync(path.join(dir, 'leak.js'));
  result = await run('smoke-test.js', [dir]);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /❌.*(?:明文 API Key|第三方大模型)/);
});
test('runtime 无显式目标/账号时拒绝执行', async () => {
  const result = await run('check-pages-runtime.js');
  assert.equal(result.code, 1);
  assert.match(result.output, /必须显式指定/);
});
test('runtime 使用指定后端、wg 登录态及 HTML 顺序的外链脚本', async t => {
  const target = await server(t);
  const dir = fixture(t, { 'page.js': 'if (getToken() !== "synthetic-token") throw new Error("未设置 wg token"); window.loaded = true; api("/probe");', 'index.html': '<script src="api.js"></script><script src="page.js"></script><script>if (!loaded) throw new Error("外链未执行");</script>' });
  const result = await run('check-pages-runtime.js', runtimeArgs(dir, target.base));
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(target.requests.map(x => x.path), ['/api/auth/login', '/api/probe']);
  assert.equal(target.requests[1].authorization, 'Bearer synthetic-token');
});
test('runtime 登录失败时不执行页面', async t => {
  const target = await server(t, (req, res) => { res.writeHead(401); res.end('{"code":401}'); return true; });
  const result = await run('check-pages-runtime.js', runtimeArgs(fixture(t), target.base));
  assert.equal(result.code, 1);
  assert.match(result.output, /检查未执行/);
  assert.equal(target.requests.length, 1);
});
test('runtime 跨 origin 和重定向都不会访问第二个服务', async t => {
  const other = await server(t);
  const target = await server(t, (req, res) => {
    if (req.url !== '/api/redirect') return false;
    res.writeHead(302, { Location: other.base + '/capture' }); res.end(); return true;
  });
  for (const code of [`fetch(${JSON.stringify(other.base + '/capture')}).catch(() => {});`, 'api("/redirect");']) {
    const dir = fixture(t, { 'index.html': '<script src="api.js"></script><script>' + code + '</script>' });
    const result = await run('check-pages-runtime.js', runtimeArgs(dir, target.base));
    assert.equal(result.code, 1, result.output);
  }
  assert.equal(other.requests.length, 0);
});
test('runtime 捕获异步异常，空目录不会误判通过', async t => {
  const target = await server(t);
  const dir = fixture(t, { 'index.html': '<script>Promise.reject(new Error("async-synthetic"));</script>' });
  const result = await run('check-pages-runtime.js', runtimeArgs(dir, target.base));
  assert.equal(result.code, 1);
  assert.match(result.output, /async-synthetic/);
  fs.unlinkSync(path.join(dir, 'index.html'));
  const empty = await run('check-pages-runtime.js', runtimeArgs(dir, target.base));
  assert.equal(empty.code, 1);
});
test('runtime 等待慢响应体并支持取消定时器', async t => {
  const target = await server(t, (req, res) => {
    if (req.url !== '/api/slow') return false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"code":');
    setTimeout(() => res.end('0,"data":{}}'), 200);
    return true;
  });
  const dir = fixture(t, { 'index.html': '<script src="api.js"></script><script>const id = setTimeout(() => { throw new Error("cancelled-timer"); }, 30); clearTimeout(id); (async () => { await api("/slow"); throw new Error("after-slow-body"); })();</script>' });
  const result = await run('check-pages-runtime.js', runtimeArgs(dir, target.base));
  assert.equal(result.code, 1);
  assert.match(result.output, /after-slow-body/);
  assert.doesNotMatch(result.output, /cancelled-timer/);
});
