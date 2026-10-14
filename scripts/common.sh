# AIO Proxy Tools · 服务器端公共函数（被其它脚本内联拼接，不单独执行）
# 输出约定：以 "::级别::" 开头的行由客户端解析并着色，其余按普通日志显示。
# shellcheck disable=SC2034  # 公共变量由各脚本按需使用
export LC_ALL=C
PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
umask 022

OPT=/opt/aio-proxy
ETC=/etc/aio-proxy
VAR=/var/lib/aio-proxy
BIN=$OPT/bin/3proxy
SVC=aio-proxy
DNS_SVC=aio-proxy-dns
RUN_USER=aio-proxy

step() { echo "::step::$*"; }
ok()   { echo "::ok::$*"; }
info() { echo "::info::$*"; }
warn() { echo "::warn::$*"; }
die()  { echo "::error::$*"; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || die "需要 root 权限"

INIT=unknown
if has systemctl && [ -d /run/systemd/system ]; then INIT=systemd
elif has rc-service; then INIT=openrc; fi

PM=""
for p in apt-get dnf yum apk pacman zypper; do
  if has $p; then PM=$p; break; fi
done

# shellcheck disable=SC1091
[ -r /etc/os-release ] && . /etc/os-release
OS_ID=${ID:-unknown}
OS_LIKE=${ID_LIKE:-}
OS_VER=${VERSION_ID:-}

APT_UPDATED=0
pkg_install() {
  case "$PM" in
    apt-get)
      # 新开的机器常有 unattended-upgrades 占着 dpkg 锁：等锁而不是直接失败
      if [ $APT_UPDATED = 0 ]; then DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -qq >/dev/null 2>&1; APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends "$@" >/dev/null 2>&1 ;;
    dnf|yum) $PM install -y -q "$@" >/dev/null 2>&1 ;;
    apk)     apk add --no-cache -q "$@" >/dev/null 2>&1 ;;
    # 不用 -Sy：只刷新数据库不升级会造成部分升级；先直接装，数据库过旧时才整体升级
    pacman)  pacman -S --noconfirm --needed "$@" >/dev/null 2>&1 || pacman -Syu --noconfirm --needed "$@" >/dev/null 2>&1 ;;
    zypper)  zypper -n -q install "$@" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

svc_exists() {
  case $INIT in
    systemd) systemctl cat "$1.service" >/dev/null 2>&1 ;;
    openrc)  [ -x "/etc/init.d/$1" ] ;;
    *) return 1 ;;
  esac
}
svc_active() {
  case $INIT in
    systemd) systemctl is-active "$1" >/dev/null 2>&1 ;;
    openrc)  rc-service "$1" status >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
svc_enabled() {
  case $INIT in
    systemd) systemctl is-enabled "$1" >/dev/null 2>&1 ;;
    openrc)  rc-update show default 2>/dev/null | grep -qw "$1" ;;
    *) return 1 ;;
  esac
}
svc_start()   { case $INIT in systemd) systemctl start "$1" ;; openrc) rc-service "$1" start >/dev/null ;; esac; }
svc_stop()    { case $INIT in systemd) systemctl stop "$1" 2>/dev/null ;; openrc) rc-service "$1" stop >/dev/null 2>&1 ;; esac; true; }
svc_restart() { case $INIT in systemd) systemctl restart "$1" ;; openrc) rc-service "$1" restart >/dev/null ;; esac; }
svc_enable()  { case $INIT in systemd) systemctl enable "$1" >/dev/null 2>&1 ;; openrc) rc-update add "$1" default >/dev/null 2>&1 ;; esac; true; }
svc_disable() { case $INIT in systemd) systemctl disable "$1" >/dev/null 2>&1 ;; openrc) rc-update del "$1" default >/dev/null 2>&1 ;; esac; true; }

# 3proxy 主进程 PID。OpenRC 的 supervise-daemon pidfile 记的是监督进程，不能用
main_pid() {
  pid=""
  [ $INIT = systemd ] && pid=$(systemctl show -p MainPID "$SVC" 2>/dev/null | cut -d= -f2)
  if [ -z "$pid" ] || [ "$pid" = 0 ]; then pid=$(pgrep -o -f "^$BIN " 2>/dev/null); fi
  echo "$pid"
}

# 下载：$1=URL $2=输出文件
fetch() {
  if has curl; then curl -fsSL --retry 2 --connect-timeout 15 -m 600 -o "$2" "$1" 2>/dev/null
  elif has wget; then wget -q -T 30 -O "$2" "$1" 2>/dev/null
  else return 1; fi
}

sha256_of() {
  if has sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif has shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}

# 已占用的监听地址，输出 "地址 端口"（排除本工具自己的进程）
listening_sockets() {
  own=$(main_pid)
  if has ss; then
    # 不用 ss -H：老版本 iproute2（CentOS 7）不支持
    ss -ltnp 2>/dev/null | awk 'NR>1' | { if [ -n "$own" ] && [ "$own" != 0 ]; then grep -v "pid=$own,"; else cat; fi; } | awk '{print $4}'
  elif has netstat; then
    netstat -ltnp 2>/dev/null | awk 'NR>2{print $4" "$7}' | { if [ -n "$own" ] && [ "$own" != 0 ]; then grep -v " $own/"; else cat; fi; } | awk '{print $1}'
  fi | sed -E 's/^\[?(.*)\]?:([0-9]+)$/\1 \2/; s/\]//; s/%[^ ]*//'
}

# 通过代理访问 IP 回显服务做自检
selftest() {
  # 输出 ::test::<id> <ok|fail> <出口IP|错误> <毫秒>
  id=$1 listen=$2 port=$3 proto=$4 user=$5 pass=$6 fam=$7
  host=$listen; case "$listen" in *:*) host="[$listen]" ;; esac
  if [ "$fam" = 6 ]; then url=https://api64.ipify.org; else url=https://api.ipify.org; fi
  case "$proto" in socks) scheme=socks5h ;; *) scheme=http ;; esac
  # 账号经 stdin 传给 curl，不出现在进程列表里
  cred=""; [ "$user" != "-" ] && cred="proxy-user = \"$user:$pass\""
  t0=$(date +%s%N 2>/dev/null)
  r=$(echo "$cred" | curl -s -m 12 -K - -x "$scheme://$host:$port" "$url" 2>/dev/null | tr -d ' \r\n')
  t1=$(date +%s%N 2>/dev/null)
  ms=0; case "$t0$t1" in *N*) ;; *) ms=$(( (t1 - t0) / 1000000 )) ;; esac
  case "$r" in
    ""|*[!0-9a-fA-F.:]*)
      # 区分 DNS 问题：直接用 IP 访问
      r2=$(echo "$cred" | curl -s -m 8 -K - -x "$scheme://$host:$port" -o /dev/null -w '%{http_code}' https://1.1.1.1/cdn-cgi/trace 2>/dev/null)
      if [ "$r2" = 200 ]; then echo "::test::$id fail DNS ${ms}"; else echo "::test::$id fail CONNECT ${ms}"; fi ;;
    *) echo "::test::$id ok $r ${ms}" ;;
  esac
}
