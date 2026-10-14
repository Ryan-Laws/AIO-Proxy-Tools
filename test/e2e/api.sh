#!/usr/bin/env bash
# 界面后端端到端测试：像网页界面一样，只通过本地 HTTP API 操作一台真实服务器（本机）。
#   添加 → 探测 → 勾选 IP → 预览（并在预览表里改一行）→ 部署 → 验证 → 测试 → 刷新统计
#   → 停止/启动服务 → SSE 事件 → 卸载 → 删除；另检查令牌与 Host 头防护。
set -euo pipefail
mode=$1
data=$(mktemp -d)
log=$data/ui.log
IPS='["10.200.0.1","10.200.0.2","10.200.0.3"]'

say()  { printf '\n=== %s\n' "$*"; }
fail() { echo "✗ $*"; exit 1; }

./aio -no-browser -listen 127.0.0.1:17999 -data "$data" >"$log" 2>&1 &
ui=$!
trap 'kill $ui 2>/dev/null || true' EXIT
for _ in $(seq 30); do grep -q '?t=' "$log" && break; sleep 0.5; done
TOK=$(grep -o '?t=[0-9a-f]*' "$log" | head -n1 | cut -c4-)
[ -n "$TOK" ] || { cat "$log"; fail "没有拿到令牌"; }
B=http://127.0.0.1:17999

api() { # METHOD PATH [JSON]
  local out code
  out=$(curl -sS -w '\n%{http_code}' -X "$1" -H "X-Token: $TOK" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} "$B$2")
  code=${out##*$'\n'}; out=${out%$'\n'*}
  [ "${code:0:1}" = 2 ] || fail "$1 $2 → HTTP $code: $out"
  printf '%s' "$out"
}
wait_task() { # taskId
  local t st
  for _ in $(seq 600); do
    t=$(api GET "/api/tasks/$1")
    st=$(jq -r .state <<<"$t")
    [ "$st" = running ] || break
    sleep 1
  done
  jq -r '.logs[]? | "  \(.level)\t\(.text)"' <<<"$t" | tail -n 40
  [ "$st" = "done" ] || fail "任务 $1 结束状态 $st：$(jq -r .error <<<"$t")"
}
srv() { api GET /api/servers | jq --arg id "$SID" '.[] | select(.id == $id)'; }

say "安全：无令牌 / 错误令牌 / 错误 Host 必须被拒"
[ "$(curl -s -o /dev/null -w '%{http_code}' $B/api/servers)" = 401 ] || fail "无令牌未被拒"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Token: bad' $B/api/servers)" = 401 ] || fail "错误令牌未被拒"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Token: $TOK" -H 'Host: attacker.example' $B/api/servers)" = 403 ] || fail "错误 Host 未被拒"
echo "✓ 通过"

say "添加服务器（批量粘贴解析 + 添加）"
if [ "$mode" = root-password ]; then
  parsed=$(api POST /api/servers/parse "$(jq -n --arg t "127.0.0.1:22 root $AIO_SSH_PASSWORD" '{text:$t, defaults:{port:22,user:"root",authType:"password"}}')")
  [ "$(jq '.errors | length' <<<"$parsed")" = 0 ] || fail "解析出错: $parsed"
  body=$(jq '{servers: .servers}' <<<"$parsed")
else
  body=$(jq -n --arg u "$(id -un)" --rawfile k "$HOME/.ssh/aio_e2e" \
    '{servers:[{name:"本机",host:"127.0.0.1",port:22,user:$u,authType:"key",key:$k}]}')
fi
SID=$(api POST /api/servers "$body" | jq -r '.[0].id')
echo "服务器 $SID"

say "探测"
wait_task "$(api POST "/api/servers/$SID/detect" '{}' | jq -r .taskId)"
s=$(srv)
jq -e '.info.addrs | length >= 4' <<<"$s" >/dev/null || fail "探测到的地址太少: $(jq -c .info.addrs <<<"$s")"
api PUT "/api/servers/$SID/selected" "{\"selected\":$IPS}" >/dev/null
echo "✓ 已勾选 3 个 IP"

say "预览，并在预览表里把第一行端口改成 24099"
defaults=$(api GET /api/meta | jq .defaults)
settings=$(jq '.protocol="dual" | .socks.mode="same" | .socks.port=24080 | .http.mode="same" | .http.port=24081 | .auth.mode="per" | .limits.speedMbps=30' <<<"$defaults")
plan=$(api POST "/api/servers/$SID/plan" "$(jq -n --argjson s "$settings" --argjson sel "$IPS" '{settings:$s, selected:$sel}')")
[ "$(jq '.errors | length' <<<"$plan")" = 0 ] || fail "预览有错误: $(jq -c .errors <<<"$plan")"
[ "$(jq '.proxies | length' <<<"$plan")" = 6 ] || fail "预览应有 6 个代理"
edited=$(jq '.proxies | (.[0].port) = 24099' <<<"$plan")
echo "✓ 预览 6 个代理，占用端口 $(jq -c .ports <<<"$plan")"

