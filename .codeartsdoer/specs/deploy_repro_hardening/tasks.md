# 部署复现与交付工程收尾 · 编码任务规划（tasks.md）

> 文档类型：编码任务规划（tasks）
> 工作区：`D:\微光同行\Glimmer`
> 上游规格：`.codeartsdoer/specs/deploy_repro_hardening/spec.md`（1112 行；R10–R13、V01–V18、A1–A7/B1–B12/C1–C5、12 个待确认点）
> 上游设计：`.codeartsdoer/specs/deploy_repro_hardening/design.md`（1064 行；三层副本、S1–S13、P0/P1/P2 分层、2.5 验证矩阵、2.7 判定红线）
> 固定提交：`2112271db26b34a557719afc60a77b91557ee624`（2026-11-15 20:04:29 +0800，Codex 独立验收通过）
> 上游依据：`docs/2026-11-15_CodeArts补修验收通过.md`、`docs/codearts_proof/2026-11-15-游客上下文归属修复.md`
> 继承基线（只读、不得回退）：`.codeartsdoer/specs/guest_context_hardening/{spec,design,tasks}.md`（R9 已验收固定）
> 状态：待用户评审。本文件只规划"按什么顺序做什么、做完怎么证明"，**不含业务代码、测试代码、配置改动**；规划阶段未执行任何安装、启动、数据库写入、测试命令，未修改任何文件。

---

## 0. 规划基线与统一约定

### 0.1 本轮实测基线（规划阶段只读核对）

| 项 | 实测值 | 本任务规划口径 |
|---|---|---|
| 仓库根 | `D:\微光同行\Glimmer` | 只在此登记，不改 |
| `git rev-parse HEAD` | `2112271db26b34a557719afc60a77b91557ee624` | 与验收报告一致，起点正确 |
| 工作区 | 仅 `?? .codeartsdoer/specs/deploy_repro_hardening/`（本规格/设计/任务目录） | 视为"无代码改动"；实施阶段 `git status --short` 只允许出现该目录与本文档 |
| 现有后端 | 3000 / PID 47736（`D:\Node.js\node.exe src/app.js`） | 只读观察，不复用、不停止 |
| 现有数据库 | 3307 / PID 39896（`mysqld --datadir=./mysql-data`，8.4.13） | 只读快照，四维隔离对象 |
| 现有前端 | 8081 / PID 35644（`node setup/start.js --no-open --port 8081`） | 只读观察，本轮前端另用 8090 |
| 8080 | PID 40112 为 `python`（非本项目） | 任何"8080 可用"的结论都不成立 |
| `sql/schema.sql` | `CREATE TABLE IF NOT EXISTS` **23** 条；`DROP`/`TRUNCATE` 命中 **0** | V05 判据 23 表 |
| `sql/seed.sql` | `INSERT INTO` **2** 条；含 `ON DUPLICATE KEY UPDATE`；`DROP`/`TRUNCATE` 命中 **0** | V05 判据 4 房间、幂等 |
| `后端源码/.env.example` | 41 行；有效键 **15** 个（`HOST/PORT/NODE_ENV/DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/JWT_SECRET/JWT_EXPIRES_IN/DEEPSEEK_API_KEY/DEEPSEEK_API_URL/DEEPSEEK_MODEL/DEV_SMS_CODE/SMS_ENABLED`）+ 注释态 **2** 个（`PUBLIC_BASE_URL/PUBLIC_HOST`） | V04 以当次解析结果为准，见 0.6 口径修正（二） |
| `前端参考/` | 26 项，含 `api.js`、`data.js`、`login.html`、`index.html`、`diary-write.html` | 影响 smoke-test 前端 5 项判定，见 0.6 口径修正（一） |
| `后端源码/scripts/` | `test-api-*.js` **8** 个（`ai/bless/bottle/client/comment/interact/message/profile`） | P2 只标注，不改 |
| 既有备份目录 | `docs/codearts_proof/backup/{2026-11-13-identity-guest,2026-11-13,2026-11-15-guest-context}/` | 本轮新增 `2026-11-15-deploy/`，不覆盖 |

### 0.2 十条默认决策（原样落入任务，语义不得改动）

