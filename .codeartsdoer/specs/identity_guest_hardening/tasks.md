# 身份核验与游客聊天加固 · 编码任务规划（tasks.md）

> 文档类型：编码任务规划（tasks）
> 工作区：`D:\微光同行\Glimmer`
> 上游规格：`.codeartsdoer/specs/identity_guest_hardening/spec.md`（779 行，EARS，R7/R8、DFX、19 条 EDGE 回归、8 个待确认点）
> 上游设计：`.codeartsdoer/specs/identity_guest_hardening/design.md`（1111 行，票据/四态核验/隔离/门禁）

> 继承基线（只读）：`.codeartsdoer/specs/ab_edge_hardening/{spec,design,tasks}.md`（R1–R6 已实现，T01–T35）
> 需求来源：`docs/给CodeArts的身份核验与游客聊天补修指令.md`、`docs/CodeArts六项收尾复验结果.md`（F1/F2）
> 缺陷存在证据：`docs/review/2026-11-13-final-acceptance/identity-boundary-repro.cjs` / `.txt`（退出 0 = 缺陷存在，不是通过）
> 状态：待用户评审。本文件只规划“谁按什么顺序做什么、做完怎么证明”，**不含任何业务代码、测试代码或配置改动**；本阶段不执行任何测试命令。

---

## 0. 规划基线与统一约定

### 0.1 基线事实（实施前须再复核一次）

| 项 | 本轮实测/文档值 | 本任务规划采用的口径 |
|---|---|---|
| 仓库根 | `D:/微光同行/Glimmer` | 本轮 Git 实际可见，**不是**“非 Git 仓库” |
| 分支 / HEAD | `main` / `3086f720feaf03a9e6678ae53821e69bb8075ae7` | 记录为基线；本轮不提交、不推送 |
| 唯一必改业务文件 | `前端参考/chat-companion.js`，`wc -l`=1454、编辑器总行 1455（末行无换行），SHA-256 `796EF67C8CADD90FE1ED489E406B584BB25C0E29C1F7DF8130EB0DBCD7406DD0` | 只改此文件；未跟踪（`??`），改动以哈希 + 只追加行区间为证 |
| 样式文件 | `前端参考/chat-companion.css`，259 行，SHA-256 `BFF4294096E6DF0B3527F566C7C64B298D4541C0C24EB6A6AC81329884CB2E58` | 默认不改；仅在证明现有元素不足时追加 |
| 测试文件 | `后端源码/scripts/test-chat-companion-repair.test.js`，`wc -l`=969、总行 970，SHA-256 `AC27B43AAAFC29E256C6B97E9075D796ED1A2645D90DDC747E4438ED6F02233F` | **只追加**，既有 36 条一行不改 |
| 既有用例数 | 36 条 `test(...)`：17 条既有（`P1-01…08`、`P2-01…03`、`B1`、`B2`、`B3`×2、`B4`、`normal confirm`）+ 19 条 `EDGE-R1…R6` | 36 条为**不允许回退**的基线；`EDGE-R6-03` 是当前最后一条（第 948–969 行） |
| 追加后目标 | 36 + 19 = 55 条 | 实际数以 TAP 输出为准，不把预计值写成实测值 |
| 测试脚本 | `后端源码/package.json` 29 行，`test:competition` 第 14 行、`test:merge24` 第 15 行 | 不改脚本（repair 测试文件已在该列表内） |
| 复现脚本 | `identity-boundary-repro.cjs` 45 行 | 退出 **0 = 缺陷仍存在**，不得写成通过 |
| 模型状态 | `ai.configured=false` | 回复来自本地规则，不得称真实大模型效果 |
| 环境风险 | 上一轮 `127.0.0.1:3307` 被沙箱拦截（`ENETUNREACH` / `Sandbox Network Error`） | 本轮须记录真实结果；仍阻塞则标“环境阻塞”，不得写通过 |

### 0.2 继承关系（本轮只加固两处，不动 R2–R6）

| 既有能力 | 本轮处置 |
|---|---|
| R1 材料/草稿归属、同步换号中止、`isDraftResponseCurrent`、同账号刷新允许 | **保留**，并在其前补“请求前复核” |
| R2 `clearEpoch` / `readSeq` / `createReadTicket` / `isReadValid` / 草稿面板不被重绘 | **保留**；隔离时额外推进代次，不改函数语义 |
| R3 `clearSeq` / `judgeClearResponse` 四级裁决 | **保留** |
| R4 `beginSend` 同步占位 / `isSendCurrent` / `settleSend` 拥有者收尾 | **保留**；游客路径复用 |
| R5 `renderConfirmSuccess` 弹层内完整关怀与 `tel:` 安全渲染 | **保留** |
| R6 `renderStopped` 终态、生成入口收敛、关怀只追加一次 | **保留** |
| 四层归属（身份/会话/面板/操作） | **只增“凭证生命周期”维度，不替换、不重命名** |

### 0.3 八条默认决策（原样落入任务，语义不得改动）

| # | 决策原文语义 | 落入任务 |
|---|---|---|
| 1 | 登录失效文案统一为“登录状态已失效，已转为临时对话；本次不保存” | T18（`removed`/`auth401`/`backend40100` 共用；`restore-failed` 用“登录状态暂时无法确认，已回到临时对话”） |
| 2 | 游客历史/记忆/清除/草稿：**直接提示、不发请求** | T20 |
| 3 | 游客沿用本页最近 16 条上下文（`chat-session.js` 既有语义） | T19（不改 `chat-session.js`） |
| 4 | A1→A2→A3 直接判 `op-obsolete`，**不做第二次核验** | T10 |
| 5 | 自动恢复只受换号/退出/新恢复影响，**不受关闭面板影响**（票据不含 `panelEpoch`/`draftEpoch`） | T15 |
| 6 | 只追加现有测试文件，**不改 `package.json`** | T05–T08、T23 |
| 7 | 浏览器复现新建 `identity_guest_a_*` / `identity_guest_b_*` 合成账号并记录清理责任 | T29 |
| 8 | 游客转登录清空匿名消息，**不自动开启保存** | T17、T19 |

### 0.4 修改面总边界（贯穿全部任务）

**允许改**
1. `前端参考/chat-companion.js`：只增字段/闭包内函数，替换少量判定调用点；不整段重写。
2. `后端源码/scripts/test-chat-companion-repair.test.js`：**只在文件末尾追加** 19 条用例，复用既有 `El`/`deferred`/`flush`/`setup`/`setAccount`/`emitStorage`/`findButton`/`action`/`buttons`/`calls`/`storage`。
3. `前端参考/chat-companion.css`：**仅当**证明现有 `#cc-save-state` / `cc-note` 无法容纳提示（裁切/不可读）时追加最小规则。
4. 新增 `docs/codearts_proof/2026-11-13-身份核验与游客聊天加固.md`、`docs/codearts_proof/logs/2026-11-13-identity-guest-*.log`、`docs/codearts_proof/backup/2026-11-13-identity-guest/`、`docs/codearts_proof/screenshots/2026-11-13-identity-guest/`。
5. `docs/README.md`：**仅追加一行**索引（需用户同意，见阶段 11）。

**禁止改（硬约束）**
1. `前端参考/api.js`、`前端参考/chat-session.js`、`前端参考/chat.html`、`login.html`、`settings.html`、日记页与双门 HTML。
2. `后端源码/src/**`、`后端源码/sql/**`、`.env`、数据库结构与数据；不改端口，不 `initdb`/`DROP`/`TRUNCATE`/`ALTER`。
3. `后端源码/package.json`。
4. HTTP 契约：`/ai/chat`、`/auth/me`、`/ai/messages`、`/ai/memory`、`/companion/prepare`、`/companion/drafts/:id`（GET/DELETE）、`/companion/drafts/:id/confirm` 的 URL/方法/body 字段/状态码语义。
5. 既有 36 条测试任一行；不得格式化整文件掩盖追加范围。
6. 既有按钮文案：`生成草稿`、`确认保存为私密日记`、`取消草稿`、`返回修改选择`、`确认清除`、`取消`、`关闭`、`再整理一段`、`返回聊天`。
7. R2–R6 的行为、可观察顺序与断言语义。
8. 历史证据：`docs/codearts_proof/2026-11-13-AB边界收尾.md` 及其日志/截图、`docs/review/**`、`docs/交接说明.md`、`ab_edge_hardening` 三份文档、`identity-boundary-repro.cjs/.txt`（只读引用）。
9. 不执行 `git reset --hard`、`git checkout .`、`git clean`、不提交、不推送。
10. 日志/截图/测试输出不出现 token、`Authorization`、密钥、真实手机号/账号/聊天正文。

### 0.5 19 条正式回归的红绿预期与落点（先红后绿的唯一依据）

> 红 = 修复前**必须失败**；绿 = 修复前应通过（防回归）。判定原则见 design 2.8.4：红必须落在业务断言（旧材料被发出 / 游客被阻断 / 隔离未发生 / 提示缺失），不得是 `TypeError`、`undefined`、环境或端口错误。

**R7（9 条，落点：`resolveIdentity`/prepare/confirm/cancel/send/restore）**

| 编号 | 修复前预期 | 关键断言（请求计数优先） | 修复后落点任务 |
|---|---|---|---|
| `EDGE-R7-01` | **红** | `/companion/prepare` = 0；`state.uid==='B'`；`state.token==='token-B'`；聊天/面板无 A 材料；`#cc-save-state` 含“账号或登录状态已变化”或“操作已失效” | T10 + T11 |
| `EDGE-R7-02` | **红** | prepare = 0；`cc-panel.hidden===true`；面板无草稿预览/进行中残留 | T10 + T11 |
| `EDGE-R7-03` | **绿** | prepare 恰好 1 次；`body.message` 含 A 材料；无身份变化提示；`state.token==='token-A2'`；turns 未清 | T10 + T11（保持） |
| `EDGE-R7-04` | **红** | `/confirm` = 0；无“已保存为私密日记”；面板无 A 正文；提示变化/失效 | T10 + T12 |
| `EDGE-R7-05` | **红** | `DELETE /companion/drafts/:id` = 0；无“草稿已取消”；面板无 A 草稿正文 | T10 + T13 |
| `EDGE-R7-06` | **红** | `/ai/chat` = 0；聊天区无 A 文本气泡；`send.disabled===false`；`state.sending===false` | T10 + T14 |
| `EDGE-R7-07` | **绿** | `state.uid==='B'`；无 A 历史/摘要；旧 `/ai/messages` 不写入 | T15（保持） |
| `EDGE-R7-08` | **红** | 第一次核验期间 prepare = 0；`state.draft===null`；`state.draftMaterial===null` 或其 `uid!=='A'` | T10 + T11 |
| `EDGE-R7-09` | **绿** | `state.draft===null`；面板无预览；无 care/成功文案 | T11（落地复核，保持） |

