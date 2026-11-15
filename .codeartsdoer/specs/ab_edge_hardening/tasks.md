# A/B 边界收尾 · 编码任务规划（tasks.md）

> 文档类型：编码任务规划（tasks）
> 工作区：`D:\微光同行\Glimmer`
> 上游输入：`.codeartsdoer/specs/ab_edge_hardening/spec.md`（696 行，EARS，R1–R6）、`.codeartsdoer/specs/ab_edge_hardening/design.md`（929 行）
> 关联只读输入：`docs/给CodeArts的返修收尾指令.md`、`docs/CodeArts返修复验与下一步.md`、`docs/codearts_proof/2026-11-13-任务AB返修.md`、`docs/review/2026-11-13-codearts-repair-check/` 下三份复现脚本
> 状态：待用户评审。本文件只规划“谁按什么顺序做什么、做完怎么证明”，**不含任何业务代码、测试代码或配置改动**；本阶段不执行测试命令。

---

## 0. 规划基线与统一约定

### 0.1 本次核对的基线事实（实施前需再次复核）

| 项 | 实测/文档值 | 本任务规划采用的口径 |
|---|---|---|
| 唯一必改业务文件 | `前端参考/chat-companion.js`，1194 行 | 只改此文件（含新增闭包字段与内部函数） |
| 测试文件 | `后端源码/scripts/test-chat-companion-repair.test.js`，483 行 | **只追加**，不改既有任何一行 |
| 既有用例数 | `grep -c "^test("` = **17 条**（`P1-01…P1-08`、`P2-01…P2-03`、`B1`、`B2`、`B3`×2、`B4`、`normal confirm`） | 以实测 17 条为基线；`design.md` 记为“12 条”属统计口径差异，**不回改 design.md**，实施时以实测数写入证据 |
| 追加后目标数 | 17 + 19 = 36 条 | 实际数以 TAP 输出为准，不把预计值写成实际值 |
| 样式文件 | `前端参考/chat-companion.css`，260 行 | 仅在 393×852 实测裁切/溢出时追加规则 |
| 只读文件 | `前端参考/api.js`（123 行）、`前端参考/chat-session.js`（77 行） | 不改 |
| 测试脚本 | `后端源码/package.json`，`test:competition`（第 14 行）、`test:merge24`（第 15 行） | 默认不改；仅在新增独立测试文件时评估 |
| 复现脚本语义 | `A-remaining-repro.cjs`、`B-remaining-repro.test.mjs`、`B-extra-checks.test.mjs` 的退出 0 = “缺陷存在” | 只作缺陷存在证据，**不得写入通过结论** |
| 模型状态 | `ai.configured=false` | 不得把本地规则结果称为真实大模型效果 |
| 证据目录 | `docs/codearts_proof/logs/` 已存在（含 2 份旧日志）；`screenshots/` 已存在；`backup/` 不存在 | 只新增文件，不覆盖旧文件；`backup/2026-11-13/` 需新建 |
| 受保护证据 | `docs/交接说明.md`、`docs/review/**`、`docs/codearts_proof/` 既有 3 份 md + 2 份 logs + 2 张截图 | 只读，不覆盖 |

### 0.2 需求 → 设计 → 用例 → 任务 对齐表（不得偏离或缩减）

| 需求 | design 章节 | 缺陷根因位置（实测行号） | 修复任务 | 正式回归用例 | 优先级 |
|---|---|---|---|---|---|
| R1 草稿材料与请求的身份绑定 | 2.4.1 | `renderDraftSelection` 624–691、`prepareDraft` 693–745、`confirmDraft` 869–930、`cancelDraft` 962–1003、`resolveUnknownDraft` 932–960 | T13（基础设施）、T14 | EDGE-R1-01…04 | P1 |
| R2 清除成功后的读取失效与面板影响域 | 2.4.2 | `openMemoryPanel` 535–563、`loadHistory` 445–465、`openPanel` 389–398、清除成功分支 593–607 | T15 | EDGE-R2-01…03 | P1 |
| R3 清除响应的账号与操作归属 | 2.4.3 | `openClearPanel` 的 `confirm.onclick` 575–608 | T16 | EDGE-R3-01…03 | P2 |
| R4 发送锁归属与重复提交防护 | 2.4.4 | `sendMessage` 1005–1053、`replaceSession` 270–279、`resetAccountView` 305–336 | T17 | EDGE-R4-01…03 | P2 |
| R5 确认成功后的关怀可见性 | 2.4.5 | `renderConfirmSuccess` 840–867、`confirmDraft` 928–929、`resolveUnknownDraft` 905–960 | T18 | EDGE-R5-01…03 | P2 |
| R6 停止生成终态 | 2.4.6 | `prepareDraft` 693–694、725、733–737、`renderDraftSelection` 626、`resetAccountView` 305–336 | T19 | EDGE-R6-01…03 | P3 |

四层归属模型（design 2.1.3，实施时必须四层齐备、互不替代）：

| 层级 | 字段 | 回答的问题 | 推进时机 |
|---|---|---|---|
| 身份层 | `state.identityEpoch` | 现在是哪个账号的连续有效期 | 换号/退出/身份校验失败/初始化换号 |
| 会话层 | `state.session.generation`（已有） | 这段上下文是否已被替换 | 清除成功、换号、模式切换 |
| 面板层 | `state.panelEpoch` + `state.panelKind` | 当前是第几次、哪种弹层 | 打开/关闭/切换/换号 |
| 操作层 | `state.draftEpoch` / `clearSeq` / `sendSeq` / `readSeq` | 这是同类第几次用户动作 | 每次准备/确认/取消/清除/发送/读取 |

三态身份复核（design 2.1.4，`resolveIdentity`）：`consistent` 允许继续；`mismatch` 不发请求、清空旧材料/旧草稿并提示；`unconfirmed` 不发请求、保留内容与输入、提示可恢复。

### 0.3 八条默认决策（原样落入任务，语义不得改动）

| # | 决策（原文语义） | 落入任务 |
|---|---|---|
| 1 | 同账号 token 刷新**不视为**身份变化：`/auth/me` 确认同账号后继续 | T13、T14（EDGE-R1-02） |
| 2 | 清除成功时已打开的草稿面板**保留可确认**，**不追加面板内提示** | T15（EDGE-R2-03） |
| 3 | confirm 失败返回 care 时**不新增**完整 `tel:` 展示 | T18（失败分支保持现状） |
| 4 | 停止生成终态**同时**提供面板“关闭”和终态内“返回聊天”，**不提供**“重新生成” | T19（EDGE-R6-01） |
| 5 | 清除成功停在历史/记忆面板时**显示空态** | T15（EDGE-R2-01/02） |
| 6 | 正常路径**允许跳过** `/auth/me`，仅本地凭证疑似变化或绑定缺失时复核一次 | T13、T14 |
| 7 | 回归**追加**到现有 `test-chat-companion-repair.test.js`，默认**不改** `package.json` | T06–T11、T21 |
| 8 | 真实页面验收**优先复用既有合成账号**，否则新建两个 `ab_edge_*` 账号并按导出 ID 逐条清理 | T26 |

### 0.4 修改面总边界（贯穿全部任务）

**允许改**
1. `前端参考/chat-companion.js`：只增字段/内部函数，并替换少数据判定的调用点。
2. `后端源码/scripts/test-chat-companion-repair.test.js`：只在文件末尾追加 19 条用例，可复用既有 `El`/`deferred`/`flush`/`setup`/`findButton`。
3. `前端参考/chat-companion.css`：**仅当** 393×852 实测出现裁切或长链接溢出时追加规则。
4. 新增 `docs/codearts_proof/2026-11-13-AB边界收尾.md`、`docs/codearts_proof/logs/2026-11-13-ab-edge-*.log`、`docs/codearts_proof/backup/2026-11-13/`、`docs/codearts_proof/screenshots/2026-11-13-ab-edge/`。
5. `docs/README.md`：仅追加一行索引。

**禁止改**
1. `后端源码/src/**`、`后端源码/sql/**`、`.env`、数据库结构/数据；不改 `3306`、不 `initdb`、不 `DROP`/`TRUNCATE`/`ALTER`。
2. `前端参考/api.js`、`前端参考/chat-session.js`、`前端参考/chat.html`、日记页与双门 HTML。
3. HTTP 契约：`/companion/prepare`、`/companion/drafts/:id`（GET/DELETE）、`/companion/drafts/:id/confirm`、`/ai/chat`、`/ai/memory`、`/ai/messages`、`/auth/me` 的 URL/方法/body 字段/状态码语义。
4. 双门入口、互关/粉丝、其他私信、未读汇总、群聊、举报、审核的任何页面与脚本。
5. 既有 17 条用例的任一行、既有 3 份证据 md、`docs/交接说明.md`、`docs/review/**`。
6. 既有按钮文案：`生成草稿`、`确认保存为私密日记`、`取消草稿`、`返回修改选择`、`确认清除`、`取消`、`关闭`、`再整理一段`；新增按钮使用新文案（`返回聊天`）。
7. 不执行 `git reset --hard` / `git checkout .`（工作区含未提交交接文档与历史证据）。
8. 日志/截图/测试输出不打印 token、`Authorization`、密钥、真实个人信息。

### 0.5 任务总表与阶段划分

| 阶段 | 任务 | 目标 | 优先级 |
|---|---|---|---|
| 阶段 0 前置基线冻结 | T01–T05 | 冻结哈希、备份、保护既有证据、登记服务身份与证据规范 | P1 |
| 阶段 1 先红 | T06–T12 | 19 条 `EDGE-*` 正式回归落地并取得“修复前失败”日志 | P1 |
| 阶段 2 逐项修复 | T13–T19 | 身份基础设施 + R1→R6 最小修改，逐项红转绿 | P1/P2/P3 |
| 阶段 3 修改面控制 | T20–T22 | 每步核对允许改/禁止改、只追加、契约不变 | P1 |
| 阶段 4 自动化验收 | T23–T25 | 两套完整回归 + 哈希与计数留痕 | P1 |
| 阶段 5 真实页面验收 | T26–T32 | 双标签、清除刷新、乱序、连发、确认族、393×852 | P2 |
| 阶段 6 证据与收尾 | T33–T34 | 新增证据文档与索引 | P2/P3 |
| 阶段 7 交付复核 | T35 | 交付清单、每项结果、未验证范围 | P1 |

**总量：35 个任务。** 其中 P1 级 19 个（T01–T07、T12–T15、T20–T26、T35）、P2 级 13 个（T08–T10、T16–T18、T27–T33）、P3 级 3 个（T11、T19、T34）。

