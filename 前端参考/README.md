# 前端参考

「微光同行」的前端：**17 个原生 HTML 页面 + `ui.css` + 3 个 JS 文件**，没有构建步骤，直接由静态服务器托管即可。

## 目录

```
前端参考/
├── login.html            登录 / 创建账号
├── index.html            首页（群聊入口 + 好友动态）
├── discover.html         发现（公开日记流）
├── diary.html            日记双门入口
├── diary-mine.html       我的日记（日历）
├── diary-write.html      写 / 改当天日记
├── diary-public.html     日记详情（他人 / 公开）
├── bless.html            发送祝福
├── bless-sent.html       送出 / 收到的祝福
├── weiguang.html         微光同行（漂流瓶）
├── friend-chat.html      与好友私信
├── chat.html             AI 陪伴（临时对话，走后端接口）
├── mine.html             我的主页
├── my-list.html          我的喜欢 / 收藏
├── report-mine.html      举报记录
├── settings.html         设置（资料、头像、举报记录入口）
├── blank.html            聚合记录页（我的粉丝 / 我的漂流瓶 / 浏览记录，按 ?t= 区分）
├── api.js                ★ 接口适配层（translate + shapeResult）
├── chat-session.js       聊天页辅助（临时会话、发送状态）
├── message-links.js      消息内站内跳转链接
├── ui.css                公共样式
├── assets/               图片素材（日记封面、信纸、日历图标等）
└── README.md             本文件
```

## 接口适配层 `api.js`

页面里调用的是适配层路径（如 `api('/diary/public')`），`api.js` 底部的 `translate()` 会映射到后端真实接口（如 `/diary/feed?feed=all`），`shapeResult()` 再把返回字段转换成页面使用的形状（`text→content`、`img→cover`、`dateKey→day`、`isPublic→visibility`、`nick→author.nickname`）。

新增功能时：

- 后端已有对应接口 → 在 `translate()` 里加一条映射；
- 后端没有 → 需要改后端，接口数量会变化，请同步更新 [`docs/接口文档.md`](../docs/接口文档.md)。

## 运行

页面需要访问 `/api` 与 `/uploads`，因此不能直接双击打开（`file://` 会被跨域拦截）。推荐使用仓库根目录的：

```
一键启动.bat            # Windows：起后端 + 静态服务 + 代理，自动打开浏览器
node setup/start.js     # 或手动执行
```

其他平台可用任意静态服务器托管本目录，并把 `/api`、`/uploads` 反向代理到后端（默认 `http://127.0.0.1:3000`）。

## 约定

- 登录令牌放在 `Authorization: Bearer <token>`，由 `api.js` 统一附加。
- 统一响应 `{ code, msg, data }`，页面只判断 `code === 0`。
- 模型密钥不放在前端：`chat.html` 走服务端 `/api/ai/chat`，是否配置 `DEEPSEEK_API_KEY` 由后端 `.env` 决定。
- 富文本一律用 `textContent` 渲染，不把模型输出或用户内容直接拼进 HTML。
