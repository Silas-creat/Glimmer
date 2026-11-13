// ============================================================
//  「陪着」后端服务入口
//  启动：npm start   （开发时用 npm run dev，改代码自动重启）
// ============================================================
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 取本机局域网 IP（给启动横幅显示用，取不到就回落 127.0.0.1）
function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const a = ni.address;
      // 排除 VMware / Radmin 这类虚拟网卡
      if (a.startsWith('192.168.33.') || a.startsWith('192.168.220.')) continue;
      if (/^(26|25)\./.test(a)) continue;
      return a;
    }
  }
  return '127.0.0.1';
}

import { config, ROOT, checkConfig } from './config/index.js';
import { query, queryOne, testConnection, pool } from './db/index.js';
import { requestLogger } from './middleware/logger.js';
import { notFound, errorHandler } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import diaryRoutes from './routes/diary.js';
import interactRoutes from './routes/interact.js';
import userRoutes from './routes/user.js';
import commentRoutes from './routes/comment.js';
import blessRoutes from './routes/bless.js';
import bottleRoutes from './routes/bottle.js';
import groupRoutes from './routes/group.js';
import messageRoutes from './routes/message.js';
import discoverRoutes from './routes/discover.js';
import aiRoutes from './routes/ai.js';
import companionRoutes from './routes/companion.js';
import logsRoutes from './routes/logs.js';
import compatRoutes from './routes/compat.js';

const app = express();

// ------------------------------------------------------------
//  基础中间件
// ------------------------------------------------------------
app.disable('x-powered-by');

// CORS：开发阶段前端可能从任何地方打开（file://、localhost、局域网IP），
// 所以先全部放开。上线前后把 origin 改成你的真实域名。
app.use(cors({
  origin: true,
  credentials: true,
}));

// 解析 JSON 请求体，限制 10mb（因为头像可能以 base64 传来）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志
app.use(requestLogger);

// 静态上传目录：/uploads/xxx.jpg 能直接访问
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}
app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d' }));

// ------------------------------------------------------------
//  健康检查（最常用的接口，用来确认"服务活着吗"）
// ------------------------------------------------------------
// ============================================================
//  启动自检：老库少了新字段，早点说清楚
//
//  CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段，
//  所以从旧版本升上来的库可能缺 users.session_version，
//  表现是"一点登录就 500"。这里启动时查一下，缺了直接提示怎么修。
// ============================================================
/**
 * 启动时把表结构对齐。
 *
 * ★ 为什么不再只"警告一句" ★
 *   以前这里是发现缺字段就打印一行提示，然后继续启动。
 *   结果前端同学装完一点登录就 500（Unknown column 'session_version'），
 *   控制台那行提示早被刷过去了，只能靠猜。
 *   现在改成：缺什么补什么（补字段用 ALTER，整表缺就用 schema.sql 建一遍），
 *   补不了再打印明确的手动命令。
 */
