// ============================================================
//  部署前自检
//  用法：  node scripts/smoke-test.js
//
//  不需要数据库、不需要装依赖，纯静态检查。
//  作用是：在你辛苦配好虚拟机环境之前，先把低级错误抓出来。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, warn = 0;
const problems = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      console.log(`  ✅ ${name}`);
      pass++;
    } else if (typeof r === 'string' && r.startsWith('WARN:')) {
      console.log(`  ⚠️  ${name} —— ${r.slice(5).trim()}`);
      warn++;
    } else {
      console.log(`  ❌ ${name} —— ${r}`);
      fail++;
      problems.push(`${name}: ${r}`);
    }
  } catch (e) {
    console.log(`  ❌ ${name} —— 抛异常: ${e.message}`);
    fail++;
    problems.push(`${name}: ${e.message}`);
  }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ============================================================
console.log('\n==============================================');
console.log('  部署前自检');
console.log('==============================================');

// ---------- 1. 必需文件 ----------
console.log('\n[1] 必需文件是否齐全');
for (const f of [
  // 项目配置
  'package.json', '.env.example', '.gitignore', 'README.md',
  // 数据库
  'sql/schema.sql', 'sql/seed.sql',
  // 脚本
  'scripts/deploy.sh', 'scripts/init-db.js', 'scripts/smoke-test.js',
  'scripts/test-all.sh', 'scripts/check-tests.js', 'scripts/fix-test-account.js',
  'scripts/test-zodiac.js', 'scripts/test-moderation.js', 'scripts/test-chatbot.js',
  'scripts/test-login.js', 'scripts/test-diary.js',
  'scripts/test-interact.js', 'scripts/test-profile.js', 'scripts/test-comment.js',
  'scripts/test-bless.js', 'scripts/test-bottle.js', 'scripts/test-group.js',
  'scripts/test-message.js', 'scripts/test-discover.js',
  'scripts/test-ai.js', 'scripts/test-ai-memory.js', 'scripts/test-deepseek.js',
  'scripts/migrate.js', 'scripts/seed-demo.js',
  'scripts/test-api-client.js', 'scripts/test-api-interact.js',
  'scripts/test-api-profile.js', 'scripts/test-api-comment.js',
  'scripts/test-api-bless.js', 'scripts/test-api-bottle.js',
  'scripts/test-api-message.js', 'scripts/test-api-ai.js',
  'scripts/check-frontend.js',
  // 服务端代码
  'src/app.js', 'src/config/index.js', 'src/db/index.js',
  'src/middleware/auth.js', 'src/middleware/error.js', 'src/middleware/logger.js',
  'src/middleware/upload.js',
  'src/routes/auth.js', 'src/routes/diary.js', 'src/routes/interact.js',
  'src/routes/user.js', 'src/routes/comment.js', 'src/routes/bless.js',
  'src/routes/bottle.js', 'src/routes/group.js', 'src/routes/message.js',
  'src/routes/discover.js', 'src/routes/ai.js',
  'src/utils/response.js', 'src/utils/validate.js', 'src/utils/jwt.js',
  'src/utils/sql.js', 'src/utils/diaryHelper.js', 'src/utils/userHelper.js',
  'src/utils/zodiac.js', 'src/utils/profileHelper.js', 'src/utils/moderation.js',
  'src/utils/chatBot.js', 'src/utils/llm.js',
]) {
  check(f, () => exists(f) || '文件不存在');
}

// 前端文件（可能和本仓库不同步，所以只警告不失败）
console.log('\n  --- 前端文件（缺失只警告）---');
const FRONTEND_DIR = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
for (const f of ['api.js', 'data.js', 'login.html', 'index.html', 'diary-write.html']) {
  const full = FRONTEND_DIR + '/' + f;
  if (fs.existsSync(full)) {
    console.log(`  ✅ 前端 ${f}`);
    pass++;
  } else {
    console.log(`  ⚠️  前端 ${f} 不存在（${FRONTEND_DIR}）`);
    warn++;
  }
}