say "部署（使用预览表）"
wait_task "$(api POST "/api/servers/$SID/deploy" "$(jq -n --argjson s "$settings" --argjson sel "$IPS" --argjson e "$edited" '{settings:$s, selected:$sel, edited:$e}')" | jq -r .taskId)"
s=$(srv)
diff <(jq -S '[.[] | {listen, protocol, port, user, pass}] | sort_by(.listen, .protocol)' <<<"$edited") \
     <(jq -S '[.manifest.proxies[] | {listen, protocol, port, user, pass}] | sort_by(.listen, .protocol)' <<<"$s") \
  || fail "部署结果与预览表不一致"
echo "✓ 部署结果与预览完全一致（含手动改的端口和随机账号）"
jq -r '.manifest.proxies[] | "\(.protocol) \(.listen) \(.port) \(.user) \(.pass)"' <<<"$s" | while read -r proto ip port user pass; do
  scheme=socks5h; [ "$proto" = http ] && scheme=http
  curl -fsS -m 15 -x "$scheme://$user:$pass@$ip:$port" https://api.ipify.org >/dev/null || fail "$proto $ip:$port 不可用"
done
echo "✓ 6 个代理全部可用"

say "测试（服务器自检）"
wait_task "$(api POST "/api/servers/$SID/test" '{"where":"server"}' | jq -r .taskId)"
s=$(srv)
[ "$(jq '[.tests[] | select(.where=="server" and .ok)] | length' <<<"$s")" = 6 ] || fail "服务器自检未全部通过: $(jq -c '.tests' <<<"$s")"
echo "✓ 自检 6/6"

say "刷新：服务状态与流量统计"
wait_task "$(api POST "/api/servers/$SID/refresh" '{}' | jq -r .taskId)"
s=$(srv)
jq -e '.status.active and .status.dnsActive and .status.pid > 0' <<<"$s" >/dev/null || fail "服务状态不对: $(jq -c .status <<<"$s")"
jq -e '[.stats[].usedMB] | add > 0' <<<"$s" >/dev/null || fail "流量统计没有数据: $(jq -c .stats <<<"$s")"
echo "✓ 运行中，流量统计 $(jq -c '[.stats[] | {user, usedMB}]' <<<"$s")"

say "服务控制：停止 → 启动"
wait_task "$(api POST "/api/servers/$SID/service" '{"action":"stop"}' | jq -r .taskId)"
if ss -ltnH | grep -q ':24081 '; then fail "停止后端口仍在监听"; fi
wait_task "$(api POST "/api/servers/$SID/service" '{"action":"start"}' | jq -r .taskId)"
for _ in $(seq 15); do ss -ltnH | grep -q ':24081 ' && break; sleep 1; done
ss -ltnH | grep -q ':24081 ' || fail "启动后端口没有监听"
echo "✓ 停止与启动正常"

say "SSE 事件流"
events=$(timeout 5 curl -sS -N "$B/api/events?t=$TOK" || true)
grep -q '^data: ' <<<"$events" || fail "没有收到 SSE 事件"
grep '^data: ' <<<"$events" | head -n1 | cut -c7- | jq -e '.type' >/dev/null || fail "SSE 数据不是 JSON"
echo "✓ 收到 $(grep -c '^data: ' <<<"$events") 条事件"

say "卸载并删除服务器"
wait_task "$(api POST "/api/servers/$SID/uninstall" '{}' | jq -r .taskId)"
test ! -e /etc/aio-proxy || fail "卸载后 /etc/aio-proxy 仍在"
api DELETE "/api/servers/$SID" >/dev/null
[ "$(api GET /api/servers | jq length)" = 0 ] || fail "删除后服务器仍在列表中"
echo "✓ 已卸载并删除"

say "本机数据目录不应保存密码"
if grep -rl -- "${AIO_SSH_PASSWORD:-__none__}" "$data" 2>/dev/null; then fail "数据目录里出现了 SSH 密码"; fi
if grep -rl 'PRIVATE KEY' "$data" 2>/dev/null; then fail "数据目录里出现了私钥"; fi
echo "✓ 未保存密码或私钥"

say "界面后端测试全部通过"
