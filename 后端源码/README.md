# 后端源码

「微光同行 / 陪着」的 MySQL 后端。Node 18+ / Express 4 / mysql2。

## 直接跑（不装整包也行）

```bash
npm install
cp .env.example .env      # 改里面的 DB_PASSWORD
node scripts/init-db.js   # 建库建表
node scripts/seed-demo.js # 灌演示数据（可选）
node src/app.js           # 起在 3000
```

健康检查：`http://127.0.0.1:3000/api/health`（会实际查一次数据库）。

## 跑测试

```bash
bash scripts/test-all.sh                      # 26 关，默认打 127.0.0.1:3000
bash scripts/test-all.sh http://127.0.0.1:3010  # 也可以指定地址
node scripts/smoke-test.js                    # 只跑第 1 关：静态自检
```

## 目录

```
src/app.js          组装中间件链、挂路由
src/config/         环境变量与默认值（启动时校验）
src/routes/         14 个路由文件，90+ 个接口
src/middleware/     认证、日志、错误、上传
src/utils/          审核、机器人、大模型、JWT、校验、星座…
src/db/index.js     连接池 + query/queryOne/insert/execute/transaction
sql/schema.sql      23 张表（全部 IF NOT EXISTS，可重复执行）
scripts/            初始化、种子、26 关测试
uploads/            上传的图片（/uploads 静态暴露）
```

## 约定

- 所有响应：`{ code, msg, data }`，`code = HTTP 状态码 × 100`，成功恒为 0
- 图片字段一律存相对路径（`/uploads/xxx.jpg`），由 `diaryHelper` 归一化
- 私密日记对非作者返回 404（不是 403，避免泄露"存在"这一事实）
- 群聊按标签匹配：同龄（5 岁一档）/ 同省 / 星座，资料没填就不过滤