**R8（10 条，落点：会话分类 / 隔离 / 游客发送 / 门禁）**

| 编号 | 修复前预期 | 关键断言（请求计数优先） | 修复后落点任务 |
|---|---|---|---|
| `EDGE-R8-01` | **红** | `/ai/chat` = 1；`body.remember===false`；出现回复；无 `/auth/me`；`#cc-mode-note` 或 `#cc-save-state` 含“临时/未保存” | T19 |
| `EDGE-R8-02` | **红** | 新页面 `state.turns` 仅初始问候；无 `/ai/messages`、`/ai/memory`；再次发送 `remember:false`；无新增持久化键 | T19 |
| `EDGE-R8-03` | **绿** | `state.mode==='temporary'`；无 `wg_ai_save_mode_` 写入；提示“登录后才能保存对话记忆” | T20（保持） |
| `EDGE-R8-04` | **红（草稿子断言）** | `historyItems` 空；`memorySnapshot===null`；`draft===null`；面板无合成账号内容；提示含“登录”；无草稿预览 | T20 |
| `EDGE-R8-05` | **红** | A 气泡/turns/草稿/摘要清空；`state.uid===''`；`mode==='temporary'`；`/ai/chat` = 1 且 `remember===false`；聊天区无 A 旧文本 | T17 + T18 + T19 |
| `EDGE-R8-06` | **红（游客发送子断言）** | A 气泡/草稿/摘要/面板清空；无 A 内容；游客发送 `remember:false` | T17 + T18 + T19 |
| `EDGE-R8-07` | **绿** | 游客页面无 A 回复/错误/关怀；`input.value` 不被 A 文本回填；`send.disabled===false` | T18（保持） |
| `EDGE-R8-08` | **绿** | 匿名内容不作为 A 历史展示；`mode==='temporary'`；未写 `wg_ai_save_mode_A`；无 `remember:true` + 匿名 `history` 请求 | T17（保持；测试内构造匿名状态，不依赖 T19） |
| `EDGE-R8-09` | **红** | `/ai/chat` = 1；用户气泡 1 个；最终 `send.disabled===false` | T19 |
| `EDGE-R8-10` | **红** | `/ai/chat` = 1；无 `/ai/messages`、`/ai/memory`、`/companion/*`；无保存偏好写入；`input.value` 回到原文 | T19 |

**红集合合计 13 条**：R7-01/02/04/05/06/08 + R8-01/02/04/05/06/09/10；**绿集合 6 条**：R7-03/07/09 + R8-03/07/08。

> 与 spec 9.4“最小应失败集合 9 条”的差异已由 design 2.8.4 说明：R8-04/06/09/10 整条为红（草稿入口无登录提示、游客发送被阻断），属真实缺陷，**不修改期望、不拆分子断言**。

### 0.6 任务总表与阶段划分

| 阶段 | 任务 | 目标 | 优先级 |
|---|---|---|---|
| 阶段 0 前置基线冻结 | T01–T04 | 哈希/备份、Git 记录、36 条不可回退基线、证据与脱敏规范 | P1 |
| 阶段 1 先红 | T05–T09 | 追加 19 条 `EDGE-R7/R8` 并取得“修复前非 0”红日志与失败原因审计 | P1 |
| 阶段 2 P1 修复（R7） | T10–T16 | 票据 + 四态核验 + 五条路径请求前复核，逐项红转绿，P1 门禁 | P1 |
| 阶段 3 P2 修复（R8） | T17–T21 | 会话分类、`isolateSignedOutContext`、游客发送、能力门禁，P2 门禁 | P1（T19）/P2（T17、T18、T20、T21） |
| 阶段 4 修改面控制 | T22–T24 | 只追加/只增字段、禁止改项、可观察契约核对 | P1 |
| 阶段 5 自动化验收 | T25–T28 | 单文件 55 条 → competition → merge24 → 复现脚本语义 | P1 |
| 阶段 6 浏览器验收 | T29–T32 | 合成账号、游客端到端、迟到核验换号、未验证项标注 | P2 |
| 阶段 7 证据与收尾 | T33–T35 | 新增证据文档、日志/截图、交付清单与修改清单 | P2/P3 |

**总量：35 个任务。**

---

## 阶段 0 · 前置基线冻结（T01–T04）

### T01 记录三份关键文件 SHA-256、行数并完成备份
- **目标**：在动任何文件前冻结 `chat-companion.js`、`chat-companion.css`、repair 测试文件的可核查基线并做可还原备份。
- **涉及文件**：`前端参考/chat-companion.js`（1454/1455 行）、`前端参考/chat-companion.css`（259 行）、`后端源码/scripts/test-chat-companion-repair.test.js`（969/970 行）、新建 `docs/codearts_proof/backup/2026-11-13-identity-guest/`。
- **前置依赖**：无。
- **执行要点**：
  1. 用 `Get-FileHash -Algorithm SHA256`（或 `sha256sum`）记录三份哈希与 `wc -l` 行数，写入证据草稿的“基本信息”章。
  2. 复制三份文件到备份目录，命名 `.pre-fix`；对备份副本再算一次哈希，必须与源一致。
  3. 备份目录只新增，不覆盖既有 `docs/codearts_proof/backup/2026-11-13/` 内文件。
- **验证方式**：源文件哈希 = 备份副本哈希；行数与 0.1 表一致；备份目录清单落盘。
- **完成判据**：3 份修复前哈希 + 3 份行数 + 3 份备份副本哈希全部记录；目录清单可复核。
- **优先级**：P1

### T02 记录 Git 实际可见范围（只登记，不操作）
- **目标**：如实登记本轮 Git 可见范围，作为“不能用 `git diff` 证明改动范围”的依据。
- **涉及文件**：无改动；记录写入证据草稿“Git 实际可见范围”章。
- **前置依赖**：无（可与 T01 并行）。
- **执行要点**：
  1. 记录 `git rev-parse --show-toplevel`、`git branch --show-current`、`git rev-parse HEAD`、`git status --short`、`git log --oneline -3`。
  2. 明确列出：`前端参考/chat-companion.js`、`chat-companion.css`、repair 测试文件、`.codeartsdoer/`、`docs/review/`、`docs/codearts_proof/` 为 `??` 未跟踪；`后端源码/package.json`、`前端参考/chat.html` 等为已跟踪未提交修改（以实测清单为准）。
  3. 写明“不创建提交、不推送、不 `reset --hard`、不 `checkout .`、不 `clean`”。
- **验证方式**：逐条命令原文 + 输出摘要落盘；未跟踪/未提交清单与实测一致。
- **完成判据**：4 个 Git 事实 + 未跟踪/未提交清单 + 边界声明齐全；未执行任何写型 Git 操作。
- **优先级**：P1

### T03 冻结 36 条既有用例与 R2–R6 为不可回退基线
- **目标**：确认“先红”之前基线本身是绿的，并登记只追加锚点。
- **涉及文件**：`后端源码/scripts/test-chat-companion-repair.test.js`。
- **前置依赖**：T01。
- **执行要点**：
  1. 在未改任何文件的条件下，于 `后端源码` 目录执行 `node --test scripts/test-chat-companion-repair.test.js`，保存完整输出与退出码到 `logs/2026-11-13-identity-guest-baseline.log`。
  2. 记录 36 条用例名清单（17 条既有 + 19 条 `EDGE-R1…R6`）；记录 `EDGE-R6-03` 为最后一条（第 948–969 行）作为追加锚点。
  3. 记录追加前文件前 969 行（或前 970 行不含末尾）的哈希，供 T22 只追加审计使用。
- **验证方式**：基线日志退出码 **0**、`pass 36 / fail 0`（以 TAP 实际计数为准）。
- **完成判据**：基线日志落盘且 36 条全绿；用例名清单 + 末尾锚点 + 前置哈希齐全。
- **优先级**：P1
- **若不成立**：先停止并如实记录“基线不为绿”，不得在非绿基线上继续追加（避免把既有失败混入本轮红集合）。

### T04 建立证据命名、日志落盘与脱敏规则
- **目标**：统一本轮所有证据的命名与脱敏口径，避免后期改名与泄密。
- **涉及文件**：新建日志目录文件（后续任务产生）、证据草稿。
- **前置依赖**：T01、T02。
- **执行要点**：
  1. 日志命名固定为 `docs/codearts_proof/logs/2026-11-13-identity-guest-<stage>.log`，`<stage>` ∈ `baseline / red / p1-green / p2-green / green / competition / merge24 / repro / browser-precheck`；不覆盖既有 `2026-11-13-ab-edge-*.log`。
  2. 截图命名固定为 `docs/codearts_proof/screenshots/2026-11-13-identity-guest/<序号>-<场景>.png`。
  3. 脱敏规则：测试统一用 `token-A` / `token-B` / `token-A2` 占位符与 `synthetic …` 合成文本；日志禁止出现真实 token、`Authorization` 明文、密钥、真实手机号/账号/聊天正文。
  4. 每条日志首行写“命令原文 + 工作目录 + 开始时间”，末行写“退出码”；不拼接多次执行结果。
- **验证方式**：命名规则清单 + 脱敏检索词表（`Bearer`、`Authorization: `、`eyJ`、真实手机号正则）落盘。
- **完成判据**：命名/截图/脱敏三类规则齐全，且与 design 2.8.6/2.8.7 一致。
- **优先级**：P1

---

## 阶段 1 · 先红：19 条正式回归（T05–T09）

> **纪律**：本阶段只允许**在测试文件末尾追加**，不得改动 `前端参考/chat-companion.js` 任何一行。任何业务代码改动必须先等 T09 完成。

