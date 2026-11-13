// ============================================================
//  错误处理 & 404
// ============================================================

/** 所有没匹配到路由的请求走到这里 */
export function notFound(req, res) {
  res.status(404).json({
    code: 40400,
    msg: `接口不存在: ${req.method} ${req.originalUrl}`,
    data: null,
  });
}

/** 全局错误处理（4 个参数是 Express 认的标志） */
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.httpStatus || 500;
  const code = err.code || status * 100;

  // 500 才打完整堆栈，400 系列是用户操作问题，不用刷屏
  if (status >= 500) {
    console.error(`\n[错误] ${req.method} ${req.originalUrl}`);
    console.error(err);
  } else {
    console.log(`[提示] ${req.method} ${req.originalUrl} -> ${status} ${err.message}`);
  }

  // MySQL 常见错误翻译成人话
  let msg = err.message || '服务器内部错误';
  if (err.code === 'ER_DUP_ENTRY') {
    msg = '数据重复了（这个记录已经存在）';
  } else if (err.code === 'ER_NO_SUCH_TABLE') {
    msg = '数据表不存在。在 后端源码 目录执行：node scripts/init-db.js（或重新运行一键安装）';
  } else if (err.code === 'ER_BAD_FIELD_ERROR') {
    msg = '数据库表结构不是最新（缺字段）。在 后端源码 目录执行：node scripts/migrate.js（或重新运行一键安装）';
  } else if (err.code === 'ECONNREFUSED') {
    msg = '连不上 MySQL，请检查数据库是否启动、.env 里的密码是否正确';
  } else if (status >= 500 && !err.httpStatus) {
    msg = '服务器内部错误，请查看后端控制台日志';
  }

  res.status(status).json({ code, msg, data: null });
}