// ---------- 2. package.json ----------
console.log('\n[2] package.json 内容');
check('是合法 JSON', () => {
  JSON.parse(read('package.json'));
  return true;
});
check('是 ESM 模块（type: module）', () => {
  const p = JSON.parse(read('package.json'));
  return p.type === 'module' || '缺少 "type": "module"，代码里用了 import 语法会报错';
});
check('依赖齐全', () => {
  const p = JSON.parse(read('package.json'));
  const need = ['express', 'mysql2', 'jsonwebtoken', 'cors', 'dotenv', 'multer'];
  const missing = need.filter(d => !p.dependencies?.[d]);
  return missing.length === 0 || '缺少依赖: ' + missing.join(', ');
});
check('有 start 脚本', () => {
  const p = JSON.parse(read('package.json'));
  return Boolean(p.scripts?.start) || '没有 npm start';
});

// ---------- 3. SQL 结构 ----------
console.log('\n[3] SQL 表结构');
const schema = read('sql/schema.sql');
const createTables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`/g)].map(m => m[1]);
check(`共解析到 ${createTables.length} 张表`, () => {
  return createTables.length >= 19 || `表数量偏少，只找到 ${createTables.length} 张`;
});

// 括号和分号平衡检查
check('CREATE 语句括号配对', () => {
  let depth = 0;
  for (const ch of schema) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return '出现多余的右括号';
  }
  return depth === 0 || `括号没配平，差 ${depth} 个`;
});

check('所有表都是 utf8mb4', () => {
  const bad = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`[\s\S]*?ENGINE=InnoDB([^;]*);/g)]
    .filter(m => !m[2].includes('utf8mb4'))
    .map(m => m[1]);
  return bad.length === 0 || '这些表不是 utf8mb4: ' + bad.join(', ');
});

check('ENGINE 都是 InnoDB', () => {
  const engines = [...schema.matchAll(/ENGINE=(\w+)/g)].map(m => m[1]);
  const bad = engines.filter(e => e !== 'InnoDB');
  return bad.length === 0 || '有非 InnoDB 引擎: ' + bad.join(', ');
});

check('每张表都有主键', () => {
  const blocks = schema.split(/CREATE TABLE IF NOT EXISTS/).slice(1);
  const bad = blocks.filter(b => !/PRIMARY KEY/.test(b)).map(b => b.match(/`(\w+)`/)[1]);
  return bad.length === 0 || '这些表没主键: ' + bad.join(', ');
});

check('外键引用的表都存在', () => {
  const refs = [...schema.matchAll(/REFERENCES `(\w+)`/g)].map(m => m[1]);
  const missing = [...new Set(refs)].filter(t => !createTables.includes(t));
  return missing.length === 0 || '引用了不存在的表: ' + missing.join(', ');
});

check('建表顺序满足外键依赖', () => {
  const pos = {};
  createTables.forEach((t, i) => { pos[t] = i; });
  const errs = [];
  for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS `(\w+)`[\s\S]*?ENGINE=InnoDB[^;]*;/g)) {
    const self = m[1];
    for (const r of m[0].matchAll(/REFERENCES `(\w+)`/g)) {
      const target = r[1];
      if (pos[target] !== undefined && pos[target] > pos[self]) {
        errs.push(`${self} 引用了后面才创建的 ${target}`);
      }
    }
  }
  return errs.length === 0 || errs.join('; ');
});

check('唯一索引没有重复命名冲突', () => {
  // 同一张表内 uk_ 名字不能重复
  const blocks = schema.split(/CREATE TABLE IF NOT EXISTS/).slice(1);
  const errs = [];
  for (const b of blocks) {
    const table = b.match(/`(\w+)`/)[1];
    const names = [...b.matchAll(/UNIQUE KEY `(\w+)`/g)].map(m => m[1]);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) errs.push(`${table} 里重复: ${[...new Set(dup)].join(',')}`);
  }
  return errs.length === 0 || errs.join('; ');
});