### T05 追加 R7 前段回归（`EDGE-R7-01…05`）
- **目标**：把“核验在途换号/关闭面板不得提交 A 材料”的五条正确行为固化为正式断言。
- **涉及文件**：`后端源码/scripts/test-chat-companion-repair.test.js`（文件末尾追加）。
- **前置依赖**：T03、T04。
- **执行要点（复用 harness，不引用新符号）**：
  1. `EDGE-R7-01`：`action('draft')` → 设置 `state.turns` 合成材料 → `renderDraftSelection()` → `querySelectorAll=()=>[{value:'0'}]` → `setAccount({uid:'A'},'token-A2')` → 点击“生成草稿”并 `flush` → `setAccount({uid:'B'},'token-B')` + `emitStorage('wg_user')` → `deferred` 的 `/auth/me` resolve 为 A → `await pending` + `flush`；断言 prepare 计数 0。
  2. `EDGE-R7-02`：同上但核验在途时 `s.ui.closePanel()`，断言 prepare 0 且 `cc-panel.hidden===true`。
  3. `EDGE-R7-03`（防回归）：A1→A2、`/auth/me` 返回 A，断言 prepare 恰好 1 次、`state.token==='token-A2'`、无身份变化提示。
  4. `EDGE-R7-04`：先 prepare 成功拿到 A 草稿（`status:'pending'`），再 `setAccount` A2 触发核验并 `deferred`，点击“确认保存为私密日记”，换 B + storage，核验返回 A；断言 `/confirm` 计数 0。
  5. `EDGE-R7-05`：同 R7-04，但点击“取消草稿”，断言 DELETE 计数 0、无“草稿已取消”。
- **验证方式**：`grep`/人工核对新增 5 条 `test(...)` 存在；前置断言先校验 `state.draftStatus==='pending'` 等构造成立（防“假通过”）。
- **完成判据**：5 条用例存在；断言只针对请求计数、`state` 既有字段、DOM 文本与提示；未改既有 36 条任何一行。
- **优先级**：P1

### T06 追加 R7 后段回归（`EDGE-R7-06…09`）
- **目标**：覆盖发送迟到核验、自动恢复换号、过期代次“续命”与迟到 prepare 响应。
- **涉及文件**：同上（继续末尾追加）。
- **前置依赖**：T05（同一文件串行追加，避免行号冲突）。
- **执行要点**：
  1. `EDGE-R7-06`：`input.value='A synthetic private text'` → `setAccount({uid:'A'},'token-A2')` → 点击“说” → `flush` → 换 B + `emitStorage` → 核验 resolve A；断言 `/ai/chat` 0、`send.disabled===false`、`state.sending===false`。
  2. `EDGE-R7-07`（防回归）：`setup(...,{saved:true})`（`wg_ai_save_mode_A=on`），初始化 `/auth/me` 用 `deferred`，`/ai/messages` 返回 A 合成历史；恢复在途时换 B + storage，核验迟到返回 A；断言 `state.uid==='B'` 且无 A 历史/摘要。
  3. `EDGE-R7-08`：触发 prepare → 换 B + storage → 核验返回 A → `flush` → 重新 `action('draft')`；断言第一次 prepare 0、`state.draft===null`、`draftMaterial` 不指向 A。
  4. `EDGE-R7-09`（防回归）：prepare 响应 `deferred`，发出后 `closePanel()`，迟到成功返回；断言 `state.draft===null`、面板无预览。
- **验证方式**：时序全部由 `deferred` + `flush`（10 次微任务）控制，不用 `setTimeout`/轮询。
- **完成判据**：4 条用例存在且时序可控；R7-07/09 明确标注“防回归”。
- **优先级**：P1

### T07 追加 R8 前段回归（`EDGE-R8-01…05`）
- **目标**：固化游客临时发送、刷新不持久化、游客保存门禁、四入口门禁、失效先隔离。
- **涉及文件**：同上（继续末尾追加）。
- **前置依赖**：T06。
- **执行要点**：
  1. `EDGE-R8-01`：`setup(handler,{user:{},token:''})` + `setAccount(null,'')`，输入合成句点击“说”；断言 `/ai/chat` 1 次、`body.remember===false`、出现回复、无 `/auth/me`、提示含“临时/未保存”。
  2. `EDGE-R8-02`：游客发送成功后用新的无 token `setup` 模拟刷新再发一次；断言新页面 `state.turns` 仅初始问候、无 `/ai/messages`/`/ai/memory`、再次 `remember:false`。
  3. `EDGE-R8-03`（防回归）：勾选 `cc-save-toggle` 并 `emit('change')`；断言 `mode==='temporary'`、无 `wg_ai_save_mode_` 写入、提示“登录后才能保存对话记忆”。
  4. `EDGE-R8-04`：游客依次 `action('history')`、`action('memory')`、`action('draft')`；断言三处均无账号内容、`memorySnapshot===null`、`draft===null`、提示含“登录”、无草稿预览（该条整条红在草稿子断言）。
  5. `EDGE-R8-05`：A 有 turns 与合成气泡 → `setAccount({uid:'A'},'')` + `emitStorage('wg_token')` → 输入新句发送；断言 A 内容清空、`state.uid===''`、`mode==='temporary'`、`/ai/chat` 1 次且 `remember===false`。
- **验证方式**：涉及游客的用例先自检 `state.mode==='temporary'` 与 token 条件（`setAccount` 构造），再断言目标行为。
- **完成判据**：5 条用例存在；R8-03 标注“防回归”；R8-04 不依赖具体请求次数（避免扩大范围）。
- **优先级**：P1

### T08 追加 R8 后段回归（`EDGE-R8-06…10`）
- **目标**：固化退出后不沿用旧内容、旧在途回复不落地、游客转登录不带匿名上下文、连点只 1 次、失败不持久化。
- **涉及文件**：同上（继续末尾追加）。
- **前置依赖**：T07。
- **执行要点**：
  1. `EDGE-R8-06`：A 有聊天/草稿/摘要 → `setAccount(null,'')` + `emitStorage('wg_user')` → 检查清空 → 游客发送；断言清空 + 游客发送 `remember:false`（整条红在游客发送子断言）。
  2. `EDGE-R8-07`（防回归）：A 的 `/ai/chat` 用 `deferred`，发出后退出登录触发隔离，旧响应返回；断言游客页面无 A 回复/错误/关怀、`input.value` 不被回填、`send.disabled===false`。
  3. `EDGE-R8-08`（防回归）：用测试内构造游客已发送状态（`state.turns=[…]`、`chat.textContent='匿名内容'`）→ `setAccount({uid:'A'},'token-A')` + `emitStorage('wg_user')`；断言匿名内容不作为 A 历史、`mode==='temporary'`、未写 `wg_ai_save_mode_A`、无 `remember:true` + 匿名 `history` 请求。
  4. `EDGE-R8-09`：游客；`/ai/chat` 用 `deferred`；连续两次 `send.emit('click')`；断言 `/ai/chat` 1 次、用户气泡 1 个、最终按钮恢复。
  5. `EDGE-R8-10`：游客；`/ai/chat` 返回 `{code:50000}`；断言 `/ai/chat` 1 次、无 `/ai/messages`/`/ai/memory`/`/companion/*`、无保存偏好写入、`input.value` 回到原文。
- **验证方式**：请求计数优先；文案断言用关键词正则（`/临时|未保存/`、`/登录后才能/`、`/账号或登录状态已变化|操作已失效/`）。
- **完成判据**：5 条用例存在；R8-07/08 标注“防回归”；新增用例共 19 条（T05 5 + T06 4 + T07 5 + T08 5）。
- **优先级**：P1

### T09 运行修复前红色基线并审计失败原因（**先红门禁**）
- **目标**：取得“当前版本确实失败”的证据，并确认失败都落在目标缺陷上。
- **涉及文件**：日志 `docs/codearts_proof/logs/2026-11-13-identity-guest-red.log`。
- **前置依赖**：T05–T08 全部完成；`前端参考/chat-companion.js` 仍为修复前版本（哈希 `796EF67C…`）。
- **执行要点**：
  1. 在 `后端源码` 目录执行 `node --test scripts/test-chat-companion-repair.test.js`，保存完整 stdout/stderr、退出码、`tests/pass/fail` 计数。
  2. 逐条核对红集合 = **13 条**：`R7-01/02/04/05/06/08`、`R8-01/02/04/05/06/09/10`；绿集合 = **6 条**：`R7-03/07/09`、`R8-03/07/08`；既有 36 条全部仍通过。
  3. 逐条阅读首次失败断言，确认不是 `TypeError`/`undefined`/模块加载错误/环境错误；若是构造问题，**只修新增用例的构造**，不改业务行为期望，并记录修正原因。
- **验证方式**：退出码**非 0**（红是预期）；日志顶部标注“红是预期，不是验收结果”。
- **完成判据**：非 0 退出码 + 13 条失败名 + 6 条防回归通过 + 36 条既有通过 全部落盘；失败原因审计结论明确。
- **优先级**：P1
- **门禁**：T09 未完成前，**禁止**开始 T10 及之后任何业务代码改动；若某条“应失败”用例实际通过，先复核时序构造（storage 是否触发、token 是否变化、面板是否关闭），**不得把期望改成缺陷行为**。

---

## 阶段 2 · P1 逐项修复：R7（T10–T16）

> 所有改动集中在 `前端参考/chat-companion.js`；每项完成后立即跑**最小验证**（同一单文件命令 + 必要时的 `--test-name-pattern`），确认目标用例转绿且既有用例不掉。

### T10 建立核验票据与四态裁决（身份基础设施）
- **目标**：把“发起上下文快照 + await 后重比 + 过期零写入”做成统一能力，供五条路径复用。
- **涉及文件/行号区间**：`前端参考/chat-companion.js` `resolveIdentity`（311–335）、`stopForIdentity`（337–344）；新增闭包内 `createVerificationTicket` / `verifyIdentity` / `isOperationStillValid`（骨架）/ `handleVerificationFailure`。
- **前置依赖**：T09。
- **票据字段（`VerificationTicket`，只读、仅内存）**：`kind`（`prepare|confirm|cancel|send|restore`）、`seq`、`uid`、`tokenAtStart`、`boundTokenAtStart`、`identityEpoch`、`opSeq`、`panelEpoch`、`sessionGen`、`draftId`、`modeEpoch`。
- **四态判定（顺序不可交换）**：
  1. **发起上下文复核（零网络、零写入）**：`currentUid()!==ticket.uid` 或 `state.uid!==ticket.uid` → `identity-changed`；`identityEpoch` 不符 → `op-obsolete`；草稿类 `panelEpoch`/`opSeq` 不符 → `op-obsolete`；发送类 `activeSend.id`/`sessionGen` 不符 → `op-obsolete`；恢复类 `modeEpoch`/`restoreSeq` 不符 → `op-obsolete`；`ticket.tokenAtStart !== getToken()`（核验未开始已被再次刷新）→ `op-obsolete`（**决策 4：不做第二次核验**）。
  2. **本地零网络通过**：`tokenAtStart === state.token === getToken()` → `valid-same-account`。
  3. **网络复核（仅当 `tokenAtStart !== state.token`）**：捕获 `tokenAtVerify = getToken()` → `await fetchMe()` → **await 后重跑第 1 步全部比对 + `getToken() === tokenAtVerify`**；任一不符返回对应状态且**不写任何 state**；`!me.ok` → `unconfirmed`；`me.uid !== ticket.uid` → `identity-changed`。
  4. **有效落地**：仅 `valid-same-account` 且 `tokenAtStart !== getToken()` 时写 `state.token = getToken()`；**禁止**写 `state.uid` / `identityEpoch` / `panelEpoch` / `draftEpoch` / `session`。
