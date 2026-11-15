# 给 CodeArts 的游客连续聊天补修指令

以下可直接复制给 CodeArts，继续当前任务，不重做 A/B。

---

请在 `D:\微光同行\Glimmer` 继续最小修复。先读 `docs/2026-11-15_CodeArts复验与待办.md`。当前 `chat-companion.js` SHA-256 为 `854EEB95CB6A9A4070F0C39C2F7705E3C01CFA0DF69C582E43C688FD839224B6`。

Codex 本轮已独立跑通 `npm run test:competition`（124 项 Node + 18/71/66 检查）和 `npm run test:merge24`（23 项 Node + 13/3 组），两套退出 0。这是后续独立复验，不要改写你之前因 `ENETUNREACH 127.0.0.1:3307` 退出 1 的原日志。该错误属于本机数据库网络访问限制；未找到具体证书错误，不要关闭 TLS/strict-ssl。

上轮 F1 的原始迟到核验换号场景通过了正确行为断言；F2 仅恢复了游客第一条发送。现在还有一个 P2 代码阻塞：

无登录状态下进入 chat.html，发第一条并等回复，不刷新再发第二条。第二条不发出 `/ai/chat`，已有聊天和本次输入全部清空，错误提示“登录状态已失效”。浏览器已实测，截图在 `docs/review/2026-11-15-identity-guest/guest-first.png` 和 `guest-second.png`。

根因是 `classifySession()` 用 `hasLegacyContext()` 判断旧账号内容，而后者把普通游客的 `state.turns.length`、`state.panelKind` 也纳入，导致合法匿名上下文被隔离。相同问题还导致首条发送失败后点击重试被吞掉、聊完后点历史入口清空匿名对话。请明确上下文归属，保留真正退出登录/换号时隔离旧账号内容的能力；不能简单删掉安全隔离。

已有独立正确行为断言：

```powershell
& 'D:\Node.js\node.exe' --test 'docs\review\2026-11-15-identity-guest\acceptance-boundaries.test.cjs'
```

当前 4 项中 1 通过、3 失败，退出 1；退出 0 才代表正确行为全部通过。脚本只加载源码，不修改生产文件、不访问真实 API。不要运行根目录临时 red/green 脚本覆盖生产文件来凑结果。

先把遗漏场景补入正式测试再修复：

1. 同一游客页面至少连续三轮；每条恰好发出一个 `remember:false` 请求，下一轮带本页已完成上下文，聊天保留，不请求 `/auth/me`，不持久化；刷新后清空。
2. 首条失败恢复输入后，用户再次点击发送会真正请求，按钮恢复，原文不被错误清空。
3. 游客聊天后打开历史、记忆、草稿等受限入口只提示登录；关闭后匿名内容仍在，可继续聊天，不访问受保护数据。
4. 保留已修好的真实账号退出、A/B 换号、迟到 auth、旧响应、发送锁和草稿幂等行为；不要削弱原 R7/R8 和更早回归。

保持原生前端和现有 API，优先只改 `前端参考/chat-companion.js` 与必要测试。模型配置用户稍后补，不查找其他项目凭证，不改数据库端口/结构、不重建数据、不打印密钥或真实用户内容。

完成后实际运行新增断言、`npm run test:competition`、`npm run test:merge24`，记录真实命令/退出码/完整日志；有浏览器时实测上述顺序操作，无法验证则标记未验证。补一份本轮 `docs/codearts_proof/` 过程报告，分清 CodeArts 的操作与 Codex 的复验，保留此前失败记录。交回文件清单、哈希、截图和未完成项，再进行独立验收与固定 Git 版本。

---