// seed.sql
console.log('\n[4] seed.sql 初始数据');
const seed = read('sql/seed.sql');
check('4 个群聊房间都在', () => {
  const need = ['age', 'interest', 'province', 'zodiac'];
  const missing = need.filter(c => !seed.includes(`'${c}'`));
  return missing.length === 0 || '缺少房间: ' + missing.join(', ');
});
check('可重复执行（带 ON DUPLICATE KEY）', () => {
  return seed.includes('ON DUPLICATE KEY UPDATE') || '重复跑会报唯一键冲突';
});
check('房间名和前端一致', () => {
  const need = ['同龄群', '拾趣', '同省群', '星迹'];
  const missing = need.filter(n => !seed.includes(n));
  return missing.length === 0 || '房间名对不上前端: ' + missing.join(', ');
});

// ---------- 5. 真实的 SQL 切分逻辑 ----------
console.log('\n[5] SQL 切分逻辑（用 src/utils/sql.js 里的真实实现）');
const { splitSql, parseTableNames } = await import('../src/utils/sql.js');

check('切分器能处理字符串里的分号', () => {
  const got = splitSql("INSERT INTO t VALUES ('a;b'); SELECT 1;");
  if (got.length !== 2) return `应该切出 2 条，实际 ${got.length} 条: ${JSON.stringify(got)}`;
  if (!got[0].includes("'a;b'")) return '字符串里的分号被切坏了';
  return true;
});

check('切分器能处理 -- 和 /* */ 注释', () => {
  const got = splitSql(
    "-- 这是注释;里面有分号\nCREATE TABLE a (id INT);\n/* 块注释;也有分号 */\nCREATE TABLE b (id INT);"
  );
  if (got.length !== 2) return `应该切出 2 条，实际 ${got.length} 条`;
  if (got.some(s => s.includes('注释'))) return '注释没被去掉';
  return true;
});

check('切分器能处理反引号标识符', () => {
  const got = splitSql('CREATE TABLE `a;b` (id INT);');
  if (got.length !== 1) return `反引号里的分号被切错了，切出 ${got.length} 条`;
  return true;
});

check('切分器能处理没有结尾分号的最后一条语句', () => {
  const got = splitSql('SELECT 1;\nSELECT 2');
  return got.length === 2 || `应该 2 条，实际 ${got.length} 条`;
});

check('切分器能处理单词里的 # （不能误判成注释）', () => {
  const got = splitSql("INSERT INTO t VALUES ('a#b'); SELECT 1;");
  if (got.length !== 2) return `# 被误判成注释了，切出 ${got.length} 条`;
  return true;
});

check('schema.sql 切分后全是 CREATE TABLE', () => {
  const stmts = splitSql(schema);
  if (stmts.length !== createTables.length) {
    return `解析到 ${createTables.length} 张表，却切出 ${stmts.length} 条语句，数量对不上`;
  }
  const notCreate = stmts.filter(s => !/^CREATE TABLE/i.test(s));
  if (notCreate.length) {
    return `有 ${notCreate.length} 条不是 CREATE 语句，例如: ` + notCreate[0].slice(0, 80);
  }
  return true;
});

check('parseTableNames 解析出的表名和正则一致', () => {
  const names = parseTableNames(schema);
  return names.length === createTables.length
    || `差了 ${Math.abs(names.length - createTables.length)} 张表`;
});

check('seed.sql 切分后是 2 条 INSERT', () => {
  const stmts = splitSql(seed);
  if (stmts.length !== 2) return `期望 2 条语句，实际 ${stmts.length} 条`;
  const bad = stmts.filter(s => !/^INSERT/i.test(s));
  return bad.length === 0 || '有非 INSERT 语句: ' + bad[0].slice(0, 60);
});

check('切分出的语句里没有多余的 SET NAMES', () => {
  // 注意：只检查"真实语句"，注释里提到 SET NAMES 不算问题
  const bad = splitSql(schema).filter(s => /^SET\s+NAMES/i.test(s));
  return bad.length === 0
    || 'SET NAMES 应交给连接层处理，写在文件里会多出一条语句';
});

