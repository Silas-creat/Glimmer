#!/usr/bin/env bash
# ============================================================
# ⚠️ **已废弃（2026-11-03）**
# 这份文档/脚本是"虚拟机时代"的产物：当时 MySQL 和后端都跑在 VMware 里。
# 现在数据库已搬到本机（`D:\mysql`），后端直接在本机 `node src/app.js`。
# 里面的 `ssh`、`systemctl`、`127.0.0.1` 等命令**现在都不能用了**，
# 当前正确的操作方式看：`论文版-启动说明.md`。
# ============================================================

# ============================================================
#  一键部署：装 Node + MySQL，建库，装依赖，启动服务
#
#  在虚拟机里执行：  bash ~/server/scripts/deploy.sh
#
#  这个脚本可以重复执行（幂等）：装过的会跳过，不会重复搞坏环境。
# ============================================================
set -uo pipefail

SUDO_PASS='123456xx'
DB_PASS='123456xx'
APP_DIR="$HOME/server"
PORT=3000

sudo_run() { printf '%s\n' "$SUDO_PASS" | sudo -S -p '' "$@"; }

step() { echo ""; echo "=============================================="; echo "  $*"; echo "=============================================="; }

# ============================================================
#  识别发行版和包管理器
#  这套脚本本来是在 Ubuntu 上写的，但既然写成"一键部署"，
#  就不该只认 apt。这里做个探测，两个家族都能走。
# ============================================================
if command -v apt-get >/dev/null 2>&1; then
  PKG="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG="yum"
else
  echo "❌ 认不出包管理器（既没有 apt-get，也没有 dnf/yum）"
  echo "   请手动安装 Node.js 18+ 和 MySQL 8 后再跑。"
  exit 1
fi
echo "检测到包管理器: $PKG"

# ============================================================
step "[1/8] 检查 sudo 权限"
# ============================================================
if ! sudo_run true 2>/dev/null; then
  echo "❌ sudo 密码不对，无法继续。请检查脚本里的 SUDO_PASS。"
  exit 1
fi
echo "✅ sudo 可用"

# ============================================================
step "[2/8] 安装 Node.js"
# ============================================================
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  echo "已装 Node $(node -v)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "版本低于 18，需要升级。请手动安装 Node 20 后再来。"
    exit 1
  fi
  echo "✅ 版本满足要求（需要 18+）"
else
  echo "正在安装 nodejs + npm ..."

  if [ "$PKG" = "apt" ]; then
    # 先更新索引（apt 索引过期会导致 404）
    sudo_run apt-get update -qq 2>&1 | tail -3
    sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm 2>&1 | tail -5
  else
    # RHEL 家族：自带的 nodejs 版本可能太老，用 NodeSource 官方源
    if [ "$PKG" = "dnf" ]; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo_run bash -
      sudo_run dnf install -y nodejs 2>&1 | tail -5
    else
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo_run bash -
      sudo_run yum install -y nodejs 2>&1 | tail -5
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    echo "✅ Node.js 安装完成: $(node -v) / npm $(npm -v)"
  else
    echo "❌ Node.js 安装失败"
    exit 1
  fi
fi

# ============================================================
step "[3/8] 安装 MySQL Server 8"
# ============================================================
if command -v mysqld >/dev/null 2>&1 || [ -f /usr/sbin/mysqld ]; then
  echo "✅ MySQL 已安装: $(mysqld --version 2>/dev/null | head -1)"
else
  echo "开始安装 MySQL Server ..."

  if [ "$PKG" = "apt" ]; then
    # MySQL 8 安装时默认会弹密码输入框，非交互环境下会卡死。
    # 用 debconf-set-selections 提前把答案写好就能全自动安装。
    # ★ 注意：密码值必须用双引号包起来，否则报 "parse error on line 1"。
    echo "  预置 debconf，避免安装过程弹出交互式密码框 ..."
    sudo_run debconf-set-selections <<DEBCONF