- **失败裁决（`handleVerificationFailure`）**：
  | 状态 | state 写入 | 提示写入位置 | 清理 |
  |---|---|---|---|
  | `identity-changed` | 无（由 `switchAccount` 统一清视图） | `#cc-save-state`：`账号或登录状态已变化，请重新…` | 交给 `resetAccountView` |
  | `op-obsolete` | 无 | 仅 `#cc-save-state`：`操作已失效或面板已关闭，本次未提交` | 不写面板/气泡 |
  | `unconfirmed` | **仅当票据仍属当前身份**（`ticket.identityEpoch===state.identityEpoch` 且 uid 一致）时 `identityEpoch += 1` | `#cc-save-state`：`登录状态暂时无法确认，…未提交，请稍后重试` | 保留面板与输入 |
- **兼容要求**：`resolveIdentity` 保留为兼容外壳（内部同一套快照比较），`stopForIdentity` 保留为薄封装，确保 `EDGE-R1-01/03` 断言的“账号或登录状态已变化”仍写入 `#cc-save-state`。
- **验证方式**：`node --test scripts/test-chat-companion-repair.test.js`，重点看 `EDGE-R1-01/02/03/04`、`EDGE-R4-02/03`、`P1-01…P1-08` 全绿；`EDGE-R7-03` 绿。
- **完成判据**：本地一致路径 0 次 `/auth/me`；同账号刷新 1 次；R1/R4 既有用例不掉；`R7-03` 保持绿；无任何“过期分支写 state”的路径。
- **优先级**：P1

### T11 R7：prepare 接入请求前复核（删除 owner 续命）
- **目标**：换号/关闭面板后核验迟到，**不发出** `/companion/prepare`，不写预览。
- **涉及文件/行号区间**：`prepareDraft`（816–894）；**删除 848–849** 两行 `owner.uid = identity.uid`、`owner.identityEpoch = state.identityEpoch`。
- **前置依赖**：T10。
- **执行要点**：
  1. `owner` 改为只读：`uid`/`identityEpoch` 来自 `state.draftMaterial`（832–837），全程不再赋值；票据在 `await` 前创建（`kind='prepare'`，`opSeq=op`，`panelEpoch=panel`，`tokenAtStart=getToken()`，`boundTokenAtStart=state.token`，绑定材料文本快照）。
  2. `await verifyIdentity(ticket)`：非 `valid-same-account` → `handleVerificationFailure` → 释放 `buttonEl`、恢复 `status`（面板未关闭时可见）→ return。
  3. 请求前第二次 `isOperationStillValid(ticket)`：账号一致、`identityEpoch` 一致、`panelEpoch` 一致、`opSeq===draftEpoch`、`draftMaterial` 存在且其 `draftEpoch` 与票据一致、`draftStatus!=='stopped'`、材料文本未被替换；不成立 → 仅写 `#cc-save-state`“操作已失效或面板已关闭，本次未提交” → return。
  4. 发请求，请求体保持 `{message, date, includeRecentDiaries}` 不变（852–860）。
  5. 响应落地：保留 `isDraftResponseCurrent(owner)`（864）并追加 `isOperationStillValid(ticket)`；失败分支（865–872）同样复核，不成立时不写 `status`、不追加关怀。
- **验证方式**：`node --test --test-name-pattern="EDGE-R7" scripts/test-chat-companion-repair.test.js`（若可用）+ 全文件回归。
- **完成判据**：`EDGE-R7-01/02/08` 转绿；`R7-03/09` 保持绿；`EDGE-R1-01/02/04`、`EDGE-R6-01/02/03`、`P1-07`、`P2-01…03` 不掉；prepare 计数在换号/关闭面板场景为 0。
- **优先级**：P1

### T12 R7：confirm 接入请求前复核（含幂等恢复）
- **目标**：核验期间换号/关闭面板/草稿被替换时，**不发出** `/confirm`、不显示“已保存为私密日记”。
- **涉及文件/行号区间**：`confirmDraft`（1034–1115）、`resolveUnknownDraft`（1117–1145）；**删除 1076–1077** 两行 owner 代次改写。
- **前置依赖**：T10、T11（共享票据与复核骨架）。
- **执行要点**：
  1. 票据 `kind='confirm'`、`opSeq=++draftEpoch`（1052）、`panelEpoch=panelEpoch`（1051）、`draftId=state.draft.id`（1050）、`uid`/`identityEpoch` 来自 `state.draftOwner`（1054–1060）。
  2. 失败分支：`setDraftBusy(false)`；面板仍打开时写原 `status`，面板已关闭时只写 `#cc-save-state`；文案：`账号或登录状态已变化，请重新选择并重新生成草稿。` / `登录状态暂时无法确认，草稿未提交，请重新登录后再试。`
  3. 请求前 `isOperationStillValid`：`state.draft.id===draftId`、`draftStatus==='pending'`、面板/操作/身份一致 → 才发请求（1080–1084）。
  4. 落地：`isDraftResponseCurrent` + `isOperationStillValid`；**幂等恢复路径** `resolveUnknownDraft` 每次重试/查询前都调用 `isOperationStillValid(ticket)`，不成立立即返回 `{code:-2}`，不得在操作失效后继续重试同 ID。
- **验证方式**：全文件回归，重点 `EDGE-R7-04/09`、`EDGE-R5-01/02/03`、`B1`、`B3`、`normal confirm`、`EDGE-R3-01`。
- **完成判据**：`R7-04` 转绿；`R7-09` 保持绿；`/confirm` 计数在换号场景为 0；幂等恢复仍能拿到真实日记数据（B1 绿）。
- **优先级**：P1

### T13 R7：cancel 接入请求前复核
- **目标**：核验期间换号/关闭面板时 **DELETE 计数 0**，不写“草稿已取消”。
- **涉及文件/行号区间**：`cancelDraft`（1147–1209）；**删除 1182–1183** 两行 owner 代次改写。
- **前置依赖**：T10、T12（同草稿票据结构）。
- **执行要点**：
  1. 票据 `kind='cancel'`、`opSeq=++draftEpoch`（1159）、`panelEpoch=panelEpoch`（1158）、`draftId`。
  2. 失败分支 `setDraftBusy(false)`；文案 `账号或登录状态已变化，请重新选择。` / `登录状态暂时无法确认，草稿未取消，请重新登录后再试。`
  3. 请求前 `isOperationStillValid`（草稿 id/pending/面板/操作/身份）→ 才发 DELETE；落地前 `isDraftResponseCurrent` + `isOperationStillValid`。
  4. 取消终态 `cancelled` 与“取消不删除日记”语义不变（1205–1208）。
- **验证方式**：全文件回归，重点 `EDGE-R7-05`、`B3`（cancel terminal）、`P2-01/03`。
- **完成判据**：`R7-05` 转绿；DELETE 计数 0（换号/关面板场景）；`B3` 取消终态测试不掉。
- **优先级**：P1

### T14 R7：send 登录路径接入请求前复核
- **目标**：迟到核验不得用 B 凭证发送 A 文本；发送按钮与锁正常释放。
- **涉及文件/行号区间**：`sendMessage`（1253–1314）；**删除 1272–1273** 两行 owner 代次改写。
- **前置依赖**：T10（本任务只做登录路径；游客分流与 401 隔离归 T17–T19）。
- **执行要点**：
  1. 保持 `beginSend()` 同步占位（1211–1228、1261–1262）与 `isSendCurrent` / `settleSend` 归属规则不变。
  2. 票据 `kind='send'`、`opSeq=owner.id`、`sessionGen=owner.sessionGen`、`uid=owner.uid`、`identityEpoch=owner.identityEpoch`。
  3. 非 `valid-same-account` → `settleSend(owner)` + `handleVerificationFailure`（`identity-changed` 走既有 `switchAccount`，保留 `EDGE-R1-01/03` 文案“账号或登录状态已变化，请确认后重新发送”）→ return。
  4. 请求前 `isOperationStillValid`：`state.activeSend===owner`、session 未替换、`generation===ticket.sessionGen`、`inputEl.value.trim()===owner.text`（1274–1277 既有检查纳入）。
  5. `mode==='saved' && !getToken()` 分支（1278–1282）**本任务暂保持原样**，由 T19 改为隔离（避免与 R8 交叉改动）。
- **验证方式**：全文件回归，重点 `EDGE-R7-06`、`EDGE-R4-01/02/03`、`P1-04/06/07/08`。
- **完成判据**：`R7-06` 转绿；`/ai/chat` 计数 0（换号场景）；`send.disabled===false`、`state.sending===false`；R4 系列全绿。
- **优先级**：P1

### T15 R7：自动恢复接入恢复票据（决策 5）
- **目标**：恢复期间换号/退出不写入旧账号历史；关闭草稿/记忆面板**不影响**恢复。
- **涉及文件/行号区间**：`restoreSavedForAccount`（430–448）、初始化恢复（1416–1435）、`loadHistory` 既有 `ReadTicket`（539–560，不改语义）。
- **前置依赖**：T10。
- **执行要点**：
  1. 统一入口：创建恢复票据（`kind='restore'`、`uid=expectedUid`、`tokenAtStart=getToken()`、`boundTokenAtStart=state.token`、`identityEpoch`、`modeEpoch`、`restoreSeq` 递增）→ `verifyIdentity` → `isOperationStillValid`（账号/身份/`modeEpoch`/`restoreSeq` 一致、`readSaveMode(uid)==='on'`）→ 才写 `state.uid`/`state.token`（唯一绑定点）→ `replaceSession('saved')` → `loadHistory(true,true)`。
  2. 票据**不含** `panelEpoch`/`draftEpoch`：关闭面板不使恢复失效（决策 5）。
  3. 结果分支：`identity-changed` → `switchAccount(nextUid)`；`unconfirmed` → 保持临时会话 + “登录状态暂时无法确认”（不清空）；401 → T18 接入 `isolateSignedOutContext('auth401')`（本任务先以 `unconfirmed` 分支占位并标注 TODO 由 T18 替换）。
  4. 删除单靠 `epoch !== modeEpoch`（1420、434）的旧判定，改由票据四态裁决（可同时保留 `modeEpoch` 作为票据字段之一）。