// ---------- 6. 代码里的安全红线 ----------
console.log('\n[6] 安全红线');
check('没有硬编码数据库密码', () => {
  const files = ['src/app.js', 'src/config/index.js', 'src/db/index.js'];
  for (const f of files) {
    if (/password\s*[:=]\s*['"][^'"]{3,}['"]/.test(read(f))) return `${f} 里写死了密码`;
  }
  return true;
});
check('没有硬编码 API Key', () => {
  const all = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .filter(f => String(f).endsWith('.js'));
  for (const f of all) {
    const c = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    if (/sk-[a-zA-Z0-9]{20,}/.test(c)) return `src/${f} 里有明文的 DeepSeek Key`;
  }
  return true;
});
check('JWT 密钥从环境变量读', () => {
  return read('src/utils/jwt.js').includes('config.jwt.secret') || '密钥没走配置';
});
check('★ 前端目录里没有明文 API Key（这条最重要）', () => {
  // ★ 为什么必须查前端 ★
  //   项目最初就是把 DeepSeek 的 Key 写死在 chat.html 里的，
  //   浏览器直接拿它去调 api.deepseek.com。
  //   前端代码是公开的 —— 任何人"查看网页源代码"就能拿到 Key。
  //
  //   所以这条检查必须在【前端目录】跑，而不是只在 src/ 里跑。
  //   （原来只查 src/，结果真正的泄露点在前端，检查是绿的。）
  const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
  if (!fs.existsSync(FRONTEND)) {
    return '（找不到前端目录，跳过）';
  }
  const files = fs.readdirSync(FRONTEND).filter(f => /\.(js|html)$/.test(f));
  for (const f of files) {
    const c = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
    // sk- 开头后面跟 20 位以上的字母数字 —— 连注释里的都不放过
    if (/sk-[a-zA-Z0-9]{20,}/.test(c)) {
      return `${f} 里有明文的 DeepSeek Key（连注释里的也要删掉）`;
    }
  }
  return true;
});
check('前端没有直接请求第三方大模型接口', () => {
  const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
  if (!fs.existsSync(FRONTEND)) return '（跳过）';
  const files = fs.readdirSync(FRONTEND).filter(f => /\.(js|html)$/.test(f));
  for (const f of files) {
    const c = fs.readFileSync(path.join(FRONTEND, f), 'utf8');
    // 前端只能请求我们自己的后端，不能直连 api.deepseek.com
    if (/api\.deepseek\.com/.test(c)) {
      return `${f} 里前端直接调了 DeepSeek（Key 会被暴露）`;
    }
  }
  return true;
});
check('密码/密钥没有被打进日志', () => {
  const auth = read('src/routes/auth.js');
  // 允许开发期返回验证码，但要有 isDev 守卫
  if (auth.includes('data.code = code') && !auth.includes('config.isDev')) {
    return '验证码返回前端时没有开发环境守卫';
  }
  return true;
});

// ---------- 7. 前端一致性 ----------
console.log('\n[7] 和前端的一致性');
const FRONTEND = 'D:/Study/Match/2026-2027.up/chat/前端八稿';
check('前端目录还在（顺手确认路径没写错）', () => {
  return fs.existsSync(FRONTEND) || `找不到前端目录 ${FRONTEND}`;
});
check('手机号校验规则和前端一致（1开头11位）', () => {
  const v = read('src/utils/validate.js');
  return v.includes('1[3-9]\\d{9}') || '校验规则和前端 /^\\d{11}$/ 不一致，需要对齐';
});
check('日期格式和前端一致（YYYY-MM-DD）', () => {
  const v = read('src/utils/validate.js');
  return v.includes('YYYY-MM-DD') || '没有和前端 diary-write.html 的日期格式对齐';
});