| 编号 | 决策 | 落入任务 |
|---|---|---|
| D1 | 独立库三重隔离：端口 **3311** + 绝对数据目录 `D:\微光同行\_deploy_repro\mysql-data-3311` + 新库名 **`peizhe_deploy_20261115`** | T27、T28、T30 |
| D2 | 临时目录 `D:\微光同行\_deploy_repro\`（仓库外） | T02、T03、T04 |
| D3 | 允许隔离目录 `npm ci`，失败两级处理（L1 重试一次 / L2 环境阻塞，禁止复用现有 `node_modules`） | T26 |
| D4 | 复用 `D:\mysql\bin\mysqld.exe`（8.4.13），不下载 8.0.28 | T07、T28 |
| D5 | 分层：P0 = `smoke-test.js` + `setup/start.js`；P1 = `check-frontend.js`、`check-pages-runtime.js`；P2 = `test-api-*.js` 只标注 | T12–T22、T23 |
| D6 | 交付说明放 `docs/`，根 README 与 `docs/README.md` 加索引 | T42、T43、T44 |
| D7 | 不改 `.gitignore`；登记"`**/*.log` 本地日志默认不入库"，日志同时保存 `.txt` 副本 | T06、T41 |
| D8 | 仅在 `checker-probe` 内做合成 `sk-` 反向验证，验证后删除 | T15 |
| D9 | 独立前端 8090（冲突顺延并记录，不占 8080/8081） | T32 |
| D10 | 浏览器验收不纳入本轮，一律标"未验证" | T45、T47 |

### 0.3 分层、优先级与任务总表

**优先级口径**：`P0` = 门禁级，未完成不得继续；`P1` = 本轮必须完成但不阻塞门禁；`P2` = 只标注或可选加固。P0/P1/P2 同时对应检查器分层归属。

| 阶段 | 任务 | 目标 | 分层/优先级 |
|---|---|---|---|
| 阶段 0 前置冻结 | T01–T08 | Git/哈希/快照冻结、三副本建立、日志规范、版本核对 | P0 |
| 阶段 1 修复前取证 | T09–T11 | V12 真实"3 失败"基线 + 逐项定位 + P1 修复前失败证据 | P0 |
| 阶段 2 P0 修复 | T12–T19 | `smoke-test.js`（路径+四态+守恒）与 `setup/start.js`（端口+归属+mysqld+死代码） | **P0 检查器** |
| 阶段 3 P1 修复 | T20–T22 | `check-frontend.js` 契约缺失 SKIP、`check-pages-runtime.js` 同源注入 | **P1 检查器** |
| 阶段 4 P2 标注与可选加固 | T23–T25 | 8 个 `test-api-*.js` 只登记；`install.js` 可选加固与 `--check` 只读验证 | **P2** |
| 阶段 5 独立环境 | T26–T30 | `npm ci` → 隔离 `.env` → 3311 实例 → 两次建表 → 端口矩阵 | P0 |
| 阶段 6 启动与归属 | T31–T34 | 后端健康、前端 8090 静态一致性、P1 实测、进程归属 | P0/P1 |
| 阶段 7 回归 | T35–T38 | 68/68 → `test:competition` → `test:merge24` → 4/4 | P0 |
| 阶段 8 隔离与修改面 | T39–T41 | 现有库零写入五件套、修改面哈希、脱敏与忽略规则 | P0 |
| 阶段 9 文档与收尾 | T42–T47 | 从零安装说明、文档缺陷修正、索引、过程报告、清理、交回清单 | P1 |

**总量：47 个任务**；P0 检查器任务 `T12–T19`，P1 检查器任务 `T20–T22` 与实测 `T33`，P2 任务 `T23–T25`。

### 0.4 依赖关系（DAG）

```
T01─T02─T03─┬─T04─┬─T09─T10─┬─[G1]─┬─T12─T13─T14─[G2]─T15
            │     │         └───────┼─T16─T17─T18─T19
            │     ├─T11──────────────┘
            │     └─T23
            ├─T05（T0 快照）
            ├─T06
            ├─T07─┐
            └─T08─┴─T24─T25
T04+T07─T26─T27─T28─T29─T30─[G3]─T31─T32─┬─T33
                                          └─T34─[G3]─T35─[G4]─T36─T37─T38─[G5]─T39─[G6]─T40─T41
T41+T42─T45─T46─[G7]─T47
T42─T43─T44
T20─T21─T22─T33
```

| 门禁 | 条件 | 未通过时的处置 |
|---|---|---|
| **G1 修复前基线门禁** | T09 取得 `npm test` 非 0 真实日志且失败项≥3；T10 每条失败定位到 `文件:行号 → 原因分类`；T11 取得两个 P1 脚本修复前真实失败 | **未取得失败基线前，禁止修改任何检查器**（T12–T21 一律不动） |
| **G2 守恒门禁** | T14 名称集合 diff 为空、总数相等、FAIL 由 3 降为 0；T15 放入合成串 → FAIL 且点名该文件、删除后 → PASS | 出现删除项/放宽断言/反向验证失效 → 回退该改动，**不得宣称修复通过** |
| **G3 归属门禁** | T30 四维隔离成立（端口/目录/库名/PID）；T34 3311 与 8090 均为本进程实例，3000/8081/3307 的 PID 与命令行未变 | 归属未证明 → 不得执行 T35–T38 回归 |
| **G4 代码层门禁** | T35 单文件 68/68 退出 0 且 T38 独立验收 4/4 退出 0 | 未通过 → 不得进入两套完整回归（T36/T37） |
| **G5 回归门禁** | T36、T37 各自单条命令退出 0，日志完整、计数与预期不符时已如实登记 | 未退出 0 → 只能写"环境阻塞/失败"，**不得写"干净部署通过"** |
| **G6 零写入门禁** | T39 现有 3307 五件套（端口/PID/启动时间/命令行/`.env` 哈希/数据目录指纹）前后完全一致 | 任一项变化 → **立即停止**并如实报告差异，不继续后续步骤 |
| **G0 冻结门禁**（补充） | T01–T08 完成；HEAD=`2112271`；两副本"干净"判据成立 | 不成立 → 不得安装依赖、不得启实例 |
| **G7 证据门禁**（补充） | T42–T47 完成；报告固定章节齐全；日志索引映射齐全；隔离实例已清理 | 不得宣告本轮完成 |

### 0.5 检查项守恒口径（可核查的三条硬判据 + 两条口径修正）

**硬判据（不得放宽）**

1. 名称集合：从 `smoke-test.js` 输出按行抽取 `✅ <名>` / `⚠️ <名> —— …` / `❌ <名> —— …` / `⏭ <名>` 的名称（去掉判定符号与 `——` 之后内容），排序后 `diff before.txt after.txt` **为空**。
2. 总数：`通过 + 警告 + 跳过 + 失败` 在修复前后**相等**（以 `scripts/*.sh` 实际数量与 `src/routes` 实际数量为准，不静态推算）。
3. 失败归零：FAIL 由 **3 → 0**，且 3 项失败**只能**是旧前端目录三项（`★ 前端目录里没有明文 API Key（这条最重要）`、`前端没有直接请求第三方大模型接口`、`前端目录还在（顺手确认路径没写错）`）。

**口径修正（一）——"仅 3 项判定变化"需按实测细化**
`smoke-test.js` L88-97 的前端 5 项（`前端 api.js`、`前端 data.js`、`前端 login.html`、`前端 index.html`、`前端 diary-write.html`）在旧目录不存在时为 `⚠️ WARN`；切到仓库内 `前端参考/` 后这 5 个文件**全部存在**（已只读核对），会变为 `✅ PASS`。因此本轮允许的判定变化是：**FAIL 3 项 → PASS，WARN 5 项 → PASS**，`warn` 由 5 降为 0、`pass` 增加 8。这两类变化都必须逐项列在 T14 的对照表里并注明"由路径来源修正引起"，**不得为凑"3 项"而隐藏 WARN→PASS、也不得把这 5 项改写为 SKIP**。

**口径修正（二）——`.env.example` 键数以实测为准**
design 1.0.4/D4 与 2.1.3.1(3) 写"21 个键 + 2 个注释态"，实测模板为 **15 个有效键 + 2 个注释态**。V04 判据改为"`checkConfig()` 所需键齐全 + 模板中全部有效键均存在"，并以当次解析清单为准；**不得**按 21 个键的数量去判定失败，也**不得**从现有 `.env` 取值补齐。

### 0.6 日志、证据与脱敏规范（贯穿全部任务）

1. 路径：`docs/codearts_proof/logs/2026-11-15-deploy-<stage>.<ext>`，同时落 `_deploy_repro\logs\` 原始副本。
2. `<stage>` 固定 19 个：`export`、`version`、`install`、`env`、`db-init`、`backend`、`frontend`、`unit`、`competition`、`merge24`、`acceptance`、`smoke-before`、`smoke-after`、`smoke-reverse`、`ports`、`db-guard`、`surface`、`redaction`、`cleanup`；另有 `2026-11-15-deploy-index.txt`（验证项 → 日志 → 退出码映射）。
3. 双份：`.log`（可检索，被 `**/*.log` 忽略）+ `.txt`（同内容副本，交付可见）。**不改 `.gitignore`，不执行 `git add -f`**。
4. 必备字段：`COMMAND=`、`WORKDIR=`、`START_AT=`、完整 stdout/stderr、`EXIT_CODE=<n>`。只留摘要视为不合格。
5. 脱敏词表：`password`、`Bearer`、`sk-`（`smoke-reverse` 的合成串说明段除外，且合成串不得是真实 Key 格式的有效值）、`JWT_SECRET=`、`DEEPSEEK_API_KEY=`、`1[3-9]\d{9}`（白名单：公开演示账号 `13800138000` 与开发验证码 `123456`）。命中即删除该证据并重新生成，**不做局部打码**。
6. 禁止读取/回显 `.env` 值：对现有 `.env` 只执行 `Get-FileHash`；对隔离 `.env` 只输出"键名 + configured 布尔 + SHA-256"。

### 0.7 修改面边界（贯穿全部任务）

**允许改（唯一清单）**：`后端源码/scripts/smoke-test.js`、`后端源码/scripts/check-frontend.js`、`后端源码/scripts/check-pages-runtime.js`、`setup/start.js`、`setup/install.js`（可选加固）、`README.md`、`docs/前置安装指南.md`、`后端源码/README.md`、`docs/本地运行说明.md`（仅末尾追加）、`docs/README.md`（仅索引行）、新增 `docs/从零安装与部署复现.md`、新增 `docs/codearts_proof/2026-11-15-部署复现与交付收尾.md`、新增 `docs/codearts_proof/logs/2026-11-15-deploy-*`、新增 `docs/codearts_proof/backup/2026-11-15-deploy/`。

**禁止改**：`后端源码/src/**`、`后端源码/sql/**`、`前端参考/**`、`scripts/test-chat-companion-repair.test.js`、`scripts/test-api-*.js`、`scripts/test-all.sh`、`package.json`/`package-lock.json`、`后端源码/.env`、`.gitignore`、`docs/review/**`、既有 `docs/codearts_proof/**`、既有验收/复验/验证报告的历史结论段落、`docs/交接说明.md`。

**禁止操作**：提交、推送、`reset --hard`、`checkout .`、`git clean`、`git add -f`；`DROP`/`TRUNCATE`（任何库）；对现有库 `ALTER/UPDATE/DELETE/INSERT`；默认 `--force-private`；停止/重启 3000/8081/3307；关闭 TLS 校验；打印任何凭证值。

---

## 阶段 0 · 前置冻结与隔离区建立（T01–T08）

### T01 冻结 Git 基线、工作区状态与九个关键文件哈希
- **优先级**：P0（G0 门禁）
- **目标**：在动任何文件前固化"起点就是 2112271"的可核查证据，作为后续所有哈希比对的锚点。
- **涉及文件**：只读 `前端参考/chat-companion.js`、`前端参考/chat-session.js`、`前端参考/api.js`、`后端源码/package.json`、`后端源码/scripts/smoke-test.js`、`后端源码/src/db/index.js`、`后端源码/src/app.js`、`后端源码/scripts/test-chat-companion-repair.test.js`、`docs/review/2026-11-15-identity-guest/acceptance-boundaries.test.cjs`；日志 `docs/codearts_proof/logs/2026-11-15-deploy-export.{log,txt}`。
- **前置依赖**：无。
- **执行要点**：
  1. 记录 `git rev-parse --show-toplevel`、`git branch --show-current`、`git rev-parse HEAD`、`git log -1 --format=%h%x09%ci%x09%s`、`git status --short`、`git diff --stat`。
  2. 对上述 9 个文件计算 SHA-256（`Get-FileHash -Algorithm SHA256`）与换行数（统计 `\n` 个数，不用 `split(/\r?\n/)`），与 spec 5.2 逐字比对（`smoke-test.js` 应为 `D9E8EE71…`，`chat-companion.js` 应为 `31C567E9…`）。
  3. 声明"不提交、不推送、不 `reset --hard`、不 `checkout .`、不 `clean`、不 `add -f`"。
- **验证方式**：命令原文与输出落盘；哈希/换行数与 spec 5.2 全部相等；`git status --short` 仅列出 `.codeartsdoer/specs/deploy_repro_hardening/`。
- **完成判据**：6 项 Git 事实 + 9 组哈希 + 9 组换行数 + 边界声明齐全；任一哈希与 spec 5.2 不一致即停止并报告。
- [ ] 记录 6 项 Git 事实与工作区清单
- [ ] 计算并登记 9 个关键文件 SHA-256 与换行数
- [ ] 与 spec 5.2 逐项比对并写明"一致/不一致"
- [ ] 写入"禁止写型 Git 操作"声明

### T02 建立仓库外隔离区骨架与"不复制清单"
- **优先级**：P0
- **目标**：把本轮全部产物（副本、实例数据、日志、快照）关在 `D:\微光同行\_deploy_repro\` 内，保证工作区与 Git 状态不被污染。
- **涉及文件**：新增目录 `_deploy_repro\{checkout-2112271,checkout-fixed,checker-probe,mysql-data-3311,logs,snapshots,tmp}`；`docs/codearts_proof/backup/2026-11-15-deploy/`。
- **前置依赖**：T01。
- **执行要点**：
  1. 创建 7 个顶层目录并在 `snapshots\README.txt` 写明用途与"仓库外、不入 Git"。
  2. 明确**不复制清单**：`后端源码/.env`（任何值）、`node_modules/`、`mysql-data*`/`.runtime/mysql-data`、`后端源码/uploads/*`（除 `.gitkeep`）、`后端源码/backend.log`、`.runtime/`、`docs/codearts_proof/logs/*`。
  3. 备份目录登记：新建 `backup/2026-11-15-deploy/`，与既有 `2026-11-13*/`、`2026-11-15-guest-context/` 并列，不覆盖。
- **验证方式**：目录存在性清单；`git status --short` 不出现 `_deploy_repro`（在仓库外）。
- **完成判据**：7 目录 + 不复制清单 7 项 + 备份目录 1 个齐备；工作区 `git status --short` 仍只出现规格目录。
- [ ] 创建 7 个隔离目录
- [ ] 写入"不复制清单"并核对仓库外位置
- [ ] 新建 `backup/2026-11-15-deploy/` 且不覆盖既有备份

### T03 导出基线副本 `checkout-2112271` 并证明"干净"（V01）
- **优先级**：P0
- **目标**：得到与固定提交逐字一致的副本，用于 V01 哈希核对与 V12 修复前取证。
- **涉及文件**：`_deploy_repro\checkout-2112271\`；日志 `deploy-export.{log,txt}`。
- **前置依赖**：T02。
- **执行要点**：
  1. `git archive --format=tar 2112271db26b34a557719afc60a77b91557ee624 | tar -x -C D:\微光同行\_deploy_repro\checkout-2112271`（或 `git archive -o <tmp>.tar` 再解包），记录退出码。
  2. 证明"干净"：`后端源码/node_modules` 不存在、`后端源码/.env` 不存在、`后端源码/uploads` 除 `.gitkeep` 外为空、无 `*.log`、无 `mysql-data*`。
  3. 对 9 个关键文件复算哈希，与 T01 记录**全部相等**（`smoke-test.js` 仍应是修复前的 `D9E8EE71…`）。
- **验证方式**：导出退出码 + 干净判据 5 项 + 9 组哈希复算，全部落盘。
- **完成判据**：副本存在；5 项干净判据全部成立；9 组哈希与 T01 相等。若混入依赖/配置 → 中止，换新空目录重导，不得删数据"凑干净"。
- [ ] 执行 `git archive` 导出并记录退出码
- [ ] 核对 5 项"干净"判据
- [ ] 复算 9 个关键文件哈希并比对

### T04 建立交付副本 `checkout-fixed` 与反向验证副本 `checker-probe`
- **优先级**：P0
- **目标**：交付副本用于从零安装与全链路验证；probe 副本只承载合成 `sk-` 反向验证，避免探测文件留在交付副本。
- **涉及文件**：`_deploy_repro\checkout-fixed\`（基线 + 允许清单补丁）、`_deploy_repro\checker-probe\`（fixed 的 `后端源码/scripts` 与 `前端参考` 副本）。
- **前置依赖**：T03。
- **执行要点**：
  1. 先整体复制 `checkout-2112271` → `checkout-fixed`，再在 `checkout-fixed` 上应用本轮修复（T12–T21 直接在此副本内改，工作区同步保留同源改动供 V17 登记）。
  2. 建立 `checker-probe`：复制 `checkout-fixed/前端参考/` 与 `checkout-fixed/后端源码/scripts/`，并保留 `checkout-fixed/后端源码/package.json`、`sql/`、`src/` 的相对结构，使 `smoke-test.js` 的 `ROOT` 解析仍成立。
  3. 记录两副本初始差异：`checkout-fixed` 相对 `checkout-2112271` **仅**允许清单文件不同（初始阶段应为零差异）。
- **验证方式**：三副本目录结构核对；`checkout-fixed` 初始差异为 0；`checker-probe` 内无 `.env`、无 `node_modules`。
- **完成判据**：三副本并存、职责写清；初始差异清单为空（或仅 `checkout-2112271` 与 `checkout-fixed` 的同名同哈希）。
- [ ] 复制并建立 `checkout-fixed`
- [ ] 建立 `checker-probe` 并核对结构可运行
- [ ] 登记三副本初始差异为 0

### T05 采集现有 3307 实例 T0 只读快照（V16 前段）
- **优先级**：P0（G6 门禁）
- **目标**：用"无凭证五件套"证明现有库在本轮开始时的状态，且全程不读取现有 `.env` 值。
- **涉及文件**：`_deploy_repro\snapshots\t0-{ports,process,env-hash,datadir}.txt`；日志 `deploy-db-guard.{log,txt}`（前段）。
- **前置依赖**：T02。
- **执行要点**：
  1. E1 端口/PID：`netstat -ano | findstr ":3307"` + `Get-CimInstance Win32_Process`（`ProcessId`、`Name`、`CreationDate`）。
  2. E2 命令行：`CommandLine` 逐字记录（应含 `--no-defaults --basedir=D:/mysql --datadir=./mysql-data --port=3307 --bind-address=127.0.0.1 --mysqlx=OFF`）。
  3. E3 `.env` 指纹：仅 `Get-FileHash -Algorithm SHA256 后端源码\.env`，**不 `cat`、不 `grep` 值**。
  4. E4 数据目录指纹：先解析 `--datadir=./mysql-data` 的启动 cwd（CIM 父进程命令行 / 文档记录 `D:\微光同行\.runtime`），再统计文件数、总字节、最新 mtime；解析不到则登记"无法确定绝对路径"并改用 `@@datadir` 为权威来源（不连库则只登记前者）。
  5. 同时登记 3000（PID 47736）、8081（PID 35644）、8080（PID 40112，非本项目）、3306 的占用情况。
- **验证方式**：五件套字段齐全且可复算；`.env` 只出现哈希。
- **完成判据**：E1–E4 + 端口矩阵 4 项落盘；日志中无任何 `.env` 值。
- [ ] 采集 3307 端口/PID/启动时间
- [ ] 记录命令行原文与 `.env` SHA-256
- [ ] 解析 cwd 后统计数据目录文件数/字节/mtime
- [ ] 登记 3000/8080/8081/3306 端口占用

### T06 定稿日志命名、字段与脱敏规则
- **优先级**：P0
- **目标**：让每条命令都有唯一日志、单一退出码，并从落盘前排除敏感信息。
- **涉及文件**：`docs/codearts_proof/logs/` 下 19 个 stage 与 `2026-11-15-deploy-index.txt`；`_deploy_repro\logs\`。
- **前置依赖**：T02。
- **执行要点**：
  1. 建 19 个 stage 名清单（见 0.6）与 `index` 映射表骨架（验证项 / 命令 / 工作目录 / 退出码 / 日志文件 / 判定）。
  2. 定字段模板 `COMMAND=` / `WORKDIR=` / `START_AT=` / 完整输出 / `EXIT_CODE=`。
  3. 落盘前检索步骤：`Select-String -Pattern 'password|Bearer|sk-|JWT_SECRET=|DEEPSEEK_API_KEY=|1[3-9]\d{9}'`，白名单 `13800138000`、`123456`。
  4. 登记 `.gitignore` 事实：`**/*.log`（第 14 行）与 `*.log`（第 13 行）；不改 `.gitignore`。
- **验证方式**：日志模板与 index 骨架存在；命名与既有 `2026-11-15-guest-context-*` 无重名。
- **完成判据**：19 个 stage + index + 脱敏词表 + 白名单 + 忽略事实五项齐全。
- [ ] 建立 19 个 stage 名与 index 骨架
- [ ] 写入日志字段模板
- [ ] 写入脱敏词表、白名单与落盘前检索步骤

### T07 版本前置核对（V02）
- **优先级**：P0
- **目标**：在执行任何安装前确认工具链满足要求，避免安装到一半才发现不兼容。
- **涉及文件**：日志 `deploy-version.{log,txt}`。
- **前置依赖**：T01、T03。
- **执行要点**：
  1. 在 `checkout-2112271` 内执行 `node -v`、`npm -v`；执行 `D:\mysql\bin\mysqld.exe --version`。
  2. 判定：Node ≥18（实测 24.22.0）、npm 11.19.1、MySQL 8.x（实测 8.4.13）。
  3. 登记版本差异事实：脚本默认假设 `D:\mysql\mysql-8.0.28-winx64\bin`，本机为 `D:\mysql\bin`（D4）；8.4.13 默认未加载 `mysql_native_password`（D11 风险）。
- **验证方式**：三条命令原文 + 退出码 + 版本字符串落盘。
- **完成判据**：版本判定"满足"；版本差异 2 条已登记。版本不足 → 环境阻塞并停止。
- [ ] 执行 `node -v` / `npm -v` / `mysqld --version`
- [ ] 判定 Node≥18 与 MySQL 8.x
- [ ] 登记 8.0.28 路径差异与 8.4 认证插件风险

### T08 冻结禁止清单哈希与本轮备份
- **优先级**：P0（G6/G7 支撑）
- **目标**：让"只改了允许清单"这件事可用哈希证明，并准备文件级回滚能力。
- **涉及文件**：`后端源码/src/**`、`后端源码/sql/**`、`前端参考/**`、`后端源码/package.json`、`package-lock.json`、`.gitignore`、`后端源码/.env`、`scripts/test-api-*.js`（8 个）、`scripts/test-all.sh`、`docs/review/**`、既有 `docs/codearts_proof/**`；备份 `docs/codearts_proof/backup/2026-11-15-deploy/`。
- **前置依赖**：T01、T02。
- **执行要点**：
  1. 对禁止清单逐文件（目录用递归清单）计算 SHA-256，落盘 `snapshots/before/forbidden-sha256.txt`。
  2. 对 5 个允许修改的脚本（`smoke-test.js`、`check-frontend.js`、`check-pages-runtime.js`、`start.js`、`install.js`）复制到 `backup/2026-11-15-deploy/*.before.*` 并复算哈希（源 = 副本）。
  3. 对既有 `docs/review/**`、`docs/codearts_proof/**` 计算目录级清单哈希，保存为 `snapshots/before/evidence-sha256.txt`。
- **验证方式**：三类清单文件存在且行数与文件数自洽；备份副本哈希与源相等。
- **完成判据**：禁止清单 + 5 份备份 + 既有证据清单三者齐备，且未覆盖既有 backup。
- [ ] 生成禁止清单 SHA-256 清单
- [ ] 备份 5 个待改脚本并校验副本哈希
- [ ] 生成既有证据目录清单哈希

---

## 阶段 1 · 修复前取证（T09–T11）

> 本阶段**只读运行与记录**，禁止修改任何检查器或业务文件。G1 未通过前不得进入阶段 2。

### T09 在基线副本取得 `npm test` 真实失败日志（V12）
- **优先级**：P0（G1 门禁）
- **目标**：用真实执行替代"静态推断 3 项失败"，取得修复前唯一基线。
- **涉及文件**：`checkout-2112271/后端源码`；日志 `deploy-smoke-before.{log,txt}`。
- **前置依赖**：T03、T06。
- **执行要点**：
  1. 在 `checkout-2112271/后端源码` 执行 `npm test`（等价 `node scripts/smoke-test.js`）。
  2. 保存完整 stdout/stderr、命令原文、工作目录、开始时间、`EXIT_CODE`。
  3. 记录汇总行实际数值（`通过 X 警告 Y 失败 W`）与耗时（R4.1 要求可测量，>120 秒须记原因）。
  4. 若失败项数与"3 项"不同，**以真实日志为准**，不套用预期、不修改日志。
- **验证方式**：退出码非 0；日志可检索到 3 条 `❌` 且名称与 0.5 硬判据第 3 条一致。
- **完成判据**：日志落盘且不再被覆盖；退出码、汇总数值、失败项原文齐备。
- [ ] 执行 `npm test` 并保存完整日志
- [ ] 记录退出码、汇总数值与耗时
- [ ] 逐条摘录失败项原文

### T10 逐项定位失败并生成 `before.txt` 检查项名称集合
- **优先级**：P0（G1 门禁）
- **目标**：把每条失败归到"文件:行号 → 原因分类 → 判定"，同时产出守恒比对的基准清单。
- **涉及文件**：`smoke-test.js`（L87、L300-321、L322-334、L344-349、L18-37、L421-432）；`snapshots/before/smoke-items-before.txt`。
- **前置依赖**：T09。
- **执行要点**：
  1. 定位表三行，原因分类限定为 `路径假设` / `跳过语义错误` / `工作目录假设` / `端口假设` / `依赖假设` / `真实缺陷`；本轮预期落点为 `路径假设 + 跳过语义错误`（`（跳过）` 无 `WARN:` 前缀 → 落入 else 分支计 fail）。
  2. 从日志抽取名称集合：去掉 `✅`/`⚠️`/`❌` 前缀与 `——` 之后内容，排序去重，写 `smoke-items-before.txt`，并记录总条数。
  3. 记录"必需文件清单 68 项"与"前端 5 项""`src/routes` N 项""`scripts/*.sh` N 项"的实际条数（以日志为准）。
- **验证方式**：定位表 3 行全部有 `文件:行号`；`before.txt` 行数 = 汇总数值之和。
- **完成判据**：无"未知原因"；`before.txt` 与汇总总数自洽；未修改 `smoke-test.js`（哈希仍为 `D9E8EE71…`）。
- [ ] 产出 3 行定位表（文件:行号 → 分类 → 判定）
- [ ] 生成并排序 `smoke-items-before.txt`
- [ ] 核对总数与汇总行一致

### T11 取得两个 P1 检查器修复前真实失败证据
- **优先级**：P0（G1 门禁）
- **目标**：为 P1 修复提供"修复前确实失败"的对照，避免"无基线先改代码"。
- **涉及文件**：`checkout-2112271/后端源码/scripts/check-frontend.js`、`check-pages-runtime.js`；日志 `deploy-smoke-before.{log,txt}`（追加段）。
- **前置依赖**：T10。
- **执行要点**：
  1. `node scripts/check-frontend.js`（无参数）→ 记录 `找不到前端目录` 与退出 1；`node scripts/check-frontend.js ../前端参考` → 记录 `Reflect.ownKeys(undefined)` 导致的异常栈（`ctx.API === undefined`，`api.js` 用 `api()` 而非 `window.API`）。
  2. `node scripts/check-pages-runtime.js`（无参数）→ 记录 `找不到前端目录` 与退出 1；`node scripts/check-pages-runtime.js ../前端参考` → 记录"连不上后端/页面失败"的真实输出（不启动任何服务，允许以 `ECONNREFUSED` 作为修复前事实）。
  3. 两个脚本哈希登记为 `before`（T08 备份已有）。
- **验证方式**：两类失败各自有命令、退出码与原始错误行；区分"路径假设"与"契约过时"。
- **完成判据**：P1 修复前失败证据齐全，且**未修改**两个脚本。
- [ ] 记录 `check-frontend.js` 两种调用的真实失败
- [ ] 记录 `check-pages-runtime.js` 两种调用的真实失败
- [ ] 标注失败类型（路径假设 / 契约过时 / 后端未启动）

---

## 阶段 2 · P0 修复（T12–T19）

> 本阶段在**工作区**修改、在 `checkout-fixed` 同步验证。每项完成后立即在 `checkout-fixed` 复跑，检查项守恒（0.5）不得破坏。

### T12 `smoke-test.js` 前端目录来源单一化
- **优先级**：**P0（检查器）**
- **目标**：四处硬编码旧路径合并为一个解析函数，使仓库内无参数运行即可定位 `前端参考/`。
- **涉及文件**：`后端源码/scripts/smoke-test.js`（L87 模块常量、L300-321、L322-334、L344-349）。
- **前置依赖**：G1（T09–T11 通过）。
- **执行要点**：
  1. 新增单一解析函数，顺序：`--frontend=<dir>` → `FRONTEND_DIR` 环境变量 → `path.resolve(ROOT, '..', '前端参考')` → 旧默认 `D:/Study/Match/.../前端八稿`（命中时打印 `WARN: 使用了旧默认路径`）。
  2. 解析结果在 `[1]` 段之后打印一次 `前端目录: <绝对路径>`；解析失败时打印"尝试过的路径"四行（参数值、环境变量值、相对路径绝对化结果、旧默认值）。
  3. 四处调用点全部改用解析结果；**不改** `sk-` 正则 `/sk-[a-zA-Z0-9]{20,}/`、扫描范围（`.js`/`.html`）、68 项必需文件清单、SQL/切分/路由检查逻辑。
- **验证方式**：`node -c` 等价的语法可加载性（`node --check`）；在 `checkout-fixed` 跑一次，日志出现实际路径且 3 项失败消失（临时结果，正式判定在 T14）。
- **完成判据**：四处调用点无硬编码旧路径残留；`node --check` 通过；仅路径来源与解析提示行变化。
- [ ] 实现解析函数与优先级顺序
- [ ] 打印实际路径与"尝试过的路径"
- [ ] 替换 L87/L308/L323/L346 四处引用

### T13 `smoke-test.js` 四态化与汇总/退出码语义
- **优先级**：**P0（检查器）**
- **目标**：把"未执行"与"失败"分开，SKIP 不计 PASS 也不计 FAIL。
- **涉及文件**：`后端源码/scripts/smoke-test.js`（L15 计数器、L18-37 `check()`、L421-432 汇总与退出）。
- **前置依赖**：T12。
- **执行要点**：
  1. `check()` 增加 `'SKIP:'` 前缀分支 → `skip++` 并打印 `⏭ <名>`；保留 `WARN:` 语义与抛异常 → FAIL。
  2. 3 处"目录不存在"返回值改为 `SKIP: 前端目录不存在（<路径>）`，**不得**把"目录存在但检查失败"改为 SKIP。
  3. 汇总改为 `通过 X 警告 Y 跳过 Z 失败 W`，并显式打印"跳过不计入通过"；退出码：`fail > 0 → 1`，否则 `0`（在注释与输出中写明）。
- **验证方式**：分别构造"目录存在"（真实 `前端参考/`）与"目录不存在"（`--frontend=<不存在路径>`）两种运行，前者 SKIP 为 0 且安全检查实际执行，后者相关项计 SKIP。
- **完成判据**：四态分支可观察；两种场景汇总数值正确；退出码语义与文档一致。
- [ ] 新增 `skip` 计数与 `SKIP:` 分支
- [ ] 三处目录缺失返回值改为 SKIP
- [ ] 汇总加"跳过 Z"并写明退出码语义
- [ ] 双场景验证（存在 / 不存在）

### T14 修复后 `npm test` 归零并证明检查项守恒（V13 / G2）
- **优先级**：P0（G2 门禁）
- **目标**：证明"3 失败 → 0 失败"来自路径来源修正，而不是删除或放宽检查。
- **涉及文件**：日志 `deploy-smoke-after.{log,txt}`；`snapshots/after/smoke-items-after.txt`。
- **前置依赖**：T10、T13。
- **执行要点**：
  1. 在 `checkout-fixed/后端源码` 执行 `npm test`，保存完整日志与 `EXIT_CODE`。
  2. 生成 `smoke-items-after.txt`，与 before 做 `diff`；记录总数、四项计数（pass/warn/skip/fail）。
  3. 产出"判定变化对照表"：3 项 FAIL→PASS + 5 项 WARN→PASS（按 0.5 口径修正一），逐项注明"由路径来源修正引起"；任何删除项或断言放宽 → 判不合格并回退。
  4. 工作区（`D:\微光同行\Glimmer`）同步执行一次 `npm test`，确认与副本一致。
- **验证方式**：`diff before after` 为空；总数相等；FAIL=0；判定变化 8 项且全部可归因。
- **完成判据**：三条硬判据 + 8 项变化说明齐全；日志保留；`smoke-test.js` 是唯一变化文件。
- [ ] 副本内执行 `npm test` 并保存日志
- [ ] 生成 `after.txt` 并做名称集合 diff
- [ ] 登记 8 项判定变化与归因
- [ ] 工作区复跑一致

### T15 合成 `sk-` 反向验证（V14 / D8）
- **优先级**：P0（G2 门禁）
- **目标**：证明前端明文 Key 检查没有被"归零"顺带削弱。
- **涉及文件**：`_deploy_repro\checker-probe\前端参考\__probe_secret_check.js`（临时）；日志 `deploy-smoke-reverse.{log,txt}`。
- **前置依赖**：T13、T14。
- **执行要点**：
  1. 仅在 `checker-probe` 的前端目录写入 `__probe_secret_check.js`，内容含合成串（形如 `sk-` + 32 位占位字符，**非真实 Key**）。
  2. 执行 `node scripts/smoke-test.js --frontend=<probe 前端目录>` → 必须 FAIL 且点名该文件；记录退出码 1。
  3. 删除探测文件 → 确认文件不存在 → 同一命令再跑 → 安全检查 PASS；记录退出码 0。
  4. 留存两次输出、文件不存在证明（`Test-Path` 为 False）与 probe 目录文件数前后对照。
- **验证方式**：放入 FAIL / 删除 PASS；合成串未出现在工作区与 `checkout-fixed`（关键）。
- **完成判据**：两次日志 + 删除证明 + 目录文件数对照齐全；工作区 `git status --short` 无新增探测文件。
- [ ] 在 probe 写入合成串文件
- [ ] 运行并取得 FAIL（点名探测文件）
- [ ] 删除并取得 PASS，留存不存在证明
- [ ] 核对工作区与 `checkout-fixed` 无合成串

### T16 `setup/start.js` 后端端口以 `.env` 为准
- **优先级**：**P0（检查器）**
- **目标**：消除"后端端口写死 3000"与隔离环境冲突，`PORT` 缺失时显式失败而不是静默猜测。
- **涉及文件**：`setup/start.js`（L31、L36-44、L84-101、L156-173、L302、L304）。
- **前置依赖**：G1。
- **执行要点**：
  1. 新增 `readBackendPort()`：解析 `后端源码/.env` 的 `PORT`；缺失或非法 → 打印"缺 `.env` 或 `PORT` 非法，请先安装"并 `exit 1`（不回落 3000）。
  2. `DB_PORT` 解析同样改为"`.env` 缺失/非法即 `exit 1`"，不静默回落 3306（C9）。
  3. `checkHealth()`、`proxyToBackend()`（含 `host` 头）、两处文案（`后端已启动（<实际端口>）`/`后端在运行（<实际端口>）`）统一使用解析值。
  4. **不改** `/api`、`/uploads` 判定规则、502 兜底语义、静态托管逻辑。
- **验证方式**：`.env` 缺失 → 退出 1 且提示明确；`.env` 存在（隔离值）→ 健康检查与代理指向该端口（端到端在 T31/T32）。
- **完成判据**：`BACKEND_PORT` 常量消失；3 处消费点统一；`.env` 缺失路径有明确提示与退出码。
- [ ] 实现 `readBackendPort()` 与显式失败路径
- [ ] 统一健康检查/代理/文案端口
- [ ] `DB_PORT` 缺失改为显式失败

### T17 `setup/start.js` 同端口实例归属校验与运行登记
- **优先级**：**P0（检查器）**
- **目标**：端口被占用时不再直接宣告"后端在运行"，避免把旧目录/旧版本后端当成本次源码。
- **涉及文件**：`setup/start.js`（L240-305）。
- **前置依赖**：T16。
- **执行要点**：
  1. 端口占用 → `netstat -ano` 取 PID → CIM 取 `Name`/`CommandLine`/`ExecutablePath` → 判定 `owned`（命令行/路径指向当前 `SERVER_DIR`） / `foreign` / `unknown`。
  2. `owned` → 打印"后端在运行（<端口>）"并继续；`foreign` / `unknown` → 打印"端口被非本次源码实例占用"+PID+命令行+"建议：改隔离 `.env` 的 `PORT`，或关闭该进程"并 `exit 2`（不启动前端）。
  3. 启动成功后写 `os.tmpdir()/glimmer-backend-<port>.json`（`pid`/`repoRoot`/`port`/`startedAt`）；复用前校验登记与 PID 一致。日志只记"登记存在/不存在"，不记内容。
  4. **不 kill 任何进程**；不要求后端新增标识接口。
- **验证方式**：构造 `foreign` 场景（用另一目录的 node 进程占用临时端口）→ 退出 2 且不打印"后端在运行"；`owned` 场景（本仓库后端）→ 正常复用。
- **完成判据**：三态判定可观察；`foreign/unknown` 退出 2；运行登记写入临时目录且不进仓库。
- [ ] 实现 PID/命令行采集与三态判定
- [ ] `foreign/unknown` → 退出 2 + 建议命令
- [ ] 写入并校验运行登记文件
- [ ] 双场景验证（foreign / owned）

### T18 `setup/start.js` mysqld 定位可配置 + 启动参数确定 + 死代码清理
- **优先级**：**P0（检查器）**
- **目标**：让启动器在本机 `D:\mysql\bin` 下可用，且启动参数与现有实例对齐（配置来源确定）。
- **涉及文件**：`setup/start.js`（L47-49、L62-64、L216-237、L321）。
- **前置依赖**：T17。
- **执行要点**：
  1. 新增参数/环境变量：`--mysqld=<path>`/`MYSQLD`、`--mysql-basedir`/`MYSQL_BASEDIR`、`--mysql-datadir`/`MYSQL_DATA_DIR`；默认顺序：显式 → `MYSQL_HOME/bin/mysqld.exe` → 旧版本目录。全部不存在 → "找不到 mysqld：<尝试过的路径>；可用 --mysqld 指定"并 `exit 1`（**不触发下载**）。
  2. 启动参数改为 `--no-defaults`（**首位**）、`--basedir`、`--datadir`（可用绝对路径覆盖）、`--port`、`--bind-address=127.0.0.1`、`--mysqlx=OFF`、`--console`。
  3. 删除 L321 `if (!NO_OPEN === false) { }` 空块，不改变控制流。
  4. **不改**"端口已开则不启动 MySQL"分支、静态托管与目录穿越防护。
- **验证方式**：不指定路径且默认不存在 → 明确报错退出 1；显式 `--mysqld=D:\mysql\bin\mysqld.exe` → 参数拼接正确（打印/日志逐字核对，实际启动在 T28）。
- **完成判据**：三类参数可覆盖；`--no-defaults` 位于首位；无版本目录硬编码残留；死代码已删。
- [ ] 实现 mysqld/basedir/datadir 三级解析
- [ ] 启动参数对齐（`--no-defaults` 首位、127.0.0.1、mysqlx OFF）
- [ ] 删除 L321 空 if 块

### T19 `setup/start.js` 离线验证（缺失路径与参数解析）
- **优先级**：P0
- **目标**：在不启动任何服务的前提下证明三处关键行为（缺 `.env`、缺 mysqld、端口参数）符合预期。
- **涉及文件**：`checkout-fixed/setup/start.js`；日志 `deploy-backend.{log,txt}`（离线段）。
- **前置依赖**：T16–T18。
- **执行要点**：
  1. 在 `checkout-fixed`（无 `.env`）执行 `node setup/start.js --no-open` → 期望：明确提示缺 `.env`/`PORT` 并 `exit 1`，**不**回落 3306/3000、不启动 MySQL。
  2. 临时构造非法 `PORT=abc`（写入隔离 `.env` 副本后删除）→ 期望同样明确失败。
  3. 执行 `node setup/start.js --port 8090 --no-open` 并在 `--help` 或日志中断言端口解析；`--mysqld=<不存在路径>` → 期望"找不到 mysqld"退出 1。
  4. 记录三次命令与退出码；不留下任何 `.env` 残留（用完立即删除并证明不存在）。
- **验证方式**：3 次命令退出码与提示文本可核对；`checkout-fixed` 仍无 `.env`。
- **完成判据**：三条离线判据全部成立；无进程被启动；无 `.env` 残留。
- [ ] 验证缺 `.env` → 退出 1
- [ ] 验证非法 `PORT` → 退出 1
- [ ] 验证 mysqld 路径不存在 → 退出 1
- [ ] 清理临时 `.env` 并证明不存在

---

## 阶段 3 · P1 修复（T20–T22）

### T20 `check-frontend.js` 目录参数化与契约缺失降级为 SKIP
- **优先级**：**P1（检查器）**
- **目标**：无参数可定位仓库内前端；旧 `window.API` 契约缺失时不崩溃、不篡改断言。
- **涉及文件**：`后端源码/scripts/check-frontend.js`（L23、L54-75、L78-95、L155-178、L264-275）。
- **前置依赖**：G1（T11）。
- **执行要点**：
  1. 目录解析：`--frontend=<dir>` → `FRONTEND_DIR` → `path.resolve(<ROOT>, '..', '前端参考')` → 旧默认（WARN）；保留 `argv[2]` 位置参数兼容。
  2. `loadApiObject()` 返回空对象并在调用处判空；`collectApiPaths()` 前置判空；契约缺失时 API 方法存在性项输出 `SKIP: 旧 window.API 契约不存在（当前前端使用 api()）`，并打印替代入口（`test:competition` / `test:merge24` / 独立验收脚本）。
  3. 汇总增加"跳过 N"；退出码仍为 `fail > 0 → 1`。
  4. **不改** `API\.x\.y(` / `API\.x(` 正则、标签配对、外链存在性、localStorage 残留检查的任何断言。
- **验证方式**：`node scripts/check-frontend.js --frontend=../前端参考` 不抛异常、不退出 1（仅 SKIP/警告）；`--frontend=<不存在>` → 退出 1 且提示明确。
- **完成判据**：L23 硬编码消失；契约缺失走 SKIP；断言与正则逐字未变（diff 只出现在路径/判空/汇总）。
- [ ] 实现目录解析优先级
- [ ] `loadApiObject`/`collectApiPaths` 判空 + SKIP 分支
- [ ] 汇总加"跳过 N" + 替代入口提示

### T21 `check-pages-runtime.js` 基址来源与同源注入
- **优先级**：**P1（检查器）**
- **目标**：`--base` 真正生效，使页面脚本在沙箱内打到隔离后端而不是现有 3000。
- **涉及文件**：`后端源码/scripts/check-pages-runtime.js`（L30、L31、L179-180、L192-231）。
- **前置依赖**：T20。
- **执行要点**：
  1. 目录解析同 T20；基址解析 `--base` / `API_BASE` → 隔离 `.env` 的 `PORT` → `http://127.0.0.1:3000`（WARN 并打印"使用了默认基址"）。
  2. sandbox 的 `location` 补齐 `protocol: 'http:'`、`host`、`origin: <base>`，使 `api.js` 的 `API_CANDIDATES[0] = location.origin + '/api'` 命中目标基址；**保留**原 `var BASE` 正则替换以兼容旧契约。
  3. 记录实际使用的目录与基址（打印一次）。
  4. **不改**假 DOM、脚本抽取、定时器处理、登录种子、页面判定与退出码。
- **验证方式**：修复后在 `checkout-fixed` 运行，输出中"后端: <隔离端口>"与实际一致（端到端在 T33）。
- **完成判据**：基址打印为传入值；`API_CANDIDATES` 命中同源候选（用一次性 `vm` 断言或日志证明）；未删任何判定。
- [ ] 实现目录与基址解析优先级
- [ ] 补齐 `location.protocol/host/origin`
- [ ] 打印实际目录与基址

### T22 P1 修复边界走查（断言未放宽、页面未减少）
- **优先级**：P1
- **目标**：在实测前先用代码级对照证明 P1 只是"路径 + 降级"，不是"放水"。
- **涉及文件**：两个 P1 脚本的 before/after 副本（`backup/2026-11-15-deploy/`）。
- **前置依赖**：T20、T21。
- **执行要点**：
  1. 逐函数 diff：列出新增/修改行，确认仅出现在"路径解析""判空""SKIP 分支""打印/汇总"四类位置。
  2. 对照 before/after 的正则清单（`API\.\w+\.\w+\s*\(`、`API\.\w+\s*\(`、`var BASE`、`<script` 抽取、`localStorage` 键清单），逐字相等。
  3. 对照页面遍历清单：`fs.readdirSync(FRONTEND).filter(.html)` 数量与排序不变。
- **验证方式**：diff 行清单 + 正则对照表 + 页面数对照。
- **完成判据**：无断言删除/放宽；改动位置仅四类；页面数不变。
- [ ] 产出两个脚本的 before/after diff 行清单
- [ ] 对照 5 组正则/抽取规则逐字相等
- [ ] 对照 HTML 页面数与排序

---

## 阶段 4 · P2 标注与可选加固（T23–T25）

### T23 登记 8 个 `test-api-*.js` 为历史过时脚本（只标注、不篡改）
- **优先级**：**P2**
- **目标**：把"旧契约"单列为历史过时，避免混入"修复通过"，也避免有人改断言骗绿。
- **涉及文件**：`后端源码/scripts/test-api-{ai,bless,bottle,client,comment,interact,message,profile}.js`（只读）。
- **前置依赖**：T10。
- **执行要点**：
  1. 逐文件登记：旧前端目录硬编码（`test-api-*.js` 各行）、`window.API` 断言（`test-api-client.js`）、依赖真实后端与真实库且会写测试数据。
  2. 每个文件给出：过时原因、替代入口（`test:competition`、`test:merge24`、独立验收脚本）、当前哈希。
  3. 在报告中写明"**未纳入本轮通过声明**"，且本轮不运行它们（避免写库）。
- **验证方式**：8 行登记表；8 个文件哈希与 T08 一致。
- **完成判据**：登记表齐全；无任何断言被改写；未执行这 8 个脚本。
- [ ] 登记 8 个文件的过时点与替代入口
- [ ] 核对 8 个文件哈希未变
- [ ] 写明"不纳入通过声明、本轮未执行"

### T24 `setup/install.js` 可选加固（不改变默认行为）
- **优先级**：**P2（可选）**
- **目标**：消除高危 `ALTER USER` 与配置来源不确定，同时保持默认端口与 `--check` 语义不变。
- **涉及文件**：`setup/install.js`（L43-49、L61、L231-248、L250-289、L338-346、L383-432、L463）。
- **前置依赖**：T08、T23。
- **执行要点**：
  1. `initMysqlData`（L237-241）与 `startMysql`（L265-271）spawn 参数**首位**加 `--no-defaults`；保留既有 `--mysqlx-port` 偏移策略。
  2. 新增 `--mysqld`/`--mysql-basedir`/`--mysql-datadir`（优先于 `MYSQL_HOME` 拼接）。
  3. `usePrivateInstance()` 前置保护：目标端口**已被监听** → 立即拒绝并 `exit 1`（"该端口已有实例，禁止在此设密码；请改用 --private-port 指定空闲端口"）；`data-<port>/mysql` 已存在 → 拒绝复用；`ALTER USER` 仅在"本进程刚初始化并启动成功"的实例上执行。
  4. 下载前探测 `--mysqld`/`MYSQL_HOME/bin/mysqld.exe`/旧版本目录，全部不存在才提示下载，并给出"用 `--mysqld` 指定已有程序"。
  5. 设密码失败且版本 ≥8.4 → 追加提示"`mysql_native_password` 在 8.4 默认未加载"与 `IDENTIFIED BY` 手工命令。
  6. **不改** `PRIVATE_PORT` 默认 3307、`--check` 语义、建库名 `peizhe`、`npm install` 行为。
- **验证方式**：代码走查 + `--check` 只读运行（T25）；不执行 `--force-private` 正式链路。
- **完成判据**：5 项加固落地；默认行为未变（`--check` 输出与 before 对照一致）。
- [ ] 两处 spawn 加 `--no-defaults`
- [ ] 新增三个显式目录/程序参数
- [ ] `ALTER USER` 前置保护（端口已监听即拒绝）
- [ ] 下载前探测与 8.4 提示
- [ ] 走查确认默认端口与 `--check` 语义未变

### T25 `install.js --check` 只读验证并登记"非本轮主路径"
- **优先级**：**P2**
- **目标**：证明 install.js 加固后不会改环境，同时明确本轮建库不走一键链路。
- **涉及文件**：`checkout-fixed/setup/install.js`；日志 `deploy-install.{log,txt}`（附加段）。
- **前置依赖**：T24。
- **执行要点**：
  1. 执行 `node setup/install.js --check`，记录输出、退出码与"未改动"证据（`netstat`、`.env` 哈希、`D:\mysql` 目录 mtime 不变）。
  2. 登记本轮**不**执行 `--force-private` 一键链路的原因（默认端口 3307 与现有实例冲突；`ALTER USER` 风险；`dbName` 硬编码 `peizhe`），替代流程为 T27–T30 的显式独立实例流程。
  3. 登记 D11 风险与 D8（`dbName='peizhe'` 忽略 `.env DB_NAME`）差异。
- **验证方式**：`--check` 退出码与输出；`.env` 哈希前后一致；3307 PID 不变。
- **完成判据**：只读验证完成；3 条"不走一键链路"理由与替代流程写清。
- [ ] 运行 `install.js --check` 并记录退出码
- [ ] 核对环境未被改动（端口/`.env` 哈希/目录 mtime）
- [ ] 登记非主路径理由与替代流程

---

## 阶段 5 · 独立环境从零安装（T26–T30）

> 顺序约束（不可打乱）：T26 → T27 → T28 → T29 → T30。**T29 必须先于 T31**（`app.js` 空库自建表分支会因未 import `mysql` 而失败，H3）。

### T26 隔离副本执行 `npm ci`（V03 / D3）
- **优先级**：P0（G3 前置）
- **目标**：用锁文件证明"从零安装"，并如实处理网络失败。
- **涉及文件**：`checkout-fixed/后端源码/package-lock.json`；`node_modules/`（生成）；日志 `deploy-install.{log,txt}`。
- **前置依赖**：T04、T07。
- **执行要点**：
  1. 执行 `npm ci`，记录命令、退出码、耗时、包数量。
  2. `npm ci` 前后证明"零依赖起点"：安装前 `node_modules` 不存在。
  3. 成功后 `npm ls --depth=0` 记录无 `missing`/`UNMET`。
  4. 失败两级：L1 若 stderr 含网络/镜像/代理/证书关键词 → 用**同一锁文件**重试一次（不改 registry、不关 TLS）；L2 仍失败 → 停止 T27–T38，标"环境阻塞"，保留原始 stderr 与两次退出码。**禁止**复制/软链工作区 `node_modules`、禁止 `npm install` 顶替、禁止改锁文件。
- **验证方式**：`npm ci` 退出 0；`node_modules` 存在；`npm ls` 无 missing。
- **完成判据**：安装日志（含两次尝试或一次成功）落盘；"零依赖起点"有证明。失败则需在报告中写"未完成从零安装"。
- [ ] 证明安装前无 `node_modules`
- [ ] 执行 `npm ci` 并记录退出码/耗时/包数
- [ ] 执行 `npm ls --depth=0` 记录无缺失
- [ ] 失败时按 L1/L2 记录原始 stderr

### T27 生成隔离 `.env`（V04）
- **优先级**：P0（G3 前置）
- **目标**：用模板生成只指向独立实例的配置，Key 留空，全程不打印任何值。
- **涉及文件**：`checkout-fixed/后端源码/.env`（生成，不入库、不进 Git）；日志 `deploy-env.{log,txt}`。
- **前置依赖**：T26。
- **执行要点**：
  1. 以 `.env.example` 为模板生成 `.env`；改写：`DB_HOST=127.0.0.1`、`DB_PORT=<3311 或顺延值>`、`DB_USER=root`、`DB_PASSWORD=<仅写入文件的随机串>`、`DB_NAME=peizhe_deploy_20261115`、`PORT=<隔离后端端口，非 3000>`、`JWT_SECRET=<随机串>`、`DEEPSEEK_API_KEY=`（留空）。
  2. 保持：`HOST`、`NODE_ENV`、`JWT_EXPIRES_IN`、`DEEPSEEK_API_URL`、`DEEPSEEK_MODEL`、`DEV_SMS_CODE`、`SMS_ENABLED`；注释态 `PUBLIC_BASE_URL`/`PUBLIC_HOST` 保持注释。
  3. 输出证据：键名清单 + `configured` 布尔（`DEEPSEEK_API_KEY=configured:false`）+ `.env` SHA-256；**禁止输出值**。
  4. 双校验：`DB_PORT ≠ 3307/3306`、`DB_NAME ≠ 现有库名`、`PORT ≠ 3000`。
- **验证方式**：键名与 0.1 的 15 个有效键一致；三项双校验通过；日志无值。
- **完成判据**：`configured` 表 + SHA-256 + 双校验三联齐全。模板缺键 → 中止并标"待确认"（不得从现有 `.env` 取值）。
- [ ] 由模板生成隔离 `.env`
- [ ] 输出键名 + configured 表 + SHA-256（无值）
- [ ] 执行端口/库名/后端端口三项双校验

### T28 启动独立 MySQL 实例 3311（V05-a / D1 / D4）
- **优先级**：P0（G3 门禁）
- **目标**：建立一个进程/端口/数据目录/库名四维都与现有 3307 分离的实例。
- **涉及文件**：`D:\mysql\bin\mysqld.exe`；数据目录 `_deploy_repro\mysql-data-3311`；日志 `deploy-db-init.{log,txt}`、`deploy-ports.{log,txt}`（前段）。
- **前置依赖**：T27、T30（前段端口空闲证明）。
- **执行要点**：
  1. 启动前证明 3311 无监听；数据目录不存在（或为空且非复用）。
  2. 首次 `--initialize-insecure --no-defaults --basedir=D:/mysql --datadir=<绝对目录>`（一次），记录退出码。
  3. 启动：`mysqld --no-defaults --basedir=D:/mysql --datadir=<绝对目录> --port=3311 --bind-address=127.0.0.1 --mysqlx=OFF --console`（后台），`--no-defaults` 必须首位。
  4. 实例身份（只读）：`SELECT @@port, @@version, @@datadir, DATABASE();` + PID + 命令行。
  5. 设 root 密码用**默认插件**（`IDENTIFIED BY`，不指定 `mysql_native_password`），密码只写入隔离 `.env`；只在本进程刚初始化的实例上执行。
  6. 3311 被占 → 顺延 3312+（最多 +10）并记录原因；目录已存在 → 拒绝复用。
- **验证方式**：`@@port=3311`；`@@datadir` 前缀为 `_deploy_repro\`；PID ≠ 39896；监听仅 `127.0.0.1`。
- **完成判据**：5 项身份证据落盘；未触碰 3307/3306；未使用 `--force-private` 默认链路。
- [ ] 证明 3311 空闲且数据目录不存在
- [ ] `--initialize-insecure` 并记录退出码
- [ ] 以显式参数启动并核对 `@@port/@@datadir/PID`
- [ ] 默认插件设密码（仅本进程实例）
- [ ] 记录端口顺延情况（如发生）

### T29 两次执行 `init-db.js` 完成 23 表 + 4 房间（V05-b）
- **优先级**：P0（G3 前置）
- **目标**：证明初始化完整且幂等，且写入只落在独立库。
- **涉及文件**：`checkout-fixed/后端源码/scripts/init-db.js`（只读）；日志 `deploy-db-init.{log,txt}`。
- **前置依赖**：T28。
- **执行要点**：
  1. 第一次 `node scripts/init-db.js`：记录退出码、`SHOW TABLES` 数量（23）、`chat_rooms` 4 行（`age/interest/province/zodiac`）。
  2. 第二次同命令：退出 0；表数仍 23；房间仍 4 且无重复（按 `code` 唯一）。
  3. 记录 `users.session_version`、`users.session_device`、`messages.is_sys` 三列存在（使 T31 的 `ensureSchema()` 不触发 ALTER）。
  4. 检索本轮全部 SQL 日志：`DROP`/`TRUNCATE` 命中 **0**；记录"未对现有库执行任何语句"。
- **验证方式**：两次退出 0；23 表/4 房间/无重复；三列存在；破坏性语句 0。
- **完成判据**：两条初始化日志 + 表/房间清单 + 三列证据 + 破坏性检索结果齐全。
- [ ] 第一次初始化并记录表/房间
- [ ] 第二次初始化验证幂等
- [ ] 核对 3 个关键列存在
- [ ] 检索 `DROP`/`TRUNCATE` 命中为 0

### T30 端口矩阵与四维隔离判据（V15 前段）
- **优先级**：P0（G3 门禁）
- **目标**：在写入前用端口/PID/命令行矩阵证明"3311 属于本轮、其余属于既有"，并排除 3000/8081/3307 被接入。
- **涉及文件**：日志 `deploy-ports.{log,txt}`。
- **前置依赖**：T28。
- **执行要点**：
  1. `netstat -ano` 采集 3306/3307/3000/8080/8081/8090/3311（含 3312… 若顺延）。
  2. CIM 采集每端口 PID 的 `Name`/`CommandLine`/`CreationDate`。
  3. 四维对照表：进程（PID ≠ 39896）、端口（3311 ≠ 3307）、数据目录（`_deploy_repro\mysql-data-3311` vs `./mysql-data`）、库名（`peizhe_deploy_20261115` vs 现有库）。
  4. 明确登记：本轮后端端口 ≠ 3000、前端端口 ≠ 8081，且**不**把 3000/8081/3307 作为本轮验证对象。
- **验证方式**：四维全部不同；3000/8081/3307 的 PID 与命令行与 T05 一致。
- **完成判据**：矩阵表 + 四维判据 + "未接入既有端口"声明齐全。任一维相同 → 判未隔离并停止。
- [ ] 采集 7 个端口占用与 PID
- [ ] 采集 PID 对应命令行与启动时间
- [ ] 产出四维对照表与"未接入"声明

---

## 阶段 6 · 启动与归属（T31–T34）

### T31 启动隔离后端并验证健康判据（V06）
- **优先级**：P0（G3/G5 支撑）
- **目标**：证明独立库可被后端连上、模型未配置、端口不是 3000。
- **涉及文件**：`checkout-fixed/后端源码/src/app.js`（只读）；日志 `deploy-backend.{log,txt}`。
- **前置依赖**：T29。
- **执行要点**：
  1. 在 `checkout-fixed/后端源码` 执行 `node src/app.js`（隔离 `.env` 已就位），记录命令、工作目录、启动日志。
  2. `GET /api/health`：断言 `code:0`、`data.db.connected===true`、`data.ai.configured===false`、实际端口 ≠ 3000。
  3. 启动日志断言：**无**"库里还没有表，正在执行 sql/schema.sql 建表"、**无**"补字段"（证明 H3/H4 规避生效）；若出现即记录并在报告中说明（不得改 `src/**`）。
  4. 端口冲突 → 改隔离 `.env` 的 `PORT` 并记录；连库失败 → 输出真实错误，标"未通过"。
- **验证方式**：健康 JSON 三项断言通过；端口 ≠ 3000；启动日志无自动建表分支。
- **完成判据**：健康摘要（脱敏）+ 端口 + 日志断言三件齐全；未触碰 3000。
- [ ] 启动后端并记录命令与启动日志
- [ ] 断言 `code:0` / `db.connected:true` / `ai.configured:false`
- [ ] 断言端口 ≠ 3000 且日志无自动建表分支

### T32 启动隔离前端 8090 并验证静态一致性（V07 / D9）
- **优先级**：P0（G3 门禁）
- **目标**：证明页面来自本次源码（而不是既有 8081 实例），且代理可达。
- **涉及文件**：`checkout-fixed/setup/start.js`；日志 `deploy-frontend.{log,txt}`。
- **前置依赖**：T31。
- **执行要点**：
  1. `node setup/start.js --port 8090 --no-open`（必要时 `--mysqld=D:\mysql\bin\mysqld.exe`）；记录实际端口。
  2. `GET /chat-companion.js` 内容 SHA-256 与 `checkout-fixed/前端参考/chat-companion.js` 磁盘哈希**相等**（应为 `31C567E9…`）。
  3. `GET <前端>/api/health` 代理返回与后端一致（`db.connected:true`）。
  4. 8090 被占 → 顺延并记录；不占用 8080/8081。
- **验证方式**：哈希相等 + 代理健康一致 + 实际端口记录。
- **完成判据**：三项成立；哈希不等即判"非本次实例"并中止前端结论（不写浏览器通过）。
- [ ] 启动前端并记录实际端口
- [ ] 比对 `/chat-companion.js` 内容哈希与磁盘哈希
- [ ] 验证 `/api/health` 代理可达
- [ ] 记录端口顺延（如发生）

### T33 P1 检查器实测（`check-frontend.js` + `check-pages-runtime.js`）
- **优先级**：**P1（检查器实测）**
- **目标**：用隔离后端证明 P1 修复真正生效（基址不再打 3000、契约缺失为 SKIP）。
- **涉及文件**：`checkout-fixed/后端源码/scripts/{check-frontend,check-pages-runtime}.js`；日志 `deploy-smoke-after.{log,txt}`（追加段）。
- **前置依赖**：T22、T32。
- **执行要点**：
  1. `node scripts/check-frontend.js --frontend=../前端参考`：不崩溃；API 方法项显示 SKIP + 替代入口；汇总出现"跳过 N"；退出码按 `fail` 判定。
  2. `node scripts/check-pages-runtime.js --frontend=../前端参考 --base=http://127.0.0.1:<隔离端口>`：输出"后端: http://127.0.0.1:<隔离端口>"；页面脚本未打到 3000（以日志中无 3000 请求/错误为准）。
  3. 登录种子说明：独立库由 `init-db.js` 建立，**不含演示账号**（`seed.sql` 仅房间），因此需要登录的页面会报"未登录"——**这是预期**，登记为"未验证（缺演示账号）"，不得计为页面失败，也不得为此跑 `seed-demo.js`（会写大量演示数据）。
- **验证方式**：目录与基址打印正确；无 3000 命中；SKIP 语义可见。
- **完成判据**：两条命令输出 + 退出码 + "未登录属预期"说明齐全。
- [ ] 运行 `check-frontend.js` 并记录 SKIP 与汇总
- [ ] 运行 `check-pages-runtime.js` 并记录基址
- [ ] 证明未命中 3000
- [ ] 登记"缺演示账号导致未登录"为预期/未验证

### T34 端口与进程归属后段核对（V15 后段）
- **优先级**：P0（G3 门禁）
- **目标**：证明 3311/8090 是本次实例，且 3000/8081/3307 从未被接入或重启。
- **涉及文件**：日志 `deploy-ports.{log,txt}`（后段）。
- **前置依赖**：T30、T32。
- **执行要点**：
  1. 复采 7 个端口与 PID；3311/8090 的 PID 均为本轮新进程，命令行为 `mysqld --port=3311` / `node setup/start.js --port 8090`。
  2. 3000/8081/3307 的 PID、启动时间、命令行与 T05 **逐字一致**。
  3. 记录 3311 的 `@@datadir` 绝对路径与监听地址（仅 `127.0.0.1`）。
  4. 任一既有 PID 变化 → 立即停止（G6 前置），如实报告。
- **验证方式**：前后对照表差异仅"新增 3311/8090"。
- **完成判据**：归属证据 5 项 + 既有进程不变声明。未证明 → 不得执行 T35–T38。
- [ ] 复采端口与 PID
- [ ] 证明 3311/8090 为本轮实例
- [ ] 证明 3000/8081/3307 未变

---

## 阶段 7 · 回归（T35–T38）

> 每条命令独立执行、独立退出码、完整日志；任一非 0 先定位（断言失败 / 环境阻塞 / 配置错误），**不得删断言、不得改期望、不得分段拼接**。

### T35 单文件回归 68/68（V08）
- **优先级**：P0（G4 门禁）
- **目标**：证明 R9 的 13 条与既有 55 条在本轮环境全部通过。
- **涉及文件**：`checkout-fixed/后端源码/scripts/test-chat-companion-repair.test.js`（只读）；日志 `deploy-unit.{log,txt}`。
- **前置依赖**：G3（T34）。
- **执行要点**：
  1. 在 `checkout-fixed/后端源码` 执行 `node --test --test-timeout=5000 --test-reporter=spec scripts/test-chat-companion-repair.test.js`。
  2. 记录 `tests/pass/fail` 实际计数、退出码；核对 `EDGE-R9-01…13` 均为 `✔`。
  3. 失败 → 记录失败用例名与断言原文，归类后停下；不得修改测试文件（哈希必须仍为 `B08A6CFA…`）。
- **验证方式**：68/68、退出 0；测试文件哈希不变。
- **完成判据**：日志可复核且退出 0；计数与 68 一致或差异已如实登记。
- [ ] 执行单文件命令并保存完整日志
- [ ] 核对 68/68 与退出码
- [ ] 核对测试文件哈希未变

### T36 竞赛回归 `test:competition`（V09）
- **优先级**：P0（G5 门禁）
- **目标**：用单条 `npm run` 取得两套完整回归之一的可核查结果。
- **涉及文件**：`package.json`（只读）；日志 `deploy-competition.{log,txt}`。
- **前置依赖**：T35（G4）。
- **执行要点**：
  1. 在 `checkout-fixed/后端源码` 执行 `npm run test:competition`（`&&` 链，单一退出码）。
  2. 记录退出码、Node 测试计数与三组集成计数（预期 137 Node + 18/71/66，**以实际输出为准**）。
  3. 非 0 → 定位到具体子命令与失败断言；环境类（`ECONNREFUSED`/认证失败）标"环境阻塞"，并核对 `.env` 指向独立库。
- **验证方式**：单条命令 + 单一退出码 + 完整日志。
- **完成判据**：日志落盘；计数与预期不一致时已如实登记，未改写期望。
- [ ] 执行 `npm run test:competition`
- [ ] 记录退出码与各组计数
- [ ] 非 0 时归类并保留原始错误

### T37 合并回归 `test:merge24`（V10）
- **优先级**：P0（G5 门禁）
- **目标**：取得第二套完整回归的可核查结果。
- **涉及文件**：`package.json`（只读）；日志 `deploy-merge24.{log,txt}`。
- **前置依赖**：T36。
- **执行要点**：
  1. 执行 `npm run test:merge24`；记录退出码与计数（预期 23 Node + 13/3，以实际为准）。
  2. 该套会写入测试数据到独立库；登记产生的测试数据范围与后续清理条件（按精确 ID/uid）。
  3. 非 0 → 归类并保留原文；不得分段拼接成"一次通过"。
- **验证方式**：单条命令 + 单一退出码 + 完整日志 + 测试数据清单。
- **完成判据**：日志与退出码齐全；测试数据清理条件已登记。
- [ ] 执行 `npm run test:merge24`
- [ ] 记录退出码与计数
- [ ] 登记测试数据范围与清理条件

### T38 独立验收脚本 4/4（V11）
- **优先级**：P0（G4 门禁）
- **目标**：复跑独立验收入口，避免只有历史 4/4、无本轮证据。
- **涉及文件**：`checkout-fixed/docs/review/2026-11-15-identity-guest/acceptance-boundaries.test.cjs`（只读）；日志 `deploy-acceptance.{log,txt}`。
- **前置依赖**：T37。
- **执行要点**：
  1. 在 `checkout-fixed` 根执行 `node --test --test-timeout=5000 --test-reporter=spec docs/review/2026-11-15-identity-guest/acceptance-boundaries.test.cjs`。
  2. 记录 4/4 与退出码；脚本哈希必须仍为 `785BFB7A…`。
  3. 失败 → 记录失败项与断言原文；**不得改断言/改期望**。
- **验证方式**：4/4、退出 0、脚本哈希不变。
- **完成判据**：日志可复核；退出 0 或已如实归类。
- [ ] 执行独立验收脚本并保存日志
- [ ] 核对 4/4 与退出码
- [ ] 核对脚本哈希未变

---

## 阶段 8 · 隔离与修改面证明（T39–T41）

### T39 现有 3307 实例 T1 快照与五件套对照（V16 / G6）
- **优先级**：P0（G6 门禁）
- **目标**：证明本轮所有写入都落在独立库，现有实例与配置零变化。
- **涉及文件**：`snapshots/t1-*.txt`；日志 `deploy-db-guard.{log,txt}`（后段）。
- **前置依赖**：T38。
- **执行要点**：
  1. 按 T05 同口径复采 E1–E4（端口/PID/启动时间、命令行、`.env` SHA-256、数据目录文件数/字节/mtime）。
  2. 产出五件套前后对照表（含 E5"独立实例库清单/23 表/4 房间/测试数据"作为对照）。
  3. 任一项不一致 → **立即停止**并如实报告差异与时间窗口，区分"本轮操作"与"外部正常业务"，**不得**用"可能是正常业务写入"一句话解释掉。
  4. 登记"现有库库清单/关键表行数"为**未验证**（原因：不得读取现有凭证；增强项需用户书面授权）。
- **验证方式**：前后对照差异为零；`.env` 哈希相等；3 个既有 PID 相同。
- **完成判据**：五件套对照表 + 未验证项说明齐全。不一致即停止，不得进入 T40。
- [ ] 复采 E1–E4 并与 T0 对照
- [ ] 产出五件套对照表
- [ ] 登记"现有库行数"为未验证及原因

### T40 修改面核对（V17 / D7）
- **优先级**：P0（G7 支撑）
- **目标**：证明改动只落在允许清单，禁止清单哈希不变。
- **涉及文件**：全部允许清单文件；`snapshots/after/*`；日志 `deploy-surface.{log,txt}`。
- **前置依赖**：T15、T19、T22、T25、T39。
- **执行要点**：
  1. 逐文件输出修改前/后 SHA-256、换行数与"改动意图一句话"（6 个脚本 + 5 个文档 + 新增 2 份交付文档）。
  2. 禁止清单逐项复算哈希，与 T08 对照**全部相等**（`src/**`、`sql/**`、`前端参考/**`、`package.json`、`package-lock.json`、`.gitignore`、`.env`、`test-api-*.js`、`test-all.sh`、`test-chat-companion-repair.test.js`）。
  3. 既有 `docs/review/**`、既有 `docs/codearts_proof/**` 目录清单哈希与 T08 对照一致（新增文件不计入既有集合）。
  4. 记录 `git status --short` 与 `git diff --stat`；声明未提交、未推送。
- **验证方式**：允许清单变化逐项在列；禁止清单无差异；既有证据无覆盖。
- **完成判据**：修改面表 + 禁止清单零差异 + Git 状态声明。出现禁止文件变化 → 回退该文件并报告。
- [ ] 产出允许清单逐文件前后哈希与换行数
- [ ] 复算禁止清单哈希并比对
- [ ] 对照既有证据目录清单哈希
- [ ] 记录 `git status` / `git diff --stat`

### T41 脱敏检索与忽略规则登记（V18）
- **优先级**：P0（G7 支撑）
- **目标**：证明证据文件不含凭证，且"`.log` 不入库"的事实已登记。
- **涉及文件**：`docs/codearts_proof/logs/2026-11-15-deploy-*`（全部）；日志 `deploy-redaction.{log,txt}`。
- **前置依赖**：T40。
- **执行要点**：
  1. 对本轮全部新增证据检索：`password`、`Bearer`、`sk-`（排除 `smoke-reverse` 合成串说明段）、`JWT_SECRET=`、`DEEPSEEK_API_KEY=`、`1[3-9]\d{9}`（白名单 `13800138000`/`123456`）；逐文件给出命中数。
  2. 命中真实值 → 删除该文件并重新生成，记录"已重新生成、旧文件已删除"，不做局部打码。
  3. `git check-ignore -v docs/codearts_proof/logs/2026-11-15-deploy-export.log` → 记录真实输出（应命中 `**/*.log`，第 14 行）。
  4. 登记"本地 `.log` 默认不入库，交付以 `.txt` 副本为准；不改 `.gitignore`、不 `git add -f`"。
- **验证方式**：命中数表；`check-ignore` 输出原文。
- **完成判据**：真实值命中 0；忽略事实已登记；未修改 `.gitignore`。
- [ ] 逐文件脱敏检索并记录命中数
- [ ] 命中即删除重生成
- [ ] 执行 `git check-ignore -v` 并登记
- [ ] 核对 `.gitignore` 哈希未变

---

## 阶段 9 · 文档与收尾（T42–T47）

### T42 编写 `docs/从零安装与部署复现.md`
- **优先级**：P1
- **目标**：让没有上下文的新人按文档独立完成一次安装与启动，且每条命令都能对应本轮真实退出码。
- **涉及文件**：新增 `docs/从零安装与部署复现.md`（固定 8 节）。
- **前置依赖**：T41（需真实命令与退出码）。
- **执行要点**：
  1. 8 节结构：0 适用范围/不适用；1 前置条件（Node≥18、npm、MySQL 8.x 程序、磁盘/网络）；2 隔离目录与独立实例（布局、显式启动命令、四维隔离）；3 依赖安装（`npm ci`、L1/L2 回退、`npm ls` 判据）；4 配置生成（键名清单、必须改写项、Key 留空、指纹）；5 初始化（两次执行、23 表/4 房间、幂等）；6 启动与健康检查（后端命令、`/api/health` 判据、前端命令与端口、哈希一致性）；7 回归与静态检查（四条命令 + `npm test` 前后对比 + 退出码）。
  2. 每条命令附"本轮实际退出码"与日志文件名；未实测步骤标"待验证"。
  3. 明确"8080 可能被占用，以窗口打印的实际端口为准"；不得写"8080 一定可用"。
- **验证方式**：章节齐全；命令与日志索引一一对应；无未标注的确定结论。
- **完成判据**：8 节 + 每条命令的退出码/日志引用 + 未实测标注齐全。
- [ ] 写 §0–§4（范围、前置、实例、依赖、配置）
- [ ] 写 §5–§7（初始化、启动、回归）
- [ ] 每条命令标注退出码与日志文件
- [ ] 未实测步骤标注"待验证"

### T43 修正既有文档的端口、转义与条目索引
- **优先级**：P1
- **目标**：消除会让人"照抄必失败"的文档缺陷（A1–A4/A5），不改历史结论。
- **涉及文件**：`README.md`（L96、L104、L145、L147-166）、`docs/前置安装指南.md`（L196-201、L311-315）、`后端源码/README.md`（L12、L15）、`docs/本地运行说明.md`（仅末尾追加）。
- **前置依赖**：T42。
- **执行要点**：
  1. `README.md` L104：把"浏览器自动打开 `http://localhost:8080`"改为"默认 8080 起，占用则自动顺延，**以窗口打印的实际端口为准**（本机实测为 8081）"。
  2. `docs/前置安装指南.md` L200：示例输出标注"示例"并加实际端口说明；L313-314：`node scripts\fix-duplicate-nick.js` 的 `\f` 被渲染成 `scriptsix` → 改为 `node scripts/fix-duplicate-nick.js`（两行同改）。
  3. `后端源码/README.md` L12/L15：改为"端口由 `.env` 的 `PORT` 决定（默认 3000）"，健康检查同口径。
  4. `README.md` L145：把"`npm test` 仍需修复"补充为"已在本轮修复，判据见 `docs/从零安装与部署复现.md` §7"（保留历史表述，不删除披露）。
  5. `docs/本地运行说明.md`：只在**末尾追加**"本轮结论段"，不改 L72-73 历史基线（"122 通过/5 警告/3 失败"原样保留）。
