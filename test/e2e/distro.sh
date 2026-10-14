#!/usr/bin/env bash
# 在 Docker 容器里的各个发行版上跑完整流程（容器内运行真正的 systemd / OpenRC 与 sshd）。
#
#   test/e2e/distro.sh <镜像> <登录方式: root-key | sudo-pass> [防火墙: none | ufw | firewalld]
#
# 宿主机能直接访问容器网卡上的地址，所以可以真正连进代理逐项验证：
# 出口地址、认证、账号隔离、禁止访问内网/本机、请求头、DNS、限速、额度、白名单、
# 多种协议/端口/账号组合、重新部署、容器重启后自动恢复、防火墙规则、卸载干净。
set -euo pipefail
image=$1
login_mode=${2:-root-key}
fw=${3:-none}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
aio=$root/aio
name="aio-e2e"
work=$(mktemp -d)
data=$work/data
ECHO=198.18.0.1            # 回显服务器：非内网地址，代理默认允许访问
IPS=(172.17.200.1 172.17.200.2 172.17.200.3)
IPLIST=$(IFS=,; echo "${IPS[*]}")
pass_n=0

say()  { printf '\n\033[1;36m=== %s\033[0m\n' "$*"; }
ok()   { pass_n=$((pass_n + 1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }
inct() { docker exec "$name" sh -c "$*"; }

dump() {
  say "失败，收集现场"
  inct 'journalctl -u aio-proxy -u aio-proxy-dns --no-pager -n 80 2>/dev/null || cat /var/log/messages 2>/dev/null | tail -n 80' || true
  inct 'ls -la /etc/aio-proxy /opt/aio-proxy /opt/aio-proxy/bin 2>&1; cat /etc/aio-proxy/3proxy.cfg 2>&1 | head -n 60' || true
  inct 'ss -ltnup 2>/dev/null || netstat -ltnup 2>/dev/null' || true
  inct 'ip -br addr; sysctl net.ipv4.ip_nonlocal_bind' || true
}
cleanup() {
  local rc=$?
  [ $rc -ne 0 ] && dump
  docker rm -f "$name" >/dev/null 2>&1 || true
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 镜像
say "构建 $image 测试镜像（$login_mode，防火墙 $fw）"
ssh-keygen -q -t ed25519 -N '' -f "$work/key"
cp "$work/key.pub" "$work/authorized_keys"
SUDO_PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
echo "::add-mask::$SUDO_PW"

# 镜像只装 init、sshd、sudo、iproute、curl（不带 ca-certificates 等，让程序自己补齐依赖）
case "$image" in
  debian:*|ubuntu:*)
    init=/sbin/init
    setup="export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus openssh-server sudo iproute2 procps curl >/dev/null && systemctl enable ssh"
    [ "$fw" = ufw ] && setup="$setup && apt-get install -y -qq ufw >/dev/null" ;;
  *rockylinux*|*almalinux*|fedora:*|*centos*)
    init=/usr/sbin/init
    # 测试容器里 RHEL 系的 PAM account 阶段会拒绝所有登录（容器开机状态不完整），测试镜像里关掉 sshd 的 PAM
    setup="dnf install -y -q systemd openssh-server sudo iproute procps-ng passwd >/dev/null && systemctl enable sshd \
      && sed -i 's/^UsePAM.*/UsePAM no/' /etc/ssh/sshd_config && grep -rl '^UsePAM' /etc/ssh/sshd_config.d 2>/dev/null | xargs -r sed -i 's/^UsePAM.*/UsePAM no/'"
    [ "$fw" = firewalld ] && setup="$setup && dnf install -y -q firewalld >/dev/null && systemctl enable firewalld" ;;
  opensuse/*)
    init=/usr/lib/systemd/systemd
    setup="zypper -n -q install systemd openssh sudo iproute2 procps shadow curl >/dev/null && systemctl enable sshd" ;;
  archlinux*)
    init=/usr/lib/systemd/systemd
    setup="pacman -Syu --noconfirm --needed openssh sudo iproute2 procps-ng >/dev/null && systemctl enable sshd" ;;
  alpine:*)
    init=/sbin/init
    setup="apk add -q openrc openssh sudo iproute2 shadow curl && rc-update add sshd default \
      && sed -i 's/^#*rc_sys=.*/rc_sys=\"docker\"/' /etc/rc.conf" ;;
  *) echo "未知镜像 $image"; exit 2 ;;
