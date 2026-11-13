// ============================================================
//  MySQL 连接池
//  为什么要用"池"？每次请求都新建连接很慢，
//  池就是提前养几条连接，用完还回去，反复利用。
// ============================================================
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: config.db.charset,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  dateStrings: config.db.dateStrings,
});

/**
 * 执行查询（推荐日常都用这个）
 * 参数化查询：用 ? 占位，mysql2 会自动转义，从根上防 SQL 注入
 *
 *   const rows = await query('SELECT * FROM users WHERE phone = ?', [phone]);
 */
/**
 * 执行查询
 *
 * ⚠️ 重要陷阱（我踩过）：
 *   mysql2 的 execute() 对不同类型的 SQL 返回的东西不一样：
 *     SELECT          → [{...}, {...}]  数组
 *     INSERT/UPDATE/DELETE → { affectedRows, insertId, ... }  ResultSetHeader 对象
 *   所以像下面这样写是【错的】：
 *
 *     const affected = await query('UPDATE t SET x = ? WHERE id = ?', [...]);
 *     if (affected === 0) { ... }        // ❌ 永远不成立！对象 !== 0
 *
 *   要判断影响行数，请用下面的 execute()，它明确返回数字。
 */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** 只取一行，没有就返回 null */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 执行 INSERT，返回新记录的 id
 *
 *   const id = await insert('INSERT INTO diaries (...) VALUES (...)', [...]);
 */
export async function insert(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result.insertId;
}

/**
 * 执行 UPDATE / DELETE，返回【受影响的函数】这个数字
 *
 * 用来判断"到底改到东西没有"：
 *   比如更新一篇不属于自己的日记，会返回 0
 *   比如确保某行存在时，返回 0 说明该行不存在、需要补 INSERT
 *
 * ★ 这就是为什么不能直接用 query() 干这件事 —— 它返回的是对象。
 */
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  // SELECT 走这里会拿到数组，没有 affectedRows 字段，
  // 这种情况返回数组长度，语义上也算"影响了几行"
  if (Array.isArray(result)) return result.length;
  return Number(result.affectedRows) || 0;
}

/**
 * 事务：把多个操作打包成"要么全成功，要么全回滚"
 * 比如注册用户时要同时插 users 和 user_profiles 两张表
 *
 *   await transaction(async (conn) => {
 *     await conn.execute('INSERT ...');
 *     await conn.execute('INSERT ...');
 *   });
 */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** 启动时探活：连不上就直接报错，别等用户请求才炸 */
export async function testConnection() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT VERSION() AS v, DATABASE() AS db');
    return rows[0];
  } finally {
    conn.release();
  }
}

export default pool;
