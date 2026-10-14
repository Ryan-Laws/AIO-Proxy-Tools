#!/bin/sh
# AIO Proxy Tools · 环境探测（只读，不修改系统）
# 输出 KEY=VALUE 行，由客户端解析。
export LC_ALL=C
PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"

has() { command -v "$1" >/dev/null 2>&1; }

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi
echo "OS=${PRETTY_NAME:-$(uname -s)}"
echo "OS_ID=${ID:-unknown}"
echo "OS_LIKE=${ID_LIKE:-}"
echo "OS_VERSION=${VERSION_ID:-}"
echo "KERNEL=$(uname -r)"
echo "ARCH=$(uname -m)"
echo "UID=$(id -u)"
echo "CPUS=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)"
echo "MEM_KB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"

if has systemctl && [ -d /run/systemd/system ]; then echo "INIT=systemd"
elif has rc-service; then echo "INIT=openrc"
else echo "INIT=unknown"; fi

for p in apt-get dnf yum apk pacman zypper; do
  if has $p; then echo "PM=$p"; break; fi
done

has curl && echo "HAS_CURL=1"
has wget && echo "HAS_WGET=1"
has ip || echo "NO_IP_CMD=1"
if [ "$(id -u)" != 0 ]; then
  if has sudo; then echo "SUDO=1"; else echo "SUDO=0"; fi
fi

# ---- 防火墙 ----
fw=""
if has ufw && ufw status 2>/dev/null | grep -q "Status: active"; then fw="$fw ufw"; fi
if has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then fw="$fw firewalld"; fi
if has iptables && iptables -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)|-j (DROP|REJECT)'; then fw="$fw iptables"; fi
if has nft && nft list chain inet filter input 2>/dev/null | grep -qE 'policy drop|drop$|reject'; then fw="$fw nftables"; fi
echo "FW=${fw# }"

echo "TCP_CC=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"

# ---- 已安装状态 / 冲突服务 ----
if [ -f /etc/aio-proxy/3proxy.cfg ]; then
  echo "INSTALLED=1"
  [ -f /etc/aio-proxy/version ] && echo "VERSION=$(cat /etc/aio-proxy/version)"
fi
svc_active() {
  if has systemctl && [ -d /run/systemd/system ]; then systemctl is-active "$1" >/dev/null 2>&1
  elif has rc-service; then rc-service "$1" status >/dev/null 2>&1
  else return 1; fi
}
conf=""
for s in 3proxy sing-box xray v2ray danted sockd gost squid tinyproxy privoxy shadowsocks-libev ss-server; do
  svc_active "$s" && conf="$conf $s"
done
echo "CONFLICTS=${conf# }"

# ---- IP 地址 ----
if has ip; then
  defif=$(ip route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
  echo "DEFIF=$defif"
  # 跳过容器/虚拟网桥/隧道的地址，它们不是对外 IP
  skip='^(lo|docker|br-|veth|virbr|cni|flannel|cali|kube|tun|tap|wg|zt|tailscale)'
  ip -o -4 addr show scope global 2>/dev/null | awk '{sub(/@.*/,"",$2); print $2, $4}' \
    | while read -r ifc cidr; do echo "$ifc" | grep -qE "$skip" || echo "ADDR4=$ifc $cidr"; done
  ip -o -6 addr show scope global 2>/dev/null | grep -vE 'temporary|deprecated|tentative' \
    | awk '{sub(/@.*/,"",$2); print $2, $4}' \
    | while read -r ifc cidr; do echo "$ifc" | grep -qE "$skip" || echo "ADDR6=$ifc $cidr"; done
  # AnyIP：整段路由到本机（常见于"包段"机器），段内任意地址都能直接监听和出站
  ip -4 route show table local 2>/dev/null | awk '
      { c=""; d=""; t=0
        for(i=1;i<=NF;i++){ if($i=="local") t=1; if($i ~ /^[0-9.]+\/[0-9]+$/ && c=="") c=$i; if($i=="dev") d=$(i+1) }
        if(t && c!="" && c !~ /^127\./ && c !~ /\/32$/) print d, c }' \
    | while read -r ifc cidr; do echo "ANYIP4=$ifc $cidr"; done
fi

# ---- 已被占用的 TCP 端口（地址:端口）----
if has ss; then
  echo "LISTEN=$(ss -ltnH 2>/dev/null | awk '{print $4}' | tr '\n' ' ')"
elif has netstat; then
  echo "LISTEN=$(netstat -ltn 2>/dev/null | awk 'NR>2{print $4}' | tr '\n' ' ')"
fi
echo "DETECT_DONE=1"
