# 前端参考

「微光同行」的前端：**17 个原生 HTML 页面 + `ui.css` + 页面脚本**，没有构建步骤，直接由静态服务器托管即可。

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
├── chat.html             AI 陪伴（临时/保存、历史、记忆、私密日记草稿）
├── chat-session.js       聊天页会话层（临时/保存请求体、reset、代次）
├── chat-companion.js     聊天页编排（模式、历史、记忆、清除、草稿预览与确认）
├── chat-companion.css    聊天页新增控件样式（不影响 ui.css）
├── mine.html             我的主页
├── my-list.html          我的喜欢 / 收藏
├── report-mine.html      举报记录
├── settings.html         设置（资料、头像、举报记录入口）
├── blank.html            聚合记录页（我的粉丝 / 我的漂流瓶 / 浏览记录，按 ?t= 区分）
├── api.js                ★ 统一请求、鉴权与错误处理

├── message-links.js      消息内站内跳转链接
├── ui.css                公共样式
├── assets/               图片素材（日记封面、信纸、日历图标等）
└── README.md             本文件
```

## 请求封装 `api.js`

页面通过全局 `api(path, options)` 请求服务端，包装器负责 `/api` 前缀、候选服务地址、令牌、JSON 解析与 401 登录处理。当前文件没有 `translate()` 或 `shapeResult()`；旧页面路径及字段兼容由后端 `src/routes/compat.js` 处理。

新增功能时：

- 后端已有接口 → 按契约通过 `api()` 调用，如 `/ai/chat`、`/companion/prepare`，不要重复 `/api` 前缀；
- 新增兼容路径确有必要时再修改后端，并同步更新 [`docs/architecture/接口文档.md`](../docs/architecture/接口文档.md)；
- 当前码道任务基于二十四稿合并版，先读 [`码道开始前必读`](../docs/project/码道开始前必读.md)；chat 页已接入临时/保存、历史续聊、记忆查看与清除、私密日记草稿确认流程。

## 陪伴对话页职责

- `chat.html`：只提供页面骨架与稳定容器（`#chat`、`#input`、`#send`、`#cc-panel`），挂载一次 `ChatCompanion.mountChatCompanion()`。
- `chat-session.js`：`createTemporaryChat()` 保持“本页最近 16 条、`remember:false`”的旧行为；`createSavedChat()` 发送 `remember:true` 且不携带本页历史；`reset()` 清空下一次请求上下文，`invalidate()` 用于丢弃清除/切模式后的迟到响应。
- `chat-companion.js`：游客可临时聊天；保存、历史、记忆和草稿要求登录。管理保存偏好 `wg_ai_save_mode_<uid>`、历史分页、记忆空态、清除确认、私密日记草稿材料/预览/确认/取消与错误映射。所有请求经 `api()`，每次显式发送布尔 `remember`。
- `chat-companion.css`：只新增 `cc-` 前缀样式；`ui.css` 与原有聊天气泡样式不变。

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