esac

# 开机时（网络就绪前）给 eth0 加上测试 IP，模拟真实服务器由网络配置恢复多 IP
cat > "$work/e2e-ips.service" <<EOF
[Unit]
Description=e2e extra IPs
DefaultDependencies=no
Before=network-online.target aio-proxy.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for ip in ${IPS[*]}; do ip addr add \$ip/16 dev eth0 || true; done'
[Install]
WantedBy=network-online.target multi-user.target
EOF
cat > "$work/e2e-ips.openrc" <<EOF
#!/sbin/openrc-run
depend() { provide net; }
start() { for ip in ${IPS[*]}; do ip addr add \$ip/16 dev eth0 || true; done; return 0; }
EOF

cat > "$work/Dockerfile" <<EOF
FROM $image
RUN $setup
COPY e2e-ips.service /etc/systemd/system/e2e-ips.service
COPY e2e-ips.openrc /etc/init.d/e2e-ips
RUN chmod 0755 /etc/init.d/e2e-ips \\
 && if command -v rc-update >/dev/null; then rc-update add e2e-ips boot; rm -f /etc/systemd/system/e2e-ips.service; \\
    else systemctl enable e2e-ips; rm -f /etc/init.d/e2e-ips; fi
RUN ssh-keygen -A \\
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh \\
 && echo 'root:$SUDO_PW' | chpasswd \\
 && printf 'PermitRootLogin prohibit-password\nPasswordAuthentication yes\nKbdInteractiveAuthentication yes\n' > /tmp/sshd_extra \\
 && if grep -q '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config; then cp /tmp/sshd_extra /etc/ssh/sshd_config.d/00-e2e.conf; else sed -i '1r /tmp/sshd_extra' /etc/ssh/sshd_config; fi \\
 && useradd -m -s /bin/sh aio 2>/dev/null || adduser -D -s /bin/sh aio \\
 && echo 'aio:$SUDO_PW' | chpasswd \\
 && mkdir -p /etc/sudoers.d && echo 'aio ALL=(ALL) ALL' > /etc/sudoers.d/aio && chmod 0440 /etc/sudoers.d/aio
COPY authorized_keys /root/.ssh/authorized_keys
STOPSIGNAL SIGRTMIN+3
CMD ["$init"]
EOF
docker build -q -t aio-e2e-img "$work" >/dev/null

# ------------------------------------------------------------------ 宿主机：回显服务器
sudo ip link add aioecho type dummy 2>/dev/null || true
sudo ip link set aioecho up
sudo ip addr add $ECHO/32 dev aioecho 2>/dev/null || true
pgrep -f "e2e/echo.py" >/dev/null || (python3 "$here/echo.py" 8000 >/dev/null 2>&1 &)

start_ct() {
  docker run -d --name $name --hostname aio-e2e --privileged --cgroupns=host \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /tmp aio-e2e-img >/dev/null
}
add_ips() { for ip in "${IPS[@]}"; do inct "ip addr add $ip/16 dev eth0 2>/dev/null || true"; done; }
wait_ssh() {
  for _ in $(seq 60); do
    # 容器里开机流程常停在 degraded，/run/nologin 不会被删除，PAM 会拒绝所有登录（真实服务器没有这个问题）
    docker exec "$name" rm -f /run/nologin /etc/nologin 2>/dev/null || true
    if ssh -i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -o ConnectTimeout=2 root@"$CIP" true 2>/dev/null; then return 0; fi
    sleep 1
  done
  docker logs --tail 30 $name 2>&1 || true
  inct 'systemctl is-system-running; systemctl status sshd ssh --no-pager -n 20; ss -ltn; grep -E "^root:" /etc/shadow | cut -c1-12' 2>&1 || true
  ssh -v -i "$work/key" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=3 root@"$CIP" true 2>&1 | tail -n 15 || true
  fail "sshd 没有起来"
}
start_ct
CIP=$(docker inspect -f '{{.NetworkSettings.IPAddress}}' $name)
wait_ssh
add_ips
if [ "$fw" = ufw ]; then inct 'ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null && ufw status | head -n 3'; fi
if [ "$fw" = firewalld ]; then inct 'for i in $(seq 30); do firewall-cmd --state >/dev/null 2>&1 && break; sleep 1; done; firewall-cmd --state'; fi
inct '. /etc/os-release; echo "容器: $PRETTY_NAME · $(uname -m)"; ip -br -4 addr show eth0'

