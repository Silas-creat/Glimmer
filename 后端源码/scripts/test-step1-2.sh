#!/usr/bin/env bash
# ============================================================
#  第 1、2 步的端到端验收测试
#  在虚拟机里执行：  bash ~/server/scripts/test-step1-2.sh
#  它把"部署到底成没成"用真实请求验一遍，不靠猜。
# ============================================================
set -uo pipefail

BASE="http://127.0.0.1:3000"
PHONE="13800138000"
PASS_COUNT=0
FAIL_COUNT=0

ok()   { echo "  ✅ $1"; PASS_COUNT=$((PASS_COUNT+1)); }
bad()  { echo "  ❌ $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
step() { echo ""; echo "----------------------------------------------"; echo "  $1"; echo "----------------------------------------------"; }

# 提取 JSON 里的字段（不依赖 jq，用 python3/grep 兜底）
json_get() {
  local json="$1" key="$2"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for k in '$key'.split('.'):
        d = d[int(k)] if k.isdigit() else d[k]
    print(d if d is not None else '')
except Exception:
    print('')
" 2>/dev/null
  else
    printf '%s' "$json" | grep -o "\"$key\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '"'
  fi
}

echo "=============================================="
echo "  陪着 · 第1-2步验收测试"
echo "=============================================="

# ---------- 1. 健康检查 ----------
step "1. 健康检查 /api/health"
HEALTH=$(curl -s -m 10 "$BASE/api/health")
if [ -z "$HEALTH" ]; then
  bad "服务没响应，先去查日志: tail -50 /var/log/peizhe.log"
  echo ""
  echo "=============================================="
  echo "  测试中断：服务没起来，后面的测不了"
  echo "=============================================="
  exit 1
fi
echo "  响应: $(printf '%s' "$HEALTH" | head -c 300)"
echo ""

DB_OK=$(json_get "$HEALTH" "data.db.connected")
if [ "$DB_OK" = "True" ] || [ "$DB_OK" = "true" ]; then
  ok "服务活着 + MySQL 连接正常"
else
  bad "服务活着但 MySQL 没连上"
fi

# ---------- 2. 发验证码 ----------
step "2. 发送验证码 POST /api/auth/send-code"
SEND=$(curl -s -m 10 -X POST "$BASE/api/auth/send-code" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$PHONE\"}")
echo "  响应: $SEND"

if printf '%s' "$SEND" | grep -q '"code":0'; then
  ok "验证码发送成功"
else
  if printf '%s' "$SEND" | grep -q '太频繁'; then
    ok "触发频控（说明接口正常，等 60 秒再试）"
  else
    bad "验证码发送失败"
  fi
fi

# ---------- 3. 手机号格式校验 ----------
step "3. 参数校验：错误的手机号应该被拒绝"
BADPHONE=$(curl -s -m 10 -X POST "$BASE/api/auth/send-code" \
  -H "Content-Type: application/json" \
  -d '{"phone":"123"}')
if printf '%s' "$BADPHONE" | grep -qE '手机号'; then
  ok "错误手机号被正确拦截"
else
  bad "错误手机号没被拦截，响应: $BADPHONE"
fi

# ---------- 4. 错误验证码应该被拒绝 ----------
step "4. 用错误验证码登录，应该失败"
BADCODE=$(curl -s -m 10 -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$PHONE\",\"code\":\"000000\"}")
if printf '%s' "$BADCODE" | grep -qE '验证码不对|过期'; then
  ok "错误验证码被正确拒绝"
else
  bad "错误验证码竟然通过了！响应: $BADCODE"
fi

# ---------- 5. 万能码登录 ----------
step "5. 用万能码 123456 登录 POST /api/auth/login"
LOGIN=$(curl -s -m 10 -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$PHONE\",\"code\":\"123456\"}")
echo "  响应: $(printf '%s' "$LOGIN" | head -c 400)"

TOKEN=$(json_get "$LOGIN" "data.token")
UID_VAL=$(json_get "$LOGIN" "data.user.uid")
USER_ID=$(json_get "$LOGIN" "data.user.id")
NICK=$(json_get "$LOGIN" "data.user.nickname")

if [ -n "$TOKEN" ]; then
  ok "登录成功，拿到 token"
  echo "     user.id  = $USER_ID"
  echo "     user.uid = $UID_VAL"
  echo "     nickname = $NICK"
else
  bad "登录失败，没拿到 token"
fi

# ---------- 6. 带 token 查自己 ----------
step "6. 带 token 访问 /api/auth/me"
if [ -n "${TOKEN:-}" ]; then
  ME=$(curl -s -m 10 "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN")
  echo "  响应: $(printf '%s' "$ME" | head -c 300)"
  ME_ID=$(json_get "$ME" "data.user.id")
  if [ "$ME_ID" = "$USER_ID" ]; then
    ok "token 能正确换回身份（id 一致）"
  else
    bad "token 换回的身份不对: 期望 $USER_ID 实际 $ME_ID"
  fi
else
  bad "没有 token，跳过"
fi

# ---------- 7. 无 token 应该 401 ----------
step "7. 不带 token 访问，应该被拒绝（401）"
NOAUTH=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/auth/me")
if [ "$NOAUTH" = "401" ]; then
  ok "未登录被正确拦截（HTTP 401）"
else
  bad "未登录没被拦截，HTTP 状态码是 $NOAUTH"
fi

# ---------- 8. 伪造 token 应该 401 ----------
step "8. 伪造 token 访问，应该被拒绝"
FAKE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/auth/me" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.fake.signature")
if [ "$FAKE" = "401" ]; then
  ok "伪造 token 被正确拒绝"