mysql-server mysql-server/root_password password "${DB_PASS}"
mysql-server mysql-server/root_password_again password "${DB_PASS}"
DEBCONF
    sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mysql-server 2>&1 | tail -8
  else
    # RHEL 家族自带的是 MariaDB，和 MySQL 8 高度兼容，够用
    echo "  RHEL 家族，安装 mariadb-server ..."
    if [ "$PKG" = "dnf" ]; then
      sudo_run dnf install -y mariadb-server mariadb 2>&1 | tail -5
    else
      sudo_run yum install -y mariadb-server mariadb 2>&1 | tail -5
    fi
  fi

  if [ -f /usr/sbin/mysqld ]; then
    echo "✅ MySQL 安装完成: $(mysqld --version 2>/dev/null | head -1)"
  else
    echo "❌ MySQL 安装失败"
    exit 1
  fi
fi

# ============================================================
step "[4/8] 启动 MySQL 服务"
# ============================================================
sudo_run systemctl enable mysql >/dev/null 2>&1 || true
sudo_run systemctl start mysql 2>/dev/null || true
sleep 3
if systemctl is-active --quiet mysql; then
  echo "✅ MySQL 正在运行，已设开机自启"
else
  echo "⚠️  mysql 服务没起来，尝试查看原因："
  sudo_run systemctl status mysql --no-pager -l 2>&1 | tail -15
  exit 1
fi

# ============================================================
step "[5/8] 配置数据库权限"
# ============================================================
# 背景知识（很重要，不然一定会踩）：
#   Ubuntu 装的 MySQL 8 把 root@localhost 默认设成 auth_socket 插件，
#   意思是"只有系统 root 身份能免密登录"，根本没有密码。
#   后端用 mysql2 走 TCP + 密码，所以必然 Access denied。
#   必须把插件改成 mysql_native_password 并设上密码。
#
#   另外：连 127.0.0.1 时 MySQL 会把地址反解成 'localhost' 去匹配用户表，
#   所以只需要改 root@localhost，不用单独建 root@127.0.0.1。
#
# ★ 这里必须用 heredoc 把 SQL 管道喂给 mysql。
#   如果用 sudo_run mysql -uroot -e "长长的SQL"，引号会被拆坏，
#   报莫名其妙的 "parse error"。
if sudo_run mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
  echo "  检测到 root 免密登录（auth_socket），正在改成密码登录 ..."
  sudo_run mysql -uroot <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${DB_PASS}';
FLUSH PRIVILEGES;
SQL
  if [ $? -eq 0 ]; then
    echo "  ✅ 已设置 root 密码并切换到密码认证"
  else
    echo "  ⚠️  设置密码失败，请手动处理（见 README 排查章节）"
  fi
elif mysql -uroot -p"$DB_PASS" -e "SELECT 1" >/dev/null 2>&1; then
  echo "  ✅ root 已经是密码登录，跳过"
else
  echo "⚠️  无法用已知方式登录 MySQL。"
  echo "    你可以在虚拟机里手动执行："
  echo "      sudo mysql -uroot"
  echo "      ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${DB_PASS}';"
  echo "      FLUSH PRIVILEGES;"
fi

# 验证 TCP 连接（这才是后端真正用的方式）
# ★ 注意 if 判定的是整条管道，mysql 失败时 grep 也可能"成功"，
#   所以这里先把 VERSION() 抓出来，再判断内容是否非空。
DB_VER=$(mysql -h127.0.0.1 -P3306 -uroot -p"$DB_PASS" -N -B -e "SELECT VERSION()" 2>/dev/null)
if [ -n "$DB_VER" ]; then
  echo "✅ TCP 方式连接 MySQL 成功（版本 $DB_VER）"
else
  echo "❌ TCP 方式连不上 MySQL，后端一定起不来！"
  echo "   bind-address 当前配置："
  grep -E "^\s*bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf 2>/dev/null | sed 's/^/     /'
  echo "   应该是 127.0.0.1 或 0.0.0.0。"
  exit 1
fi

# ============================================================
step "[6/8] 写入后端配置文件"
# ============================================================
cd "$APP_DIR" || { echo "❌ 找不到 $APP_DIR"; exit 1; }

# 生成随机 JWT 密钥
JWT=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c 48)

cat > .env <<ENV
# ==== 由 scripts/deploy.sh 自动生成 ====
HOST=0.0.0.0
PORT=${PORT}
NODE_ENV=development

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=${DB_PASS}
DB_NAME=peizhe

