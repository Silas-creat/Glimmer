#!/usr/bin/env bash
# ============================================================
# ⚠️ **已废弃（2026-11-03）**
# 这份文档/脚本是"虚拟机时代"的产物：当时 MySQL 和后端都跑在 VMware 里。
# 现在数据库已搬到本机（`D:\mysql`），后端直接在本机 `node src/app.js`。
# 里面的 `ssh`、`systemctl`、`127.0.0.1` 等命令**现在都不能用了**，
# 当前正确的操作方式看：`论文版-启动说明.md`。
# ============================================================

# ============================================================
#  端到端验收（自动转发到虚拟机上跑）
#
#  用法：  bash scripts/verify-all.sh
#
#  ★ 为什么要转发 ★
#    verify-all.js 收尾时要用 mysql2 直连数据库清理它造的测试数据，
#    而 Windows 上没有 node_modules（依赖都装在虚拟机上）。
#    所以不能在本机跑，得 ssh 过去跑。
#
#    （这和 test-all.sh 里的 run_on_vm 是同一个道理。）
# ============================================================
set -uo pipefail

VM_HOST=""   # 已改为本地执行，这个变量不再使用
VM_SERVER_DIR="~/server"
BASE="${BASE:-http://127.0.0.1:3000}"

echo "正在同步代码到虚拟机…"

# 同步后端代码和脚本
#
# ★ 注意：这里只列【本地确实存在】的路径 ★
#   我第一版把 package-lock.json 也写进去了，但本地并没有这个文件
#   （它是 npm install 时在虚拟机上生成的），
#   于是 tar 报错退出非 0，整个同步被判成失败。
#   不要打包不确定存在的文件。
tar czf - scripts src sql package.json 2>/dev/null \
  | ssh -o BatchMode=yes "$VM_HOST" "tar xzf - -C $VM_SERVER_DIR" || {
    echo "❌ 同步失败，检查一下 ssh 是否可用：$VM_HOST"
    exit 1
  }

echo "开始在虚拟机上验收…"
echo ""

ssh -o BatchMode=yes "$VM_HOST" "cd $VM_SERVER_DIR && node scripts/verify-all.js $BASE"
EXIT_CODE=$?

echo ""
echo "=============================================="
if [ $EXIT_CODE -eq 0 ]; then
  echo "  ✅ 验收通过"
  echo ""
  echo "  顺手把临时测试账号也清掉（建议每次都做）："
  ssh -o BatchMode=yes "$VM_HOST" "cd $VM_SERVER_DIR && node scripts/fix-test-account.js" 2>/dev/null \
    | grep -E "删除了|清理后|id=" || true
else
  echo "  ❌ 验收发现问题，见上面的输出"
fi
echo "=============================================="

exit $EXIT_CODE