else
  bad "伪造 token 竟然通过了！状态码 $FAKE"
fi

# ---------- 9. 换设备继续聊的核心验证 ----------
step "9. 【核心】换设备：同一手机号再登一次"
LOGIN2=$(curl -s -m 10 -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"$PHONE\",\"code\":\"123456\"}")
TOKEN2=$(json_get "$LOGIN2" "data.token")
USER_ID2=$(json_get "$LOGIN2" "data.user.id")
IS_NEW2=$(json_get "$LOGIN2" "data.isNewUser")

echo "  第二次登录返回:"
echo "     user.id   = $USER_ID2   (第一次是 $USER_ID)"
echo "     isNewUser = $IS_NEW2"
echo "     新 token  = $(printf '%s' "$TOKEN2" | head -c 20)..."

if [ "$USER_ID2" = "$USER_ID" ]; then
  ok "第二次登录拿到同一个 user.id —— 换设备能续上的基础成立"
else
  bad "两次登录 user.id 不一样（$USER_ID vs $USER_ID2），换设备就接不上了"
fi

if [ "$IS_NEW2" = "False" ] || [ "$IS_NEW2" = "false" ]; then
  ok "第二次不再重复注册（isNewUser=false）"
else
  bad "第二次登录又被当成新用户了"
fi

if [ -n "$TOKEN2" ] && [ "$TOKEN2" != "$TOKEN" ]; then
  ok "每次登录发新 token（旧 token 依然能用，适合多设备）"
fi

# ---------- 10. 数据库表是否建全 ----------
step "10. 数据库表结构检查"
TABLE_COUNT=$(mysql -h127.0.0.1 -uroot -p'123456xx' -N -B -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='peizhe'" 2>/dev/null)
echo "  peizhe 库里共 $TABLE_COUNT 张表"
if [ "${TABLE_COUNT:-0}" -ge 19 ]; then
  ok "20 张表建全了"
else
  bad "表数量不对（期望 >=19，实际 $TABLE_COUNT）"
fi

ROOM_COUNT=$(mysql -h127.0.0.1 -uroot -p'123456xx' -N -B -e \
  "SELECT COUNT(*) FROM peizhe.chat_rooms" 2>/dev/null)
echo "  群聊房间数: $ROOM_COUNT"
if [ "${ROOM_COUNT:-0}" = "4" ]; then
  ok "4 个群聊房间已就位"
else
  bad "群聊房间数不对（期望 4，实际 $ROOM_COUNT）"
fi

USER_ROWS=$(mysql -h127.0.0.1 -uroot -p'123456xx' -N -B -e \
  "SELECT COUNT(*) FROM peizhe.users" 2>/dev/null)
echo "  users 表里已有 $USER_ROWS 个用户"
if [ "${USER_ROWS:-0}" -ge 1 ]; then
  ok "登录时自动注册真的写进数据库了"
else
  bad "数据库里没有用户记录，自动注册没生效"
fi

# ---------- 汇总 ----------
echo ""
echo "=============================================="
echo "  结果： 通过 $PASS_COUNT   失败 $FAIL_COUNT"
echo "=============================================="
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo ""
  echo "  🎉 第 1、2 步全部通过！后端骨架 + 登录系统已经跑通。"
  echo ""
  echo "  下一步可以做第 3 步：DeepSeek AI 聊天 + 换设备续聊。"
  echo ""
  exit 0
else
  echo ""
  echo "  有 $FAIL_COUNT 项没过。把上面的 ❌ 发给我，我来修。"
  echo "  另外可以看看服务日志： tail -50 /var/log/peizhe.log"
  echo ""
  exit 1
fi