---

## 阶段 0 · 前置基线冻结（T01–T05）

### T01 记录三份关键文件 SHA-256 并完成备份
- **优先级**：P1（阻塞全部后续任务）
- **目标**：在动手前冻结 `前端参考/chat-companion.js`、`前端参考/chat-companion.css`、`后端源码/scripts/test-chat-companion-repair.test.js` 的字节级基线，并生成可回滚副本。
- **涉及文件**：上述 3 个文件（只读计算）；新增 `docs/codearts_proof/backup/2026-11-13/`。
- **前置依赖**：无。
- **验证方式**：用 `sha256sum`（或 `powershell -Command 'Get-FileHash <path> -Algorithm SHA256'`）计算三份文件；把哈希与文件行数记入 `docs/codearts_proof/logs/2026-11-13-ab-edge-baseline.txt`。
- **完成判据**：3 个哈希 + 3 个行数（预期 1194 / 260 / 483）写入基线日志；备份目录存在且 3 份副本哈希与原文件逐一相等。
- **允许改 / 禁止改**：允许新增备份目录与基线日志；禁止以备份覆盖原文件，禁止改动原文件内容。
- [ ] 计算并记录 3 份 SHA-256 与行数（写入基线日志，含命令原文）
- [ ] 将 3 份文件复制到 `docs/codearts_proof/backup/2026-11-13/` 并标注“修复前副本”
- [ ] 校验 3 份副本哈希与原文件哈希一致，结果写入基线日志
- [ ] 记录 `前端参考/api.js`、`前端参考/chat-session.js`、`后端源码/package.json` 的哈希，作为“只读文件未被改动”的对照基线

### T02 核对工作区未提交修改与既有证据不被覆盖
- **优先级**：P1
- **目标**：确认实施不会覆盖未提交的交接文档与历史证据，并建立“实施后对比”清单。
- **涉及文件**：`docs/交接说明.md`、`docs/review/**`（3 份脚本 + 6 份结果）、`docs/codearts_proof/` 既有 3 份 md + `logs/` 2 份旧日志 + `screenshots/` 2 张旧截图、`docs/README.md`、`docs/给CodeArts的返修收尾指令.md`、`docs/CodeArts返修复验与下一步.md`。
- **前置依赖**：无（可与 T01 并行）。
- **验证方式**：逐个文件记录 SHA-256 与最后修改时间，形成保护清单；实施结束（T20、T35）时重算并比对。
- **完成判据**：保护清单覆盖上述全部条目，且清单文件落在基线日志；比对规则写明“哈希不变 = 未被覆盖”。
- **允许改 / 禁止改**：只新增清单；禁止编辑任何受保护文件，包括修正错别字。
- [ ] 为受保护文件逐一记录 SHA-256 与 mtime
- [ ] 明确列出“本轮可新增但不可改名/不可重写”的既有证据文件名
- [ ] 记录工作区非 Git 仓库的事实（无 `git status` 可用），改用哈希+目录清单作为等价基线

### T03 登记 8081 / 3000 / 3307 服务实例身份核对方法（只登记，不启动、不探测）
- **优先级**：P1（验收前置条件定义）
- **目标**：把“服务实例身份”这件事固化为可复现的核对步骤，避免验收时误连上级旧启动器或错误数据库。
- **涉及文件**：仅记录到证据文档草稿（`docs/codearts_proof/logs/2026-11-13-ab-edge-baseline.txt`）；不触碰任何服务与配置。
- **前置依赖**：无。
- **验证方式（本任务只登记命令与判定标准，不执行）**：
  - 8081：`curl -s http://127.0.0.1:8081/chat-companion.js` 取得内容，与磁盘 `前端参考/chat-companion.js` 的 SHA-256 比对；不一致即“非本工作区实例”，验收中止。
  - 3000：`curl -s http://127.0.0.1:3000/api/health`，要求 `db.connected=true`、`ai.configured=false` 并记录返回原文（脱敏）。
  - 3307：`netstat -ano | findstr ":3307"` + `tasklist /FI "PID eq <PID>"`，确认是本机 MySQL，且不是 3306。
  - 三端口 PID 一并登记，用于验收当日二次比对。
- **完成判据**：核对命令、预期值、失败判定（不一致/被拦截/端口被他人占用）三者齐全；明确“本阶段只登记，不启动、不重启、不建库”。
- **允许改 / 禁止改**：禁止在本阶段执行启动/重启/连接数据库；禁止改 `.env` 或端口配置。
- [ ] 写入 8081 静态资源比对命令与判定标准
- [ ] 写入 3000 健康检查命令、期望字段与“被沙箱拦截时记环境阻塞”的处置
- [ ] 写入 3307 端口与进程身份核对命令，明确禁止改用 3306
- [ ] 注明“本阶段不启动任何服务”，实际探测在 T26 执行

### T04 登记既有测试文件的“只追加”锚点
- **优先级**：P1
- **目标**：为 T20 的“纯追加”核验准备可机读锚点，防止误改既有 17 条用例。
- **涉及文件**：`后端源码/scripts/test-chat-companion-repair.test.js`（只读）。
- **前置依赖**：T01。
- **验证方式**：记录文件总行数（483）、最后一行内容（第 483 行 `});`）、`grep -c "^test("`（17）、`grep -n "^test("` 的全部行号，以及第 119–124 行的 harness 辅助常量区间。
- **完成判据**：锚点清单写入基线日志；追加完成后可用“前 483 行哈希不变 + 新增行从 484 开始”判定纯追加。
- **允许改 / 禁止改**：本任务不修改测试文件。
- [ ] 记录 17 条用例名称与起始行号
- [ ] 记录 483 行文件的 SHA-256（前 483 行整体哈希）
- [ ] 记录可复用的 harness 符号：`El`、`deferred`、`flush`、`setup`、`chatSuccess`、`historyEmpty`、`findButton`

### T05 建立证据与日志命名规范（含脱敏约束）
- **优先级**：P1
- **目标**：统一本轮所有日志、截图、备份的落盘路径，确保可审计且不泄密。
- **涉及文件**：新增 `docs/codearts_proof/logs/2026-11-13-ab-edge-*.log`、`docs/codearts_proof/screenshots/2026-11-13-ab-edge/`；`docs/codearts_proof/2026-11-13-AB边界收尾.md`（T33 创建，此处只定名）。
- **前置依赖**：无。
- **验证方式**：列出本轮计划产出的文件清单与命名，逐项注明“谁生成、何时生成、内容是否脱敏”。
- **完成判据**：命名清单完整，至少包含 `baseline`、`red`、`green`、`competition`、`merge24`、`browser` 六类日志；明确“日志只记录命令、退出码、用例名、断言摘要，不记录 token/Authorization/手机号/真实账号”。
- **允许改 / 禁止改**：只新增目录与空规范说明；禁止删除 `logs/` 下既有 2 份旧日志。
- [ ] 定义 6 类日志文件名与内容边界
- [ ] 定义截图目录命名与每张图的“检查项 + 响应来源”标注格式
- [ ] 明确脱敏规则与截图前的账号/内容检查清单

---

## 阶段 1 · 先红：19 条正式回归（T06–T12）

> 统一约束（适用于 T06–T11）：
> 1. 用例只断言**可观察行为**（请求次数与 body、`cc-panel-body` 文本、按钮 `disabled`、`state.uid`/`turns`/`draft`/`draftStatus`/`sending`/`memorySnapshot`），**不得直接调用修复后才存在的内部函数**（如 `resolveIdentity`），否则“修复前失败”只是 `TypeError` 假象。
> 2. 用例名统一以 `EDGE-R1-01` 等编号开头，便于 TAP 与证据检索。
> 3. 只在文件末尾追加，复用既有 harness，不复制第二套 `El`/`setup`。
> 4. 若某条“应为红”的用例修复前通过，**不得改断言期望为缺陷行为**；应先复核场景构造是否真实复现（参考 `A-remaining-repro.cjs`、`B-remaining-repro.test.mjs` 的时序），修正用例后重跑。

### T06 追加 R1 正式回归（EDGE-R1-01…04）
- **优先级**：P1
- **目标**：把“草稿材料与请求身份绑定”的正确行为固化为 4 条正式回归。
- **涉及文件**：`后端源码/scripts/test-chat-companion-repair.test.js`（仅追加）。
- **前置依赖**：T04。
- **验证方式**：`node --test scripts/test-chat-companion-repair.test.js`，逐条核对用例名出现在 TAP 输出中。
- **完成判据**：4 条用例存在且断言符合下表；其中 3 条（R1-01/03/04）在修复前必须失败。
- **允许改 / 禁止改**：允许追加；禁止修改既有 17 条、禁止改 `package.json`。
- [ ] `EDGE-R1-01`（修前必红）：A 已选材料 → 仅 `setAccount({uid:'B'},'token-B')`、**不触发 storage** → 点击“生成草稿”；断言 `/companion/prepare` 调用数 = 0、`state.uid` 不为 B、面板无可提交的 A 材料、提示含“账号或登录状态已变化”
- [ ] `EDGE-R1-02`（防回归，允许修前通过）：同账号 token 刷新（uid 仍 A）→ `/auth/me` 返回 A → 断言 prepare 恰好 1 次、请求体 `message` 含 A 材料、`state.token` 已更新为新 token
- [ ] `EDGE-R1-03`（修前必红）：A 的草稿预览 → 仅 `setAccount` 换 B（不触发 storage）→ 点击“确认保存为私密日记”；断言 confirm 调用数 = 0、面板无“已保存为私密日记”、出现可恢复提示
- [ ] `EDGE-R1-04`（修前必红）：prepare 在途（`deferred` 门控）→ `setAccount` 换 B 且不触发 storage → 迟到响应 resolve；断言 `state.draft` 仍为 `null`、面板无 A 的草稿正文
- [ ] 复核 4 条用例均未读取修复前不存在的内部符号

