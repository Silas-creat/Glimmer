// ============================================================
//  数据库迁移：漂流瓶表结构升级
//
//  用法：  node scripts/migrate.js
//          node scripts/migrate.js --dry-run    只看会做什么，不改
//
//  为什么需要这个脚本，而不是直接改 schema.sql 重跑 initdb：
//    initdb 用的是 CREATE TABLE IF NOT EXISTS，
//    对【已存在】的表它什么都不会做 —— 表结构改了它也不会生效。
//    所以对已经在跑的数据库，必须写 ALTER 迁移。
//
//  这次迁移做了三件事：
//    1. 新建 bottle_picks 表（支持"一个瓶子被多人捞到"）
//    2. bottles 表加 is_anon 字段（漂流瓶默认匿名）
//    3. bottles.status 的枚举值从 floating/picked/removed
//       改成 floating/removed —— 因为"有没有被捞"现在由
//       bottle_picks 表记录，status 只表示"还在不在海里"
//
//  每个步骤都是幂等的（先检查再执行），可以重复运行。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne, execute, pool } from '../src/db/index.js';
import { config } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

/** 表是否存在 */
async function tableExists(name) {
  const r = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = ?`,
    [config.db.database, name]
  );
  return Number(r.n) > 0;
}

/** 某张表有没有某个字段 */
async function columnExists(table, column) {
  const r = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [config.db.database, table, column]
  );
  return Number(r.n) > 0;
}

/** 某张表的某个字段的完整定义（含枚举值） */
async function columnType(table, column) {
  const r = await queryOne(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
    [config.db.database, table, column]
  );
  return r ? r.t : '';
}

/** 索引是否存在 */
async function indexExists(table, indexName) {
  const r = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
    [config.db.database, table, indexName]
  );
  return Number(r.n) > 0;
}

/** 外键是否存在 */
async function fkExists(table, fkName) {
  const r = await queryOne(
    `SELECT COUNT(*) AS n FROM information_schema.table_constraints
      WHERE table_schema = ? AND table_name = ? AND constraint_name = ?
        AND constraint_type = 'FOREIGN KEY'`,
    [config.db.database, table, fkName]
  );
  return Number(r.n) > 0;
}

let changed = 0;
let skipped = 0;

async function step(desc, fn) {
  process.stdout.write(`  → ${desc} ... `);
  try {
    const result = await fn();
    if (result === 'skip') {
      console.log('\x1b[33m跳过（已经做过）\x1b[0m');
      skipped++;
    } else if (result === 'dry') {
      // dry-run 时被守卫拦住，什么都没执行
      console.log('\x1b[36m需要做（试运行，未执行）\x1b[0m');
      changed++;
    } else {
      console.log('\x1b[32m完成\x1b[0m');
      changed++;
    }
  } catch (e) {
    console.log('\x1b[31m失败\x1b[0m');
    throw e;
  }
}

// ============================================================
async function migrateBottles() {
  console.log('\n[1] 漂流瓶：更新 status 枚举');
  // 旧枚举里的 'picked' 现在由 bottle_picks 表表达，status 只表示在不在海里。
  // 先把已有的 picked 数据改成 floating（它们本来就是还在的瓶子），
  // 再改枚举定义。
  await step('把 status=\'picked\' 的旧数据改成 \'floating\'', async () => {
    const n = await execute("UPDATE bottles SET status = 'floating' WHERE status = 'picked'");
    if (n === 0) return 'skip';
    console.log(`\n     （改了 ${n} 行）`);
    return n;
  });

  await step('修改 status 枚举为 floating/removed', async () => {
    const t = await columnType('bottles', 'status');
    if (!t.includes("'picked'")) return 'skip';   // 已经是新定义
    if (DRY) return 'dry';
    await execute(
      "ALTER TABLE bottles MODIFY COLUMN `status` ENUM('floating','removed') NOT NULL DEFAULT 'floating' COMMENT '漂着/被撤回'"
    );
    return true;
  });

  console.log('\n[2] 漂流瓶：加 is_anon 字段（匿名）');
  await step('添加 bottles.is_anon', async () => {
    if (await columnExists('bottles', 'is_anon')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      "ALTER TABLE bottles ADD COLUMN `is_anon` TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1匿名' AFTER content"
    );
    return true;
  });

  console.log('\n[3] 漂流瓶：加 user_id 索引');
  await step('添加 idx_user 索引', async () => {
    if (await indexExists('bottles', 'idx_user')) return 'skip';
    if (DRY) return 'dry';
    await execute('ALTER TABLE bottles ADD KEY `idx_user` (`user_id`)');
    return true;
  });

  console.log('\n[4] 漂流瓶：删除不再使用的 picked_by / picked_at');

  // 先删外键（如果有），再删字段
  await step('删除 picked_by 上的外键（如果有）', async () => {
    const fks = await query(
      `SELECT constraint_name AS n FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = 'bottles' AND column_name = 'picked_by'
          AND referenced_table_name IS NOT NULL`,
      [config.db.database]
    );
    if (fks.length === 0) return 'skip';
    if (DRY) return 'dry';
    for (const f of fks) {
      await execute(`ALTER TABLE bottles DROP FOREIGN KEY \`${f.n}\``);
    }
    return true;
  });

  await step('删除 picked_by 字段', async () => {
    if (!(await columnExists('bottles', 'picked_by'))) return 'skip';
    if (DRY) return 'dry';
    await execute('ALTER TABLE bottles DROP COLUMN picked_by');
    return true;
  });

  await step('删除 picked_at 字段', async () => {
    if (!(await columnExists('bottles', 'picked_at'))) return 'skip';
    if (DRY) return 'dry';
    await execute('ALTER TABLE bottles DROP COLUMN picked_at');
    return true;
  });
}