- **验证方式**：逐条 diff 对照 A1–A4/A5/A6；历史段落字符串未变（`122 通过`、`3 失败` 仍可检索）。
- **完成判据**：5 处文档缺陷全部修正；历史结论段零改动；`docs/交接说明.md` 未改（仅在报告中登记 A8）。
- [ ] 修正 README 端口表述与 `npm test` 判据
- [ ] 修正前置指南示例端口与 `\f` 转义两行
- [ ] 修正后端 README 端口口径
- [ ] 本地运行说明末尾追加（历史段不动）

### T44 在根 README 与 `docs/README.md` 增加索引（D6）
- **优先级**：P1
- **目标**：让新文档可被发现，且不重写历史索引结构。
- **涉及文件**：`README.md`（§八文档索引表）、`docs/README.md`（"使用与部署"表 + "参赛与过程"表）。
- **前置依赖**：T42。
- **执行要点**：
  1. 根 README §八表格新增一行：`docs/从零安装与部署复现.md` → "从零安装、独立测试库、启动与回归的真实命令与退出码"。
  2. `docs/README.md` "使用与部署"表新增同一条；"参赛与过程"表新增 `codearts_proof/2026-11-15-部署复现与交付收尾.md`。
  3. 只加索引行，不重排、不改其它行、不改既有报告结论。