### T07 追加 R2 正式回归（EDGE-R2-01…03）
- **优先级**：P1
- **目标**：固化“清除成功使在途读取失效 + 面板影响域分别处理”的正确行为。
- **涉及文件**：同上（仅追加）。
- **前置依赖**：T04。
- **验证方式**：同 T06。
- **完成判据**：3 条用例存在；R2-01/02 修前必红，R2-03 为防回归。
- **允许改 / 禁止改**：允许追加；禁止改既有 `P2-01`/`P2-02`（它们覆盖“先读后清除”，本轮不重复也不得改动）。
- [ ] `EDGE-R2-01`（修前必红）：DELETE 门控在途 → `closePanel()` → `action('memory')` 发 GET（门控）→ DELETE 先成功 → 记忆 GET 迟到返回旧摘要；断言面板无旧摘要、`state.memorySnapshot === null`、面板显示空态文案
- [ ] `EDGE-R2-02`（修前必红）：DELETE 在途 → 记忆 GET **先**返回并渲染旧摘要 → DELETE 后成功；断言清除成功后不再显示旧摘要、`memorySnapshot === null`、`historyPage === 1`、`historyHasMore === false`
- [ ] `EDGE-R2-03`（防回归）：清除成功时草稿编辑面板打开；断言 textarea 值与面板文本不变、面板未出现“已清除 N 条”、面板未关闭
- [ ] 复核“空态”断言使用既有文案（`还没有聊天记录。` / `还没有已保存的聊天记录。`），不新造文案

### T08 追加 R3 正式回归（EDGE-R3-01…03）
- **优先级**：P2
- **目标**：固化“清除响应按发起账号与操作归属隔离”的正确行为。
- **涉及文件**：同上（仅追加）。
- **前置依赖**：T04。
- **验证方式**：同 T06。
- **完成判据**：3 条用例存在；R3-01 修前必红，R3-02/03 为防回归。
- **允许改 / 禁止改**：允许追加；禁止改既有 `P2-01`、`P1-05`、`P2-03`。
- [ ] `EDGE-R3-01`（修前必红）：A 的 DELETE 门控 → `setAccount(B)` + `emitStorage('wg_user')` → B 发送并得到回复 → A 的成功响应迟到；断言 B 的 `state.uid`/`turns`/气泡文本/`cc-save-state` 均不变、无“已清除本人”
- [ ] `EDGE-R3-02`（防回归）：同账号 A 关闭清除面板后 DELETE 成功；断言旧气泡与 `memorySnapshot` 被清理、面板不出现“已清除 N 条”
- [ ] `EDGE-R3-03`（防回归）：A 的清除失败响应在 B 页面到达；断言 B 页面无 A 的失败提示、B 的 turns 不变
- [ ] 复核断言不依赖计时，全部通过 `deferred` + `flush` 控制时序

### T09 追加 R4 正式回归（EDGE-R4-01…03）
- **优先级**：P2
- **目标**：固化“发送锁归属、同步占位、旧失败不回填”的正确行为。
- **涉及文件**：同上（仅追加）。
- **前置依赖**：T04。
- **验证方式**：同 T06。
- **完成判据**：3 条用例存在；R4-01/02 修前必红，R4-03 为防回归。
- **允许改 / 禁止改**：允许追加；禁止改既有 `P1-06`（该用例锁定“清除后立即发送不被旧请求阻塞”，修 R4 时不得让它失败）。
- [ ] `EDGE-R4-01`（修前必红）：旧请求门控 → 清除成功 → 新请求门控 pending → 旧请求 resolve → 第三次点击；断言旧返回后 `state.sending === true`、`send.disabled === true`、用户气泡数不增、`/ai/chat` 调用数仍为 2
- [ ] `EDGE-R4-02`（修前必红）：身份复核 `await` 期间连续两次 `emit('click')`；断言 `/ai/chat` 调用数 = 1、用户气泡 1 个
- [ ] `EDGE-R4-03`（防回归）：A 的发送失败响应在 B 页面到达；断言 B 的 `input.value` 未被 A 文本覆盖、B 页面无 A 的错误提示
- [ ] 复核用例断言的是可观察状态，不断言内部锁对象身份

### T10 追加 R5 正式回归（EDGE-R5-01…03）
- **优先级**：P2
- **目标**：固化“confirm 成功（含幂等恢复成功）当前弹层内完整展示 care”的正确行为。
- **涉及文件**：同上（仅追加）。
- **前置依赖**：T04。
- **验证方式**：同 T06。
- **完成判据**：3 条用例存在；R5-01/02 修前必红，R5-03 为防回归。
- **允许改 / 禁止改**：允许追加；禁止改既有 `B4`（只覆盖 prepare 的 `draft:null` 分支）。
- [ ] `EDGE-R5-01`（修前必红）：confirm 成功带 `care{message,lines:[{name,phone}]}`；断言 `cc-panel-body` 文本含 care 正文、渠道名、电话，且存在 `href === 'tel:<清洗后号码>'` 的节点、care 正文出现 1 次、confirm 调用数 1
- [ ] `EDGE-R5-02`（修前必红）：首次 confirm 返回 `code:-1` → 同 ID 重试成功并带 care；断言面板同样含正文/渠道/`tel:`、prepare 调用数 1、日记编号为服务端返回值（如 `42`）
- [ ] `EDGE-R5-03`（防回归）：confirm 成功但 `data.care` 为空；断言无 care 块、无虚构电话、无 `tel:` 链接
- [ ] 复核电话断言基于清洗后字符集（仅数字、`+`、`-`、`()`）

### T11 追加 R6 正式回归（EDGE-R6-01…03）
- **优先级**：P3
- **目标**：固化“停止生成终态”的正确行为。
- **涉及文件**：同上（仅追加）。
- **前置依赖**：T04。
- **验证方式**：同 T06。
- **完成判据**：3 条用例存在；R6-01 修前必红，R6-02/03 为防回归。
- **允许改 / 禁止改**：允许追加；禁止改既有 `B4` 与 `B-extra-checks` 的既有断言语义。
- [ ] `EDGE-R6-01`（修前必红）：prepare 返回 `draft:null + care`；断言“生成草稿”按钮 `disabled === true`（或已不在选择视图）、prepare 调用数 1、关怀块 1、存在“返回聊天”与面板“关闭”入口、无 confirm/DELETE 请求
- [ ] `EDGE-R6-02`（防回归）：prepare 返回 `code:-1`；断言不出现“已停止生成”、按钮可再次点击、无终态
- [ ] `EDGE-R6-03`（防回归）：停止态下换号；断言面板关闭、旧关怀不进入新账号页面
- [ ] 复核“返回聊天”为本轮新增文案，未与既有按钮文案冲突

### T12 运行修复前红色基线并保存非 0 日志
- **优先级**：P1（阻塞阶段 2）
- **目标**：取得“缺陷确实存在”的正式证据，且失败点与需求一一对应。
- **涉及文件**：新增 `docs/codearts_proof/logs/2026-11-13-ab-edge-red.log`。
- **前置依赖**：T01、T06–T11。
- **验证方式**：在后端目录执行 `node --test scripts/test-chat-companion-repair.test.js`，完整保存 stdout/stderr 与退出码。
- **完成判据**：
  1. 退出码非 0，且日志中可见 **11 条** `EDGE-*` 失败（R1-01/03/04、R2-01/02、R3-01、R4-01/02、R5-01/02、R6-01）；
  2. 8 条防回归用例通过（R1-02、R2-03、R3-02/03、R4-03、R5-03、R6-02/03）；
  3. 既有 17 条全部通过；
  4. 每条失败的断言摘要与 T06–T11 预期的失败点一致（不是环境错误、不是 `TypeError` 未定义符号）。
- **不算完成的情形**：把环境错误当作缺陷证据；失败数不足 11 条却直接进入修复；为凑失败而修改期望。
- **允许改 / 禁止改**：只新增日志；禁止改测试断言、禁止改业务代码后再“补”红日志（若中途改过业务代码，须回滚到 T01 备份后重跑）。
- [ ] 执行命令并保存完整日志与退出码
- [ ] 在日志顶部标注“红是预期：此日志证明缺陷存在，不代表通过”
- [ ] 逐条记录 11 条失败用例名 + 失败断言摘要
- [ ] 记录未变的既有 17 条用例通过情况

---

## 阶段 2 · 逐项修复（T13–T19）

> 统一约束（适用于 T13–T19）：
> 1. 每完成一项，**先只跑本任务的最小验证**，确认对应 `EDGE-*` 由红转绿且既有 17 条不掉；再进入下一项。
> 2. 只改 `前端参考/chat-companion.js`；不改 `api.js`、`chat-session.js`、后端与契约。
> 3. 新增字段一律追加到 `state`（180–197 区间）或闭包变量（199–202 区间），不改既有字段类型与语义。
> 4. 每个修复点都必须同时给出“请求前判定”和“响应落地前判定”两处，缺一视为未完成。
> 5. P1（T13–T15）任一未通过，不得进入 P2/P3 的收尾验收（T23 之后）。

### T13 建立身份归属基础设施（identityEpoch + resolveIdentity 三态）
- **优先级**：P1（R1/R3/R4/R6 共同依赖）
- **目标**：提供四层归属中的“身份层”，并实现三态复核，供草稿、清除、发送复用。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`state` 180–197、闭包代次 199–202、`currentUid` 301–303、`resetAccountView` 305–336、`ensureCurrentAccount` 368–387、`fetchMe` 287–298、返回对象 1176。
- **前置依赖**：T12。
- **改动要点**：
  1. `state.identityEpoch = 0`；在 `resetAccountView()`（305–336）内 `+1` 一次，且不重复推进（design 2.1.3 规则 2）。
  2. 新增 `resolveIdentity(owner, options)`：先本地比对 `owner.uid` / `state.uid` / `currentUid()` / `getToken()` / `state.token`；本地一致 → `consistent` 且**不发请求**（决策 6）；`storedUid` 存在且与绑定不同 → `mismatch`；token 变化但 uid 相同或绑定缺失 → 至多 1 次 `/auth/me`。
  3. `/auth/me` 返回同 uid → `consistent` 并刷新 `state.token`（**不**推进 `identityEpoch`，决策 1）；返回不同 uid → `mismatch`；401/网络失败/无 uid → `unconfirmed` 且 `identityEpoch += 1`。
  4. **不复用** `ensureCurrentAccount()`（368–387）的副作用：它发现 uid 变化会走 `switchAccount()` 关面板并写保存文案，草稿链路不得调用它（design 1.2.1）。
  5. 返回结构含 `status`/`uid`/`nextUid`/`viaNetwork`；不导出到全局对象。
