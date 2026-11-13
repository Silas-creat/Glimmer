#!/usr/bin/env bash
# ============================================================
#  一键跑完所有测试
#
#  用法：  bash scripts/test-all.sh
#          bash scripts/test-all.sh http://127.0.0.1:3000
#
#  一共二十六关，从"代码本身"到"真机跑通"层层递进：
#    1. 静态自检        —— 文件、SQL、配置、路由挂载、安全红线（不需要后端）
#    2. 前端检查        —— HTML 里的 JS 语法、API 调用是否合法（不需要后端）
#    3. 工具函数单测    —— 星座/省份/年龄段推算（不需要后端）
#    4. 内容检测单测    —— 违规词/刷屏/危机信号（不需要后端）
#    5. 机器人单测      —— 违规分级尺度（不需要后端）
#    5.5 AI 记忆单测    —— 摘要/去重/长度上限（不需要后端，也不需要 API Key）
#    6. 测试自身检查    —— 断言写法有没有写错（不需要后端）
#    7. 登录接口
#    8. 日记接口
#    9. 互动接口
#   10. 资料接口
#   11. 评论接口
#   12. 祝福接口
#   13. 漂流瓶接口（需数据库，转发到虚拟机）
#   14. 群聊接口（需数据库，转发到虚拟机）
#   15. 私信接口（需数据库，转发到虚拟机）
#   16. 发现页推荐流（需数据库，转发到虚拟机）
#   17. AI 聊天 + 记忆（需数据库；没配 Key 也能跑，走体验版陪伴者）
#   18-25. 前端 api.js 契约（日记/互动/资料/评论/祝福/漂流瓶/私信/发现/AI）
# ============================================================
set -uo pipefail

BASE="${1:-http://127.0.0.1:3000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

PASSED=0
FAILED=0
FAILED_NAMES=()

run_stage() {
  local num="$1"; shift
  local name="$1"; shift

  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  printf "║  第 %s 关：%-46s║\n" "$num" "$name"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""

  if "$@"; then
    echo ""
    echo "  ✅ 第 $num 关通过：$name"
    PASSED=$((PASSED+1))
  else
    echo ""
    echo "  ❌ 第 $num 关失败：$name"
    FAILED=$((FAILED+1))
    FAILED_NAMES+=("第${num}关 $name")
  fi
}

# ============================================================
#  需要直连数据库的测试：本地直接跑（数据库已搬到本机）
#
#  背景：漂流瓶的测试要用 mysql2 造一批瓶子（因为扔瓶子有 20 秒频控），
#        而 Windows 本机连不上虚拟机里只监听 127.0.0.1 的 MySQL。
#        所以这类测试必须在虚拟机上执行。
#
#  这个函数做三件事：
#    1. 把后端的 scripts/ 和前端目录同步到虚拟机
#    2. 通过 ssh 在虚拟机里跑那个测试
#    3. 把退出码原样传回来（run_stage 据此判断成败）
# ============================================================
VM_HOST=""   # 已改为本地执行，这个变量不再使用
VM_SERVER_DIR="~/server"
VM_FRONTEND_DIR="~/frontend"

run_on_vm() {
  local test_script="$1"
  local extra_env="$2"

  # ★ 2026-11-02 改动：数据库已经搬到本机 D:\mysql，不再需要 ssh 到虚拟机 ★
  #   原来的实现是"同步代码到虚拟机 → ssh 执行 → 回传退出码"，
  #   现在直接本地执行。想跑回虚拟机版本，把这段换回 git 里的旧实现即可。
  env $extra_env node "scripts/$test_script" "$BASE"
  return $?
}

echo ""
echo "=============================================================="
echo "  「陪着」后端 · 全量测试"
echo "  目标: $BASE"
echo "  目录: $DIR"
echo "=============================================================="

# ---- 第 1 关：静态自检（不需要后端）----
run_stage 1 "静态自检（文件/SQL/配置/路由挂载）" node scripts/smoke-test.js

# ---- 第 2 关：前端 HTML 检查（不需要后端）----
run_stage 2 "前端 HTML 与 API 调用检查" node scripts/check-frontend.js

# ---- 第 3 关：工具函数单测（不需要后端）----
run_stage 3 "工具函数单测（星座/省份/年龄段）" node scripts/test-zodiac.js

# ---- 第 4 关：内容检测单测（不需要后端）----
run_stage 4 "内容检测单测（违规词/刷屏/危机信号）" node scripts/test-moderation.js

# ---- 第 5 关：违规检测机器人单测（不需要后端）----
run_stage 5 "机器人单测（违规分级 + 危机信号保护）" node scripts/test-chatbot.js

# ---- 第 5.5 关：AI 记忆逻辑单测（不需要后端，也不需要 API Key）----
# ★ 注意：这个要转发到虚拟机跑 ★
#   它 import 了 src/utils/llm.js，而 llm.js 会 import config，
#   config 又依赖 dotenv 包。Windows 上没有 node_modules，
#   所以在本地跑会报 ERR_MODULE_NOT_FOUND。
#   （这个测试本身不需要数据库，只是需要能加载依赖。）
run_stage 5.5 "AI 记忆单测（摘要/去重/长度上限）" \
  run_on_vm test-ai-memory.js ""

# ---- 第 6 关：测试自身检查（不需要后端）----
run_stage 6 "测试脚本自身检查（断言写法）" node scripts/check-tests.js