- **验证方式**：diff 行数（新增 ≤4 行）；既有表格行字符串未变。
- **完成判据**：两处索引各至少 1 条新增；无整表重写。
- [ ] 根 README 索引新增 1 行
- [ ] `docs/README.md` 新增 2 行（文档 + 报告）
- [ ] 核对既有表格行未改

### T45 编写过程报告 `docs/codearts_proof/2026-11-15-部署复现与交付收尾.md`
- **优先级**：P1
- **目标**：把本轮全部结论分层归档，任一"通过"都能追溯到日志与退出码。
- **涉及文件**：新增报告；`deploy-index.txt`。
- **前置依赖**：T41、T42。
- **执行要点**：
  1. 固定 12 章：① 基线与 Git；② 环境与版本；③ 安装（L1/L2）；④ 初始化（23 表/4 房间/幂等）；⑤ 启动（后端健康 + 前端哈希 + 端口）；⑥ 回归（4 条命令与退出码）；⑦ 检查器修复前后（before/after、守恒 diff、8 项判定变化、反向验证）；⑧ 零写入校验（五件套前后）；⑨ 修改清单与哈希；⑩ CodeArts 与 Codex 边界（本轮实测 / 历史复验 / 未验证）；⑪ 未验证项与原因；⑫ 复验命令。
  2. 每章结论必须带"日志文件 + `EXIT_CODE`"；历史结论单独成段，标"Codex 历史复验"。
  3. 未验证项至少包含：浏览器端到端（D10）、真实模型、现有库库清单/行数（无凭证）、`install.js` 一键链路、MySQL 8.0.28 下载路径、`check-pages-runtime` 需登录页面（缺演示账号）。
  4. 索引 `deploy-index.txt` 给出"验证项 → 日志文件 → 退出码"映射（V01–V18 全覆盖）。