if [ "$login_mode" = root-key ]; then
  LOGIN=(-user root -key "$work/key")
else
  LOGIN=(-user aio)
  export AIO_SSH_PASSWORD=$SUDO_PW
fi
run_aio() { "$aio" "$1" -host "$CIP" "${LOGIN[@]}" -data "$data" "${@:2}"; }

# ------------------------------------------------------------------ 工具函数
# px <proto> <listen> <port> <user> <pass> → curl 的 -x 参数
px() {
  local scheme=socks5h; [ "$1" = http ] && scheme=http
  if [ -n "$4" ]; then echo "$scheme://$4:$5@$2:$3"; else echo "$scheme://$2:$3"; fi
}
proxies() { jq -r '.manifest.proxies[] | "\(.protocol) \(.listen) \(.port) \(.user // "") \(.pass // "")"' "$1"; }
listening() { inct "ss -ltnH 2>/dev/null | awk '{print \$4}'" | grep -c ":$1\$" || true; }

check_proxy() { # proto listen port user pass
  local proto=$1 ip=$2 port=$3 user=$4 pass=$5 p out
  p=$(px "$@")
  out=$(curl -fsS -m 15 -x "$p" "http://$ECHO:8000/ip") || fail "$proto $ip:$port 连不上"
  [ "$out" = "$ip" ] || fail "$proto $ip:$port 出口地址是 $out，应为 $ip"
  curl -fsS -m 20 -x "$p" https://api.ipify.org >/dev/null || fail "$proto $ip:$port 访问外网（域名经服务器解析）失败"
  if [ -n "$user" ] && curl -fsS -m 8 -x "$(px "$proto" "$ip" "$port" "" "")" "http://$ECHO:8000/ip" >/dev/null 2>&1; then
    fail "$proto $ip:$port 不带密码也能用"
  fi
  if [ -n "$user" ] && curl -fsS -m 8 -x "$(px "$proto" "$ip" "$port" "$user" "wrong$pass")" "http://$ECHO:8000/ip" >/dev/null 2>&1; then
    fail "$proto $ip:$port 密码错误也能用"
  fi
  if curl -fsS -m 8 -x "$p" "http://127.0.0.1:22/" >/dev/null 2>&1; then fail "$proto $ip:$port 能访问服务器本机"; fi
  # 用域名指向本机：代理端解析后也必须拦截
  if curl -fsS -m 8 -x "$p" "http://localhost:22/" >/dev/null 2>&1; then fail "$proto $ip:$port 能通过域名 localhost 访问服务器本机"; fi
  # 服务器自己的其它地址（绕过云安全组访问本机服务）
  if curl -fsS -m 8 -x "$p" "http://$CIP:22/" >/dev/null 2>&1; then fail "$proto $ip:$port 能访问服务器自己的地址 $CIP"; fi
  if curl -fsS -m 8 -x "$p" "http://172.17.0.1:8000/ip" >/dev/null 2>&1; then fail "$proto $ip:$port 能访问内网地址"; fi
  if [ "$proto" = http ]; then
    out=$(curl -fsS -m 15 -x "$p" "http://$ECHO:8000/headers")
    if echo "$out" | jq -e 'keys[] | ascii_downcase | select(. == "x-forwarded-for" or . == "via" or . == "forwarded" or . == "x-real-ip" or . == "proxy-authorization")' >/dev/null; then
      fail "HTTP 代理泄露了请求头: $out"
    fi
    echo "$out" | grep -q '172\.17\.0\.1' && fail "HTTP 代理请求头里出现了客户端 IP: $out"
  fi
  return 0
}

# ================================================================== 1. 部署
say "1. 部署：双协议 · 每 IP 独立账号 · 限速 20Mbps · 本机递归 DNS"
run_aio deploy -ips "$IPLIST" -protocol dual -socks-port 21080 -http-port 21081 \
  -speed 20 -max-conn 50 -via-listen -json "$work/d1.json" || fail "部署失败（退出码 $?）"
test "$(jq '.manifest.proxies | length' "$work/d1.json")" -eq 6 || fail "应有 6 个代理"
ok "部署完成，程序自带的本机测试 6/6 通过"