- **验证方式**：全文件回归，重点 `EDGE-R7-07`、`P1-02`（初始恢复败给显式关闭）、`P1-05/06`。
- **完成判据**：`R7-07` 保持绿；`P1-02` 不掉；恢复成功时 `/auth/me` 1 次 + `/ai/messages` 1 次；换号后 B 页面无 A 历史。
- **优先级**：P1

### T16 P1 收尾与门禁（R7 全绿）
- **目标**：确认 R7 九条全部转绿或保持绿，且 P1 修复未破坏既有基线。
- **涉及文件**：日志 `docs/codearts_proof/logs/2026-11-13-identity-guest-p1-green.log`。
- **前置依赖**：T11–T15。
- **执行要点**：
  1. 在 `后端源码` 目录执行单文件回归，保存完整日志与退出码。
  2. 逐条记录 `EDGE-R7-01…09` 结果（红→绿清单）；此时 `EDGE-R8-01/02/04/05/06/09/10` 仍应红，`R8-03/07/08` 仍应绿。
  3. 复核既有 36 条全部通过（尤其 `P1-06`、`P1-07`、`EDGE-R2-03`、`EDGE-R4-02`、`B1`、`B4`）。
- **验证方式**：TAP 输出逐条比对；退出码非 0 是允许的（因 R8 未修复），但**不得有 R7 失败**。
- **完成判据**：R7 全绿 + 36 条既有全绿 + R8 红集合与预期一致；日志落盘。
- **优先级**：P1
- **门禁**：**R7 未全绿不得进入 T20/T21 完成 P2 收尾**；不得以“响应落地检查已覆盖”声明 R7 完成。

---

## 阶段 3 · P2 逐项修复：R8（T17–T21）

### T17 会话分类、`accountBound` 与 storage 监听改造
- **目标**：区分“匿名游客”“已登录”“曾登录但凭证失效待隔离”，并让 token 移除/账号缺失也能触发隔离。
- **涉及文件/行号区间**：`state` 新增 `accountBound`（默认 `false`，只增字段）；`classifySession` / `isGuestSession` / `hasLegacyContext`；`resetAccountView`（391–428）增量；`storage` 监听（1406–1414）。
- **前置依赖**：T16（P1 全绿门禁）。
- **执行要点**：
  1. `classifySession` 顺序判定：`getToken()` 非空且 `currentUid()` 非空 → `signed-in`；`getToken()` 为空且（`state.accountBound` 或 `hasLegacyContext()`）→ `signed-out-with-context`；否则 `guest`。
  2. `hasLegacyContext()` 实时计算（不持久化）：`state.uid` 非空、`state.token` 非空、`mode==='saved'`、`turns.length>0`、`draft!==null`、`memorySnapshot!==null`、`historyItems.length>0`、`panelKind` 非空、`activeSend!==null` 任一为真。
  3. `accountBound` 维护：初始化 `uid && token` 为 `true`；`switchAccount(nextUid)` 且非空为 `true`；核验 `valid-same-account` 且 `confirmedUid` 非空为 `true`；`enableSaved`/恢复成功为 `true`；隔离完成与 `resetAccountView('')` 为 `false`。
  4. `resetAccountView` 增量：补 `state.clearEpoch += 1`、`state.readSeq += 1`、`accountBound` 置位；**仅退出/失效**场景清 `inputEl.value`（换号路径**不得清输入**，否则 `P1-07` 第二次点击无文本）；不做“无 uid 有 token”错配重建。
  5. `storage` 判定表（替换 1406–1414 判断逻辑，事件注册位置不变）：
     | 事件状态 | 动作 |
     |---|---|
     | `key` 非 `wg_token`/`wg_user`/`null` | 忽略 |
     | `getToken()===''`（凭证移除/退出） | `accountBound || hasLegacyContext()` → `isolateSignedOutContext('removed')`；否则忽略 |
     | `getToken()!==''` 且 `currentUid()===''` | 视为不完整身份 → `isolateSignedOutContext('removed')` |
     | `currentUid() !== state.uid` | `switchAccount(nextUid, '检测到账号变化，已回到临时对话')` |
     | `currentUid()===state.uid` 且 `getToken()!==state.token` | 同账号刷新：**不清理、不推进代次、不写 `state.token`**，下一次动作由票据触发 1 次核验 |
     | 其他 | 忽略 |
  6. `event.key === null`（`localStorage.clear()`）按“凭证被移除”处理。
- **验证方式**：全文件回归，重点 `EDGE-R8-07/08`（保持绿）、`P1-07`、`EDGE-R4-03`、`EDGE-R1-01`。
- **完成判据**：`R8-07/08` 保持绿；`P1-07`（换号后第二次发送成功）不掉；token 移除但 user 未清 → 触发隔离；同账号刷新不被清理。
- **优先级**：P2

### T18 新增 `isolateSignedOutContext`（登录失效先隔离）
- **目标**：登录失效时先清空旧账号上下文并使在途请求失效，再转匿名临时会话；统一文案（决策 1）。
- **涉及文件/行号区间**：新增闭包内 `isolateSignedOutContext(reason)`；调用点为 storage（T17）、发送入口（T19）、发送 catch `40100`（T19）、`enableSaved` 的 `me` 失败分支（1327–1333）、初始化恢复 401（T15 占位替换）。
- **前置依赖**：T17。
- **执行要点（顺序不可交换）**：
  1. 推进代次：`modeEpoch+1`、`panelEpoch+1`、`draftEpoch+1`、`state.identityEpoch+1`、`state.clearEpoch+1`、`state.readSeq+1`、`restoreSeq+1`。
  2. 失效在途：`state.session.invalidate()`（只递增 generation）；`state.activeSend=null`；`state.sending=false`；`sendEl.disabled=false`。
  3. 清空 UI/内容：`chatEl.replaceChildren()`；`turns=[]`；`historyItems=[]`；`historyPage=1`；`historyHasMore=false`；草稿族（`draft/draftTrace/draftProvider/draftInclude/draftStatus/draftMaterial/draftOwner`）复位；`memorySnapshot=null`；`stoppedRound=0`；`panelKind=''`；`panelEl.hidden=true`；`panelBodyEl.replaceChildren()`；`activeDraftControls=null`；`careEl.hidden=true` 且清空；`inputEl.value=''`。
  4. 换会话：`state.session.reset()` → `createTemporary(request)`；`mode='temporary'`；`uid=''`；`token=''`；`accountBound=false`；`saveToggleEl.checked=false`；`updateModeUi()`。
  5. 提示：`removed`/`auth401`/`backend40100` 统一“登录状态已失效，已转为临时对话；本次不保存”；`restore-failed` 用“登录状态暂时无法确认，已回到临时对话”；写入 `#cc-save-state`，并追加一条 `ai` 气泡（`track=false`，不写入 `turns`）。
  6. **禁止**：不改服务端数据、不删账号历史/记忆、不写 `saveModeKey`（不把 A 的偏好改成 off）。
- **验证方式**：全文件回归，重点 `EDGE-R8-05/06/07`、`P1-05/06`、`EDGE-R2-03`。
- **完成判据**：隔离完成标志 11 项全部成立（`accountBound===false`、`uid===''`、`token===''`、`mode==='temporary'`、`turns.length===0`、`draft===null`、`memorySnapshot===null`、`historyItems.length===0`、`panelEl.hidden===true`、`activeSend===null`、`inputEl.value===''`）；`R8-07` 保持绿；`R8-05/06` 的清空子断言绿（游客发送子断言待 T19）。
- **优先级**：P2

### T19 游客临时发送与发送入口三分流（P2 核心）
- **目标**：游客可直接 `remember:false` 临时发送；曾登录失效先隔离后不发送；登录用户走票据路径。
- **涉及文件/行号区间**：`sendMessage`（1253–1314）入口分流；`mode==='saved' && !getToken()`（1278–1282）；catch `40100`（1301–1303）；失败回填（1307）。
- **前置依赖**：T17、T18、T14（登录路径票据已就绪）。
- **执行要点**：
  1. `beginSend()` 之后、任何 `await` 之前 `classifySession()` 分流：
     - `guest`：**不调用 `verifyIdentity`、不发 `/auth/me`**；`isOperationStillValid`（activeSend/session/generation/输入）→ `session.send(owner.text)`；成功：`isSendCurrent` → 追加回复、`showCare`、`showProvider`，`mode==='temporary'` 时 `showNotice('本次未保存；临时对话刷新后清空')`（绝不说“已保存”）；失败：`isSendCurrent` → 错误气泡、必要时回填（仅 owner 当前），不写历史/记忆。
     - `signed-out-with-context`：`isolateSignedOutContext('removed')` → `settleSend(owner)` → 提示“登录状态已失效，已转为临时对话；本次不保存” → **本次不发送**。
     - `signed-in`：走 T14 票据路径。
  2. `mode==='saved' && !getToken()`（1278–1282）改为 `isolateSignedOutContext('backend40100')`（或 `removed`）+ `settleSend`，本次不发送；**删除** `forceTemporary('登录状态已失效，已切换为临时对话')` 调用。
  3. catch `40100`：改为 `isolateSignedOutContext('backend40100')`；**不**追加“请重新登录后再保存”气泡；**不**回填输入（旧账号文本不得进入游客输入框）。
  4. 失败回填（1307）仅在 `isSendCurrent(owner)` 且输入仍为空时执行；隔离后 `activeSend===null`，自然不满足。
  5. 游客路径不引入第二个锁；`beginSend` 仍是唯一入口锁（连点第二次在 1254 返回）。
  6. 游客发送不得调用 `enableSaved`/`replaceSession('saved')`；请求体由 `chat-session.js` 生成 `remember:false` + 本页最近 16 条（决策 3，不改 `chat-session.js`）。
- **验证方式**：全文件回归，重点 `EDGE-R8-01/02/05/06/09/10`、`EDGE-R4-01/02/03`、`P1-04/06/07/08`。
- **完成判据**：`R8-01/02/06/09/10` 转绿；`R8-05` 转绿；游客 `/ai/chat` 恰好 1 次且 `remember:false`；无 `/auth/me`；提示含“未保存/临时”；R4 系列与 `P1-07` 不掉。
- **优先级**：P1（P2 功能的核心门禁项）

