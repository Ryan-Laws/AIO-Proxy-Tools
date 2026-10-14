#!/usr/bin/env bash
# CI 端到端测试：通过 SSH 部署到本机，然后逐项验证
set -euo pipefail
mode=$1
if [ "$mode" = root-password ]; then
  login="-user root"
else
  login="-user $(id -un) -key $HOME/.ssh/aio_e2e"
fi
IPS=10.200.0.1,10.200.0.2,10.200.0.3
data=$(mktemp -d)

echo "=== 部署（双协议、每 IP 独立账号、限速/限连接/额度）"
# shellcheck disable=SC2086
./aio deploy -host 127.0.0.1 $login -data "$data" -ips $IPS -protocol dual \
  -socks-port 21080 -http-port 21081 -speed 50 -max-conn 100 -quota 10 \
  -via-listen -json deploy1.json

echo "=== 服务状态"
systemctl is-active aio-proxy
systemctl is-active aio-proxy-dns
test "$(jq '.manifest.proxies | length' deploy1.json)" -eq 6

echo "=== 用 curl 独立验证每个代理"
jq -r '.manifest.proxies[] | "\(.protocol) \(.listen) \(.port) \(.user) \(.pass)"' deploy1.json | while read -r proto ip port user pass; do
  if [ "$proto" = socks ]; then scheme=socks5h; else scheme=http; fi
  out=$(curl -fsS -m 20 -x "$scheme://$user:$pass@$ip:$port" https://api.ipify.org)
  echo "$proto $ip:$port -> $out"
  if curl -fsS -m 10 -x "$scheme://$ip:$port" https://api.ipify.org >/dev/null 2>&1; then
    echo "不带密码竟然能用: $ip:$port"; exit 1
  fi
  if curl -fsS -m 10 -x "$scheme://$user:$pass@$ip:$port" http://127.0.0.1:22 >/dev/null 2>&1; then
    echo "能经代理访问本机回环地址: $ip:$port"; exit 1
  fi
done

echo "=== 账号隔离：A 的账号不能用 B 的 IP"
a_user=$(jq -r '.manifest.proxies[] | select(.listen=="10.200.0.1" and .protocol=="socks") | .user' deploy1.json)
a_pass=$(jq -r '.manifest.proxies[] | select(.listen=="10.200.0.1" and .protocol=="socks") | .pass' deploy1.json)
if curl -fsS -m 10 -x "socks5h://$a_user:$a_pass@10.200.0.2:21080" https://api.ipify.org >/dev/null 2>&1; then
  echo "账号未隔离"; exit 1
fi

echo "=== 重新部署（应沿用原账号，热重载）"
# shellcheck disable=SC2086
./aio deploy -host 127.0.0.1 $login -data "$data" -ips $IPS -protocol dual \
  -socks-port 21080 -http-port 21081 -via-listen -json deploy2.json
diff <(jq -S '[.manifest.proxies[] | {listen, protocol, user, pass}]' deploy1.json) \
     <(jq -S '[.manifest.proxies[] | {listen, protocol, user, pass}]' deploy2.json)

echo "=== 测试命令"
# shellcheck disable=SC2086
./aio test -host 127.0.0.1 $login -data "$data" -via-listen

echo "=== 卸载"
# shellcheck disable=SC2086
./aio uninstall -host 127.0.0.1 $login -data "$data"
if systemctl is-active aio-proxy >/dev/null 2>&1; then echo "卸载后服务仍在运行"; exit 1; fi
test ! -e /etc/aio-proxy
test ! -e /opt/aio-proxy
echo "=== 全部通过"