async function ensureSchema() {
  const needColumns = [
    ['users', 'session_version', "INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '会话版本号（单点登录）'"],
    ['users', 'session_device', "VARCHAR(64) NULL COMMENT '最后登录的设备标识'"],
    ['messages', 'is_sys', "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=系统提示消息'"],
  ];

  try {
    // 1) 库里有表吗？一张都没有就直接建
    const t = await queryOne(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    if (!t || Number(t.n) === 0) {
      const sqlFile = path.join(__dirname, '..', 'sql', 'schema.sql');
      if (fs.existsSync(sqlFile)) {
        console.log('\n[i] 库里还没有表，正在执行 sql/schema.sql 建表……');
        try {
          await executeSqlFile(sqlFile);
          console.log('[i] 建表完成');
        } catch (e) {
          console.log('⚠️  自动建表失败：' + e.message);
          console.log('   请手动执行：cd 后端源码 && node scripts/init-db.js');
          return;
        }
      }
      return;
    }

    // 2) 逐列检查，缺的就补
    for (const [table, column, ddl] of needColumns) {
      const row = await queryOne(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
      );
      const hasTable = await queryOne(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
      );
      if (!hasTable || Number(hasTable.n) === 0) continue;   // 表都没有，跳过（建表走 schema.sql）

      if (!row || Number(row.n) === 0) {
        console.log(`[i] 补字段 ${table}.${column} ……`);
        await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
        console.log(`[i] 已补上 ${table}.${column}`);
      }
    }
  } catch (e) {
    // 数据库还没起来时不打断启动，交给 /api/health 报
    console.log('⚠️  检查表结构失败：' + e.message);
  }
}

/** 用一次性连接执行整个 .sql 文件（允许多语句） */
async function executeSqlFile(file) {
  const sql = fs.readFileSync(file, 'utf8');
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: config.db.charset,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

app.get('/api/health', async (req, res) => {
  let dbOk = false;
  let dbVersion = '';
  let dbError = '';
  try {
    const info = await testConnection();
    dbOk = true;
    dbVersion = info.v;
  } catch (e) {
    dbError = e.message;
  }

  res.json({
    code: 0,
    msg: 'ok',
    data: {
      service: '陪着后端',
      version: '0.1.0',
      env: config.nodeEnv,
      time: new Date().toLocaleString('zh-CN'),
      uptime: Math.floor(process.uptime()) + 's',
      db: { connected: dbOk, version: dbVersion, error: dbError || undefined },
      ai: { configured: Boolean(config.ai.apiKey), model: config.ai.model },
    },
  });
});

// 根路径给个人话提示，方便浏览器直接打开看
app.get('/', (req, res) => {
  res.type('html').send(`
    <meta charset="utf-8">
    <div style="font-family:system-ui;padding:40px;line-height:2">
      <h2>陪着 · 后端服务</h2>
      <p>✅ 服务正在运行</p>
      <p>健康检查：<a href="/api/health">/api/health</a></p>
      <p>接口前缀：<code>/api</code></p>
      <p style="color:#999">这是我写的后端，不是给你看的页面。前端页面在别处。</p>
    </div>
  `);
});

// ------------------------------------------------------------
//  业务路由
// ------------------------------------------------------------
app.use('/api/auth', authRoutes);

// ★ 前端契约路由必须放在具体业务路由之前 ★
//   否则 /api/diary/public 会被 diary.js 里的 /:id 当成 id='public' 吃掉
app.use('/api', compatRoutes);

app.use('/api/diary', diaryRoutes);
app.use('/api/interact', interactRoutes);
app.use('/api/user', userRoutes);
app.use('/api/comment', commentRoutes);
app.use('/api/bless', blessRoutes);
app.use('/api/bottle', bottleRoutes);
app.use('/api/group', groupRoutes);
app.use('/api/message', messageRoutes);
app.use('/api', logsRoutes);   // 浏览记录 /view/*、举报 /report/*
app.use('/api/discover', discoverRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/companion', companionRoutes);

// 前端静态文件（可选）：把前端文件放进 server/public 就能一起托管
const publicDir = path.join(ROOT, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  // 没放 public 目录时，加一句提示，避免以后忘了
  app.use('/app', (req, res) => {
    res.status(404).send('前端文件还没放进来。把 html 文件拷到 server/public/ 目录即可。');
  });
}

// ------------------------------------------------------------
//  收尾：404 和全局错误处理必须放在所有路由之后
// ------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

// ------------------------------------------------------------
//  启动
// ------------------------------------------------------------
async function bootstrap() {
  console.log('\n==============================================');
  console.log('  陪着 · 后端服务启动中...');
  console.log('==============================================');

  const { problems, warnings } = checkConfig();
  if (problems.length) {
    console.log('\n❌ 配置缺失，无法启动：');
    problems.forEach(p => console.log('   - ' + p));
    console.log('');
    process.exit(1);
  }
  if (warnings.length) {
    console.log('\n⚠️  提醒：');
    warnings.forEach(w => console.log('   - ' + w));
  }

  // 先测数据库，连不上就别启动了，否则用户请求全报 500
  try {
    const info = await testConnection();
    console.log(`\n✅ MySQL 连接正常（版本 ${info.v}，库 ${info.db}）`);
  } catch (e) {
    console.log('\n❌ 连不上 MySQL：' + e.message);
    console.log('\n   排查：');
    console.log('   1) 数据库起了吗：  netstat -ano | findstr :3306');
    console.log('   2) 建过表了吗：    npm run initdb');
    console.log('   3) .env 里的密码对吗');
    console.log('');
    process.exit(1);
  }

  // 老库少字段时给个明确提示（不阻断启动）
  await ensureSchema();

  const server = app.listen(config.port, config.host, () => {
    console.log(`\n🚀 服务已启动`);
    console.log(`   本机访问   : http://127.0.0.1:${config.port}`);
    console.log(`   局域网访问 : http://${lanIp()}:${config.port}`);
    console.log(`   健康检查   : http://127.0.0.1:${config.port}/api/health`);
    console.log(`   运行模式   : ${config.nodeEnv}`);
    console.log(`   AI 已配置  : ${config.ai.apiKey ? '是' : '否（DEEPSEEK_API_KEY 未填）'}`);
    console.log('\n   按 Ctrl+C 停止\n');
  });

  // 优雅退出：收到停止信号时先关连接池，别把数据库连接漏在那
  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭服务...`);
    server.close(async () => {
      await pool.end();
      console.log('已安全退出。\n');
      process.exit(0);
    });
    // 5 秒还没关完就强退，防止卡死
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 兜底：任何没被捕获的异常都打出来，不要静默死掉
process.on('unhandledRejection', (reason) => {
  console.error('\n[未处理的 Promise 拒绝]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('\n[未捕获的异常]', err);
});

bootstrap();