say "2. 逐个代理验证"
while read -r proto ip port user pass; do
  check_proxy "$proto" "$ip" "$port" "$user" "$pass"
  ok "$proto $ip:$port 出口正确 / 外网可达 / 认证生效 / 禁止本机和内网$([ "$proto" = http ] && echo ' / 无请求头泄露')"
done < <(proxies "$work/d1.json")

say "3. 账号隔离、服务状态、安全设置"
read -r _ _ _ ua pa < <(jq -r '.manifest.proxies[] | select(.listen=="172.17.200.1" and .protocol=="socks") | "x x x \(.user) \(.pass)"' "$work/d1.json")
if curl -fsS -m 8 -x "socks5h://$ua:$pa@172.17.200.2:21080" "http://$ECHO:8000/ip" >/dev/null 2>&1; then fail "IP1 的账号能用在 IP2 上"; fi
ok "账号互相隔离"
# 只匹配以程序路径开头的进程（OpenRC 的 supervise-daemon 参数里也含这个路径，但它是 root）
u=$(inct "stat -c %U /proc/\$(pgrep -o -f '^/opt/aio-proxy/bin/3proxy ')" | tr -d ' ')
[ "$u" = aio-proxy ] || fail "3proxy 运行用户是 '$u'，应为 aio-proxy"
ok "3proxy 以非 root 用户 aio-proxy 运行"
dnsl=$(inct "ss -lnuH 2>/dev/null | awk '{print \$4}' | grep ':5335\$' || true")
[ -n "$dnsl" ] || fail "unbound 没有监听 5335"
echo "$dnsl" | grep -qv '^127\.0\.0\.1:' && fail "unbound 不只监听在 127.0.0.1: $dnsl"
ok "unbound 只监听 127.0.0.1:5335"
inct "stat -c '%a %U:%G' /etc/aio-proxy/users.list /etc/aio-proxy/users.active /etc/aio-proxy/proxies.json"
inct "[ \"\$(stat -c %a /etc/aio-proxy/proxies.json)\" = 600 ] && [ \"\$(stat -c %a /etc/aio-proxy/users.list)\" = 640 ]" || fail "账号文件权限不对"
ok "账号文件权限 600/640"

say "4. 限速（20Mbps ≈ 2.5MB/s）"
read -r proto ip port user pass < <(proxies "$work/d1.json" | head -n1)
read -r t spd < <(curl -sS -m 60 -o /dev/null -w '%{time_total} %{speed_download}\n' -x "$(px "$proto" "$ip" "$port" "$user" "$pass")" "http://$ECHO:8000/bytes?n=20000000")
echo "  下载 20MB 用时 ${t}s，速度 $(awk -v s="$spd" 'BEGIN{printf "%.2f", s/1048576}')MB/s"
awk -v s="$spd" 'BEGIN{exit !(s < 3.6*1048576)}' || fail "限速没有生效"
awk -v s="$spd" 'BEGIN{exit !(s > 1.0*1048576)}' || fail "限速后速度过低"
ok "限速生效"

say "5. 重新部署：应沿用原端口和账号，且不中断服务"
run_aio deploy -ips "$IPLIST" -protocol dual -socks-port 21080 -http-port 21081 -speed 20 -max-conn 50 \
  -via-listen -json "$work/d2.json" || fail "重新部署失败"
diff <(jq -S '[.manifest.proxies[] | {listen, protocol, port, user, pass}]' "$work/d1.json") \
     <(jq -S '[.manifest.proxies[] | {listen, protocol, port, user, pass}]' "$work/d2.json") || fail "重新部署后账号或端口变了"
ok "账号和端口保持不变"

say "6. 重启机器：服务开机自启；额外 IP 晚于 3proxy 就绪（cloud-init/DHCP）也要能用"
docker restart -t 10 $name >/dev/null
wait_ssh
# 先去掉额外 IP（不管测试镜像的开机服务有没有加上），模拟"3proxy 已启动、IP 还没到"
for ip in "${IPS[@]}"; do inct "ip addr del $ip/16 dev eth0 2>/dev/null || true"; done
for _ in $(seq 60); do inct "pgrep -f '^/opt/aio-proxy/bin/3proxy '" >/dev/null 2>&1 && break; sleep 1; done
if ! inct "pgrep -f '^/opt/aio-proxy/bin/3proxy '" >/dev/null 2>&1; then
  inct "systemctl is-system-running; systemctl list-jobs --no-pager; systemctl status aio-proxy aio-proxy-dns --no-pager -n 20; journalctl -b --no-pager -n 40 2>/dev/null; rc-status 2>/dev/null" || true
  fail "重启后 3proxy 没有自动启动"