- **验证方式**：12 章齐全；索引 18 行；任一"通过"可追溯；无"未验证"项被写成通过。
- **完成判据**：报告 + 索引齐全；分层措辞符合 0.6 与设计 2.8.1。
- [ ] 写 ①–⑤（基线、环境、安装、初始化、启动）
- [ ] 写 ⑥–⑧（回归、检查器前后、零写入）
- [ ] 写 ⑨–⑫（修改清单、边界、未验证、复验命令）
- [ ] 生成 V01–V18 → 日志 → 退出码索引

### T46 清理隔离实例与临时资产（保留命令与退出码）
- **优先级**：P1
- **目标**：结束本轮后不留后台进程与临时探测文件，但证据与命令完整保留。
- **涉及文件**：隔离进程（3311 mysqld、隔离后端、8090 前端）；`_deploy_repro\tmp\*`；`checker-probe` 探测文件；日志 `deploy-cleanup.{log,txt}`。
- **前置依赖**：T45。
- **执行要点**：
  1. 记录隔离进程的 PID/端口/命令行，按 PID 停止（**只停本轮进程**），停止后复采端口证明已释放。
  2. 清理 `tmp\` 下的临时 client 配置（若有）与运行登记文件；证明 `checker-probe` 内探测文件不存在（`Test-Path` 为 False）。
  3. 测试数据清理：仅对独立库按精确 ID/uid 删除，记录条件与影响行数；**不执行** `DROP`/`TRUNCATE`。
  4. 保留 `mysql-data-3311` 目录（不删除，便于复验），记录其存在与大小。
  5. **不得**停止 3000/8081/3307；停止动作后再复采一次，证明三者 PID 未变。
- **验证方式**：端口释放证明 + 进程清理清单 + 探测文件不存在 + 既有实例不变。
- **完成判据**：清理日志含全部停止命令与退出码；无遗留探测文件；既有实例未被触碰。
- [ ] 按 PID 停止隔离 3311/后端/8090 并证明端口释放
- [ ] 清理 `tmp\` 与探测文件并证明不存在
- [ ] 按精确 ID 清理独立库测试数据并记录影响行数
- [ ] 复采 3000/8081/3307 证明未变

### T47 最终门禁复核与交回清单
- **优先级**：P1（G7 门禁）
- **目标**：用一张清单把"修改、命令、退出码、未验证、Git"五类信息交回，判定本轮是否可宣告完成。
- **涉及文件**：报告末尾"交回清单"章；`docs/codearts_proof/logs/2026-11-15-deploy-index.txt`。
- **前置依赖**：T46。
- **执行要点**：
  1. 逐条复核 G1–G7；未通过项写"未通过"并给出跟进措施，不得留空。
  2. 交回清单五类：修改（路径/前/后 SHA-256/换行数/意图）、命令（原文 + 工作目录）、退出码（`EXIT_CODE` + 判定）、未验证（项/原因/已尝试命令）、Git（HEAD/`git status --short`/未跟踪清单/"未提交未推送"）。
  3. 声明"不提交、不推送、未改业务功能、未打印凭证、未覆盖既有证据、已清理实例"。
  4. 复核"不算完成"清单（附录 D），逐条自检并记录"未触犯"。
- **验证方式**：五类信息齐全；门禁表 7 行有结论；不算完成 13 条自检有记录。
- **完成判据**：清单可直接复核；任一缺项标"缺失"而非留空。
- [ ] 复核 G1–G7 并记录结论
- [ ] 输出五类交回清单
- [ ] 自检"不算完成"13 条

---

## 附录 A · 验证项 V01–V18 落点

| 编号 | 验证项 | 落点任务 | 证据日志 |
|---|---|---|---|
| V01 | 隔离目录导出 | T03、T04 | `deploy-export` |
| V02 | Node/MySQL 版本 | T07 | `deploy-version` |
| V03 | 依赖安装 | T26 | `deploy-install` |
| V04 | 隔离 `.env` | T27 | `deploy-env` |
| V05 | 独立库初始化（实例 + 两次建表） | T28、T29 | `deploy-db-init`、`deploy-ports` |
| V06 | 后端健康 | T31 | `deploy-backend` |
| V07 | 前端静态一致性 | T32 | `deploy-frontend` |
| V08 | 单文件回归 68/68 | T35 | `deploy-unit` |
| V09 | `test:competition` | T36 | `deploy-competition` |
| V10 | `test:merge24` | T37 | `deploy-merge24` |
| V11 | 独立验收脚本 4/4 | T38 | `deploy-acceptance` |
| V12 | `npm test` 修复前 | T09、T10 | `deploy-smoke-before` |
| V13 | `npm test` 修复后 + 守恒 | T14 | `deploy-smoke-after` |
| V14 | 合成 `sk-` 反向验证 | T15 | `deploy-smoke-reverse` |
| V15 | 端口与归属（前/后段） | T30、T34、T25 | `deploy-ports`、`deploy-install` |
| V16 | 现有库零写入五件套 | T05（前）、T39（后） | `deploy-db-guard` |
| V17 | 修改面 | T40 | `deploy-surface` |
| V18 | 脱敏与忽略规则 | T41 | `deploy-redaction` |

## 附录 B · 关键命令清单（可直接复制，均需记录退出码）

```bash
# 0) 基线
git -C "D:\微光同行\Glimmer" rev-parse HEAD
git -C "D:\微光同行\Glimmer" status --short

