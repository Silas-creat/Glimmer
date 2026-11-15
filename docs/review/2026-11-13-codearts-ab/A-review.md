# CodeArts 任务 A 独立检查

检查对象：`D:/微光同行/Glimmer` 中 CodeArts 新增/修改的前端实现。基线 `3086f72`。本次没有修改生产代码、已有测试、数据库或服务。

结论：主要入口和接口已经接入，但有 3 个需要先修复的 P1 隐私/状态问题，以及 1 个 P2 面板请求竞争问题，暂不建议将任务 A 标记为验收完成。

## A1 [P1] 关闭保存会被更早的开启请求重新打开

- 位置：`前端参考/chat-companion.js:834–840`；关联 `849–853`、`863–867`。
- 触发：打开“保存对话记忆”后，`/auth/me` 还未返回时立即关闭；随后较早的认证请求成功返回。
- 实际结果：`enableSaved()` 没有核对当前开关意图或请求代次，继续执行 `writeSaveMode(state.uid, true)` 和 `replaceSession('saved')`，把用户刚刚关闭的保存重新打开，并把本地偏好写回开启。之后的消息会被保存。
- 预期：最后一次明确选择必须生效；关闭后，旧请求不能再次开启保存。
- 建议：模式切换使用独立递增代次，并绑定发起时的账号/token；异步认证成功后同时核对代次、身份和当前用户意图。初始自动恢复保存（900–908）也应采用同一机制。
- 隔离复现已通过：A1。

## A2 [P1] 清除成功后，迟到回复会把已清除内容放回下一次请求

- 主要位置：`前端参考/chat-session.js:46–51`。
- 关联：`chat-session.js:21–24`；`chat-companion.js:443–444`、`799–803`。
- 触发：在临时模式发送一条消息，回复仍在等待时执行“清除对话和记忆”；清除返回成功后，原先回复到达；再发送一条新消息。
- 实际结果：页面调用 `invalidate()` 和 `reset()`，随后页面层确实会丢弃旧回复，但 helper 的 `send()` 在返回前已无条件将旧问答写回 `history`。下一次请求重新携带已清除的两条消息。
- 影响：界面显示清除成功，实际下一次发给服务端/模型的上下文仍包含已清除内容。
- 建议：`send()` 开始时捕获会话代次，任何回复处理和 history 修改之前核对；`reset()` 同时作废待完成请求，或者清除时更换会话实例。仅在页面层过滤显示不够。
- 隔离复现已通过：A2，断言下一次请求包含两条已清除的历史。

## A3 [P1] 另一个标签页切换账号后，旧页面沿用前一账号的保存授权

- 主要位置：`前端参考/chat-companion.js:790–803`；关联 `890–907`。
- 请求鉴权依据：`前端参考/api.js:59–60` 每次请求读取当前 localStorage token。
- 触发：账号 A 在旧页面打开保存模式；另一个标签页登录账号 B，更新共享 token/user；回到旧页面继续发言，期间不刷新页面。
- 实际结果：旧页面只检查 token 是否存在，不核对账号；它仍使用 A 的 saved 会话并传 `remember:true`，但 API 携带 B 的 token，所以内容会保存至没有在该页面同意保存的 B 账号。`state.uid` 和页面内容仍属于 A；代码也没有监听 storage 事件来重置身份状态。
- 影响：跨账号保存、授权继承；旧账号显示内容也可能继续作为日记来源。有效的 B token 不会触发 401 保护。
- 建议：模式/对话/草稿/面板与已验证账号、token 绑定；共享存储变化或每次关键操作发现身份变化时立即作废旧异步请求、清空账号专属页面状态，并重新读取 B 自己的保存偏好，不能继承 A 的授权。
- 隔离复现已通过：A3，B 没有保存偏好，旧页面发出的请求仍为 B token + `remember:true`，状态 uid 仍为 A。

## A4 [P2] 较早的记忆请求会覆盖清除成功结果并重新显示旧摘要

- 位置：`前端参考/chat-companion.js:397–410`。
- 触发：点击“你记得我什么”，GET 尚未结束；切换到清除面板并完成删除；较早的 GET 此时才返回旧摘要。
- 实际结果：GET 回调未核对当前面板、账号、会话代次，直接清空共用 `panelBodyEl` 并显示旧摘要。清除成功信息被覆盖，标题仍可能是“清除对话和记忆”。
- 建议：为面板引入独立请求代次；打开、关闭、切换、清除、换账号均使旧回调失效。成功和失败两个分支的 DOM 写入都须核对。历史/草稿等共用面板的异步路径应一并检查。
- 隔离复现已通过：A4。

## 证据与限制

隔离脚本：`D:/微光同行/.runtime/codearts-review-20261113/A-repro.cjs`。

执行：

```powershell
& 'D:\Node.js\node.exe' 'D:\微光同行\.runtime\codearts-review-20261113\A-repro.cjs'
```

2026-11-13 执行结果，退出码 0：

```text
A1 REPRO: user toggled OFF during auth, late response re-enabled SAVED and persisted on.
A2 REPRO: next temporary request includes 2 cleared messages after old response settles.
A3 REPRO: B has no save consent, but existing A page sends remember:true using B token.
A4 REPRO: old memory GET overwrites successful clear panel with the cleared summary.
```

脚本通过 Node vm 加载提交的真实 `chat-session.js` 与 `chat-companion.js`，使用最小 DOM 和合成接口响应控制异步完成顺序。它验证上述前端逻辑问题，不替代真实浏览器和数据库端到端验收；不会连接真实 API，也不会接触用户数据。

建议下一轮补测上述 4 个场景，并将网络迟缓时的切换/清除/账号变化纳入 A/B 验收。现有纯函数测试通过不能覆盖这些状态竞争。