fi
sleep 2
add_ips   # IP 此时才到
for _ in $(seq 15); do [ "$(listening 21080)" -ge 3 ] && [ "$(listening 21081)" -ge 3 ] && break; sleep 1; done
[ "$(listening 21080)" -ge 3 ] || fail "重启后 3proxy 没有在全部地址上监听"
while read -r proto ip port user pass; do
  curl -fsS -m 15 -x "$(px "$proto" "$ip" "$port" "$user" "$pass")" "http://$ECHO:8000/ip" >/dev/null || fail "重启后 $proto $ip:$port 不可用"
done < <(proxies "$work/d1.json")
ok "重启后全部恢复"

if [ "$fw" != none ]; then
  say "7. 防火墙规则（$fw）"
  case $fw in
    ufw) inct "ufw status | grep -E '21080|21081'" >/dev/null || fail "ufw 没有放行代理端口" ;;
    firewalld) inct "firewall-cmd --list-ports; firewall-cmd --permanent --list-ports" | grep -q 21080 || fail "firewalld 没有放行代理端口" ;;
  esac
  ok "已放行代理端口"
fi

say "8. 换配置重新部署：同端口自动识别协议 · 端口递增 · 全部共用账号 · 转发 DNS"
run_aio deploy -ips "$IPLIST" -protocol auto -port-mode inc -socks-port 22000 -auth shared -dns forward \
  -via-listen -json "$work/d3.json" || fail "部署失败"
test "$(jq '[.manifest.proxies[].user] | unique | length' "$work/d3.json")" -eq 1 || fail "共用账号模式下用户名应该只有一个"
test "$(jq '[.manifest.proxies[].port] | unique | length' "$work/d3.json")" -eq 3 || fail "递增端口应各不相同"
while read -r _ ip port user pass; do
  check_proxy socks "$ip" "$port" "$user" "$pass"
  check_proxy http "$ip" "$port" "$user" "$pass"
  ok "auto $ip:$port 同一端口 SOCKS5 和 HTTP 都可用"
done < <(proxies "$work/d3.json")
[ "$(listening 21080)" -eq 0 ] && [ "$(listening 21081)" -eq 0 ] || fail "旧端口仍在监听"
ok "旧端口已关闭"
inct "grep -q '^nserver' /etc/aio-proxy/3proxy.cfg && grep '^nserver' /etc/aio-proxy/3proxy.cfg"

say "9. 无认证 + 来源 IP 白名单 · 仅 SOCKS5 · 随机端口 · 公共 DNS"
run_aio deploy -ips "$IPLIST" -protocol socks -port-mode random -auth none -whitelist 172.17.0.1 -dns public \
  -via-listen -json "$work/d4.json" || fail "部署失败"
while read -r _ ip port _ _; do
  out=$(curl -fsS -m 15 -x "socks5h://$ip:$port" "http://$ECHO:8000/ip") || fail "白名单内来源连不上 $ip:$port"
  [ "$out" = "$ip" ] || fail "出口地址错误"
  # 对照：从监听地址本身发起（在白名单内）必须可用，确保下面的"被拒"不是因为命令本身失败
  inct "curl -fsS -m 8 --interface $ip -x socks5h://$ip:$port http://$ECHO:8000/ip" >/dev/null || fail "容器内对照请求失败"
  # 从容器自身的主地址发起（不在白名单内）应被拒绝
  if inct "curl -fsS -m 8 --interface $CIP -x socks5h://$ip:$port http://$ECHO:8000/ip" >/dev/null 2>&1; then
    fail "白名单外的来源也能用 $ip:$port"
  fi
  ok "socks $ip:$port 白名单内可用，白名单外被拒"
done < <(proxies "$work/d4.json")

say "10. 流量额度（每账号约 20MB，SOCKS5 与 HTTP 共用同一账号）"
# 3proxy 按"剩余额度"处理每个连接：HTTP 代理会直接拒绝声明大小超过剩余额度的响应，SOCKS5 传到额度为止截断。
# 所以检验的是：反复下载累计送达的数据不超过额度，并且最终会被拒绝。
run_aio deploy -ips "${IPS[0]}" -protocol dual -socks-port 23000 -http-port 23001 -auth per -quota 0.02 \
  -via-listen -json "$work/d5.json" || fail "部署失败"
