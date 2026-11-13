# Companion Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现可控记忆、确定性关怀和用户确认后保存私密记录的后端能力，供码道完成核心界面集成。

**Architecture:** 复用现有 ai.js 与 llm.js；新增隔离的 companion 路由和草稿数据表。写入权限绑定服务端 uid；确认通过数据库事务实现一次性效果。

**Tech Stack:** Node.js 24、Express 4、mysql2、MySQL 8.4、原生 HTML/JS。

**Spec:** docs/superpowers/specs/2026-11-12-companion-core.md

## Global Constraints

- 不增加框架依赖，不修改已存在的用户记录，不打印密钥，不调用付费模型。
- SQL 参数化，归属来自认证中间件，跨用户对象统一 404。
- 新建日记必须私密；同日存在时返回 409，不自动覆盖。
- 前后端继续使用 `{code,msg,data}`；本地兜底明确标注。
- 码道留有实质核心集成任务；不伪造工具使用证明。

### Task 1: AI 会话与记忆一致性

**Files:** src/routes/ai.js；src/utils/aiSession.js（如需）；scripts/test-ai-session.test.js。
**Interfaces:** POST /api/ai/chat 接收 remember 与临时 history；既有 messages/memory API 契约不变；care 格式沿用 `{message,lines}`。
- [x] 先复现临时聊天意外落库与删除/在途响应竞争，编写行为测试。
- [x] 参数验证，临时模式上下文隔离，消息原子落库，同用户操作串行化。
- [x] 模型故障返回明示降级响应与 care；摘要失败不损坏主请求。
- [x] 运行针对性测试，报告错误路径和并发语义。

### Task 2: 私密草稿准备与确认

**Files:** src/routes/companion.js；src/utils/companion.js；src/utils/llm.js；sql/schema.sql；scripts/test-companion.test.js。
**Interfaces:** 设计文件规定的 prepare / GET draft / confirm / cancel；挂载工作由主代理完成。
- [x] 为预览不落日记、确认私密、幂等、跨用户、同日冲突和日期验证编写行为测试。
- [x] 新建 ai_diary_drafts 表；使用现有迁移器补表。
- [x] 按用户授权取记录，生成有来源的草稿与简洁执行轨迹；本地模式可运行。
- [x] 事务确认，执行失败回滚，记录只返回给拥有者。
- [x] 运行真实 MySQL 合成数据测试并自审。

### Task 3: 独立危机检测与一致关怀

**Files:** src/utils/moderation.js；src/utils/chatBot.js；src/routes/diary.js；src/routes/comment.js；src/routes/message.js；scripts/test-crisis-policy.test.js。
**Interfaces:** detectCrisis 返回 boolean，原有导出保持兼容；内容违规不会因危机信号被放行。
- [x] 先写危机加广告的漏检回归，再实现独立检测。
- [x] 统一路由处理顺序，危机不抵消其他违规；违规响应可携带 care，保持错误状态。
- [x] 运行既有审核/群机器人测试和新增回归。

### Task 4: 集成、最小接线与交接

**Files:** src/app.js；前端参考/chat.html；package.json；码道任务与接口契约.md。
- [x] 挂载 companion 路由；通过现有迁移器创建新表。
- [x] 聊天页移除前端密钥和直连，默认临时模式调用服务端；保留原视觉风格，显示状态、错误和 care。
- [x] 在独立端口启动测试后端，用合成账号验证跨用户与确认结果；不改变浏览器中用户现有账号的会话。
- [x] 独立审查差异与规格，修重要问题，重启实际服务并浏览器检查。
- [x] 交付码道核心 UI 实现任务、接口样例、测试命令、真实贡献记录与 3 分钟演示脚本。