- **状态与归属判定**：`mismatch` 由调用方清理（本任务只产出判定，不清 DOM）；`unconfirmed` 由调用方推进代次后再保留内容。
- **UI 行为**：本任务不直接改 UI；提示文案由 T14/T15/T17 按场景调用 `showNotice()`。
- **迟到响应处理**：`unconfirmed` 必须推进 `identityEpoch`，使在途响应的 `isDraftResponseCurrent`/`isReadValid`/`isSendCurrent` 全部失效。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R1-02` 转为通过（同账号 token 刷新允许继续且只 1 次 `/auth/me`）；既有 `P1-03`、`P1-07` 仍通过。
- **完成判据**：`EDGE-R1-02` 绿；本地一致路径 `/auth/me` 调用数为 0；同账号刷新路径 `/auth/me` 恰好 1 次；`P1-01…P1-08` 全绿。
- **允许改 / 禁止改**：允许新增闭包函数与 `state.identityEpoch`；禁止改 `modeEpoch` 语义（仍只表示保存开关意图，不得用于身份判定）、禁止改 `fetchMe()` 契约、禁止改 `/auth/me` 请求参数。
- [ ] 新增 `state.identityEpoch` 并在 `resetAccountView()` 推进
- [ ] 实现 `resolveIdentity()` 本地比对分支（零网络请求）
- [ ] 实现 `/auth/me` 分支（三态映射 + 同账号刷新绑定）
- [ ] 实现 `unconfirmed` 推进代次且不清面板
- [ ] 运最小验证并记录结果

### T14 R1 接入：草稿材料/草稿归属与三段请求复核
- **优先级**：P1
- **目标**：让 prepare / confirm / cancel / 恢复四条路径都带身份归属，并在响应落地前复核。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`selectedTurns` 614–622、`renderDraftSelection` 624–691、`prepareDraft` 693–745、`renderDraftPreview` 758–838（`activeDraftControls` 825）、`confirmDraft` 869–930、`resolveUnknownDraft` 932–960、`cancelDraft` 962–1003、`restoreSavedForAccount` 338–356、初始化恢复 1155–1174。
- **前置依赖**：T13。
- **改动要点**：
  1. 新增 `bindDraftMaterial(parts, panelToken, opToken)`：返回 `{parts, uid, identityEpoch, panelEpoch, draftEpoch}` 只读快照；在 `renderDraftSelection()` 内材料列表渲染完成后写入 `state.draftMaterial`。材料来源固定为当前 `state.turns` 快照（`selectedTurns` 615–621 不变）。
  2. 新增 `isDraftResponseCurrent(owner)`：比对 `identityEpoch`、`panelEpoch`、`draftEpoch`、`uid` 四项；替换 `prepareDraft` 第 724 行的 `op/panel` 判定，保留其对 `code:-1` 的既有处理。
  3. `prepareDraft()`（693）在**任何 `await` 与请求之前**调用 `resolveIdentity({uid: material.uid, identityEpoch: material.identityEpoch})`；`mismatch` → 清空 `state.draftMaterial`、重绘空选择、`showNotice('账号或登录状态已变化，请重新选择')`、**不发请求**；`unconfirmed` → 保留面板与正文、`showNotice('登录状态暂时无法确认，材料未提交，请重新登录后再试')`、按钮恢复。
  4. prepare 成功落地时写入 `state.draftOwner = {id, uid, identityEpoch, panelEpoch}`（新增，放在 `renderDraftPreview()` 之前，行 739–744 区间）。
  5. `confirmDraft()`（869）与 `cancelDraft()`（962）在请求前用 `resolveIdentity` 核对 `state.draftOwner.uid`；严重不一致不发请求；响应落地（903、910、987）在原有 `panel/op` 判定后追加 `identityEpoch` 与账号核对。
  6. 恢复路径（338–356、1155–1174）保留既有 `modeEpoch`/token/uid 复核，**只追加** `clearEpoch` 与读取票据校验（与 T15 共用，若 T15 未完成则本项先留出调用点并在 T15 补齐）。
- **状态与归属判定**：`consistent` 时若 token 被刷新，同步更新 `state.draftMaterial`/`draftOwner` 的凭证快照但不推进身份代次；`mismatch` 走既有 `switchAccount(nextUid)` → `resetAccountView()`，`state.draftMaterial`/`draftOwner` 需在 `resetAccountView` 内清空；`unconfirmed` 只推进代次。
- **UI 行为**：不一致时不出现预览、不出现任何 A 账号内容；无法确认时保留可编辑正文与面板，按钮恢复可用。
- **迟到响应处理**：prepare/confirm/cancel 在途换号（无论 storage 是否触发）→ `isDraftResponseCurrent` 为 `false` → 直接 return，不写预览、不写 `state.draft`、不追加关怀、**不用旧正文补写新账号草稿**。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R1-01`、`EDGE-R1-03`、`EDGE-R1-04` 转绿；`EDGE-R1-02` 保持绿；既有 `P2-01`/`P2-02`/`B1`/`B2`/`B3`×2/`normal confirm` 全绿。
- **完成判据**：R1 四条全绿；prepare 请求体字段仍只含 `message`/`date`/`includeRecentDiaries`；`buildDraftMaterial` 的 2000 字校验与 `draftTextIssue` 的 5000 字校验未被改动。
- **允许改 / 禁止改**：允许新增内部函数与 `state.draftMaterial`/`draftOwner`；禁止改 2000/5000 字上限、禁止改三类草稿请求的 URL/方法/body、禁止改 `mapDraftError`。
- [ ] 实现 `bindDraftMaterial()` 并在材料渲染后绑定
- [ ] 实现 `isDraftResponseCurrent()` 并替换 prepare 落地判定
- [ ] prepare 前置 `resolveIdentity` + 三态分支处理
- [ ] confirm/cancel 前置复核 + 响应追加身份判定
- [ ] `resetAccountView()` 清空 `draftMaterial`/`draftOwner`
- [ ] 运最小验证并记录结果

### T15 R2 接入：clearEpoch + ReadTicket + panelKind 影响域
- **优先级**：P1
- **目标**：清除成功使同账号在途历史/记忆读取失效，并按面板类型分别处理面板表现。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`state` 180–197、`openPanel` 389–398、`closePanel` 400–410、`loadHistory` 445–465、`renderHistoryPanel` 487–521、`openHistoryPanel` 523–533、`openMemoryPanel` 535–563、清除成功分支 593–607。
- **前置依赖**：T13（需要 `identityEpoch`）。可与 T14 并行开发，但需在 T14 之后合并验证以免同区域冲突。
- **改动要点**：
  1. `state.clearEpoch = 0`、`state.readSeq = 0`、`state.panelKind = ''`。
  2. `openPanel(title, kind)` 增加可选 `kind`，写入 `state.panelKind`；`closePanel()` 重置为 `''`；五个入口分别传 `history`/`memory`/`clear`/`draft`（草稿面板由 `renderDraftSelection`/`renderDraftPreview` 所在面板标记 `draft`）。
  3. 新增 `createReadTicket(kind, page)` 与 `isReadValid(ticket)`：比对 `uid`、`identityEpoch`、`clearEpoch`、`panelEpoch`、同类型 `seq`。
  4. `openMemoryPanel()` 在 `request('/ai/memory')`（540）前创建票据；第 542 行的 `token !== panelEpoch` 判定替换为 `isReadValid(ticket)`；`state.memorySnapshot = data`（551）只在有效时执行。
  5. `loadHistory()` 在请求前创建票据（含 `page`）；第 456 行的会话代次判定扩展为 `isReadValid` + 会话代次双条件。
  6. 清除成功分支（593–607）：`clearEpoch += 1`、`readSeq += 1`、`memorySnapshot = null`；**上下文清理无条件执行**（不依赖 `panelEpoch`）；面板按 `panelKind` 分别处理：`memory` → 空态、`history` → 空态 + 分页归零、`draft` → **不改 DOM、不追加面板内提示**（决策 2）、`clear` → 成功文案、已关闭 → 不动 DOM。
  7. 清除失败分支（582–591）保持现状：不推进 `clearEpoch`、保留摘要、保留“摘要仍然保留”提示。
- **状态与归属判定**：成功时一次性推进 `clearEpoch`/`readSeq` 并清空 `memorySnapshot`；`historyPage=1`、`historyHasMore=false`。
- **UI 行为**：记忆面板空态文案复用 `还没有聊天记录。`；历史面板复用 `还没有已保存的聊天记录。`；草稿面板完全不动（textarea 值、焦点、编辑状态）。
- **迟到响应处理**：`isReadValid` 任一维不符即返回，**不写面板、不写缓存**；清除成功使全部在途票据失效（含加载更早分页）。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R2-01`、`EDGE-R2-02` 转绿、`EDGE-R2-03` 保持绿；既有 `P2-01`、`P2-02`、`P2-03` 全绿。
- **完成判据**：R2 三条全绿；清除失败路径不推进 `clearEpoch`；`/ai/memory`、`/ai/messages` 请求结构不变。
- **允许改 / 禁止改**：允许新增 `clearEpoch`/`readSeq`/`panelKind`/票据函数；禁止把 `panelEpoch` 当作清理上下文的唯一条件、禁止为清记忆而重绘无关草稿面板、禁止改读取接口参数。
- [ ] 新增 `clearEpoch`/`readSeq`/`panelKind` 并在五个面板入口设置类型
- [ ] 实现 `createReadTicket()`/`isReadValid()`
- [ ] 记忆读取接入票据（替换 542 行判定）
- [ ] 历史读取接入票据（456 行双条件）
- [ ] 清除成功按 `panelKind` 分派影响域 + 推进失效代次
- [ ] 运最小验证并记录结果

### T16 R3 接入：ClearOp 发起归属与回调裁决
- **优先级**：P2
- **目标**：让清除的成功/失败回调按“发起账号 + 操作序号 + 面板”裁决，跨账号完全丢弃。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`openClearPanel` 565–612（`confirm.onclick` 575–608，成功分支 593–607，失败分支 582–591）、`replaceSession` 270–279、`resetAccountView` 305–336。
- **前置依赖**：T13（`identityEpoch`）、T15（`panelKind`、失效代次）。
- **改动要点**：
  1. `state.clearSeq = 0`；`confirm.onclick`（575）在任何 `await` 之前创建 `ClearOp = {id: ++clearSeq, uid: currentUid() || state.uid, identityEpoch, panelToken: panelEpoch, sessionGen: state.session.generation}`。
  2. 新增 `judgeClearResponse(op, outcome)`，判定顺序固定：`op.id === state.clearSeq`（旧操作 → `discard`）→ `currentUid() === op.uid`（跨账号 → `discard`）→ `op.identityEpoch === state.identityEpoch` → `op.panelToken === panelEpoch && panelKind === 'clear'`（决定 `context-and-panel`）否则 `context-only`。
  3. 成功分支（593–607）：`discard` → 直接 return（不 `replaceSession`、不清 `chatEl`/`turns`/`history`、不 `showNotice`、不 `addBubble`）；`context-only`/`context-and-panel` 都执行同账号上下文清理（`replaceSession`、`memorySnapshot=null`、清气泡、`turns=[]`、历史与分页归零、隐藏背景关怀），仅后者写面板成功文案。
  4. 失败分支（582–591）：跨账号或旧操作 → 丢弃；同账号且原面板 → 保留现有失败提示与“摘要仍然保留”。
  5. `replaceSession()` 追加 `state.activeSend = null`（与 T17 协作，作废旧发送归属）；保留 `sending=false` 与按钮恢复（`P1-06` 依赖）。
  6. `resetAccountView()` 追加 `clearSeq` 相关重置（`clearSeq` 不清零以免序号回退，仅置 `activeSend=null`，并清 `panelKind`）。
- **状态与归属判定**：跨账号不改 `uid`/`tokens`/`turns`/`session`/`memorySnapshot`，不写任何提示；同账号连续两次清除时旧 `op.id` 必须丢弃。
- **UI 行为**：B 页面在 A 的迟到成功到达后，气泡、turns、输入框、保存提示、面板内容全部保持原样；同账号关闭面板成功后重新打开记忆显示空态。
- **迟到响应处理**：判定顺序保证“先操作、后账号、再面板”，任何一步不符不进入渲染分支。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R3-01` 转绿、`EDGE-R3-02`/`R3-03` 保持绿；既有 `P1-05`、`P1-06`、`P2-01`、`P2-03` 全绿。
- **完成判据**：R3 三条全绿；DELETE 的 URL/方法不变；成功文案内容与 `deleted` 数量来源不变。
- **允许改 / 禁止改**：允许新增 `clearSeq`/`ClearOp`/`judgeClearResponse`；禁止在成功回调中无条件 `replaceSession`、禁止改清除接口字段、禁止改日记/草稿与清除的影响边界（只影响聊天记录与摘要）。
- [ ] 新增 `state.clearSeq` 并在 `确认清除` 点击时同步创建 `ClearOp`
- [ ] 实现 `judgeClearResponse()` 四级顺序判定
- [ ] 成功分支改为三步裁决（discard / context-only / context-and-panel）
- [ ] 失败分支增加账号与操作归属判定
- [ ] `replaceSession()`/`resetAccountView()` 作废旧 `activeSend`
- [ ] 运最小验证并记录结果