limit=$(( 21 * 1048576 ))   # 0.02GB 向上取整为 21MB
total=0; refused=0
mapfile -t qps < <(proxies "$work/d5.json")
for i in 1 2 3 4 5 6; do
  read -r proto ip port user pass <<<"${qps[$(( i % ${#qps[@]} ))]}"
  got=$(curl -s -m 60 -o /dev/null -w '%{size_download} %{http_code}' -x "$(px "$proto" "$ip" "$port" "$user" "$pass")" \
    "http://$ECHO:8000/bytes?n=8000000" 2>/dev/null || true)
  read -r bytes code <<<"$got"
  bytes=${bytes:-0}
  echo "  第 $i 次（$proto）：收到 $bytes 字节，HTTP $code，3proxy PID $(inct "pgrep -o -f '^/opt/aio-proxy/bin/3proxy '" 2>/dev/null)"
  [ "$code" = 200 ] && [ "$bytes" -ge 8000000 ] || refused=$((refused + 1))
  [ "$code" = 200 ] && total=$(( total + bytes ))
  sleep 1
done
echo "  累计送达 $total 字节，额度 $limit 字节"
[ "$total" -ge $(( 8000000 * 2 )) ] || fail "额度内的下载也被拒绝了（累计只有 $total 字节）"
[ "$refused" -ge 1 ] || fail "超出额度后没有被拒绝"
# 3proxy 在额度边界上偶尔放过一个连接：最多超出一个连接的量
[ "$total" -le $(( limit + 8000000 )) ] || fail "累计送达 $total 字节，超出额度不止一个连接"
# 额度守护（每分钟）把额度将尽的账号移出账号表：之后两种协议的新连接都必须被拒绝
blocked=0
for _ in $(seq 20); do
  sleep 5
  a=$(curl -s -m 10 -o /dev/null -w '%{size_download}' -x "$(px socks "${IPS[0]}" 23000 "$user" "$pass")" "http://$ECHO:8000/bytes?n=1000000" 2>/dev/null || true)
  b=$(curl -s -m 10 -o /dev/null -w '%{size_download}' -x "$(px http "${IPS[0]}" 23001 "$user" "$pass")" "http://$ECHO:8000/bytes?n=1000000" 2>/dev/null || true)
  if [ "${a:-0}" -lt 1000000 ] && [ "${b:-0}" -lt 1000000 ] && ! inct "grep -q '^$user:' /etc/aio-proxy/users.active"; then blocked=1; break; fi
done
[ $blocked = 1 ] || fail "额度用尽 100 秒后账号仍可使用（额度守护没有生效）"
ok "额度内正常使用，超出后被拒绝；额度守护在一分钟内停用该账号"

say "11. 卸载"
run_aio uninstall || fail "卸载失败"
inct "test ! -e /etc/aio-proxy && test ! -e /opt/aio-proxy" || fail "卸载后还留有文件"
inct "pgrep -f '^/opt/aio-proxy/bin/3proxy '" >/dev/null 2>&1 && fail "卸载后 3proxy 仍在运行"
inct "ss -ltnH | grep -E ':(21080|21081|22000|23000|23001) '" >/dev/null 2>&1 && fail "卸载后端口仍在监听"
inct "ss -lnuH | grep ':5335 '" >/dev/null 2>&1 && fail "卸载后 DNS 解析器仍在运行"
inct "ls /etc/systemd/system/aio-proxy* /etc/init.d/aio-proxy* /etc/sysctl.d/99-aio-proxy.conf /etc/periodic/hourly/aio-proxy* 2>/dev/null" && fail "卸载后还留有服务或系统配置文件"
case $fw in
  ufw) inct "ufw status | grep -E '2[0-9]{4}'" && fail "卸载后 ufw 规则没有撤销" ;;
  firewalld) inct "firewall-cmd --permanent --list-ports | grep -E '2[0-9]{4}'" && fail "卸载后 firewalld 规则没有撤销" ;;
esac
for ip in "${IPS[@]}"; do inct "ip -br addr | grep -q '$ip/'" || fail "卸载把服务器原有的地址 $ip 删掉了"; done
ok "卸载干净，服务器原有地址保留"

say "全部通过（$pass_n 项）"