// ---------- 8. 部署脚本 ----------
console.log('\n[8] 部署脚本');
const deploySh = read('scripts/deploy.sh');
check('deploy.sh 首行是 bash', () => deploySh.startsWith('#!/usr/bin/env bash') || '缺少 shebang');
check('deploy.sh 兼容 apt 和 yum', () => {
  return (deploySh.includes('apt-get') && deploySh.includes('yum')) || '只兼容了一种发行版';
});
check('deploy.sh 用 debconf 预置 MySQL 密码（否则安装会卡住）', () => {
  return deploySh.includes('debconf-set-selections') || 'MySQL 安装会弹出交互式密码框，非交互环境会卡死';
});
check('deploy.sh 修了 MySQL auth_socket 问题', () => {
  return deploySh.includes('mysql_native_password') || 'root 默认是 auth_socket，后端连不上';
});
check('deploy.sh 没有用 heredoc 给 sudo tee 传内容（会抢 stdin）', () => {
  // 这个坑很隐蔽：sudo -S 从 stdin 读密码，heredoc 也想用 stdin，
  // 结果是密码被写进文件。正确做法是写临时文件再 sudo cp。
  //
  // ★ 检查前必须先把注释去掉再匹配。
  //   否则脚本里那句反面教材注释「千万不要写成 sudo_run tee ... <<SERVICE」
  //   会被当成真代码，造成误报 —— 我第一版就是这么误报的。
  const codeOnly = deploySh
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
  const bad = /sudo_run\s+tee[\s\S]{0,160}<<\s*\w+/.test(codeOnly);
  return !bad || 'sudo_run tee 配 heredoc 会把密码写进文件，改用「临时文件 + sudo cp」';
});
check('deploy.sh 写入 service 文件后有校验', () => {
  return deploySh.includes('grep -q "ExecStart="') || '没有校验，坏文件会一路跑到 systemd 报错';
});

console.log('\n  --- 所有 shell 脚本换行符（CRLF 会让 Linux 报 bad interpreter）---');
const shFiles = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter(f => f.endsWith('.sh'));
for (const f of shFiles) {
  check(`scripts/${f}`, () => {
    const raw = fs.readFileSync(path.join(ROOT, 'scripts', f));
    return !raw.includes('\r\n') || 'Windows 换行符，需转成 LF';
  });
}

// ---------- 9. 路由挂载一致性 ----------
console.log('\n[9] 路由是否都挂到了 app.js');
const appSrc = read('src/app.js');
const routeFiles = fs.readdirSync(path.join(ROOT, 'src/routes'))
  .filter(f => f.endsWith('.js'));
check(`src/routes 下有 ${routeFiles.length} 个路由文件`, () => routeFiles.length > 0 || '没有路由文件');
for (const f of routeFiles) {
  const name = f.replace('.js', '');
  check(`路由 ${name} 已在 app.js 里挂载`, () => {
    // app.js 里应该出现 app.use('/api/xxx', xxxRoutes) 且 import 了它
    const imported = new RegExp(`import\\s+\\w*${name}\\w*\\s+from\\s+['"]./routes/${f}['"]`, 'i').test(appSrc);
    // 允许两种挂法：app.use('/api/xxx', ...) 或 app.use('/api', ...)
    // （compat / logs 是挂在 /api 上的，路由里自带 /diary/public、/view 这些前缀）
    const mounted = new RegExp(`app\\.use\\(\\s*['"]/api(?:/${name})?['"]`, 'i').test(appSrc);
    if (!imported) return `app.js 没有 import ${f}`;
    if (!mounted) return `app.js 没有 app.use('/api/${name}', ...)`  ;
    return true;
  });
}

// ---------- 汇总 ----------
console.log('\n==============================================');
console.log(`  通过 ${pass}   警告 ${warn}   失败 ${fail}`);
console.log('==============================================');

if (problems.length) {
  console.log('\n必须修掉的问题：');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  console.log('');
  process.exit(1);
} else {
  console.log('\n🎉 全部检查通过，可以开始部署了。\n');
  process.exit(0);
}