### T20 游客受限能力门禁（保存/历史/记忆/清除/草稿）
- **目标**：游客点击受限入口时**直接提示、不发请求**；待隔离状态先隔离再提示。
- **涉及文件/行号区间**：新增 `requireSignedInFor(feature)`；`openHistoryPanel`（618–628）、`openMemoryPanel`（630–659）、`openClearPanel`（661–726）、工具栏草稿入口（1383）；`enableSaved`（1316–1350）。
- **前置依赖**：T17、T18。
- **执行要点**：
  1. `requireSignedInFor`：`signed-out-with-context` → 先 `isolateSignedOutContext('removed')`；`guest`/待隔离 → 打开对应面板并显示 `登录后才能查看历史对话` / `登录后才能查看记忆` / `登录后才能清除记录` / `登录后才能生成草稿`，**不发任何需登录请求**，返回 `false`；`signed-in` → 返回 `true`，走既有路径（请求、40100 映射、`ReadTicket`、`clearEpoch` 全部不变）。
  2. 历史/记忆/清除/草稿四个入口在发请求前调用门禁；游客不渲染“确认清除”按钮、不渲染材料选择与“生成草稿”。
  3. `enableSaved`：无 token 分支（1318–1324）**保留原样**（`登录后才能保存对话记忆`）；`me` 失败分支（1327–1333）改走 `isolateSignedOutContext('auth401')`，不再 `forceTemporary`。
  4. 登录用户路径零改动：不改请求体、错误映射、读取票据语义。
- **验证方式**：全文件回归，重点 `EDGE-R8-03/04`、`P2-01/02/03`、`EDGE-R2-01/02/03`、`EDGE-R3-02/03`。
- **完成判据**：`R8-03` 保持绿、`R8-04` 转绿；游客四入口提示含“登录后才能”且需登录请求数为 0；登录用户历史/记忆/清除行为不变（P2 系列全绿）。
- **优先级**：P2

### T21 P2 收尾与门禁（R8 全绿 + 全量自检）
- **目标**：确认 19 条新增全部转绿或保持绿，既有 36 条不回退。
- **涉及文件**：日志 `docs/codearts_proof/logs/2026-11-13-identity-guest-p2-green.log`。
- **前置依赖**：T19、T20（且 T16 已完成）。
- **执行要点**：
  1. 单文件回归；逐条记录 `EDGE-R8-01…10` 结果与 `EDGE-R7-01…09` 复核结果；统计实际 `tests/pass/fail`。
  2. 若仍有用例红，逐条定位是实现缺口还是用例构造问题；构造问题只改用例，不改期望。
- **验证方式**：退出码 **0**；新增 19 条全部通过；既有 36 条全部通过（实际计数以 TAP 为准）。
- **完成判据**：`p2-green.log` 显示 55 条全通过（以实测为准）、退出码 0；R7 与 R8 均无失败。
- **优先级**：P1
- **门禁**：P2 未全绿不得进入 T25 及之后的完整验收与收尾。

---

## 阶段 4 · 修改面控制（T22–T24）

### T22 每步改动面与“只追加”静态核对
- **目标**：证明业务改动只在允许文件、测试只追加、既有行未变。
- **涉及文件**：`前端参考/chat-companion.js`、`后端源码/scripts/test-chat-companion-repair.test.js`。
- **前置依赖**：每个修复任务完成后即执行（T11–T20），最终在 T21 后汇总。
- **执行要点**：
  1. 每次改动后重新计算 `chat-companion.js` 的 SHA-256 与行数，记录“before → after”递增行数；确认新增内容均在闭包内（未改导出对象 `1440–1454`）。
  2. 测试文件：比对追加前哈希（T03 记录）与追加后前 969/970 行是否逐行一致；确认新增 19 条都在文件末尾且既有 36 条一行未改（不得格式化整文件）。
  3. `git status --short` 复核：未新增对禁止改文件的修改。
- **验证方式**：哈希对照表 + 行数差 + 前置行一致性核验结论落盘。
- **完成判据**：业务文件哈希/行数有 before/after；测试文件“前 969 行一致 + 末尾新增 19 条”有证据；出现越界即停止并回滚该项改动（用 T01 备份还原）。
- **优先级**：P1

### T23 禁止改项核对与脱敏检索
- **目标**：证明未改后端/契约/HTML/脚本，且日志无敏感信息。
- **涉及文件**：`api.js`、`chat-session.js`、`chat.html`、`login.html`、`settings.html`、`后端源码/package.json`、`后端源码/src/**`、`sql/**`、`.env`、既有证据文件。
- **前置依赖**：T22。
- **执行要点**：
  1. 对上述文件计算哈希并与 T01/基线清单比对，确认零变化；`package.json` 的 `test:competition`（第 14 行）与 `test:merge24`（第 15 行）未变。
  2. 对全部 `2026-11-13-identity-guest-*.log` 与截图执行脱敏检索：`Bearer`、`Authorization:`、`eyJ`、真实手机号正则、真实账号名。
  3. 确认既有证据文件（`2026-11-13-AB边界收尾.md` 及其日志/截图、`docs/review/**`、`docs/交接说明.md`）mtime/哈希未变。
- **验证方式**：哈希清单全一致；脱敏检索零命中（检索词本身作为说明文本出现时需标注）。
- **完成判据**：只读文件零改动；日志/截图无敏感信息；历史证据未覆盖。
- **优先级**：P1

### T24 可观察契约核对（state 字段/按钮/请求体/错误语义/Enter）
- **目标**：证明既有 36 条测试依赖的契约未被改变。
- **涉及文件**：`前端参考/chat-companion.js`。
- **前置依赖**：T21。
- **执行要点**：
  1. `state` 既有字段名/类型不变（`uid/mode/turns/sending/memorySnapshot/draft/draftStatus` 等）；新增字段只增（`accountBound` 等），不改既有语义。
  2. 9 条既有按钮文案逐条存在且在相同面板位置。
  3. 请求体不变：`/companion/prepare` 仍为 `{message,date,includeRecentDiaries}`；`/confirm` 仍为 `{text}`；`/ai/chat` 的 `remember/history` 由 `chat-session.js` 生成。
  4. 错误语义不变：`mapDraftError` 的 `cancelled/confirmed/expired/40400` 映射与既有文案保持。
  5. Enter 输入法保护（`isComposing`/`keyCode!==229`）与 2000 字上限不变。
- **验证方式**：逐条核对记录（表格）。
- **完成判据**：五类契约逐条有结论；新增用户可见文案仅限本轮新增提示（不覆盖既有按钮文案）。
- **优先级**：P1

---

## 阶段 5 · 自动化验收（T25–T28）

> 全部命令在 `后端源码` 目录执行（除复现脚本在仓库根），保存命令原文、退出码、完整 TAP 输出与用例计数。

### T25 单文件回归（55 条）
- **目标**：取得本轮单文件全绿证据。
- **涉及文件**：日志 `logs/2026-11-13-identity-guest-green.log`。
- **前置依赖**：T21、T22–T24。
- **执行要点**：`node --test scripts/test-chat-companion-repair.test.js`；记录 `tests/pass/fail` 实际值（预期 55/55，但以输出为准）。
- **验证方式**：退出码 0；新增 19 条在通过列表中。
- **完成判据**：退出码 0 + 完整日志 + 实际用例计数落盘；未把“预计 55 条”写成实测值。
- **优先级**：P1

### T26 `npm run test:competition`（完整竞赛回归）
- **目标**：证明既有 Node/脚本检查与新增用例共同通过。
- **涉及文件**：日志 `logs/2026-11-13-identity-guest-competition.log`。
- **前置依赖**：T25。
- **执行要点**：
  1. 在 `后端源码` 执行并保存完整 stdout/stderr 与退出码。
  2. 记录各段计数（Node `tests/pass/fail`、后续 `test-companion`、`test-moderation`、`test-chatbot` 结果）。
  3. 若出现 `127.0.0.1:3307` 沙箱拦截（`ENETUNREACH` / `Sandbox Network Error`），**如实标注“环境阻塞”**，不写成断言失败、也不写成通过；保留原文日志。
- **验证方式**：退出码 0 为通过；非 0 时逐条判定“环境阻塞 / 真实失败”。
- **完成判据**：命令、退出码、分段计数、日志路径全部落盘；阻塞项明确标注。
- **优先级**：P1

### T27 `npm run test:merge24`（合并回归）
- **目标**：证明合并链路未回退。
- **涉及文件**：日志 `logs/2026-11-13-identity-guest-merge24.log`。
- **前置依赖**：T26。
- **执行要点**：同 T26；记录 Node 23 项与后续社交/禁言检查结果；同样区分环境阻塞与真实失败。
- **验证方式**：退出码 0 为通过。
- **完成判据**：同 T26。
- **优先级**：P1

### T28 复现脚本（只作“缺陷是否复现”的辅助证据）
- **目标**：记录修复后缺陷是否仍按原路径复现；**不得**当作验收通过。
- **涉及文件**：日志 `logs/2026-11-13-identity-guest-repro.log`。
- **前置依赖**：T25。
- **执行要点**：
  1. 在仓库根执行 `node docs/review/2026-11-13-final-acceptance/identity-boundary-repro.cjs`，保存输出与退出码。
  2. 证据文档写明语义：退出 **0 = 缺陷仍存在**；退出 **非 0 = 至少一个“缺陷存在”断言失败，缺陷不再按原路径复现**，仍不等于浏览器端到端验收。
  3. 不得修改脚本断言方向来制造 0 或非 0。
- **验证方式**：退出码 + 两行 `REPRO:` 输出原文落盘。
- **完成判据**：日志含命令、退出码、语义说明；未将其写入“通过”栏。
- **优先级**：P1

---

## 阶段 6 · 浏览器验收（T29–T32）

> 只有 T25–T27 全绿（或有明确“环境阻塞”记录且已如实标注）才可进入本阶段。所有结论必须标注响应来源：**真实服务 / 控制响应（DevTools 限速、本机代理）/ 未验证**。

### T29 验收前置与合成账号准备
- **目标**：确认服务与文件一致，并准备可清理的合成账号。
- **涉及文件**：日志 `logs/2026-11-13-identity-guest-browser-precheck.log`；截图目录 `screenshots/2026-11-13-identity-guest/`。
- **前置依赖**：T25–T27。
- **执行要点**：
  1. 核对 `http://127.0.0.1:3000/api/health`、`http://127.0.0.1:8081/chat-companion.js` 的哈希与本地文件一致、`netstat` 的 8081/3000/3307 监听实例。
  2. 新建 `identity_guest_a_*` 与 `identity_guest_b_*` 两个合成账号（决策 7），记录创建 ID、用途、清理责任（验收后按 ID 逐条清理 `users`/`ai_messages`/`ai_diary_drafts`/`diaries`，**不执行** `DROP`/`TRUNCATE`/`ALTER`）。
  3. 若环境不允许创建或访问，明确记“未验收/环境阻塞”，**不得**用模拟数据冒充真实双账号验收。
