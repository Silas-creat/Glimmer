// ============================================================
//  简单请求日志
//  在控制台打印每个请求，方便你调试时看到"前端到底调没调后端"
// ============================================================
export function requestLogger(req, res, next) {
  const start = Date.now();
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    // 2xx 绿点、4xx 黄点、5xx 红点（终端里看得清）
    const dot = status >= 500 ? '🔴' : status >= 400 ? '🟡' : '🟢';
    console.log(`${dot} ${time} ${req.method} ${req.originalUrl} ${status} ${ms}ms`);
  });

  next();
}
