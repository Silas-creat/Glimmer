// ============================================================
//  统一响应格式
//  所有接口都返回同一个形状，前端好处理：
//    成功: { code: 0, msg: 'ok', data: {...} }
//    失败: { code: 400xx, msg: '原因', data: null }
// ============================================================

/** 成功 */
export function ok(res, data = null, msg = 'ok') {
  return res.json({ code: 0, msg, data });
}

/** 失败。httpStatus 给它 200 也行，但用真实状态码更规范 */
export function fail(res, msg = '出错了', httpStatus = 400, code = null) {
  return res.status(httpStatus).json({
    code: code ?? httpStatus * 100,
    msg,
    data: null,
  });
}

/**
 * 包装 async 路由函数，自动捕获异常丢给全局错误中间件。
 * 没有它就得每个路由写 try/catch，很啰嗦。
 *
 *   router.get('/x', wrap(async (req, res) => { ... }))
 */
export function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * 业务异常：主动 throw 出来，由全局错误中间件统一转成响应
 *   throw new ApiError('验证码错误', 400);
 */
export class ApiError extends Error {
  constructor(message, httpStatus = 400, code = null) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code ?? httpStatus * 100;
  }
}

/** 分页参数解析：?page=1&size=20 -> { page, size, offset } */
export function parsePage(req, defaultSize = 20, maxSize = 100) {
  let page = parseInt(req.query.page, 10);
  let size = parseInt(req.query.size, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(size) || size < 1) size = defaultSize;
  if (size > maxSize) size = maxSize;
  return { page, size, offset: (page - 1) * size };
}
