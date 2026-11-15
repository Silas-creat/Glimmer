# 安装与启动脚本

在仓库根目录运行这些命令。`一键安装.bat` 与 `一键启动.bat` 分别调用本目录的 `install.js` 和 `start.js`。

| 文件 | 作用 |
|---|---|
| `install.js` | 检查环境、准备独立 MySQL、生成配置、初始化数据库 |
| `start.js` | 按配置启动已初始化的 MySQL、后端、前端静态服务与 API 代理 |
| `install.test.js` | 安装器的实例识别、认证与只读边界测试 |
| `start.test.js` | 启动器的端口、配置、代理及失败处理测试 |

## 使用顺序

1. 先运行 `node setup/install.js --check` 做只读环境检查。
2. 首次安装运行 `node setup/install.js`，或使用根目录的 `一键安装.bat`。
3. 已有 `.env` 时再次运行默认安装命令会保留原配置并退出；需要按该配置建表或迁移时，显式运行 `node setup/install.js --use-existing`。此命令会写入指定数据库的表结构与基础群聊房间，但不修改认证、不重写 `.env`、不重建演示聊天。
4. 安装完成后运行 `node setup/start.js --no-open --port 8081`，或双击 `一键启动.bat`。

前端默认从 8080 尝试监听，`--port` 可指定起点；前端端口被占用时自动顺延。后端端口以 `后端源码/.env` 的 `PORT` 为准；被占用时拒绝继续，需先核对已有进程的归属。正常 Ctrl+C 停止本次创建的前后端，MySQL 保持运行。

完整的独立环境操作与证据边界见 [从零安装与部署复现](../docs/guides/从零安装与部署复现.md)。不要将示例命令的端口或数据目录直接指向已有实例。

## 新实例与已有实例

首次安装默认寻找空闲端口和不存在的数据目录。要指定安装位置和端口，可在 PowerShell 中设置：

```powershell
$env:MYSQL_BASEDIR = 'D:/mysql' # 该目录下应有 bin/mysqld.exe
$env:MYSQL_DATA_DIR = 'D:/glimmer-local/mysql-data-new' # 必须尚不存在
node setup/install.js --private-port 3310
```

指定端口被占用或指定数据目录已存在时立即拒绝，不尝试密码。新实例的 UUID 与本次目录 `auto.cnf` 核对后，才设置初始随机密码。`MYSQL_INSTANCE_UUID` 会写入新 `.env`；之后 `--use-existing` 会核对它。手工配置已有数据库时，安装器仅使用指定账号，不猜测或重置密码；可在配置中加入已由管理员核实的 UUID。

未找到 MySQL 时会停止并说明配置方式。Windows 默认下载路径需显式使用 `--download`；本轮实际测试使用预装 MySQL 8.4.13，没有验证 8.0.28 下载解压。`--force-private` 只用于无 `.env` 的独立副本，不能绕过已有配置保护。

安装失败会停止本轮创建的实例并保留数据目录、已生成的配置供恢复，避免自动删除或重置。`--check` 不连接数据库，因此只读检查通过不代表认证有效。系统环境变量优先于已有 `.env`，执行 `--use-existing` 前应确认没有遗留的 `DB_*` 覆盖值。

安装器不再自动运行 `seed-demo.js`，因为它会重建部分聊天内容。需要演示数据时，仅在可丢弃的演示库中手动运行；普通首次登录仍可使用配置中的开发验证码创建账号。

## 代码验证

在后端安装依赖后，从仓库根目录运行：

```bash
node --test setup/install.test.js setup/start.test.js 后端源码/scripts/test-deploy-checkers.test.js
```

静态检查与业务回归在后端目录运行：

```bash
cd 后端源码
npm test
npm run test:engineering
node scripts/check-frontend.js
npm run test:competition
npm run test:merge24
```

两套完整业务回归会连接 `.env` 配置的数据库，只在独立测试库执行。页面运行时检查使用假 DOM，必须显式指定隔离后端和合成账号，它不能替代真实浏览器验收。