### T17 R4 接入：同步占位 SendOwner 与拥有者收尾
- **优先级**：P2
- **目标**：发送锁带归属，`await` 前占位，旧请求只收尾自己。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`sendMessage` 1005–1053（入口 1005–1013、占位 1021–1025、响应 1028–1036、catch 1037–1046、finally 1047–1052）、Enter 监听 1099–1104、`replaceSession` 270–279、`resetAccountView` 305–336。
- **前置依赖**：T13（`resolveIdentity`）、T16（`replaceSession` 作废旧发送）。
- **改动要点**：
  1. `state.activeSend = null`、`state.sendSeq = 0`。
  2. 新增 `beginSend()`：**同步**创建 `SendOwner = {id: ++sendSeq, uid, identityEpoch, session, sessionGen, text, typingEl: null, committed: false}` 并置 `state.activeSend`/`state.sending = true`/`sendEl.disabled = true`；已有 `activeSend` 时返回 `null`。
  3. `sendMessage()` 顺序重排：读文本与长度校验（1007–1011）→ `beginSend()`（**在任何 `await` 之前**，替换 1021 行的晚置位）→ `resolveIdentity`（替换 1013 的 `ensureCurrentAccount`，但保留其“换号时清理”语义：`mismatch` 走既有 `switchAccount`）→ 复核 `owner.text === inputEl.value.trim()`（输入被改写则释放占位、不发送）→ 置 `committed=true`、清输入、加气泡与 typing → `session.send()`。
  4. 响应落地用 `isSendCurrent(owner)`：`state.activeSend === owner`、`state.session === owner.session`、`!session.isStale(owner.sessionGen)`、`identityEpoch` 与账号一致；任一不符丢弃页面更新。
  5. `settleSend(owner)`：**总是**移除自己的 `typingEl`；仅当 `state.activeSend === owner` 才置 `sending=false`、`sendEl.disabled=false`、`inputEl.focus()`。
  6. 输入回填守卫：仅当 `state.activeSend === owner`、账号未变、`inputEl.value === ''` 时回填 `owner.text`。
  7. Enter 监听（1099–1104）保持 `isComposing`/`keyCode !== 229` 保护，内部调用同一 `sendMessage()`（占位逻辑自然生效）。
- **状态与归属判定**：`state.sending` 继续作为可观察布尔，与 `activeSend` 同步；占位阶段**尚未**新增气泡（`P1-07` 的“第一次拒绝、第二次成功”顺序不得改变）。
- **UI 行为**：新请求 pending 期间旧请求返回不改按钮、不移除新 typing；第三次点击被同步拦截（不新增气泡、不调 `/ai/chat`）。
- **迟到响应处理**：`isSendCurrent` 五维核对；`settleSend` 对非拥有者只移除自己的 typing，不动锁/按钮/焦点。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R4-01`、`EDGE-R4-02` 转绿、`EDGE-R4-03` 保持绿；既有 `P1-04`、`P1-06`、`P1-07`、`P1-08` 全绿。
- **完成判据**：R4 三条全绿；`/ai/chat` 请求体仍由 `chat-session.js` 决定（`remember`/`history` 不变）；未改 `chat-session.js`。
- **允许改 / 禁止改**：允许新增 `activeSend`/`sendSeq`/三个发送函数；禁止改 `chat-session.js` 的 `pending` 语义、禁止改 Enter 中文输入法保护、禁止把气泡渲染提前到“未实际发送”之前。
- [ ] 新增 `state.activeSend`/`state.sendSeq` 与 `beginSend()`
- [ ] `sendMessage()` 重排为“同步占位 → 复核 → 发送”
- [ ] 实现 `isSendCurrent()` 并替换会话单一判定
- [ ] 实现 `settleSend()`（拥有者收尾）
- [ ] 输入回填守卫按归属与空输入判定
- [ ] 运最小验证并记录结果

### T18 R5 接入：confirm 成功弹层内完整关怀
- **优先级**：P2
- **目标**：confirm 成功（含幂等恢复成功）在**当前成功弹层**内展示 care 正文、渠道与 `tel:`，且只展示一次。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`appendCareFull` 425–439、`responseCare` 441–443、`renderConfirmSuccess` 840–867、`confirmDraft` 928–929、`resolveUnknownDraft` 932–960（905–908 回到同一成功分支）。样式文件仅条件触发。
- **前置依赖**：T14（成功分支已受归属约束）。
- **改动要点**：
  1. `renderConfirmSuccess(data, care)` 增加 `care` 参数；在成功信息、日记链接之后调用 `appendCareFull(care)`（复用 425–439 的纯文本 + `tel:` + 电话字符清洗，不新增第二套渲染）；`care` 为空时不渲染。
  2. `confirmDraft()` 第 928–929 行：移除单独的背景 `showCare(res.data && res.data.care)`，改为 `renderConfirmSuccess(res.data, responseCare(res))`；背景关怀由 `appendCareFull` 内部 `showCare` 统一处理。
  3. `resolveUnknownDraft()` 不改恢复逻辑；恢复成功仍回到同一成功分支，自动获得完整关怀。
  4. 失败分支（912–926）**保持现状**：背景关怀 + 面板正文提示，**不新增** `tel:` 链接（决策 3）。
  5. `renderConfirmSuccess` 保持 `activeDraftControls = null` 与“关闭”/“再整理一段”按钮不变。
- **状态与归属判定**：不新增业务状态；`state.draftStatus` 仍由服务端结果决定，care 不改变成功事实。
- **UI 行为**：弹层内出现 care 正文 1 次 + 每个渠道名 + 可点击 `tel:`；日记编号/日期/可见性/站内链接仍来自服务端返回值。
- **迟到响应处理**：成功渲染仍受 `panel/op/identity` 归属约束；关闭面板后的迟到确认不渲染、不追加关怀。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R5-01`、`EDGE-R5-02` 转绿、`EDGE-R5-03` 保持绿；既有 `B1`、`B4`、`normal confirm` 全绿。
- **完成判据**：R5 三条全绿；confirm 请求次数不因渲染 care 增加；无伪造 care；`tel:` 清洗正则未改。
- **允许改 / 禁止改**：允许改 `renderConfirmSuccess` 签名与调用点；禁止改后端确认语义、禁止改 `mapDraftError`、禁止在失败分支新增渠道链接、禁止改 `isSafeDiaryUrl`。
- [ ] `renderConfirmSuccess(data, care)` 签名与 care 渲染
- [ ] `confirmDraft` 成功分支改为单一调用（去掉重复背景渲染）
- [ ] 核对幂等恢复成功路径自动复用
- [ ] 核对失败分支未新增 `tel:`
- [ ] 运最小验证并记录结果

### T19 R6 接入：停止生成终态（stopped）
- **优先级**：P3
- **目标**：`draft:null + care` 进入 `stopped` 终态，生成入口收敛、关怀只追加一次、提供关闭与返回。
- **涉及文件**：`前端参考/chat-companion.js`。基线行号：`renderDraftSelection` 624–691（`draftStatus=''` 626、`prepare.disabled` 676、按钮 675–677）、`prepareDraft` 693–745（入口 693–694、按钮解锁 725、停止分支 733–737）、`resetAccountView` 305–336、`setDraftBusy` 747–756。
- **前置依赖**：T14（`isDraftResponseCurrent` 约束停止态渲染）、T18（`appendCareFull` 已在成功路径验证）。
- **改动要点**：
  1. `prepareDraft()` 首部（693–694）增加终态拦截：`state.draftStatus === 'stopped'` 时直接返回并保留现有提示，不构造材料、不发请求。
  2. 按钮解锁（725）与停止分支（733–737）顺序调整：进入停止分支时**不执行** `buttonEl.disabled = false`；设置 `state.draftStatus='stopped'`、`state.draft=null`、`state.stoppedRound = op`。
  3. 新增 `renderStopped(care, opToken)`：`panelBodyEl.replaceChildren()` 后一次性渲染“已停止生成”说明、`appendCareFull(care)`、`返回聊天` 按钮；面板头部关闭按钮保持可用；**不提供**“重新生成”（决策 4）。
  4. `renderDraftSelection()`（626）在新一轮进入时重置 `state.draftStatus=''`、`state.stoppedRound=0`，并重新校验身份与材料（与 T14 协作）。
  5. `resetAccountView()` 追加 `draftStatus=''`、`stoppedRound=0`（面板关闭、关怀清空已由现有行为覆盖）。
  6. 网络失败分支（726–731）保持现状：显示错误、允许重试、**不进入** `stopped`。