- **验证方式**：四项前置核对结论 + 账号 ID 清单 + 清理责任落盘。
- **完成判据**：前置核对有明确结论（可用/阻塞）；合成账号与清理责任记录齐全。
- **优先级**：P2

### T30 游客临时聊天端到端（P2/F2）
- **目标**：真实页面验证游客可发送、刷新清空、退出后转游客。
- **涉及文件**：截图 + 证据文档“浏览器验收”章。
- **前置依赖**：T29。
- **执行要点**：
  1. 未登录打开 `chat.html`，输入合成句点击“说”；记录 `/ai/chat` 次数、`remember:false`、是否出现回复、是否无 `/auth/me`、提示是否含“本次未保存/临时”。
  2. 刷新页面再发一次；记录匿名消息是否消失、是否仍可临时发送、是否无历史/记忆请求。
  3. 以 A 登录聊天后退出（或异地失效）；记录 A 气泡/草稿/摘要是否消失、是否提示“登录状态已失效，已转为临时对话；本次不保存”。
  4. 标注响应来源：真实服务或控制响应；`configured=false` 时说明“本地支持回复，未使用大模型”。
- **验证方式**：截图 + 观察记录逐项对应 spec 6.2.1.2/6.2.1.5/6.2.1.8。
- **完成判据**：三项均有截图与文字结论；未验证项明确标注。
- **优先级**：P2

### T31 迟到核验换号（P1/F1）与关闭面板
- **目标**：真实/可控环境下确认不出现 A 材料跨账号提交。
- **涉及文件**：截图 + 证据文档。
- **前置依赖**：T29。
- **执行要点**：
  1. 用双标签页或可控响应（DevTools 限速/本机代理）构造：A 选材料 → token 刷新触发 `/auth/me` 在途 → 切 B 并触发 storage → 核验迟到返回 A。
  2. 观察：B 页面是否干净、是否无 A 材料/草稿/正文/成功提示、`/companion/prepare` 是否未发出。
  3. 关闭面板场景：点击“生成草稿”后立即关闭面板，核验返回后确认面板保持关闭、无预览。
  4. 若无法构造真实时序，明确标“仅最小 DOM harness 验证，浏览器未验收”。
- **验证方式**：截图/网络面板记录 + 结论。
- **完成判据**：场景与结论一一对应；标注“控制响应”或“未验收”。
- **优先级**：P2

### T32 游客受限能力与未验证项清单
- **目标**：验证游客保存/历史/记忆/清除/草稿的登录提示与零数据泄漏，并汇总不可验证项。
- **涉及文件**：截图 + 证据文档“不可验证项”清单。
- **前置依赖**：T29。
- **执行要点**：
  1. 游客点击保存开关、历史、记忆、清除、草稿；记录提示文案与是否出现任何账号数据；记录是否发出需登录请求。
  2. 汇总不可验证项：真实大模型效果（`configured=false`）、真实跨设备登录、真实网络超时、服务端 `40100` 未实际触发、393×852 未测量、非 Chrome 浏览器未验证。
- **验证方式**：五入口观察记录 + 不可验证清单。
- **完成判据**：五入口结论 + 不可验证项逐条标注“未验证/模拟响应”；无“验收通过”式笼统结论。
- **优先级**：P2

---

## 阶段 7 · 证据与收尾（T33–T35）

### T33 新增 `docs/codearts_proof/2026-11-13-身份核验与游客聊天加固.md`
- **目标**：形成本轮唯一新增过程记录，固定 11 章，如实记录命令、退出码、日志与结论。
- **涉及文件**：新建 `docs/codearts_proof/2026-11-13-身份核验与游客聊天加固.md`（**不得**覆盖 `2026-11-13-AB边界收尾.md`）。
- **前置依赖**：T25–T32。
- **执行要点（固定章节）**：
  1. **基本信息**：日期、时区、工作区、HEAD、分支、输入文档、基线哈希。
  2. **修改文件清单与前后哈希**：必改/可能改/只读；逐文件一句意图 + 前后 SHA-256 + 行数。
  3. **Git 实际可见范围**：T02 的事实与“未提交/未跟踪”说明。
  4. **红色证据**：命令、退出码、13 条失败用例名、关键失败断言、红的原因属于 R7/R8 业务缺陷的判定。
  5. **R7 逐项结果**：根因行号、改动点、对应用例、修复后结果；明确“已删除四处 owner 代次改写（849、1077、1183、1273）”。
  6. **R8 逐项结果**：会话分类、隔离清单、游客门禁、对应用例。
  7. **完整回归**：四条命令 + 退出码 + 用例计数 + 日志路径（含环境阻塞如实记录）。
  8. **浏览器验收**：检查项、合成账号、响应来源（真实/控制/设备模拟）、结果、截图路径；不可验证项单列。
  9. **状态清单**：`已修复-待人工复核` / `未修复` / `未验收`，**不写“验收通过”** 除非真实页面验收完成。
  10. **安全约束**：未改后端/数据库/端口/模型凭证；日志无 token/`Authorization`/真实个人信息；未覆盖历史证据。
  11. **遗留与复验命令**：未验证范围、复跑命令、残余窗口（复核到请求之间的极短窗口）。
- **验证方式**：逐章核对齐全；每条结论都能追溯到日志/截图。
- **完成判据**：11 章齐全、三态标注逐项、失败与未验收原文保留。
- **优先级**：P2

### T34 日志/截图落盘与 `docs/README.md` 索引（待用户同意）
- **目标**：证据文件齐全可检索；索引仅追加一行。
- **涉及文件**：`docs/codearts_proof/logs/2026-11-13-identity-guest-*.log`、`screenshots/2026-11-13-identity-guest/`、`docs/README.md`。
- **前置依赖**：T33。
- **执行要点**：
  1. 核对日志齐全：`baseline / red / p1-green / p2-green / green / competition / merge24 / repro / browser-precheck`；每份含命令、目录、时间、退出码。
  2. 截图与 T30–T32 检查项一一对应。
  3. `docs/README.md` 在“参赛与过程”表**追加一行**指向本轮证据文档（不改既有条目）。
- **验证方式**：文件清单 + 命名规范比对；README 仅新增 1 行（diff 或行数核对）。
- **完成判据**：日志/截图齐全对应；README 只追加一行（若用户同意）。
- **优先级**：P3

### T35 交付清单、修改清单与复验指引
- **目标**：向用户交回可核查的修改清单与后续动作。
- **涉及文件**：无代码改动；交付说明（回复 + 证据文档末章）。
- **前置依赖**：T33、T34。
- **执行要点**：
  1. 列出：改了哪些文件（含行区间）、删除了哪四处 owner 代次改写、新增哪些内部能力、新增哪些用例、哪些文件零改动。
  2. 列出：四条命令的实际退出码与计数；环境阻塞项；浏览器已验收/未验收项。
  3. 给出复验命令清单（单文件、competition、merge24、复现脚本、浏览器前置）与残余风险。
  4. 明确“本轮不提交、不推送”，由用户决定后续固定版本。
- **验证方式**：四段交付说明齐全；用户确认。
- **完成判据**：修改清单 + 结果表 + 复验命令 + 未完成项 齐备且可核查。
- **优先级**：P1

---

## 阶段 8 · 依赖与并行性

### 8.1 依赖关系（DAG，按可执行顺序）

```text
T01 ─┬─> T03 ─┬─> T05 ─> T06 ─> T07 ─> T08 ─> T09
T02 ─┤        │
T04 ─┘        │
              └────────────> T09 ─> T10 ─> T11 ─> T12 ─> T13 ─> T14 ─> T15 ─> T16
                                                                              │
                                                     T16（P1 门禁） ─> T17 ─> T18 ─> T19 ─> T20 ─> T21
                                                                                                    │
T22（每步执行）─ T23 ─ T24 ─────────────────────────────────────────────────────────────────────────┤
                                                                                                    v
                                                                T25 ─> T26 ─> T27 ─> T28 ─> T29
                                                                                              │
                                                                    T30 ─┬─> T31 ─┐           │
                                                                          └─> T32 ─┤
                                                                                   v
                                                                        T33 ─> T34 ─> T35
```

- `T09` 同时依赖 T05–T08（同一文件串行追加）与 T03/T04（基线与规范）。
- `T10–T15` 严格串行：`T10` 的票据/四态是所有路径的前置。
- `T17–T20` 串行：`T17`（分类/accountBound/storage）→ `T18`（隔离）→ `T19`（游客发送）→ `T20`（门禁）。
- `T19` 额外依赖 `T14`（登录路径已迁移到票据，避免游客分流与旧 `resolveIdentity` 混用）。

### 8.2 可并行 / 必须串行

| 关系 | 任务 | 说明 |
|---|---|---|
| 可并行 | T01、T02、T04 | 均为只读登记/新建目录，不写同一文件 |
| 必须串行 | T05 → T06 → T07 → T08 | 同一测试文件末尾追加，需保证连续行、避免行号冲突；建议按 R7 前段→R7 后段→R8 前段→R8 后段顺序 |
| 必须串行（门禁） | T03 → T09 | 必须先确认 36 条基线为绿，再追加并取得红日志 |
| 必须串行（门禁） | T09 → T10–T15 | **先红未完成前禁止任何业务代码改动** |
| 必须串行 | T10 → T11/T12/T13/T14/T15 | 票据与四态是公共前置 |
| 必须串行（门禁） | T16（R7 全绿）→ T17–T20 | **P1 未全绿不得进入 P2 收尾** |
| 必须串行 | T17 → T18 → T19 → T20 | 分类→隔离→游客发送→门禁存在链式依赖 |
| 必须串行 | T21 → T22–T24 | 全绿后才能做最终修改面/契约核对 |
| 必须串行 | T25 → T26 → T27 → T28 | 单文件绿后再跑两套完整回归与复现脚本 |
| 必须串行 | T27 → T29 | 浏览器验收必须在代码冻结且回归有结论之后 |
| 可并行 | T30、T31、T32 | 三个验收场景互不写同一文件（截图命名区分） |
| 必须串行 | T33 → T34 → T35 | 证据 → 索引 → 交付 |

### 8.3 优先级门禁

1. **先红门禁**：T09（13 条红 + 6 条绿 + 36 条既有绿）未完成，禁止开始 T10。
2. **P1 门禁**：`EDGE-R7-*` 未全绿（T16 未完成），禁止以“P2 已修”宣布本轮完成，禁止进入 T21 之后的收尾验收。
3. **完整回归门禁**：T25 未退出 0，不得进入 T29 浏览器验收与 T33 结论文档。
4. **结论门禁**：T26/T27 若为环境阻塞，必须在证据文档标注，不得写“通过”；不得用历史 105 项/23 项通过记录替代本轮结果。
5. **失败回滚**：某项改动导致既有 36 条失败且无法最小修复时，按 T01 备份还原 `chat-companion.js`，保留测试追加内容以便复现红，并记录还原原因/时间/哈希。

