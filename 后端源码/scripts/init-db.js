// ============================================================
//  一键建库建表
//  用法：  npm run initdb
//
//  它干三件事：
//    1. 用你给的账号连上 MySQL（不指定数据库，因为库可能还不存在）
//    2. CREATE DATABASE IF NOT EXISTS peizhe
//    3. 切到 peizhe，执行 sql/schema.sql 建表、sql/seed.sql 塞初始数据
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config, ROOT, checkConfig } from '../src/config/index.js';
import { splitSql } from '../src/utils/sql.js';

async function run() {
  console.log('==============================================');
  console.log('  「陪着」数据库初始化');
  console.log('==============================================');

  // ---- 自检 ----
  const { problems } = checkConfig();
  if (problems.length) {
    console.log('\n❌ 配置有问题，先解决这些：');
    problems.forEach(p => console.log('   - ' + p));
    console.log('\n   提示：复制 .env.example 为 .env，填好 DB_PASSWORD 再跑。\n');
    process.exit(1);
  }

  const { host, port, user, password, database } = config.db;
  console.log(`\n目标 MySQL : ${user}@${host}:${port}`);
  console.log(`目标数据库 : ${database}\n`);

  // ---- 1. 不带库名连接 ----
  let conn;
  try {
    conn = await mysql.createConnection({
      host, port, user, password,
      multipleStatements: false,
      charset: 'utf8mb4',
    });
  } catch (e) {
    console.log('❌ 连不上 MySQL：' + e.message);
    console.log('\n   排查清单：');
    console.log('   1) MySQL 服务起了吗？  systemctl status mysqld  或  service mysql status');
    console.log('   2) .env 里的 DB_PASSWORD 对吗？（就是 mysql -uroot -p 那个密码）');
    console.log('   3) 端口对吗？默认 3306，改过的话在 .env 里改 DB_PORT');
    console.log('   4) root 是否只允许本机登录？——后端在同一台虚拟机，用 127.0.0.1 就没问题\n');
    process.exit(1);
  }
  const [verRow] = await conn.query('SELECT VERSION() AS v');
  console.log(`✅ 已连上 MySQL，版本 ${verRow[0].v}`);

  // ---- 2. 建库 ----
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\`
     DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
  );
  console.log(`✅ 数据库 \`${database}\` 已就绪`);
  await conn.end();

  // ---- 3. 连到目标库执行 SQL ----
  conn = await mysql.createConnection({
    host, port, user, password,
    database,
    charset: 'utf8mb4',
    multipleStatements: false,
  });

  for (const file of ['schema.sql', 'seed.sql']) {
    const full = path.join(ROOT, 'sql', file);
    if (!fs.existsSync(full)) {
      console.log(`⚠️  跳过不存在的文件 ${file}`);
      continue;
    }
    const stmts = splitSql(fs.readFileSync(full, 'utf8'));
    let done = 0;
    for (const sql of stmts) {
      try {
        await conn.query(sql);
        done++;
      } catch (e) {
        // 建表用 IF NOT EXISTS，重复执行不该报错；真报错就说明 SQL 有问题
        console.log(`\n❌ 执行失败（${file} 第 ${done + 1} 条）：`);
        console.log('   ' + sql.slice(0, 160).replace(/\s+/g, ' ') + ' ...');
        console.log('   错误：' + e.message + '\n');
        await conn.end();
        process.exit(1);
      }
    }
    console.log(`✅ ${file} 执行完成（${done} 条语句）`);
  }

  // ---- 4. 报告结果 ----
  const [tables] = await conn.query('SHOW TABLES');
  const [rooms] = await conn.query('SELECT code, name FROM chat_rooms ORDER BY sort');

  console.log('\n----------------------------------------------');
  console.log(`共 ${tables.length} 张表：`);
  console.log('  ' + tables.map(t => Object.values(t)[0]).join(', '));
  console.log(`\n群聊房间 ${rooms.length} 个：`);
  rooms.forEach(r => console.log(`  ${r.code.padEnd(10)} ${r.name}`));
  console.log('----------------------------------------------');
  console.log('\n🎉 数据库初始化完成！下一步：npm start 启动服务\n');

  await conn.end();
}

run().catch(e => {
  console.error('初始化脚本崩了：', e);
  process.exit(1);
});
