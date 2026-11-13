// 检查测试脚本里 eq() 的调用是否漏了参数
// eq(actual, expected, msg) 需要三个参数，少传会导致断言逻辑颠倒、
// 失败信息也变成一团乱麻（我踩过这个坑）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname);

const files = fs.readdirSync(dir).filter(f => f.startsWith('test-') && f.endsWith('.js'));

let problems = 0;

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');

  // ★ 必须按"整条语句"分析，不能只看一行。
  //   因为断言经常写成多行：
  //     eq((await api('GET', '/api/auth/me', {
  //       token: 'x',
  //     })).status, 401, '未登录 401');
  //   只看第一行会误报"参数不足"。
  //
  //   这里用"按分号断句"的粗略办法把源码切成一条条语句，
  //   语句里可能有换行，但不再有歧义。
  const statements = [];
  {
    let buf = '';
    let depth = 0;
    let inStr = false;
    let quote = '';

    for (let k = 0; k < src.length; k++) {
      const c = src[k];

      if (inStr) {
        buf += c;
        if (c === '\\') { buf += src[k + 1] ?? ''; k++; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inStr = true; quote = c; buf += c; continue; }

      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;

      buf += c;

      // 顶层分号 = 一条语句结束
      if (c === ';' && depth === 0) {
        statements.push(buf);
        buf = '';
      }
    }
    if (buf.trim()) statements.push(buf);
  }

  // 记录每条语句在原文里的起始行号，方便报错定位
  let lineNo = 1;
  const lineOfStatement = statements.map(s => {
    const at = lineNo;
    lineNo += (s.match(/\n/g) || []).length;
    return at;
  });

  statements.forEach((stmt, si) => {
    // 只关心 eq( 开头的断言语句（排除 assertEq 之类）
    const trimmed = stmt.trim();
    if (!/^(eq|truthy)\s*\(/.test(trimmed)) return;

    const isEq = /^eq\s*\(/.test(trimmed);
    const need = isEq ? 3 : 2;

    // 数顶层逗号
    const start = trimmed.indexOf('(') + 1;
    let depth = 0, commas = 0, inStr2 = false, quote2 = '';

    for (let k = start; k < trimmed.length; k++) {
      const c = trimmed[k];
      if (inStr2) {
        if (c === '\\') { k++; continue; }
        if (c === quote2) inStr2 = false;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inStr2 = true; quote2 = c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; continue; }
      if (c === ',' && depth === 0) commas++;
    }

    if (commas < need - 1) {
      console.log(`  ⚠️  ${f}:${lineOfStatement[si]}  ${isEq ? 'eq' : 'truthy'}() 只传了 ${commas + 1} 个参数（需要 ${need} 个）`);
      console.log(`      ${trimmed.replace(/\s+/g, ' ').slice(0, 110)}`);
      problems++;
    }
  });
}

console.log('');
if (problems === 0) {
  console.log('  ✅ 所有 eq() 调用都传够了 3 个参数');
} else {
  console.log(`  ❌ 有 ${problems} 处 eq() 参数不足，断言信息会错乱`);
  process.exit(1);
}