// ============================================================
async function createBottlePicks() {
  console.log('\n[5] 新建 bottle_picks 表（支持一个瓶子被多人捞到）');
  await step('创建 bottle_picks', async () => {
    if (await tableExists('bottle_picks')) return 'skip';
    if (DRY) return 'dry';
    await execute(`
      CREATE TABLE \`bottle_picks\` (
        \`id\`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`bottle_id\`  BIGINT UNSIGNED NOT NULL,
        \`user_id\`    BIGINT UNSIGNED NOT NULL COMMENT '谁捞的',
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_bottle_user\` (\`bottle_id\`, \`user_id\`),
        KEY \`idx_user_time\` (\`user_id\`, \`created_at\`),
        CONSTRAINT \`fk_pick_bottle\` FOREIGN KEY (\`bottle_id\`) REFERENCES \`bottles\` (\`id\`) ON DELETE CASCADE,
        CONSTRAINT \`fk_pick_user\`   FOREIGN KEY (\`user_id\`)   REFERENCES \`users\` (\`id\`)   ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='捞漂流瓶记录'
    `);
    return true;
  });
}

// ============================================================
//  私信：加"拉黑"和"未读冗余"支持
//
//  1. conversations.blocked_by  谁拉黑了谁（否则骚扰无法阻止）
//  2. messages.status           被机器人拦下的消息留痕
//     —— 拦下来的内容不该发出去，但管理员需要能看到
//        "这个人试图发广告"，所以存起来但标记 blocked
// ============================================================
async function migrateDirectMessages() {
  console.log('\n[7] 私信：加拉黑和拦截留痕');

  await step('添加 conversations.blocked_by', async () => {
    if (await columnExists('conversations', 'blocked_by')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      'ALTER TABLE conversations ADD COLUMN `blocked_by` BIGINT UNSIGNED NULL '
      + "COMMENT '谁拉黑了这段会话' AFTER unread_b"
    );
    return true;
  });

  await step('添加 conversations.last_from', async () => {
    // 记一下最后一条是谁发的，前端列表要显示"我：xxx"还是"xxx：yyy"
    if (await columnExists('conversations', 'last_from')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      'ALTER TABLE conversations ADD COLUMN `last_from` BIGINT UNSIGNED NULL '
      + 'COMMENT \'最后一条消息的发送者\' AFTER last_msg'
    );
    return true;
  });

  await step('添加 messages.status', async () => {
    if (await columnExists('messages', 'status')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      "ALTER TABLE messages ADD COLUMN `status` ENUM('normal','blocked') NOT NULL "
      + "DEFAULT 'normal' COMMENT 'blocked=被机器人拦下的内容（留痕不展示）' AFTER is_read"
    );
    return true;
  });

  await step('给 messages.from_user 加索引（查会话列表要用）', async () => {
    if (await indexExists('messages', 'idx_from')) return 'skip';
    if (DRY) return 'dry';
    await execute('ALTER TABLE messages ADD KEY `idx_from` (`from_user`)');
    return true;
  });
}