- **状态与归属判定**：`pending → stopped` 仅由 `draft:null + care` 触发；不调用取消/确认接口、不写日记；`stopped` 不上报服务端。
- **UI 行为**：“生成草稿”禁用或不在选择视图；关怀正文/渠道/`tel:` 可见；`返回聊天` 与面板关闭均可聚焦可点击；文案为“已停止生成”，**不写**“草稿已取消”。
- **迟到响应处理**：停止态渲染受 `isDraftResponseCurrent` 约束；换号后旧停止态不进入新账号页面。
- **最小验证命令与预期**：`node --test scripts/test-chat-companion-repair.test.js` → `EDGE-R6-01` 转绿、`EDGE-R6-02`/`R6-03` 保持绿；既有 `B4` 全绿。
- **完成判据**：R6 三条全绿；停止态下 prepare 调用数 1、关怀块 1；无 confirm/DELETE 请求；`mapDraftError` 未改。
- **允许改 / 禁止改**：允许新增 `stopped` 状态值与 `renderStopped()`；禁止改后端 prepare 语义、禁止改取消终态与确认成功路径、禁止在 `stopped` 下重新启用生成按钮。
- [ ] `prepareDraft()` 首部终态拦截
- [ ] 停止分支不再解锁按钮，写入 `draftStatus='stopped'`
- [ ] 新增 `renderStopped()`（说明 + 一次关怀 + `返回聊天`）
- [ ] `renderDraftSelection()`/`resetAccountView()` 重置终态
- [ ] 运最小验证并记录结果

---

## 阶段 3 · 修改面控制（T20–T22）

### T20 每步修改面静态核对（diff 范围、行数、纯追加）
- **优先级**：P1
- **目标**：证明改动只落在允许文件，且测试文件是纯追加。
- **涉及文件**：`前端参考/chat-companion.js`、`后端源码/scripts/test-chat-companion-repair.test.js`、`前端参考/chat-companion.css`（若有）、上述三份基线日志。
- **前置依赖**：T13–T19 每完成一项即执行一次；T23 之前做一次汇总。
- **验证方式**：
  1. 对 `chat-companion.js` 用“备份 vs 当前”逐行比对（`diff -u` 或编辑器对比），列出新增函数与改动调用点，确认没有整段重写；
  2. 对测试文件校验“前 483 行哈希不变”，新增内容只出现在 484 行之后；
  3. 对 `chat-companion.css` 校验“原 260 行不变，仅追加”。
- **完成判据**：三份比对结论写入证据文档；`chat-companion.js` 无删除既有导出字段、无删除既有按钮文案；测试文件既有 17 条 ULID 级不变。
- **不算完成的情形**：用“格式化整个文件”掩盖改动范围；测试文件出现对既有行的任何编辑（即使语义等价）。
- **允许改 / 禁止改**：只读比对；禁止在核对阶段“顺手”调整代码。
- [ ] 每完成一个修复任务后执行一次 diff 范围核对并记录
- [ ] 校验测试文件前 483 行哈希不变
- [ ] 校验 CSS 仅在触发条件成立时追加
- [ ] 汇总“新增函数/新增字段/改动调用点”清单

### T21 禁止改项核对（后端零改动 + 既有能力保护 + 日志脱敏）
- **优先级**：P1
- **目标**：一次性证明后端、数据库、契约、既有增量均未被触碰，且日志无敏感信息。
- **涉及文件**：`后端源码/src/**`、`后端源码/sql/**`、`.env`、`前端参考/api.js`、`前端参考/chat-session.js`、双门/社交/未读/举报/审核相关页面与脚本、所有本轮新增日志与截图。
- **前置依赖**：T01（只读文件哈希基线）。
- **验证方式**：重算 T01 记录的只读文件哈希并逐项比对；目录清单比对（`src`/`sql` 下文件数与 mtime 不变）；对日志全文检索 `token`、`Authorization`、`Bearer`、`password`、手机号模式。
- **完成判据**：只读文件哈希全部一致；`.env` 未变；日志检索无命中（命中即整改后重跑）；未执行 `initdb`/`DROP`/`TRUNCATE`/`ALTER`（无命令记录）。
- **不算完成的情形**：以“只是加了一行注释”为由解释后端改动；截图包含真实账号/手机号/token。
- **允许改 / 禁止改**：只核对；发现问题时只回滚本轮自己的改动，禁止 `git reset --hard`/`git checkout .`。
- [ ] 重算并比对只读文件哈希
- [ ] 核对 `src`/`sql` 文件清单与 mtime 未变
- [ ] 日志与截图敏感信息检索
- [ ] 记录“未改后端/未重建库/未改契约”的结论与依据

### T22 可观察契约核对（state 字段、按钮文案、请求体、错误语义、Enter 保护）
- **优先级**：P1
- **目标**：确认既有测试与既有 UI 依赖的可观察契约未被破坏（design 1.2.3 七条）。
- **涉及文件**：`前端参考/chat-companion.js`。
- **前置依赖**：T13–T19。
- **验证方式**：逐条核对并记录：①`state.uid/mode/turns/sending/memorySnapshot/draft/draftStatus` 字段名与类型；②换号首次发送被拒、第二次成功；③清除后立即发送不被旧请求阻塞；④清除失败保留 turns 与摘要；⑤prepare 乱序只保留新草稿、关闭面板后迟到响应不落地；⑥幂等恢复同 ID 且只 prepare 1 次；⑦八条既有按钮文案存在且未被替换。
- **完成判据**：七条全部有“位置 + 复核方式”的记录；新增文案仅 `返回聊天`；`/ai/chat` 请求体字段未变（由 `chat-session.js` 只读佐证）。
- **不算完成的情形**：把既有按钮改名后同步改测试定位（会破坏既有 17 条）。
- **允许改 / 禁止改**：只核对；禁止为方便测试而改既有文案。
- [ ] 核对 7 个 `state` 字段
- [ ] 核对换号首拒/再成功、清除后立即发送、清除失败保留
- [ ] 核对乱序与幂等恢复可观察顺序
- [ ] 核对 8 条既有按钮文案与新增 `返回聊天`

---

## 阶段 4 · 自动化验收（T23–T25）

### T23 运行 `npm run test:competition` 并归档
- **优先级**：P1（阻塞交付）
- **目标**：取得本轮完整回归的真实退出码与用例计数。
- **涉及文件**：新增 `docs/codearts_proof/logs/2026-11-13-ab-edge-competition.log`。
- **前置依赖**：T12（红）、T13–T19、T20–T22。**P1 未通过不得进入本任务。**
- **验证方式**：在 `后端源码` 目录执行 `npm run test:competition`，保存 stdout/stderr 全文与退出码。
- **完成判据**：退出码 0；日志含 Node 测试用例数与 `test-companion`/审核/聊天机器人各段结果；新增 19 条用例全部出现在通过列表；用例计数与 T12 的对比表写入证据。
- **不算完成的情形**：退出码非 0 却写“通过”；用分段运行拼接成一次完整运行；把 3307 沙箱拦截写成断言失败或通过。
- **允许改 / 禁止改**：只新增日志；禁止为通过而改脚本或删用例。
- [ ] 执行并保存完整日志与退出码
- [ ] 记录 Node 用例总数与新增 19 条的通过情况
- [ ] 记录各子段（草稿集成、审核、机器人）结果
- [ ] 若出现环境阻塞，单独标注“环境阻塞”并保留原文

### T24 运行 `npm run test:merge24` 并归档
- **优先级**：P1（阻塞交付）
- **目标**：确认合并回归未受影响。
- **涉及文件**：新增 `docs/codearts_proof/logs/2026-11-13-ab-edge-merge24.log`。
- **前置依赖**：T23。
- **验证方式**：`npm run test:merge24`，保存全文与退出码。
- **完成判据**：退出码 0；23 项 Node + 13 组社交 + 3 组禁言结果出现在日志中。
- **不算完成的情形**：只跑社交或只跑禁言就宣称整体通过。
- **允许改 / 禁止改**：只新增日志。
- [ ] 执行并保存完整日志与退出码
- [ ] 记录各子段结果

### T25 哈希、用例计数与旧复现脚本的证据边界
- **优先级**：P1
- **目标**：把“改了什么、通过多少、旧脚本说明什么”三者分开留痕。
- **涉及文件**：`docs/codearts_proof/logs/2026-11-13-ab-edge-baseline.txt`（追加）、`docs/codearts_proof/2026-11-13-AB边界收尾.md`（T33 汇总）。
- **前置依赖**：T23、T24。
- **验证方式**：重算 `chat-companion.js`/`chat-companion.css`/测试文件哈希并与 T01 比对；运行三份旧复现脚本并记录其语义。
- **完成判据**：修改前后哈希对照表完整；用例数对比表（17 → 36，实际以 TAP 为准）；三份旧脚本的退出码被标注为“缺陷存在证据，不作通过依据”。
- **不算完成的情形**：把旧脚本退出 0 写成本轮通过；把预计用例数写成实际数。
- **允许改 / 禁止改**：只新增记录；禁止为了让旧脚本“变绿/变红”而调整前端代码。
- [ ] 重算三份文件哈希并出对照表
- [ ] 记录 `node ../docs/review/2026-11-13-codearts-repair-check/A-remaining-repro.cjs` 的退出码与语义说明
- [ ] 记录 `node --test ../docs/review/.../B-remaining-repro.test.mjs` 的退出码与语义说明
- [ ] 记录 `node --test ../docs/review/.../B-extra-checks.test.mjs` 的退出码与语义说明

---

## 阶段 5 · 真实页面验收（T26–T32）

> 统一标注要求：每项必须写明“真实服务 / 控制响应 / 设备模拟”。单元测试通过不等于浏览器验收；`configured=false` 时不得把本地规则结果称为真实大模型效果。

