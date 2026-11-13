// ============================================================
//  SQL 文件解析工具
//
//  为什么不能简单地 raw.split(';') ？
//    因为字符串里也可能有分号，比如
//      INSERT INTO t VALUES ('a;b');
//    简单切分会把它切成两条，直接报语法错误。
//
//  所以这里写一个"认识引号状态"的切分器：
//    遇到 ' 或 " 就进入字符串状态，字符串里的分号不当分隔符。
//    顺便处理 -- 和 # 开头的注释、/* */ 块注释。
// ============================================================

/**
 * 把一个 .sql 文件拆成一条条可执行的语句
 * @param {string} raw 文件内容
 * @returns {string[]} 语句数组（已去掉注释和空语句）
 */
export function splitSql(raw) {
  const stmts = [];
  let buf = '';
  let i = 0;
  const n = raw.length;

  // 当前状态
  let inSingle = false;   // 在 '...' 里
  let inDouble = false;   // 在 "..." 里
  let inBacktick = false; // 在 `...` 里
  let inLineComment = false;
  let inBlockComment = false;

  while (i < n) {
    const ch = raw[i];
    const next = raw[i + 1];

    // ---- 行注释 ----
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; buf += '\n'; }
      i++;
      continue;
    }
    // ---- 块注释 ----
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }
    // ---- 字符串 ----
    if (inSingle) {
      buf += ch;
      // 处理转义：\' 或 ''
      if (ch === '\\') { buf += next ?? ''; i += 2; continue; }
      if (ch === "'") {
        if (next === "'") { buf += next; i += 2; continue; } // '' 是转义的引号
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '\\') { buf += next ?? ''; i += 2; continue; }
      if (ch === '"') {
        if (next === '"') { buf += next; i += 2; continue; }
        inDouble = false;
      }
      i++;
      continue;
    }
    if (inBacktick) {
      buf += ch;
      if (ch === '`') inBacktick = false;
      i++;
      continue;
    }

    // ---- 普通状态：判断是否进入各种特殊状态 ----
    if (ch === '-' && next === '-') {
      // MySQL 要求 -- 后面跟空格或行尾才算注释
      const after = raw[i + 2];
      if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r') {
        inLineComment = true;
        i += 2;
        continue;
      }
    }
    if (ch === '#') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }

    if (ch === "'") { inSingle = true; buf += ch; i++; continue; }
    if (ch === '"') { inDouble = true; buf += ch; i++; continue; }
    if (ch === '`') { inBacktick = true; buf += ch; i++; continue; }

    // ---- 语句结束 ----
    if (ch === ';') {
      const s = buf.trim();
      if (s) stmts.push(s);
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }

  // 最后一条可能没有分号结尾
  const last = buf.trim();
  if (last) stmts.push(last);

  return stmts;
}

/** 从 SQL 里解析出所有被创建的表名 */
export function parseTableNames(schemaSql) {
  return [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`(\w+)`/gi)].map(m => m[1]);
}