// ============================================================
//  私信：每个用户各自的"已删除"标记
//
//  ★ 这是我第一版设计错的地方 ★
//
//  原来的实现：删会话就把 last_time 清成 NULL，
//  而会话列表查询里写了 `WHERE last_time IS NOT NULL`。
//  结果：**我删了会话，对方也看不到了** —— 因为清的是同一行。
//
//  正确做法：记录"每个人各自什么时候删的"：
//    deleted_by_a / deleted_by_b
//  列表查询里判断：如果这条消息是在我删除之后来的，就重新显示。
//  这样删会话只影响自己的列表，对方完全不受影响。
// ============================================================
async function migrateConversationDeletes() {
  console.log('\n[9] 私信：每个用户各自的已删除标记');

  await step('添加 conversations.deleted_by_a', async () => {
    if (await columnExists('conversations', 'deleted_by_a')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      'ALTER TABLE conversations ADD COLUMN `deleted_by_a` DATETIME(3) NULL '
      + "COMMENT 'a 什么时候把会话从自己列表里删了' AFTER blocked_by"
    );
    return true;
  });

  await step('添加 conversations.deleted_by_b', async () => {
    if (await columnExists('conversations', 'deleted_by_b')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      'ALTER TABLE conversations ADD COLUMN `deleted_by_b` DATETIME(3) NULL '
      + "COMMENT 'b 什么时候把会话从自己列表里删了' AFTER deleted_by_a"
    );
    return true;
  });
}

// ============================================================
//  时间字段统一到毫秒精度
//
//  ★ 这是被测试逼出来的一个真 bug，而且我修了两次才修对 ★
//
//  【第一次尝试】发现问题：messages.created_at 是 DATETIME（秒级），
//  用它算频控会少算近 1 秒。于是把 7 个 created_at 改成 DATETIME(3)。
//
//  【结果：更糟了】因为**只改了一边**。`NOW()` 返回的是秒级时间，
//  而 created_at 变成了毫秒级，两边精度不对称，于是：
//      TIMESTAMPDIFF(MICROSECOND, created_at, NOW())
//  在刚插入时会返回【负数】（比如 created_at=.902，NOW()=.000，
//  算出来 -902000 微秒）。实测就是这样：
//      刚插入    ago_us = -902000
//      等1.6秒后 ago_us = 1098000   ← 本该 1615000，少了 created_at 的小数部分
//  结果 1.6 秒的等待被判定成 1.098 秒 → 还是"发得太快了"。
//
//  【教训】改精度必须**两边一起改**。混用精度的字段放在同一个表达式里
//  比两个都粗或都细更危险 —— 因为差值会莫名其妙地偏。
//
//  【最终做法】把所有 DATETIME 列统一成 DATETIME(3)，
//  并且所有比较/赋值都用 NOW(3) / CURRENT_TIMESTAMP(3)。
//  全都一样就没有不对称。
//
//  存储代价：DATETIME(3) 比 DATETIME 多 1 字节（5→6）。
//  100 万行才多 1MB，完全可以接受。
// ============================================================
async function migrateTimestamps() {
  console.log('\n[8] 时间字段统一到毫秒精度（DATETIME(3)）');
  // 从 information_schema 里把所有还没精度的 DATETIME 列捞出来，
  // 这样以后新加的表/字段也会被自动覆盖，不用手工维护清单
  const cols = await query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, IS_NULLABLE AS n,
            COLUMN_DEFAULT AS d, EXTRA AS e
       FROM information_schema.columns
      WHERE table_schema = ?
        AND DATA_TYPE = 'datetime'
        AND (DATETIME_PRECISION IS NULL OR DATETIME_PRECISION = 0)
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [config.db.database]
  );

  if (cols.length === 0) {
    console.log('  （所有 DATETIME 列都已经是毫秒精度了）');
    return;
  }

  console.log(`  找到 ${cols.length} 个秒级 DATETIME 列，逐个升级：\n`);

  for (const col of cols) {
    await step(`${col.t}.${col.c}`, async () => {
      if (DRY) return 'dry';

      // ★ 关键：modify 的时候要把原来的 NULL / DEFAULT / ON UPDATE 全带上 ★
      //   只写 `MODIFY COLUMN x DATETIME(3) NOT NULL` 会把
      //   DEFAULT CURRENT_TIMESTAMP 和 ON UPDATE 丢掉，
      //   之后插入数据就会报 "Field 'created_at' doesn't have a default value"。
      const parts = [`\`${col.c}\` DATETIME(3)`];
      parts.push(col.n === 'YES' ? 'NULL' : 'NOT NULL');

      if (col.d && /CURRENT_TIMESTAMP/i.test(col.d)) {
        parts.push('DEFAULT CURRENT_TIMESTAMP(3)');
      } else if (col.d !== null && col.d !== undefined) {
        parts.push(`DEFAULT '${col.d}'`);
      }

      // EXTRA 里可能有 "on update CURRENT_TIMESTAMP"
      if (col.e && /on update CURRENT_TIMESTAMP/i.test(col.e)) {
        parts.push('ON UPDATE CURRENT_TIMESTAMP(3)');
      }

      await execute(
        `ALTER TABLE \`${col.t}\` MODIFY COLUMN ${parts.join(' ')}`
      );
      return true;
    });
  }
}