### T26 验收前置核对（8081 目录与哈希、3000 健康、3307 实例、合成账号）
- **优先级**：P1（阻塞全部浏览器验收）
- **目标**：确认页面、服务、数据库三者都是本工作区实例，并准备可控的合成账号。
- **涉及文件**：新增 `docs/codearts_proof/logs/2026-11-13-ab-edge-browser-precheck.log`。
- **前置依赖**：T03（方法已登记）、T23（代码已冻结）。
- **验证方式（执行 T03 登记的命令）**：8081 返回的 `chat-companion.js` 哈希 == 磁盘哈希；`/api/health` 显示 `db.connected=true`、`ai.configured=false`；3307 为本机 MySQL；账号按决策 8：优先复用既有合成/seed 账号，否则新建 `ab_edge_a_*`/`ab_edge_b_*` 并**先导出** `users`/`ai_messages`/`ai_diary_drafts`/`diaries` 记录 ID。
- **完成判据**：四项核对结果全部落盘；导出 ID 清单存在；明确“不切换 3306、不重建库、不做 DDL”。
- **不算完成的情形**：用 8081 页面可访问替代“文件一致”；未导出 ID 就开始造数据。
- **允许改 / 禁止改**：只读探测；禁止启动/重启服务（若服务未就绪，记录为环境阻塞并等待，不自行启动）。
- [ ] 核对 8081 静态文件哈希一致
- [ ] 核对 `/api/health` 的 `db.connected` 与 `ai.configured`
- [ ] 核对 3307 端口与进程身份
- [ ] 准备并登记合成账号（含导出 ID 清单）

### T27 双标签换号验收
- **优先级**：P2
- **目标**：验证 A/B 跨标签账号隔离在真实页面的表现。
- **涉及文件**：新增 `docs/codearts_proof/screenshots/2026-11-13-ab-edge/` 下截图。
- **前置依赖**：T26。
- **验证方式**：标签 1 登录 A 并对话/选材料；标签 2 登录 B；回到标签 1 观察 storage 触发后的状态；**响应来源标注：真实服务**。
- **完成判据**：A 的旧气泡、草稿、摘要不进入 B；B 首次发送按临时模式；截图与文字记录一一对应。
- **不算完成的情形**：只截一张当前页面就宣称“跨标签隔离通过”。
- [ ] 记录操作步骤与账号（脱敏）
- [ ] 截图标签 1 换号前后
- [ ] 记录 B 首次发送结果与保存状态
- [ ] 标注“真实服务”

### T28 清除与刷新验收
- **优先级**：P2
- **目标**：验证清除成功后历史/记忆为空态、刷新不复活旧摘要、日记与草稿未受影响。
- **前置依赖**：T26、T27。
- **验证方式**：A 清除 → 打开记忆/历史 → 刷新页面 → 复查；**响应来源标注：真实服务**。
- **完成判据**：清空后空态文案正确；刷新后无旧摘要；日记与草稿仍存在；截图完整。
- **不算完成的情形**：只看提示文案“已清除”就判定成功。
- [ ] 记录清除前数据量（脱敏）
- [ ] 截图清除后记忆/历史空态
- [ ] 截图刷新后状态
- [ ] 核对日记与草稿未删除

### T29 请求乱序验收（控制响应）
- **优先级**：P2
- **目标**：在浏览器中验证“清除在途打开记忆”“发送在途清除”两类乱序。
- **前置依赖**：T26。
- **验证方式**：DevTools 离线/限速或本机可控代理构造迟到响应；**响应来源标注：控制响应**。
- **完成判据**：旧摘要不重写面板；旧 finally 不解锁新请求；每项标注为“可控响应验证”，**不写**“真实端到端通过”。
- **不算完成的情形**：把单元测试结论搬进浏览器验收表。
- [ ] 记录构造延迟的方法（离线/限速/代理）
- [ ] 截图清除在途打开记忆的最终面板
- [ ] 截图发送在途清除后的按钮与气泡状态
- [ ] 标注“控制响应”

### T30 连续发送验收
- **优先级**：P2
- **目标**：验证快速连续点击/Enter 只产生 1 条气泡与 1 次请求。
- **前置依赖**：T26。
- **验证方式**：真实页面快速连点 + Enter 交替；用 Network 面板核对 `/ai/chat` 请求数；**响应来源标注：真实服务**。
- **完成判据**：用户气泡 1 个、请求 1 次、按钮保持禁用直到回复；截图含 Network 计数。
- **不算完成的情形**：仅凭“看起来只有一条消息”判定。
- [ ] 记录操作节奏与设备
- [ ] 截图气泡与按钮状态
- [ ] 截图 `/ai/chat` 请求计数
- [ ] 标注“真实服务”

### T31 确认/取消/冲突/过期/恢复验收
- **优先级**：P2
- **目标**：覆盖草稿族五类结果的可见性与可恢复性（含 R5 关怀在弹层内）。
- **前置依赖**：T26、T28。
- **验证方式**：正常确认、取消后禁止确认、同日冲突、草稿过期、首次确认超时后同 ID 恢复；前三类与取消为**真实服务**，冲突/过期/超时恢复用**控制响应**。
- **完成判据**：成功弹层含真实日记编号与链接、care 正文/渠道/`tel:`；取消后不能确认；恢复不产生第二篇日记；每项标注响应来源。
- **不算完成的情形**：用模拟响应证明“真实保存成功”。
- [ ] 正常确认（真实服务）+ 截图
- [ ] 取消终态（真实服务）+ 截图
- [ ] 同日冲突（控制响应）+ 截图
- [ ] 草稿过期（控制响应）+ 截图
- [ ] 超时后同 ID 恢复（控制响应）+ 截图，核对日记数未增
- [ ] 确认成功弹层内 care 完整（真实服务）+ 截图

### T32 393×852 关怀弹层验收
- **优先级**：P2
- **目标**：验证小屏下关怀正文、渠道、`tel:`、关闭/返回可见可点。
- **涉及文件**：`前端参考/chat-companion.css`（**仅当**实测裁切/溢出时追加）。
- **前置依赖**：T18、T19、T26。
- **验证方式**：Chrome DevTools 设备模拟 393×852 + 合成危机文本；**响应来源标注：真实服务 + 设备模拟**。
- **完成判据**：滚动可见全部关怀；`tel:` 可点；关闭与 `返回聊天` 可聚焦可点击；若追加 CSS，必须记录“触发条件 + 追加规则 + 原 260 行未改”。
- **不算完成的情形**：用桌面视口截图代替；CSS 改动超出“滚动/换行/小屏”范围。
- [ ] 在 393×852 下打开成功弹层（带 care）并截图
- [ ] 在 393×852 下打开停止生成终态并截图
- [ ] 验证滚动与按钮可点击
- [ ] 若出现裁切，仅追加允许的样式规则并复测

---

## 阶段 6 · 证据与收尾（T33–T34）

### T33 新增 `docs/codearts_proof/2026-11-13-AB边界收尾.md`
- **优先级**：P2
- **目标**：形成本轮唯一新增证据文档，9 章结构固定（design 2.8.1）。
- **涉及文件**：新增 `docs/codearts_proof/2026-11-13-AB边界收尾.md`。
- **前置依赖**：T23–T32。
- **验证方式**：按章节逐项填写真实命令、退出码、用例名、截图路径；不得引用历史通过记录充当本轮结果。
- **完成判据**：9 章齐全；每项状态落在 `已修复-待人工复核` / `未修复` / `未验收` 三态之一；修复前失败日志与未验收项均保留原文。
- **不算完成的情形**：把“已修复-待人工复核”写成“验收通过”；删除失败记录；用预计值替代实测值。
- **允许改 / 禁止改**：只新增该文件；禁止改既有三份证据 md。
- [ ] 第 1 章 基本信息（日期/时区/工作区/输入基线/输入文档）
- [ ] 第 2 章 修改文件清单（必改/可能改/只读 + 前后 SHA-256）
- [ ] 第 3 章 修复前红色证据（命令、退出码、11 条失败用例与断言摘要）
- [ ] 第 4 章 逐项 R1–R6（根因行号、改动要点、对应用例、修复后结果）
- [ ] 第 5 章 完整回归结果表（competition / merge24 命令、退出码、计数、日志路径）
- [ ] 第 6 章 真实页面验收表（检查项、账号、响应来源、结果、截图路径）
- [ ] 第 7 章 状态清单（三态逐项）
- [ ] 第 8 章 安全与约束（未改后端/未重建库/未打印敏感信息）
- [ ] 第 9 章 遗留与复验指引（未验证范围、复跑命令、已知风险）

### T34 截图与日志落盘 + `docs/README.md` 索引
- **优先级**：P3
- **目标**：确保所有证据可定位，并在文档索引登记新证据。
- **涉及文件**：`docs/codearts_proof/logs/2026-11-13-ab-edge-*.log`、`docs/codearts_proof/screenshots/2026-11-13-ab-edge/`、`docs/README.md`（仅追加一行）。
- **前置依赖**：T33。
- **验证方式**：核对日志 6 类齐全、截图与 T27–T32 一一对应；`docs/README.md` 在“参赛与过程”表末尾追加一行索引。
- **完成判据**：无孤立截图、无缺失日志；README 只新增一行，既有条目不变（哈希比对）。
- **允许改 / 禁止改**：允许追加一行；禁止重排或改写既有条目。
- [ ] 核对 6 类日志齐全且路径写入证据文档
- [ ] 核对截图与检查项一一对应
- [ ] 在 `docs/README.md` 追加一行索引（若用户同意）

---

## 阶段 7 · 交付复核（T35）

### T35 交付清单、每项结果、完整命令、未验证范围
- **优先级**：P1（最终门禁）
- **目标**：让独立复验者可只凭文档复跑。
- **前置依赖**：T33、T34，且 T23/T24 退出码均为 0。
- **验证方式**：按“修改清单 → 每项 R1–R6 结果 → 命令清单 → 未验证范围”四段输出；命令可复制即用（注明执行目录）。
- **完成判据**：四段齐全；未验证范围至少包含“模型未配置、跨浏览器未验证、数据库层一致性未验证、复核到请求的残余窗口”；用户确认无进一步修改。
- **不算完成的情形**：P1 项未全绿就宣称交付；把“未验收”略去不写。
- [ ] 输出修改清单（文件 + 一句改动意图）
- [ ] 输出 R1–R6 逐项结果与对应用例
- [ ] 输出完整命令清单（含执行目录）
- [ ] 输出未验证范围与复验指引
- [ ] 取得用户对交付说明的确认

---

## 阶段 8 · 依赖与并行性

### 8.1 依赖关系（DAG，按可执行顺序）

