// ============================================================
//  修重名：库里出现两个「小海」的时候，把晚建的那个改名
//
//  为什么会重名：
//    注册接口会查重，但 seed-demo.js 直接写库、不查重。
//    所以「先用 180xxx 注册了一个叫小海的账号」+「再跑一键安装灌演示数据」
//    就会得到两个小海，好友列表里像是一个人出现了两次。
//
//  用法：
//    node scripts/fix-duplicate-nick.js          // 只看，不改
//    node scripts/fix-duplicate-nick.js --apply  // 真的改名
//
//  规则：同一昵称只保留「最早创建」的那个，其余改成「昵称·id后4位」
//        （比如 小海 → 小海·1508），并打印出来。
// ============================================================
import { query, execute, pool } from '../src/db/index.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  // 按昵称分组（去空格 + 忽略大小写），找出重复的
  const groups = await query(`
    SELECT TRIM(nickname) AS nick, COUNT(*) AS n
      FROM users
     GROUP BY TRIM(nickname)
    HAVING n > 1
     ORDER BY n DESC
  `);

  if (!groups.length) {
    console.log('✅ 没有重名账号');
    return;
  }

  console.log('发现 ' + groups.length + ' 组重名：\n');

  let planned = 0;

  for (const g of groups) {
    const rows = await query(
      `SELECT u.id, u.phone, u.nickname, u.created_at,
              (SELECT COUNT(*) FROM diaries d WHERE d.user_id = u.id) AS diaries,
              (SELECT COUNT(*) FROM messages m WHERE m.from_user = u.id) AS msgs
         FROM users u
        WHERE TRIM(u.nickname) = ?
        ORDER BY u.id ASC`,
      [g.nick]
    );

    console.log('  昵称「' + g.nick + '」有 ' + rows.length + ' 个：');
    rows.forEach((r, i) => {
      console.log('    ' + (i === 0 ? '保留 ' : '改名 →')
        + ' id=' + r.id + '  手机=' + r.phone
        + '  日记=' + r.diaries + '  发出私信=' + r.msgs
        + '  建于=' + String(r.created_at).slice(0, 19));
    });

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const newNick = g.nick + '·' + String(r.phone).slice(-4);
      // 万一新名字也被占了，加 id 兜底
      const clash = await query(
        'SELECT id FROM users WHERE TRIM(nickname) = ? AND id <> ?',
        [newNick, r.id]
      );
      const finalNick = clash.length ? newNick + '-' + r.id : newNick;

      if (APPLY) {
        await execute('UPDATE users SET nickname = ? WHERE id = ?', [finalNick, r.id]);
        console.log('    ✅ 已改名：' + r.nickname + ' → ' + finalNick + '（id=' + r.id + '）');
      } else {
        console.log('    （预览）会改名：' + r.nickname + ' → ' + finalNick + '（id=' + r.id + '）');
      }
      planned++;
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('上面只是预览。确认没问题后加 --apply 真的改：');
    console.log('  node scripts/fix-duplicate-nick.js --apply\n');
  } else {
    console.log('✅ 处理完成，共改名 ' + planned + ' 个账号');
  }
}

main()
  .catch(e => { console.error('出错：' + e.message); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (e) {} });
