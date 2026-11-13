// ============================================================
//  补救脚本：把测试账号恢复到干净状态
//
//  用法：  node scripts/fix-test-account.js
//
//  什么时候需要跑：
//    测试脚本中途崩溃时，可能来不及还原被测账号，
//    结果账号昵称变成 "前端测试22066"、地址变成测试用的"浙江省…"。
//    跑这个脚本就能恢复。
//
//  它做三件事：
//    1. 把 13800138000 这个测试账号的昵称/资料恢复成干净状态
//    2. 清掉测试过程中自动注册出来的垃圾账号
//    3. 清掉 uploads 目录里的孤儿文件（数据库里没人引用的）
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryOne, execute, pool } from '../src/db/index.js';
import { config } from '../src/config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_PHONE = '13800138000';
const CLEAN_NICKNAME = '林小满';   // 前端原型里用的名字

async function main() {
  console.log('==============================================');
  console.log('  恢复测试账号 / 清理测试垃圾');
  console.log('==============================================');

  // ---------- 1. 恢复主测试账号 ----------
  console.log('\n[1] 恢复主测试账号 ' + TEST_PHONE);
  const user = await queryOne('SELECT id, uid, nickname FROM users WHERE phone = ?', [TEST_PHONE]);

  if (!user) {
    console.log('  ⚠️  这个账号不存在，跳过（下次登录会自动创建）');
  } else {
    console.log(`  当前: id=${user.id} uid=${user.uid} 昵称=${user.nickname}`);

    // 昵称恢复成干净的名字（重名的话加个后缀）
    let nickname = CLEAN_NICKNAME;
    const dup = await queryOne('SELECT id FROM users WHERE nickname = ? AND id <> ?', [nickname, user.id]);
    if (dup) nickname = CLEAN_NICKNAME + user.uid.slice(-4);

    await execute('UPDATE users SET nickname = ? WHERE id = ?', [nickname, user.id]);
    await execute(
      `UPDATE user_profiles
          SET signature = '', addr = '', province = '', zodiac = '',
              birth_year = NULL, avatar = ''
        WHERE user_id = ?`,
      [user.id]
    );
    console.log(`  ✅ 已恢复: 昵称=${nickname}，资料字段已清空`);
  }

  // ---------- 2. 清掉垃圾账号 ----------
  console.log('\n[2] 清理测试过程中自动注册的垃圾账号');
  console.log('    规则：没有任何日记、点赞、收藏、关注、私信、祝福的用户 = 垃圾');

  const before = await queryOne('SELECT COUNT(*) AS n FROM users');
  console.log(`  清理前共 ${before.n} 个用户`);

  // 保留：有日记的、有互动的、有群聊消息的、以及那个主测试账号
  //
  // ★★ 这里必须用 NOT EXISTS，绝不能用 NOT IN ★★
  //
  //  写成 `id NOT IN (SELECT user_id FROM diaries)` 是错的：
  //  只要子查询结果里有【任何 NULL 值】（chat_messages.user_id 允许 NULL，
  //  因为系统消息的 user_id 就是 NULL），`NOT IN` 的整个结果就变成 NULL
  //  而不是 TRUE —— WHERE 条件不成立，结果【一行都删不掉】。
  //  这就是 SQL 里著名的 NOT IN + NULL 陷阱。
  //
  //  我第一版就踩了这个坑：脚本报告"删除 0 个垃圾账号"，
  //  但垃圾账号明明还在。换成 NOT EXISTS 立刻就对了。
  const removed = await execute(
    `DELETE FROM users
      WHERE phone <> ?
        AND NOT EXISTS (SELECT 1 FROM diaries d        WHERE d.user_id   = users.id)
        AND NOT EXISTS (SELECT 1 FROM likes l          WHERE l.user_id   = users.id)
        AND NOT EXISTS (SELECT 1 FROM favorites f      WHERE f.user_id   = users.id)
        AND NOT EXISTS (SELECT 1 FROM follows fo       WHERE fo.user_id  = users.id
                                                          OR fo.target_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM messages m       WHERE m.from_user = users.id
                                                          OR m.to_user   = users.id)
        AND NOT EXISTS (SELECT 1 FROM blessings b      WHERE b.from_user = users.id
                                                          OR b.to_user   = users.id)
        AND NOT EXISTS (SELECT 1 FROM bottles bo       WHERE bo.user_id  = users.id)
        AND NOT EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.user_id  = users.id)
        -- ★ 群聊成员记录也要排除 ★
        --   一开始我漏了这一项，结果"只进过群、没说过话"的测试账号清不掉
        --   （chat_members 里有行，但其他表都没有，看起来像垃圾账号）
        AND NOT EXISTS (SELECT 1 FROM chat_members cmb WHERE cmb.user_id = users.id)`,
    [TEST_PHONE]
  );
  console.log(`  ✅ 删除了 ${removed} 个垃圾账号`);

  // ★ 还剩下谁、为什么删不掉 ★
  //
  //  为什么要打印原因：
  //    脚本原来只说"删除了 0 个"，但不说为什么。
  //    我遇到过好几次"明明看起来是垃圾账号却删不掉"，
  //    只能自己去猜是哪张表挡住了。把原因打出来能省很多时间。
  const survivors = await query('SELECT id, nickname, phone FROM users WHERE phone <> ?', [TEST_PHONE]);
  for (const s of survivors) {
    const reasons = [];
    const checks = [
      ['diaries', 'SELECT COUNT(*) AS n FROM diaries WHERE user_id = ?'],
      ['likes', 'SELECT COUNT(*) AS n FROM likes WHERE user_id = ?'],
      ['favorites', 'SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?'],
      ['follows', 'SELECT COUNT(*) AS n FROM follows WHERE user_id = ? OR target_id = ?'],
      ['messages', 'SELECT COUNT(*) AS n FROM messages WHERE from_user = ? OR to_user = ?'],
      ['blessings', 'SELECT COUNT(*) AS n FROM blessings WHERE from_user = ? OR to_user = ?'],
      ['bottles', 'SELECT COUNT(*) AS n FROM bottles WHERE user_id = ?'],
      ['chat_messages', 'SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?'],
      ['chat_members', 'SELECT COUNT(*) AS n FROM chat_members WHERE user_id = ?'],
    ];
    for (const [table, sql] of checks) {
      const needTwo = (sql.match(/\?/g) || []).length === 2;
      const r = await queryOne(sql, needTwo ? [s.id, s.id] : [s.id]);
      if (Number(r.n) > 0) reasons.push(`${table}×${r.n}`);
    }
    if (reasons.length > 0) {
      console.log(`  ⏭  ${s.nickname}（id=${s.id}）没被删，因为还有：${reasons.join(' ')}`);
    } else {
      console.log(`  ⚠️  ${s.nickname}（id=${s.id}）明明没有关联数据却没被删 —— 检查一下删除语句`);
    }
  }

  const after = await query('SELECT id, uid, nickname, phone FROM users ORDER BY id');
  console.log(`  清理后剩 ${after.length} 个用户：`);
  after.forEach(u => {
    const masked = u.phone ? u.phone.slice(0, 3) + '****' + u.phone.slice(-4) : '(无)';
    console.log(`    id=${u.id}  uid=${u.uid}  ${u.nickname}  ${masked}`);
  });

  // ---------- 3. 清理孤儿上传文件 ----------
  console.log('\n[3] 清理 uploads 目录里的孤儿文件');
  const files = fs.existsSync(config.uploadDir) ? fs.readdirSync(config.uploadDir) : [];
  if (files.length === 0) {
    console.log('  目录是空的，无需清理');
  } else {
    // 收集数据库里所有还在引用的文件名
    const refs = new Set();
    const avatars = await query('SELECT avatar FROM user_profiles WHERE avatar <> ""');
    avatars.forEach(r => { if (r.avatar && !/^https?:|^data:/.test(r.avatar)) refs.add(r.avatar); });
    const covers = await query('SELECT cover FROM user_profiles WHERE cover <> ""');
    covers.forEach(r => { if (r.cover && !/^https?:|^data:/.test(r.cover)) refs.add(r.cover); });
    const diaryImgs = await query('SELECT img FROM diaries WHERE img <> ""');
    diaryImgs.forEach(r => {
      if (r.img && r.img.includes('/uploads/')) refs.add(r.img.split('/uploads/').pop());
    });

    let deleted = 0;
    for (const f of files) {
      if (!refs.has(f)) {
        try {
          fs.unlinkSync(path.join(config.uploadDir, f));
          console.log(`  已删除孤儿文件: ${f}`);
          deleted++;
        } catch (e) {
          console.log(`  删不掉 ${f}: ${e.message}`);
        }
      }
    }
    console.log(`  ✅ 共检查 ${files.length} 个文件，删除 ${deleted} 个孤儿文件`);
  }

  console.log('\n==============================================');
  console.log('  清理完成');
  console.log('==============================================\n');
}

main()
  .then(async () => {
    // ★ 必须关闭连接池！
    //   因为 import 了 src/db/index.js，池里活着的连接会让 Node
    //   的事件循环一直不退出 —— 表现就是"脚本干完了活但卡住不结束"。
    //   （我第一次跑就卡了 3 分钟直到超时）
    await pool.end();
    process.exitCode = 0;
  })
  .catch(async (e) => {
    console.error('清理失败：', e.message);
    try { await pool.end(); } catch { /* 忽略 */ }
    process.exitCode = 1;
  });