// ============================================================
//  AI 记忆：用消息 id 当游标，而不是用条数当游标
//
//  ★ 这是被测试逼出来的一个设计修正 ★
//
//  原来的实现：压完摘要就把 ai_profiles.msg_count 重置成 KEEP_RECENT(8)，
//  下次攒到 20 再压"最早 12 条"。
//
//  问题：第二次压缩取的还是"最早的 12 条"，而那些已经被压过一次了，
//        真正没压过的中间部分永远轮不到。
//        实测：总共有 20 条消息，但摘要里只覆盖了 8 条 —— 中间的丢了。
//
//  正确做法：记住"已经压到哪条消息了"（summary_until_id）。
//  下次从这条之后开始压，只压到"最近 KEEP_RECENT 条之前"。
//  这样每一条消息都恰好被压一次。
// ============================================================
async function migrateAiMemory() {
  console.log('\n[10] AI 记忆：加"已压缩到哪条消息"的游标');

  await step('添加 ai_profiles.summary_until_id', async () => {
    if (await columnExists('ai_profiles', 'summary_until_id')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      'ALTER TABLE ai_profiles ADD COLUMN `summary_until_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 '
      + "COMMENT '已经压缩进 summary 的最后一条消息 id（游标，别用条数）' AFTER msg_count"
    );
    return true;
  });
}

// ============================================================
//  通用：确保所有 schema.sql 里的表都存在
//  （以后加新表时，直接跑这个脚本就能补上）
// ============================================================
async function ensureAllTablesFromSchema() {
  console.log('\n[6] 补齐 schema.sql 里所有缺失的表');

  const schemaPath = path.join(ROOT, 'sql', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.log('  ⚠️  找不到 sql/schema.sql，跳过');
    return;
  }

  const { splitSql, parseTableNames } = await import('../src/utils/sql.js');
  const raw = fs.readFileSync(schemaPath, 'utf8');
  const statements = splitSql(raw);
  const names = parseTableNames(raw);

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    await step(`表 ${name}`, async () => {
      // ★ --dry-run 的检查必须放在最前面！
      //   我第一版把"表已存在"的判断放在它前面，
      //   结果试运行时照样执行了 CREATE TABLE（因为表确实不存在，
      //   代码就往下一步走了）—— 试运行居然改了数据库，这绝对不行。
      if (DRY) return 'dry';
      if (await tableExists(name)) return 'skip';
      // 找到创建这张表的那条语句
      const stmt = statements.find(s => s.includes(`\`${name}\``) && /^CREATE TABLE/i.test(s));
      if (!stmt) throw new Error('在 schema.sql 里找不到建表语句');
      await execute(stmt);
      return true;
    });
  }
}