# ---- 后端服务在线检查 ----
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  检查后端服务是否在线                                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
if curl -s -m 8 "$BASE/api/health" | grep -q '"connected":true'; then
  echo "  ✅ 后端在线，MySQL 已连接"
  ONLINE=1
else
  echo "  ❌ 后端不在线或数据库未连接：$BASE"
  echo "     启动方法："
  echo "       启动后端：cd server && node src/app.js"
  echo "       sudo systemctl start peizhe"
  echo ""
  ONLINE=0
fi

if [ "$ONLINE" -eq 1 ]; then
  # ---- 第 7 关：登录 ----
  run_stage 7 "登录接口测试（验证码/token/自动注册）" node scripts/test-login.js "$BASE"

  # ---- 第 8 关：日记接口 ----
  run_stage 8 "日记接口测试（CRUD + 隐私权限）" node scripts/test-diary.js "$BASE"

  # ---- 第 9 关：互动接口 ----
  run_stage 9 "互动接口测试（点赞/收藏/关注）" node scripts/test-interact.js "$BASE"

  # ---- 第 10 关：资料接口 ----
  run_stage 10 "资料接口测试（改资料/自动推导/头像）" node scripts/test-profile.js "$BASE"

  # ---- 第 11 关：评论接口 ----
  run_stage 11 "评论接口测试（两级/权限/级联删除/检测）" node scripts/test-comment.js "$BASE"

  # ---- 第 12 关：祝福接口 ----
  run_stage 12 "祝福接口测试（按昵称找人/收发/已读/撤回）" node scripts/test-bless.js "$BASE"

  # ---- 第 13 关：漂流瓶接口 ----
  # ★ 需要 mysql2 直连数据库（扔瓶子有 20 秒频控，造数据只能走数据库），
  #   所以自动转发到虚拟机上跑。
  run_stage 13 "漂流瓶接口测试（扔/捞/不重复捞/匿名/收回）" \
    run_on_vm test-bottle.js ""

  # ---- 第 14 关：群聊接口 ----
  # ★ 同样需要数据库：清理测试消息时要用 SQL 直连删除
  run_stage 14 "群聊接口测试（4房间/机器人分级/危机信号）" \
    run_on_vm test-group.js ""

  # ---- 第 15 关：私信接口 ----
  # ★ 需要数据库：一是造数据，二是"秒级时间截断"这类问题只有
  #   直连数据库才能看清（这个测试帮忙抓到了两个真 bug）
  run_stage 15 "私信接口测试（会话归一/未读/拉黑/拦截留痕）" \
    run_on_vm test-message.js ""

  # ---- 第 16 关：发现页推荐流 ----
  run_stage 16 "发现页推荐流测试（随机/分页稳定/不推私密）" \
    run_on_vm test-discover.js ""

  # ---- 第 17 关：AI 聊天 + 记忆 ----
  # ★ 没配 API Key 也能跑：后端会降级到内置的体验版陪伴者，
  #   所以"记录落库 / 换设备续聊 / 长期记忆 / 删记忆"全都能验。
  run_stage 17 "AI 聊天测试（记录落库/换设备续聊/长期记忆）" \
    run_on_vm test-ai.js ""

  # ---- 第 18~23 关：前端 api.js 契约 ----
  run_stage 18 "前端 api.js 契约（日记）" node scripts/test-api-client.js "$BASE"
  run_stage 19 "前端 api.js 契约（互动）" node scripts/test-api-interact.js "$BASE"
  run_stage 20 "前端 api.js 契约（资料 + 头像）" node scripts/test-api-profile.js "$BASE"
  run_stage 21 "前端 api.js 契约（评论）" node scripts/test-api-comment.js "$BASE"
  run_stage 22 "前端 api.js 契约（祝福）" node scripts/test-api-bless.js "$BASE"

  # ---- 第 23 关：前端漂流瓶契约（需要数据库，转发到虚拟机）----
  run_stage 23 "前端 api.js 契约（漂流瓶）" \
    run_on_vm test-api-bottle.js "FRONTEND_DIR=\$HOME/frontend"

  # ---- 第 24 关：前端私信 + 发现页契约（需要数据库）----
  run_stage 24 "前端 api.js 契约（私信 + 发现页）" \
    run_on_vm test-api-message.js "FRONTEND_DIR=\$HOME/frontend"

  # ---- 第 25 关：前端 AI 聊天契约（需要数据库）----
  run_stage 25 "前端 api.js 契约（AI 聊天 + 安全）" \
    run_on_vm test-api-ai.js "FRONTEND_DIR=\$HOME/frontend"
else
  echo ""
  echo "  后端不在线，第 7~25 关跳过。"
  FAILED=$((FAILED+1))
  FAILED_NAMES+=("后端不在线，第7~25关未执行")
fi

# ============================================================
echo ""
echo "=============================================================="
echo "  总结"
echo "=============================================================="
echo ""
echo "  通过 $PASSED 关，失败 $FAILED 关"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo "  🎉 全部通过！后端和前端接口完全对齐。"
  echo ""
  exit 0
else
  echo "  失败项："
  for n in "${FAILED_NAMES[@]}"; do echo "    - $n"; done
  echo ""
  echo "  排错建议："
  echo "    - 看后端日志：  启动后端的那个窗口（node src/app.js）里就有"
  echo "    - 重启后端：    关掉后端窗口，重新 node src/app.js"
  echo ""
  exit 1
fi