JWT_SECRET=${JWT}
JWT_EXPIRES_IN=30d

DEEPSEEK_API_KEY=
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_MODEL=deepseek-chat

DEV_SMS_CODE=123456
SMS_ENABLED=false
ENV

chmod 600 .env
echo "✅ 已生成 .env（权限 600，只有你能读）"
echo "   JWT_SECRET 已随机生成"
echo "   注意：DEEPSEEK_API_KEY 还是空的，第 3 步做 AI 聊天时再填"

# ============================================================
step "[7/8] 安装 npm 依赖"
# ============================================================
cd "$APP_DIR"
# 用国内镜像，不然会很慢
npm config set registry https://registry.npmmirror.com >/dev/null 2>&1
echo "npm 源: $(npm config get registry)"
echo ""
if npm install --no-audit --no-fund 2>&1 | tail -12; then
  echo ""
  echo "✅ 依赖安装完成"
else
  echo "❌ 依赖安装失败"
  exit 1
fi

# ============================================================
step "[8/8] 建库建表 + 启动服务"
# ============================================================
cd "$APP_DIR"
if ! npm run initdb 2>&1 | tail -25; then
  echo "❌ 建库失败"
  exit 1
fi

# ---- 注册为 systemd 服务，开机自启、崩溃自动重启 ----
echo ""
echo "注册 systemd 服务（开机自启）..."
NODE_BIN=$(command -v node)

# ★ 重要坑位说明 ★
# 千万不要写成  sudo_run tee /etc/systemd/system/peizhe.service <<SERVICE
# 因为 sudo -S 要从 stdin 读密码，heredoc 也走 stdin，两者会互抢，
# 结果是密码被写进文件、service 内容丢失，systemd 报
# "Assignment outside of section"。
# 正确做法：先用普通权限把内容写到临时文件，再让 sudo 只做一次 cp
# （内容走参数，stdin 完整留给密码）。
TMPFILE=$(mktemp /tmp/peizhe.service.XXXXXX)
cat > "$TMPFILE" <<SERVICE
[Unit]
Description=Peizhe Backend
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/app.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/peizhe.log
StandardError=append:/var/log/peizhe.log

[Install]
WantedBy=multi-user.target
SERVICE

# 写进去之前先校验，避免带着坏文件往下跑
if ! grep -q "ExecStart=" "$TMPFILE"; then
  echo "❌ service 文件生成异常（没有 ExecStart），跳过服务注册。"
  rm -f "$TMPFILE"
else
  sudo_run cp "$TMPFILE" /etc/systemd/system/peizhe.service
  sudo_run chmod 644 /etc/systemd/system/peizhe.service
  rm -f "$TMPFILE"

  # 再校验落地后的真实内容
  if grep -q "ExecStart=" /etc/systemd/system/peizhe.service; then
    sudo_run touch /var/log/peizhe.log
    sudo_run chown "$(whoami):$(whoami)" /var/log/peizhe.log
    sudo_run systemctl daemon-reload
    sudo_run systemctl enable peizhe >/dev/null 2>&1
    sudo_run systemctl restart peizhe
    sleep 5
    if systemctl is-active --quiet peizhe; then
      echo "✅ 后端服务已启动并设为开机自启（systemd: peizhe）"
    else
      echo "⚠️  服务没起来，日志如下："
      sudo_run journalctl -u peizhe --no-pager -n 20 2>&1 | tail -20
    fi
  else
    echo "❌ 落地后的 service 文件异常，跳过服务注册。"
  fi
fi

# ============================================================
echo ""
echo "=============================================="
echo "  ✅ 部署完成"
echo "=============================================="
echo ""
echo "  验证服务："
echo "    curl http://127.0.0.1:${PORT}/api/health"
echo ""
echo "  从 Windows 浏览器打开："
echo "    http://127.0.0.1:${PORT}/api/health"
echo ""
echo "  查看日志："
echo "    tail -f /var/log/peizhe.log"
echo "    或 journalctl -u peizhe -f"
echo ""
echo "  管理服务："
echo "    sudo systemctl restart peizhe    重启"
echo "    sudo systemctl stop peizhe       停止"
echo "    sudo systemctl status peizhe     状态"
echo ""