# 1) 导出基线副本（V01）
git -C "D:\微光同行\Glimmer" archive --format=tar 2112271db26b34a557719afc60a77b91557ee624 > D:\微光同行\_deploy_repro\base.tar
tar -x -f D:\微光同行\_deploy_repro\base.tar -C D:\微光同行\_deploy_repro\checkout-2112271

# 2) 修复前 npm test（V12）
cd /d D:\微光同行\_deploy_repro\checkout-2112271\后端源码 && npm test

# 3) 修复后 npm test（V13）
cd /d D:\微光同行\_deploy_repro\checkout-fixed\后端源码 && npm test

# 4) 依赖（V03）
cd /d D:\微光同行\_deploy_repro\checkout-fixed\后端源码 && npm ci
npm ls --depth=0

# 5) 初始化独立实例（V05-a）
D:\mysql\bin\mysqld.exe --initialize-insecure --no-defaults --basedir=D:/mysql --datadir=D:\微光同行\_deploy_repro\mysql-data-3311
D:\mysql\bin\mysqld.exe --no-defaults --basedir=D:/mysql --datadir=D:\微光同行\_deploy_repro\mysql-data-3311 --port=3311 --bind-address=127.0.0.1 --mysqlx=OFF --console

# 6) 建库建表两次（V05-b）
cd /d D:\微光同行\_deploy_repro\checkout-fixed\后端源码 && node scripts/init-db.js
node scripts/init-db.js