---

## 阶段 9 · 完成定义（DoD）与“不算完成”

### 9.1 逐项 DoD（可核查条件）

| 任务 | 完成的可核查条件 |
|---|---|
| T01 | 3 份哈希 + 3 份行数 + 3 份备份副本哈希一致，全部落盘 |
| T02 | 4 个 Git 事实 + 未跟踪/未提交清单 + 不写型 Git 操作声明 |
| T03 | 基线日志退出码 0；36 条全绿；末尾锚点与前 969 行哈希登记 |
| T04 | 9 类日志命名 + 截图命名 + 脱敏词表齐全 |
| T05–T08 | 19 条 `EDGE-R7-01…09`、`EDGE-R8-01…10` 存在于文件末尾；断言只用既有 harness/`state`/DOM/`calls`；既有 36 条一行未改 |
| T09 | 退出码非 0；13 条指定用例失败；6 条防回归 + 36 条既有通过；无 `TypeError`/环境错误；日志标注“红是预期” |
| T10 | 四态齐备；`R7-03` 绿；本地一致 0 次 `/auth/me`；同账号刷新 1 次；过期分支零写入 |
| T11 | `R7-01/02/08` 绿；`R7-03/09` 保持绿；848–849 两行已删除；prepare 计数 0（换号/关面板） |
| T12 | `R7-04` 绿；`R7-09` 保持绿；1076–1077 已删除；`B1` 幂等恢复仍绿 |
| T13 | `R7-05` 绿；1182–1183 已删除；`B3` 取消终态不掉 |
| T14 | `R7-06` 绿；1272–1273 已删除；R4 三条与 `P1-04/06/07/08` 不掉 |
| T15 | `R7-07` 保持绿；`P1-02` 不掉；恢复票据不含 `panelEpoch`/`draftEpoch`（决策 5） |
| T16 | R7 九条全绿；既有 36 条全绿；`p1-green.log` 落盘 |
| T17 | `R8-07/08` 保持绿；`P1-07` 不掉；storage 五行判定与“同账号刷新不清理”生效 |
| T18 | 隔离 11 项标志全部成立；`R8-07` 绿；统一文案（决策 1）；未写 `saveModeKey` |
| T19 | `R8-01/02/05/06/09/10` 绿；游客 `/ai/chat` 1 次且 `remember:false`；无 `/auth/me`；提示“未保存/临时” |
| T20 | `R8-03` 保持绿、`R8-04` 绿；游客四入口请求数 0 且提示“登录后才能” |
| T21 | 单文件 55 条全通过（以实测计）、退出码 0；`p2-green.log` 落盘 |
| T22 | 业务文件 before/after 哈希与行数；测试文件前 969 行一致 + 末尾 19 条 |
| T23 | 只读文件哈希全一致；日志/截图脱敏检索零命中；历史证据未覆盖 |
| T24 | `state` 字段、9 条按钮文案、请求体、错误语义、Enter 保护五类逐条有结论 |
| T25 | 退出码 0；55 条（实测）通过；日志含命令与计数 |
| T26 | 退出码 0；分段计数落盘；阻塞项标注“环境阻塞” |
| T27 | 退出码 0；分段计数落盘；阻塞项标注“环境阻塞” |
| T28 | 退出码与两行 `REPRO:` 输出落盘；语义写明“0 = 缺陷存在”；未写入通过结论 |
| T29 | 四项前置核对有结论；合成账号 ID 与清理责任记录 |
| T30–T32 | 每项有截图、步骤、响应来源标注；不可验证项单列 |
| T33 | 11 章齐全；三态逐项；失败与未验收原文保留 |
| T34 | 9 类日志齐全；截图一一对应；README 仅追加一行（若同意） |
| T35 | 四段交付说明齐全；用户确认 |

### 9.2 什么情况“不算完成”

1. **删断言 / 改期望 / 跳过用例**：为了让用例变绿而删除断言、放宽期望、`test.skip`、或把“应失败”改成“应通过”。
2. **把复现脚本退出 0 当通过**：`identity-boundary-repro.cjs` 退出 0 只表示**缺陷仍存在**；退出非 0 也只是“缺陷不再按原路径复现”，不等于浏览器验收。
3. **假红**：修复前失败原因是 `TypeError`、引用修复后才存在的符号、未定义变量、环境/端口错误，而非“旧材料被发出 / 游客被阻断 / 隔离未发生 / 提示缺失”。
4. **假绿**：前置不成立（草稿未渲染、`draftStatus` 非 `pending`、token 未变化、storage 未触发）导致的“通过”。
5. **只做响应落地检查**：仅保留/新增 `isDraftResponseCurrent`、`isSendCurrent` 而未做请求前 `verifyIdentity` + `isOperationStillValid`。
6. **把旧 owner 代次续命**：仍存在 `owner.identityEpoch = state.identityEpoch` 一类赋值（849/1077/1183/1273 未删）。
7. **过期核验写状态**：过期分支仍写 `state.uid`/`state.token`/`identityEpoch`/`panelEpoch`/`draftEpoch`/`session`。
8. **游客被阻断或旧上下文泄漏**：游客 `/ai/chat` 0 次；登录失效后仍保留 A 气泡/草稿/摘要/输入；游客消息 `remember:true`。
9. **改后端 / 改契约 / 改脚本**：改 `src/**`、`sql/**`、`.env`、数据库、端口、`package.json`、`api.js`、`chat-session.js`、HTML，或改请求 URL/方法/body/状态码。
10. **改既有 36 条或 R2–R6 行为**：包括格式化整文件、调整用例顺序、修改按钮文案。
11. **覆盖历史证据**：改写/删除 `2026-11-13-AB边界收尾.md`、`docs/review/**`、`docs/交接说明.md`。
12. **泄密**：日志/截图/测试输出含 token、`Authorization`、密钥、真实手机号/账号/聊天正文。
13. **把模拟当真实验收**：把单元测试、DevTools 模拟、可控代理写成“浏览器端到端通过”。
14. **结论冒进**：P1 未全绿就宣布完成；`configured=false` 时宣称真实大模型效果；环境阻塞写成通过。

---

## 阶段 10 · 关键验证命令清单（实施阶段使用，本阶段不执行）

> 执行目录已注明；每条命令对应一份日志，不拼接多次执行结果。

```text
# A. 基线哈希与行数（仓库根目录）
sha256sum 前端参考/chat-companion.js 前端参考/chat-companion.css 后端源码/scripts/test-chat-companion-repair.test.js
wc -l 前端参考/chat-companion.js 前端参考/chat-companion.css 后端源码/scripts/test-chat-companion-repair.test.js
# Windows PowerShell 等价：
powershell -Command 'Get-FileHash 前端参考/chat-companion.js -Algorithm SHA256'

# B. Git 可见范围（仓库根目录，只读）
git rev-parse --show-toplevel; git branch --show-current; git rev-parse HEAD; git status --short

# C. 基线（后端源码 目录，追加测试前，预期退出 0 / 36 条通过）
node --test scripts/test-chat-companion-repair.test.js

# D. 修复前红色基线（后端源码 目录，追加 19 条后、未改业务源码；预期退出码非 0）
node --test scripts/test-chat-companion-repair.test.js

# E. 逐项转绿（后端源码 目录，每项修复后）
node --test scripts/test-chat-companion-repair.test.js
# 可选按名过滤（Node 支持时）：
node --test --test-name-pattern="EDGE-R7" scripts/test-chat-companion-repair.test.js

# F. 完整回归（后端源码 目录）
npm run test:competition
npm run test:merge24

# G. 复现脚本（仓库根目录；退出 0 = 缺陷仍存在，非 0 = 原路径不再复现）
node docs/review/2026-11-13-final-acceptance/identity-boundary-repro.cjs

# H. 浏览器验收前置（需允许访问本地端口；被拦截则记“环境阻塞”）
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:8081/chat-companion.js | sha256sum
netstat -ano | findstr ":8081 :3000 :3307"

# I. 脱敏检索（仓库根目录）
rg -n "Bearer|Authorization:|eyJ" docs/codearts_proof/logs/2026-11-13-identity-guest-*.log
```

**命令纪律**：一条命令一份日志；命令原文、工作目录、开始时间、退出码必记；环境阻塞保留原文并标注，不改写成断言失败或通过。

---

## 阶段 11 · 仍需用户确认的事项

1. **`docs/README.md` 是否允许追加一行索引**：design 2.7.2 列为“可能改”；默认计划追加到“参赛与过程”表，请确认“追加”或“本轮不登记”。
2. **浏览器验收执行者与时间窗口**：T29–T32 需要 8081/3000/3307 就绪与人工观察；上一轮 3307 被沙箱拦截。请确认本轮由谁执行、是否允许在可访问本地端口的会话中执行；若否，T30–T32 全部标“未验收”。
3. **合成账号**：决策 7 要求新建 `identity_guest_a_*` / `identity_guest_b_*`；请确认是否允许创建，以及验收后按 ID 清理的执行者与授权范围（只逐条删除，不 `DROP`/`TRUNCATE`）。
4. **红集合口径**：本轮红集合为 **13 条**（比 spec 9.4 的 9 条多出 `R8-04/06/09/10`）。请确认接受该口径与“不拆分子断言、不改期望”。
5. **P1 全绿后是否停顿等人复核**：T16 完成后，是先交付人工复核再进入 R8（T17–T21），还是连续执行至 T21。
6. **`chat-companion.css` 授权范围**：仅当证明现有 `#cc-save-state`/`cc-note` 无法容纳新提示时才追加；请确认是否包含 `min-height:0` 一类小屏规则。
7. **`configured=false` 的表述**：本轮浏览器验收只能验证本地规则/降级回复；请确认证据文档统一写“本地支持回复，未使用大模型”。

---

**文档结论**：本任务规划共 **35 个任务、8 个执行阶段**，把 R7（票据/四态核验/五条路径请求前复核/过期零写入）、R8（会话分类/登录失效先隔离/游客临时发送/受限能力门禁）与 **19 条正式回归（13 红 / 6 绿）** 逐条落到可追踪任务；先红后绿、P1 先于 P2、逐项最小验证、修改面控制、两套完整回归与浏览器验收分列，并明确“什么情况不算完成”。本阶段不写业务代码、不改测试、不改配置、不执行测试命令。