// ============================================================
async function main() {
  console.log('==============================================');
  console.log('  数据库迁移' + (DRY ? '（试运行，不会真的改）' : ''));
  console.log('  库: ' + config.db.database);
  console.log('==============================================');

  try {
    // 迁移前先确认能连上
    await query('SELECT 1');
  } catch (e) {
    console.log('\n❌ 连不上数据库：' + e.message);
    console.log('   先检查 .env 里的 DB_PASSWORD 和 MySQL 是否在跑\n');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  try {
    await migrateBottles();
    await createBottlePicks();
    await migrateDirectMessages();
    await migrateConversationDeletes();
    await migrateTimestamps();
    await migrateAiMemory();
    await ensureAllTablesFromSchema();
  } catch (e) {
    console.log('\n❌ 迁移失败：' + e.message);
    console.log('   数据库可能处于中间状态，修好之后重新跑一次即可（脚本是幂等的）\n');
    process.exitCode = 1;
    await pool.end();
    return;
  }

  // ---------- 单点登录：users 补两列 ----------
  //
  //  为什么要在迁移脚本里做：
  //    schema.sql 用的是 CREATE TABLE IF NOT EXISTS，
  //    对【已经存在】的 users 表它不会加列。
  //    所以别人那边正在跑的库，必须靠 ALTER 补上，
  //    否则一登录就报 Unknown column 'session_version'。
  console.log('\n[?] 单点登录：users 加 session_version / session_device');

  await step('添加 users.session_version', async () => {
    if (await columnExists('users', 'session_version')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      "ALTER TABLE users ADD COLUMN `session_version` INT UNSIGNED NOT NULL DEFAULT 0 "
      + "COMMENT '每次登录 +1；token 里带着它，旧设备立刻失效' AFTER last_login"
    );
    return true;
  });

  await step('添加 users.session_device', async () => {
    if (await columnExists('users', 'session_device')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      "ALTER TABLE users ADD COLUMN `session_device` VARCHAR(64) NULL "
      + "COMMENT '最后一次登录的设备标识' AFTER session_version"
    );
    return true;
  });

  // ---------- follows 唯一索引（防止重复关注）----------
  console.log('\n[?] 关注关系：去重 + 补唯一索引');
  await step('清理重复关注', async () => {
    const dupRows = await query(
      `SELECT user_id, target_id, MIN(id) AS keep_id, COUNT(*) AS n
         FROM follows GROUP BY user_id, target_id HAVING n > 1`
    );
    if (!dupRows.length) return 'skip';
    if (DRY) return 'dry';
    let removed = 0;
    for (const r of dupRows) {
      const del = await execute(
        'DELETE FROM follows WHERE user_id = ? AND target_id = ? AND id <> ?',
        [r.user_id, r.target_id, r.keep_id]
      );
      removed += Number(del) || 0;
    }
    return '删掉 ' + removed + ' 条重复关注';
  });

  await step('补 follows 唯一索引', async () => {
    const idx = await query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'follows'
          AND INDEX_NAME = 'uk_user_target'`
    );
    if (Number(idx[0].n) > 0) return 'skip';
    if (DRY) return 'dry';
    await execute('ALTER TABLE follows ADD UNIQUE KEY `uk_user_target` (`user_id`, `target_id`)');
    return true;
  });

  // ---------- 加好友问候：messages 补 is_sys ----------
  console.log('\n[?] 加好友问候：messages 加 is_sys');
  await step('添加 messages.is_sys', async () => {
    if (await columnExists('messages', 'is_sys')) return 'skip';
    if (DRY) return 'dry';
    await execute(
      "ALTER TABLE messages ADD COLUMN `is_sys` TINYINT(1) NOT NULL DEFAULT 0 "
      + "COMMENT '1=系统提示消息' AFTER content"
    );
    return true;
  });

  // ---------- 报告 ----------
  const tables = await query('SHOW TABLES');
  console.log('\n==============================================');
  console.log(`  迁移结束：改了 ${changed} 处，跳过 ${skipped} 处`);
  console.log(`  当前共 ${tables.length} 张表`);
  console.log('==============================================\n');

  await pool.end();
}

main().catch(async (e) => {
  console.error('脚本异常：', e);
  try { await pool.end(); } catch { /* 忽略 */ }
  process.exitCode = 1;
});