# 7) 后端与健康（V06）
cd /d D:\微光同行\_deploy_repro\checkout-fixed\后端源码 && node src/app.js
curl http://127.0.0.1:<隔离PORT>/api/health

# 8) 前端 8090 与代理（V07）
cd /d D:\微光同行\_deploy_repro\checkout-fixed && node setup/start.js --port 8090 --no-open --mysqld=D:\mysql\bin\mysqld.exe
curl http://127.0.0.1:<实际前端端口>/api/health

# 9) 四条回归（V08–V11）
cd /d D:\微光同行\_deploy_repro\checkout-fixed\后端源码
node --test --test-timeout=5000 --test-reporter=spec scripts/test-chat-companion-repair.test.js
npm run test:competition
npm run test:merge24
cd /d D:\微光同行\_deploy_repro\checkout-fixed
node --test --test-timeout=5000 --test-reporter=spec docs/review/2026-11-15-identity-guest/acceptance-boundaries.test.cjs

# 10) P1 检查器（T33）
cd /d D:\微光同行\_deploy_repro\checkout-fixed\后端源码
node scripts/check-frontend.js --frontend=../前端参考
node scripts/check-pages-runtime.js --frontend=../前端参考 --base=http://127.0.0.1:<隔离PORT>

# 11) 反向验证（V14，仅 probe）
cd /d D:\微光同行\_deploy_repro\checker-probe
node scripts/smoke-test.js --frontend=<probe 前端目录>