```text
T01 ─┬─> T04 ─┬─> T06 ─┐
T02 ─┘        ├─> T07 ─┤
T03 ──────────┼─> T08 ─┼─> T12 ─> T13 ─┬─> T14 ─┬─> T18 ─┐
T05 ──────────┘ ├─> T09 ─┘             │        ├─> T19 ─┤
                 └─> T10 ─┐            │        └─> T16* │
                     T11 ─┘            └─> T15 ─> T16 ─> T17 ─┘
                                                             │
T20（每步执行） ── T21 ── T22 ───────────────────────────────┴─> T23 ─> T24 ─> T25
                                                                              │
T26 ─┬─> T27 ─> T28 ─> T31                                                    │
     ├─> T29                                                                  │
     ├─> T30                                                                  │
     └─> T32                                                                  │
                                                                              v
                                                            T33 ─> T34 ─> T35
```

说明：`T16*` 表示 T16 同时依赖 T13 与 T15；T17 依赖 T13 与 T16（`replaceSession` 作废旧发送）。

### 8.2 可并行 / 必须串行

| 关系 | 任务 | 说明 |
|---|---|---|
| 可并行 | T01、T02、T03、T05 | 均为只读登记/新建目录，互不写同一文件 |
| 可并行 | T06–T11 六组用例追加 | 同一文件末尾追加，需约定“各自独占一段连续行”，避免行号冲突；建议顺序提交或按 R1→R6 串行追加更稳妥 |
| 必须串行 | T12 → T13–T19 | 必须先有红日志，才允许改业务代码 |
| 必须串行 | T13 → T14/T15 | `resolveIdentity` 是 R1/R2 的前置 |
| 必须串行 | T15 → T16 → T17 | `panelKind`、`clearEpoch`、`replaceSession` 作废旧发送存在链式依赖 |
| 必须串行 | T14 → T18 → T19 | R5 依赖成功分支归属，R6 复用 `appendCareFull` 与归属判定 |
| 必须串行（门禁） | T13–T15（P1）→ T23–T24 | **P1 未通过不得进入 P2/P3 收尾验收** |
| 必须串行 | T23 → T26 | 浏览器验收必须在代码冻结并全绿之后 |
| 必须串行 | T33 → T34 → T35 | 证据 → 索引 → 交付 |

### 8.3 优先级门禁

1. **P1 门禁**：T13、T14、T15 与 `EDGE-R1-*`、`EDGE-R2-*` 未全绿，不得执行 T23 及之后任何收尾任务。
2. **P2 门禁**：T23/T24 退出码非 0，不得进入 T26 浏览器验收与 T33 结论文档。
3. **P3 允许最后**：T19（R6）可在 P1/P2 全绿后单独收尾，但必须在 T23 之前完成，否则 T23 的完整回归不含 R6 修复。
4. 任一任务出现“需回滚”时，回到 T01 备份还原该文件，并重新执行 T12 → 对应修复 → T20。

---

## 阶段 9 · 完成定义（DoD）与“不算完成”

### 9.1 逐项 DoD（可核查条件）

| 任务 | 完成的可核查条件 |
|---|---|
| T01 | 3 份哈希 + 3 份行数 + 3 份备份副本哈希一致，全部落盘 |
| T02 | 受保护文件哈希/mtime 清单齐全，且实施后重算无变化 |
| T03 | 三端口核对命令与判定标准已登记，且明确“本阶段不启动” |
| T04 | 17 条用例名 + 行号 + 前 483 行哈希已登记 |
| T05 | 6 类日志命名 + 截图命名 + 脱敏规则齐全 |
| T06–T11 | 19 条 `EDGE-*` 用例存在，断言只针对可观察行为，未改既有 17 条 |
| T12 | 退出码非 0，11 条指定用例失败，8 条防回归 + 既有 17 条通过，日志含命令原文 |
| T13 | `EDGE-R1-02` 绿；本地一致 0 次 `/auth/me`；同账号刷新 1 次 |
| T14 | `EDGE-R1-01/03/04` 绿；R1-02 保持绿；既有 P2/B 系列全绿 |
| T15 | `EDGE-R2-01/02` 绿；R2-03 保持绿；清除失败不推进 `clearEpoch` |
| T16 | `EDGE-R3-01` 绿；R3-02/03 保持绿；跨账号零写入 |
| T17 | `EDGE-R4-01/02` 绿；R4-03 保持绿；`P1-06`/`P1-07` 不掉 |
| T18 | `EDGE-R5-01/02` 绿；R5-03 保持绿；confirm 次数 1 |
| T19 | `EDGE-R6-01` 绿；R6-02/03 保持绿；prepare 次数 1、关怀块 1 |
| T20 | 三份 diff 比对结论落盘，测试文件前 483 行哈希不变 |
| T21 | 只读文件哈希全一致；日志/截图敏感信息检索无命中 |
| T22 | 七条可观察契约逐条有记录；新增文案仅 `返回聊天` |
| T23 | 退出码 0；19 条新增全部在通过列表；计数对比表落盘 |
| T24 | 退出码 0；23 项 Node + 13 组社交 + 3 组禁言落盘 |
| T25 | 前后哈希对照表 + 用例数实际值 + 旧脚本语义标注 |
| T26 | 4 项前置核对落盘，合成账号与导出 ID 清单存在 |
| T27–T32 | 每项有截图、有步骤、有响应来源标注 |
| T33 | 9 章齐全；三态标注逐项；失败与未验收原文保留 |
| T34 | 6 类日志齐全；截图一一对应；README 仅追加一行 |
| T35 | 四段交付说明齐全；用户确认 |

### 9.2 什么情况“不算完成”

1. **删断言 / 改期望**：为了让用例通过而删除断言、放宽期望、跳过用例、或把“应失败”改成“应通过”。
2. **用例只是假红**：修复前失败原因不是目标缺陷（如引用未定义符号抛 `TypeError`、环境错误、端口不通）。
3. **旧复现脚本退出 0 被写成通过**：三份复现脚本只证明缺陷存在，不能作为修复依据。
4. **模拟响应当浏览器验收**：把单元测试、DevTools 模拟、可控代理结果写成“真实端到端通过”。
5. **后端改动**：改了 `src/**`、`sql/**`、`.env`、数据库结构或数据，或切换 3306、执行 `initdb`/`DROP`/`TRUNCATE`/`ALTER`。
6. **契约改动**：改了既有请求 URL/方法/body、状态码语义、既有 8 条按钮文案。
7. **修改面越界**：改了 `api.js`、`chat-session.js`、双门/社交/未读/举报/审核，或重写了 `chat-companion.js` 的结构而非最小改动。
8. **覆盖既有证据**：改写或删除 `docs/交接说明.md`、`docs/review/**`、既有 `docs/codearts_proof/` 三份记录及其日志/截图。
9. **日志泄密**：日志/截图含 token、`Authorization`、密钥、真实手机号或真实账号信息。
10. **结论冒进**：P1 未全绿就宣称本轮完成；`configured=false` 时宣称真实大模型效果；未做浏览器验收却写“验收通过”。

---

## 阶段 10 · 关键验证命令清单（实施时使用，本阶段不执行）

> 执行目录已在行首注明；所有命令的 stdout/stderr 与退出码必须原样落盘到 `docs/codearts_proof/logs/2026-11-13-ab-edge-*.log`。

```text
# A. 基线哈希（项目根目录或 后端源码 目录，按相对路径调整）
sha256sum 前端参考/chat-companion.js 前端参考/chat-companion.css 后端源码/scripts/test-chat-companion-repair.test.js
# 或 Windows PowerShell：
powershell -Command 'Get-FileHash 前端参考/chat-companion.js -Algorithm SHA256'

# B. 红色基线（后端源码 目录）
node --test scripts/test-chat-companion-repair.test.js        # 预期：退出码非 0，11 条 EDGE-* 失败

# C. 逐项转绿（后端源码 目录，每项修复后）
node --test scripts/test-chat-companion-repair.test.js        # 预期：退出码 0，EDGE 逐项转绿
# 可选：按用例名过滤（Node 支持时）
node --test --test-name-pattern="EDGE-R1" scripts/test-chat-companion-repair.test.js

# D. 完整回归（后端源码 目录）
npm run test:competition                                      # 预期：退出码 0
npm run test:merge24                                          # 预期：退出码 0

# E. 旧复现脚本（仅作“缺陷存在/已变化”证据，不作通过依据）
node ../docs/review/2026-11-13-codearts-repair-check/A-remaining-repro.cjs
node --test ../docs/review/2026-11-13-codearts-repair-check/B-remaining-repro.test.mjs
node --test ../docs/review/2026-11-13-codearts-repair-check/B-extra-checks.test.mjs

# F. 服务身份核对（验收前置，T26 执行）
curl -s http://127.0.0.1:3000/api/health
curl -s http://127.0.0.1:8081/chat-companion.js
netstat -ano | findstr ":8081 :3000 :3307"
tasklist /FI "PID eq <PID>"
```

**命令使用纪律**：一条命令对应一份日志；不把多条命令输出拼接成“一次运行”；出现环境阻塞时保留原文并标注“环境阻塞”，不改写成断言失败或通过。

---

## 阶段 11 · 仍需用户确认的事项

1. **`docs/README.md` 是否允许追加索引**：design 2.5.2 将其列为“可能改”。请确认是“追加一行到‘参赛与过程’表”还是“本轮不登记”。
2. **真实页面验收的执行者与时间窗口**：T26–T32 需要本机 8081/3000/3307 就绪与人工观察。请确认由谁执行、何时执行；若本轮不执行，则全部标记“未验收”。
3. **合成账号来源**：决策 8 规定“优先复用既有合成/seed 账号”。请确认是否存在可直接复用的 `ab_edge_*` 或既有 seed 账号；若无，将新建两个并按导出 ID 逐条清理。
4. **393×852 是否允许改 `chat-companion.css`**：当前 CSS 260 行已含 `cc-sheet-body { overflow-y: auto; }`。请确认“仅实测裁切时追加”的授权范围（是否包含 `min-height: 0` 与 `word-break` 两类规则）。
5. **P1 完成后是否停顿等人复核**：T14/T15 转绿后，是先交付人工复核再进入 R3–R6，还是连续执行到 T23。
6. **是否接受 `tasks.md` 记录的“既有用例 17 条”口径**（与 `design.md` 的“12 条”不一致）：本文件以实测为准，且不回改 `design.md`。

---

**文档结论**：本任务规划共 **35 个任务**、**8 个执行阶段**，把 R1–R6 六项边界、四层归属模型、三态身份复核与 **19 条 `EDGE-*`** 用例逐条落到可追踪任务；先红后绿、逐项最小验证、修改面控制、双回归与真实页面验收分列，且明确“什么情况不算完成”。本阶段不写代码、不改测试、不执行测试命令。