# 12) 端口与忽略规则（V15/V18）
netstat -ano | findstr ":3311"
git -C "D:\微光同行\Glimmer" check-ignore -v docs/codearts_proof/logs/2026-11-15-deploy-export.log
```

## 附录 C · 过程报告固定章节（12 章，不得增减）

1. 基线与 Git（HEAD/状态/关键哈希）｜2. 环境与版本（Node/npm/mysqld）｜3. 安装（`npm ci` 与 L1/L2）｜4. 初始化（23 表/4 房间/幂等）｜5. 启动（后端健康 + 前端哈希 + 端口）｜6. 回归（4 条命令与退出码）｜7. 检查器修复前后（守恒 diff + 8 项变化 + 反向验证）｜8. 零写入校验（五件套前后）｜9. 修改清单与哈希｜10. CodeArts 与 Codex 边界｜11. 未验证项与原因｜12. 复验命令。

## 附录 D · "不算完成"（判定红线，T47 逐条自检）

| 编号 | 不算完成的做法 | 对应任务自检 |
|---|---|---|
| N-1 | 删除检查项、注释断言、合并检查项以减少失败 | T14、T22 |
| N-2 | 放宽断言（缩短 `sk-` 正则、收窄扫描范围、目录存在性改恒真） | T14、T15、T22 |
| N-3 | 把 SKIP 计 PASS，或把"跳过"写成"全部通过" | T13、T14 |
| N-4 | 复用现有 `node_modules`、软链依赖、复用现有库冒充"从零安装" | T26、T27 |
| N-5 | 改业务功能（`src/**`、`sql/**`、`前端参考/**`）让回归变绿 | T40 |
| N-6 | 日志/报告出现凭证、token、真实手机号 | T41 |
| N-7 | 把环境阻塞写成"通过"，或用历史结果冒充本轮 | T36、T37、T45 |
| N-8 | 分段运行后拼接成"一次完整回归通过" | T36、T37 |
| N-9 | 用静态推断代替真实执行 | T09、T31、T35 |
| N-10 | 对现有库任何写入，或用"可能是正常业务写入"解释差异 | T39 |
| N-11 | 改 `.gitignore` / `package.json` 脚本"解决"证据或门禁问题 | T40、T41 |
| N-12 | 停止/重启现有 3000/8081/3307 | T34、T46 |
| N-13 | 在现有工作区放入合成 `sk-` 串 | T15 |

## 附录 E · 仍需用户确认的事项

| # | 事项 | 当前默认（未确认则按此执行） | 影响任务 |
|---|---|---|---|
| 1 | 现有库"库清单/关键表行数"增强验证是否授权（需临时 client 配置读取现有凭证） | **不执行**，报告中标"未验证（不得读取现有凭证）" | T39 |
| 2 | 隔离实例与前端端口冲突时的顺延上限 | 3311 与 8090 各最多 +10，逐次记录；不 kill 占用进程 | T28、T32 |
| 3 | 是否允许在独立实例上由 `start.js` 触发 `migrate.js` 产生 `ALTER`（仅独立库） | 允许（仅独立库），日志单独标注；现有库仍绝对禁止 | T32、T39 |
| 4 | `mysql-data-3311` 目录清理粒度 | **保留不删**（便于复验），仅停止进程；不 `DROP` 数据库 | T46 |
| 5 | `.txt` 日志副本是否需纳入 Git（本轮不提交） | 仅落盘，不 `git add`、不改 `.gitignore` | T41、T47 |
| 6 | `checker-probe` 目录是否保留 | 保留目录，仅删除探测文件并给出不存在证明 | T15、T46 |

---

**任务规划结束。**