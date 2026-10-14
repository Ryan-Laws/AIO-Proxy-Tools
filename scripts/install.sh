# AIO Proxy Tools · 安装 / 更新（由客户端与 common.sh 拼接后执行）
#
# 工作目录 $W 中由客户端上传的文件：
#   3proxy.cfg  users.list  expiry.list  proxies.json  listen.txt  fw.txt
#   bind.txt  selftest.txt  unbound.conf(可选)  assets/(可选，客户端代下载的安装包)
# 环境变量：
#   TP_VERSION  3proxy 版本      MIRROR   GitHub 下载镜像前缀（可空）
#   DNS_MODE    recursive|forward|public|system|custom
#   DNS_FALLBACK  unbound 不可用时 3proxy 直接使用的 DNS（空格分隔）
#   FW BBR TUNE SELFTEST  1/0     STOP_CONFLICTS  要停用的服务名（空格分隔）
#   TOOL_VERSION  客户端版本

W=$(cd "$(dirname "$0")" && pwd)
cd "$W" || die "工作目录不可用"
: "${TP_VERSION:?}" "${DNS_MODE:=recursive}" "${FW:=1}" "${BBR:=1}" "${TUNE:=1}" "${SELFTEST:=1}"

# =============================================================== 依赖
step "检查依赖"
need=""
has curl || has wget || need="$need curl"
has tar || need="$need tar"
has ip || case "$PM" in apk|pacman) need="$need iproute2" ;; apt-get) need="$need iproute2" ;; *) need="$need iproute" ;; esac
has ss || has netstat || case "$PM" in apt-get|apk|pacman) need="$need iproute2" ;; *) need="$need iproute" ;; esac
[ -d /etc/ssl/certs ] || need="$need ca-certificates"
if [ -n "$need" ]; then
  info "安装:$need"
  pkg_install $need || warn "部分依赖安装失败:$need"
fi
ok "依赖就绪"

# =============================================================== 3proxy
ARCH=$(uname -m)
REL="https://github.com/3proxy/3proxy/releases/download/$TP_VERSION"

# 取得一个发布文件：优先用客户端上传的 assets/，否则从 GitHub（可经镜像）下载
get_asset() {
  if [ -s "$W/assets/$1" ]; then cp "$W/assets/$1" "$2"; return 0; fi
  fetch "${MIRROR}$REL/$1" "$2"
}

# 校验：$1=文件 $2=文件名 $3=校验和文件
verify() {
  want=$(awk -v n="$2" '{f=$2; sub(/^\*/,"",f)} f==n {print $1}' "$3")
  [ -n "$want" ] || { warn "校验文件中找不到 $2"; return 1; }
  got=$(sha256_of "$1")
  [ "$want" = "$got" ] || { warn "$2 SHA256 不匹配"; return 1; }
}

binary_ok() {
  [ -x "$1" ] || return 1
  # 必须是 ELF 程序：官方 deb 里还有同名的 /etc/init.d/3proxy 启动脚本
  [ "$(dd if="$1" bs=1 skip=1 count=3 2>/dev/null)" = ELF ] || return 1
  if has ldd && ldd "$1" 2>&1 | grep -q "not found"; then return 1; fi
  return 0
}

install_from_pkg() {
  pkg=""; sums=""
  case "$ARCH" in
    x86_64|amd64) sums=SHA256SUMS-x86_64; deb="3proxy-$TP_VERSION.x86_64.deb"; rarch=x86_64 ;;
    aarch64|arm64) sums=SHA256SUMS-arm64; deb="3proxy-$TP_VERSION.arm64.deb"; rarch=aarch64 ;;
    armv7*|armv6*|armhf) sums=SHA256SUMS-arm; deb="3proxy-$TP_VERSION.arm.deb"; rarch="" ;;
    *) return 1 ;;
  esac
  major=${OS_VER%%.*}
  if has dpkg-deb; then
    pkg=$deb
  elif has rpm2cpio && [ -n "$rarch" ] && echo " $OS_ID $OS_LIKE " | grep -qE ' (rhel|centos|fedora|rocky|almalinux|ol) ' \
       && [ "$major" -ge 8 ] 2>/dev/null; then
    [ "$major" -gt 10 ] && major=10
    case "$OS_ID" in fedora) major=10 ;; esac
    pkg="3proxy-$TP_VERSION.el$major.$rarch.rpm"
  else
    return 1
  fi
  info "尝试官方安装包 $pkg"
  T=$W/pkg; rm -rf "$T"; mkdir -p "$T/x"
  get_asset "$sums" "$T/sums" || { echo "::need::pkg $pkg $sums"; return 1; }
  get_asset "$pkg" "$T/$pkg" || { echo "::need::pkg $pkg $sums"; return 1; }
  verify "$T/$pkg" "$pkg" "$T/sums" || return 1
  case "$pkg" in
    *.deb) dpkg-deb -x "$T/$pkg" "$T/x" 2>/dev/null || { warn "dpkg-deb 无法解包（系统 dpkg 不支持 zstd）"; return 1; } ;;
    *.rpm) has cpio || pkg_install cpio; (cd "$T/x" && rpm2cpio "$T/$pkg" | cpio -idm --quiet 2>/dev/null) || return 1 ;;
  esac
  f=$(find "$T/x" -type f -name 3proxy | while read -r c; do binary_ok "$c" && { echo "$c"; break; }; done)
  [ -n "$f" ] || { warn "安装包中的程序无法在本系统运行"; return 1; }
  install -m 0755 "$f" "$BIN.new" && mv -f "$BIN.new" "$BIN"
}

install_from_src() {
  src="3proxy-$TP_VERSION.tar.gz"
  info "从官方源码编译（约 1 分钟）"
  T=$W/src; rm -rf "$T"; mkdir -p "$T"
  get_asset SHA256SUMS-src "$T/sums" || { echo "::need::src $src SHA256SUMS-src"; return 1; }
  get_asset "$src" "$T/$src" || { echo "::need::src $src SHA256SUMS-src"; return 1; }
  verify "$T/$src" "$src" "$T/sums" || return 1
  if ! has gcc || ! has make; then
    info "安装编译工具"
    case "$PM" in
      apt-get) pkg_install gcc make libc6-dev ;;
      dnf|yum) pkg_install gcc make glibc-devel ;;
      apk)     pkg_install gcc make musl-dev linux-headers ;;
      pacman)  pkg_install gcc make ;;
      zypper)  pkg_install gcc make glibc-devel ;;
    esac
    has gcc && has make || die "无法安装 gcc/make，无法编译 3proxy"
  fi
  tar xzf "$T/$src" -C "$T" || return 1
  d="$T/3proxy-$TP_VERSION"
  jobs=$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
  if ! (cd "$d" && make -f Makefile.Linux -j"$jobs" >"$T/build.log" 2>&1); then
    # 部分老编译器不支持 LTO，去掉后重试
    (cd "$d" && make -f Makefile.Linux clean >/dev/null 2>&1; make -f Makefile.Linux CFLAGS=-O2 LDFLAGS=-O2 -j"$jobs" >"$T/build.log" 2>&1) \
      || { tail -n 20 "$T/build.log"; return 1; }
  fi
  binary_ok "$d/bin/3proxy" || return 1
  install -m 0755 "$d/bin/3proxy" "$BIN.new" && mv -f "$BIN.new" "$BIN"
}

step "安装 3proxy $TP_VERSION"
mkdir -p "$OPT/bin" "$ETC" "$VAR"
if binary_ok "$BIN" && [ "$(cat "$OPT/3proxy.version" 2>/dev/null)" = "$TP_VERSION" ]; then
  ok "3proxy $TP_VERSION 已安装"
else
  if install_from_pkg || install_from_src; then
    echo "$TP_VERSION" > "$OPT/3proxy.version"
    ok "3proxy $TP_VERSION 安装完成"
  else
    echo "::error::3proxy 安装失败"
    exit 42
  fi
fi

# =============================================================== 用户与目录
if ! id "$RUN_USER" >/dev/null 2>&1; then
  if has useradd; then useradd -r -M -d "$VAR" -s /sbin/nologin "$RUN_USER" 2>/dev/null || useradd -r -M -s /bin/false "$RUN_USER"
  elif has adduser; then adduser -S -D -H -h "$VAR" -s /sbin/nologin "$RUN_USER" 2>/dev/null; addgroup -S "$RUN_USER" 2>/dev/null; addgroup "$RUN_USER" "$RUN_USER" 2>/dev/null
  fi
fi
id "$RUN_USER" >/dev/null 2>&1 || die "无法创建运行用户 $RUN_USER"
RUN_GROUP=$(id -gn "$RUN_USER")
mkdir -p "$VAR/logs"
chown "$RUN_USER:$RUN_GROUP" "$VAR" "$VAR/logs"; chmod 0750 "$VAR"

# =============================================================== 冲突服务
for s in $STOP_CONFLICTS; do
  if svc_active "$s" || svc_enabled "$s"; then
    svc_stop "$s"; svc_disable "$s"
    echo "$s" >> "$ETC/stopped-services"
    ok "已停用冲突服务 $s"
  fi
done

# =============================================================== 端口冲突检查
step "检查端口占用"
listening_sockets > "$W/inuse.txt"
conflicts=$(awk 'NR==FNR { u[$1" "$2]=1; if($1=="0.0.0.0"||$1=="*"||$1=="::") w[$2]=1; next }
                 { if (($1" "$2) in u || $2 in w) print $1":"$2 }' "$W/inuse.txt" "$W/listen.txt" | head -n 20)
if [ -n "$conflicts" ]; then
  echo "$conflicts" | while read -r c; do warn "端口已被其它程序占用: $c"; done
  die "端口冲突，请换端口或停用占用端口的服务后重试"
fi
ok "端口可用"

# =============================================================== 绑定额外 IP
cat > "$OPT/bind-ip.sh" <<'EOF'
#!/bin/sh
# 把 /etc/aio-proxy/bind.txt 中的地址绑定到网卡（开机/服务启动前执行）
[ -s /etc/aio-proxy/bind.txt ] || exit 0
while read -r cidr dev; do
  [ -n "$cidr" ] && [ -n "$dev" ] || continue
  ip addr replace "$cidr" dev "$dev" 2>/dev/null || true
done < /etc/aio-proxy/bind.txt
exit 0
EOF
chmod 0755 "$OPT/bind-ip.sh"
if [ -s "$W/bind.txt" ]; then
  step "绑定额外 IP 到网卡"
  # 撤销上次绑定但这次不再需要的地址
  if [ -s "$ETC/bind.txt" ]; then
    awk 'NR==FNR{k[$1]=1; next} !($1 in k)' "$W/bind.txt" "$ETC/bind.txt" | while read -r cidr dev; do ip addr del "$cidr" dev "$dev" 2>/dev/null; done
  fi
  install -m 0644 "$W/bind.txt" "$ETC/bind.txt"
  "$OPT/bind-ip.sh"
  ok "已绑定 $(wc -l < "$W/bind.txt" | tr -d ' ') 个地址（重启后自动恢复）"
else
  if [ -s "$ETC/bind.txt" ]; then
    while read -r cidr dev; do ip addr del "$cidr" dev "$dev" 2>/dev/null; done < "$ETC/bind.txt"
    rm -f "$ETC/bind.txt"
  fi
fi

# =============================================================== DNS
DNS_EFFECTIVE=$DNS_MODE
UB_CONF=/etc/unbound/aio-proxy.conf
use_fallback_dns() {
  awk -v list="$DNS_FALLBACK" '/^nserver /{next}
       {print} /^# @dns/{n=split(list,a," "); for(i=1;i<=n;i++){s=a[i]; if(s ~ /:.*:/) s="["s"]"; print "nserver " s}}'        "$W/3proxy.cfg" > "$W/3proxy.cfg.new" && mv -f "$W/3proxy.cfg.new" "$W/3proxy.cfg"
  DNS_EFFECTIVE=public
}
stop_own_dns() {
  if svc_exists "$DNS_SVC"; then svc_stop "$DNS_SVC"; svc_disable "$DNS_SVC"; fi
}
case "$DNS_MODE" in
  recursive|forward)
    step "配置本机 DNS 解析器（unbound）"
    if ! has unbound; then
      pkg_install unbound || pkg_install unbound-daemon || true
      # 发行版自带的 unbound 服务会占用 53 端口，本工具使用独立实例，不需要它
      if has unbound && svc_exists unbound && [ ! -f "$ETC/unbound.keep" ]; then
        svc_stop unbound; svc_disable unbound; echo installed-by-aio > "$ETC/unbound.installed"
      fi
    fi
    UB=$(command -v unbound 2>/dev/null)
    if [ -z "$UB" ]; then
      warn "unbound 安装失败，改用公共 DNS 直连：$DNS_FALLBACK"
      use_fallback_dns
    else
      # 放在 /etc/unbound 下：Ubuntu 的 AppArmor 只允许 unbound 读取该目录
      mkdir -p /etc/unbound
      install -m 0644 "$W/unbound.conf" "$UB_CONF"
      if has unbound-checkconf && ! unbound-checkconf "$UB_CONF" >/dev/null 2>&1; then
        unbound-checkconf "$UB_CONF" 2>&1 | tail -n 3
        warn "unbound 配置无效，改用公共 DNS 直连"; use_fallback_dns
      else
        case $INIT in
          systemd)
            cat > /etc/systemd/system/$DNS_SVC.service <<EOF
[Unit]
Description=AIO Proxy Tools DNS resolver (unbound)
After=network-online.target
Wants=network-online.target
Before=$SVC.service

[Service]
Type=simple
User=$RUN_USER
ExecStart=$UB -d -p -c $UB_CONF
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
            systemctl daemon-reload ;;
          openrc)
            cat > /etc/init.d/$DNS_SVC <<EOF
#!/sbin/openrc-run
description="AIO Proxy Tools DNS resolver (unbound)"
command="$UB"
command_args="-d -p -c $UB_CONF"
command_user="$RUN_USER"
supervisor=supervise-daemon
respawn_delay=3
depend() { need net; before $SVC; }
EOF
            chmod 0755 /etc/init.d/$DNS_SVC ;;
        esac
        svc_enable "$DNS_SVC"; svc_restart "$DNS_SVC"
        sleep 2
        if svc_active "$DNS_SVC"; then ok "unbound 已启动（127.0.0.1:5335，模式: $DNS_MODE）"
        else warn "unbound 启动失败，改用公共 DNS 直连"; stop_own_dns; use_fallback_dns; fi
      fi
    fi ;;
  *)
    stop_own_dns ;;
esac

# =============================================================== 配置文件
step "写入配置"
for f in 3proxy.cfg users.list proxies.json; do [ -f "$ETC/$f" ] && cp -p "$ETC/$f" "$ETC/$f.bak"; done
install -m 0640 -o root -g "$RUN_GROUP" "$W/3proxy.cfg" "$ETC/3proxy.cfg"
install -m 0640 -o root -g "$RUN_GROUP" "$W/users.list" "$ETC/users.list"
install -m 0640 -o root -g "$RUN_GROUP" "$W/expiry.list" "$ETC/expiry.list"
install -m 0600 "$W/proxies.json" "$ETC/proxies.json"
echo "${TOOL_VERSION:-unknown}" > "$ETC/version"

# 到期账号过滤：生成 users.active（3proxy 实际读取的账号表）
cat > "$OPT/expire.sh" <<'EOF'
#!/bin/sh
# 根据 /etc/aio-proxy/expiry.list 过滤到期账号，变化时让 3proxy 重新加载
E=/etc/aio-proxy
today=$(date +%Y-%m-%d)
tmp=$E/users.active.tmp
awk -v t="$today" 'NR==FNR { if ($2 != "" && $2 < t) x[$1]=1; next }
                   { split($0,a,":"); if (!(a[1] in x)) print }' "$E/expiry.list" "$E/users.list" > "$tmp"
if ! cmp -s "$tmp" "$E/users.active" 2>/dev/null; then
  mv -f "$tmp" "$E/users.active"
  chgrp "$(stat -c %G "$E/users.list")" "$E/users.active" 2>/dev/null; chmod 0640 "$E/users.active"
  if [ "$1" = "--reload" ]; then
    systemctl reload aio-proxy 2>/dev/null || rc-service aio-proxy reload 2>/dev/null || pkill -USR1 -f "^/opt/aio-proxy/bin/3proxy " 2>/dev/null
  fi
else
  rm -f "$tmp"
fi
exit 0
EOF
chmod 0755 "$OPT/expire.sh"
"$OPT/expire.sh"

# 每小时检查到期
if [ $INIT = systemd ]; then
  cat > /etc/systemd/system/$SVC-expire.service <<EOF
[Unit]
Description=AIO Proxy Tools expiry check
[Service]
Type=oneshot
ExecStart=$OPT/expire.sh --reload
EOF
  cat > /etc/systemd/system/$SVC-expire.timer <<EOF
[Unit]
Description=AIO Proxy Tools hourly expiry check
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
EOF
elif [ -d /etc/periodic/hourly ]; then
  printf '#!/bin/sh\n%s --reload\n' "$OPT/expire.sh" > /etc/periodic/hourly/$SVC-expire
  chmod 0755 /etc/periodic/hourly/$SVC-expire
fi

# =============================================================== 内核参数
if [ "$TUNE" = 1 ] || [ "$BBR" = 1 ]; then
  step "优化内核参数"
  {
    echo "# AIO Proxy Tools"
    if [ "$TUNE" = 1 ]; then
      echo "net.core.somaxconn = 4096"
      echo "net.ipv4.tcp_max_syn_backlog = 4096"
      echo "net.ipv4.ip_local_port_range = 10240 65535"
      echo "net.ipv4.tcp_tw_reuse = 1"
      echo "net.ipv4.tcp_fin_timeout = 30"
      echo "net.ipv4.tcp_keepalive_time = 600"
      echo "fs.file-max = 1048576"
    fi
    if [ "$BBR" = 1 ]; then
      modprobe tcp_bbr 2>/dev/null
      if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null; then
        echo "net.core.default_qdisc = fq"
        echo "net.ipv4.tcp_congestion_control = bbr"
      fi
    fi
  } > /etc/sysctl.d/99-aio-proxy.conf
  sysctl -p /etc/sysctl.d/99-aio-proxy.conf >/dev/null 2>&1 || true
  if [ "$BBR" = 1 ]; then
    if [ "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" = bbr ]; then ok "BBR 已开启"
    else warn "内核不支持 BBR，已跳过"; fi
  fi
fi

# =============================================================== 服务
step "注册系统服务"
case $INIT in
  systemd)
    cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=AIO Proxy Tools (3proxy)
After=network-online.target $DNS_SVC.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ExecStartPre=+$OPT/bind-ip.sh
ExecStartPre=+$OPT/expire.sh
ExecStart=$BIN $ETC/3proxy.cfg
ExecReload=/bin/kill -USR1 \$MAINPID
KillMode=process
Restart=always
RestartSec=3
LimitNOFILE=1048576
LimitNPROC=infinity
TasksMax=infinity

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable $SVC-expire.timer >/dev/null 2>&1; systemctl start $SVC-expire.timer >/dev/null 2>&1 ;;
  openrc)
    cat > /etc/init.d/$SVC <<EOF
#!/sbin/openrc-run
description="AIO Proxy Tools (3proxy)"
command="$BIN"
command_args="$ETC/3proxy.cfg"
supervisor=supervise-daemon
respawn_delay=3
pidfile=/run/$SVC.pid
rc_ulimit="-n 1048576"
extra_started_commands="reload"
depend() { need net; after $DNS_SVC; }
start_pre() { $OPT/bind-ip.sh; $OPT/expire.sh; }
reload() { ebegin "Reloading \$RC_SVCNAME"; pkill -USR1 -f "^$BIN " ; eend \$?; }
EOF
    chmod 0755 /etc/init.d/$SVC ;;
  *) die "不支持的 init 系统（需要 systemd 或 OpenRC）" ;;
esac
svc_enable "$SVC"

all_listening() {
  listening_sockets >/dev/null  # 预热
  if has ss; then ss -ltnH 2>/dev/null | awk '{print $4}'; else netstat -ltn 2>/dev/null | awk 'NR>2{print $4}'; fi \
    | sed -E 's/^\[?(.*)\]?:([0-9]+)$/\1 \2/; s/\]//; s/%[^ ]*//' > "$W/now.txt"
  missing=$(awk 'NR==FNR{u[$1" "$2]=1; next} !(($1" "$2) in u)' "$W/now.txt" "$W/listen.txt" | wc -l)
  [ "$missing" -eq 0 ]
}

if svc_active "$SVC"; then
  step "重新加载 3proxy（不断开现有连接）"
  case $INIT in systemd) systemctl reload $SVC ;; openrc) rc-service $SVC reload >/dev/null ;; esac
else
  step "启动 3proxy"
  svc_start "$SVC"
fi

i=0
while [ $i -lt 10 ]; do sleep 1; all_listening && break; i=$((i + 1)); done
if ! all_listening; then
  warn "部分端口未监听，执行完整重启"
  svc_restart "$SVC"; sleep 3
fi
if ! svc_active "$SVC" || ! all_listening; then
  n=$(awk 'NR==FNR{u[$1" "$2]=1; next} !(($1" "$2) in u)' "$W/now.txt" "$W/listen.txt" | head -n 5)
  [ -n "$n" ] && echo "$n" | while read -r a p; do warn "未监听: $a:$p"; done
  if [ $INIT = systemd ]; then journalctl -u $SVC -n 15 --no-pager 2>/dev/null; fi
  if [ -f "$ETC/3proxy.cfg.bak" ]; then
    warn "回滚到上一次的配置"
    for f in 3proxy.cfg users.list proxies.json; do [ -f "$ETC/$f.bak" ] && mv -f "$ETC/$f.bak" "$ETC/$f"; done
    "$OPT/expire.sh"; svc_restart "$SVC"
  fi
  die "3proxy 启动失败"
fi
ok "3proxy 运行中，$(wc -l < "$W/listen.txt" | tr -d ' ') 个监听全部就绪"

# =============================================================== 防火墙
fw_state=$ETC/fw.state
if [ "$FW" = 1 ] && [ -s "$W/fw.txt" ]; then
  step "放行防火墙端口"
  # 先撤销上一次添加的规则
  if [ -s "$fw_state" ]; then sh "$OPT/fw-undo.sh" 2>/dev/null; fi
  : > "$fw_state"
  opened=""
  if has ufw && ufw status 2>/dev/null | grep -q "Status: active"; then
    while read -r proto ports; do
      ufw allow "$ports/$proto" >/dev/null 2>&1 && echo "ufw $proto $ports" >> "$fw_state"
    done < "$W/fw.txt"
    opened="$opened ufw"
  fi
  if has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    while read -r proto ports; do
      p=$(echo "$ports" | tr ':' '-')
      firewall-cmd --permanent --add-port="$p/$proto" >/dev/null 2>&1 && echo "firewalld $proto $p" >> "$fw_state"
    done < "$W/fw.txt"
    firewall-cmd --reload >/dev/null 2>&1
    opened="$opened firewalld"
  fi
  if [ -z "$opened" ]; then
    for t in iptables ip6tables; do
      has $t || continue
      $t -S INPUT 2>/dev/null | grep -qE '^-P INPUT (DROP|REJECT)|-j (DROP|REJECT)' || continue
      while read -r proto ports; do
        $t -C INPUT -p "$proto" --dport "$ports" -m comment --comment aio-proxy -j ACCEPT 2>/dev/null \
          || $t -I INPUT -p "$proto" --dport "$ports" -m comment --comment aio-proxy -j ACCEPT 2>/dev/null \
          && echo "$t $proto $ports" >> "$fw_state"
      done < "$W/fw.txt"
      opened="$opened $t"
    done
    if has nft && nft list chain inet filter input >/dev/null 2>&1 && ! echo "$opened" | grep -q iptables; then
      while read -r proto ports; do
        p=$(echo "$ports" | tr ':' '-')
        nft insert rule inet filter input "$proto" dport "$p" accept comment \"aio-proxy\" 2>/dev/null \
          && echo "nft $proto $p" >> "$fw_state"
      done < "$W/fw.txt"
      opened="$opened nftables"
    fi
    # 持久化 iptables 规则（尽力而为）
    if echo "$opened" | grep -q iptables; then
      if has netfilter-persistent; then netfilter-persistent save >/dev/null 2>&1
      elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4 2>/dev/null; ip6tables-save > /etc/iptables/rules.v6 2>/dev/null
      elif [ -f /etc/sysconfig/iptables ]; then iptables-save > /etc/sysconfig/iptables 2>/dev/null
      fi
    fi
  fi
  cat > "$OPT/fw-undo.sh" <<'EOF'
#!/bin/sh
# 撤销本工具添加的防火墙规则
S=/etc/aio-proxy/fw.state
[ -s "$S" ] || exit 0
reload_fwd=0
while read -r kind proto ports; do
  case $kind in
    ufw) ufw delete allow "$ports/$proto" >/dev/null 2>&1 ;;
    firewalld) firewall-cmd --permanent --remove-port="$ports/$proto" >/dev/null 2>&1; reload_fwd=1 ;;
    iptables|ip6tables) $kind -D INPUT -p "$proto" --dport "$ports" -m comment --comment aio-proxy -j ACCEPT 2>/dev/null ;;
    nft) h=$(nft -a list chain inet filter input 2>/dev/null | grep 'comment "aio-proxy"' | grep "dport $ports " | sed -n 's/.*# handle //p' | head -n1)
         [ -n "$h" ] && nft delete rule inet filter input handle "$h" 2>/dev/null ;;
  esac
done < "$S"
[ $reload_fwd = 1 ] && firewall-cmd --reload >/dev/null 2>&1
: > "$S"
exit 0
EOF
  chmod 0755 "$OPT/fw-undo.sh"
  if [ -n "$opened" ]; then ok "已放行:${opened}"; else info "未检测到启用的防火墙，无需放行"; fi
fi

# =============================================================== 自检
if [ "$SELFTEST" = 1 ] && [ -s "$W/selftest.txt" ] && has curl; then
  step "服务器自检"
  run_tests() {
    n=0
    while read -r a b c d e f g; do
      selftest "$a" "$b" "$c" "$d" "$e" "$f" "$g" &
      n=$((n + 1)); [ $((n % 32)) -eq 0 ] && wait
    done < "$W/selftest.txt"
    wait
  }
  run_tests > "$W/test.out"
  dnsfail=$(grep -c ' fail DNS ' "$W/test.out")
  total=$(wc -l < "$W/test.out" | tr -d ' ')
  if [ "$dnsfail" -gt 0 ] && [ "$dnsfail" -ge $((total / 2)) ] && [ "$DNS_EFFECTIVE" = recursive ]; then
    warn "从根递归解析失败（机房可能限制 53 端口），改为转发模式"
    sed -i '/^forward-zone:/,$d' "$UB_CONF"
    {
      echo "forward-zone:"
      echo "  name: \".\""
      for s in $DNS_FALLBACK; do echo "  forward-addr: $s"; done
    } >> "$UB_CONF"
    svc_restart "$DNS_SVC"; sleep 2
    DNS_EFFECTIVE=forward
    run_tests > "$W/test.out"
  fi
  cat "$W/test.out"
  okc=$(grep -c ' ok ' "$W/test.out")
  if [ "$okc" = "$total" ]; then ok "自检通过 $okc/$total"; else warn "自检通过 $okc/$total"; fi
fi

echo "$DNS_EFFECTIVE" > "$ETC/dns.effective"
echo "::dns::$DNS_EFFECTIVE"
rm -f "$ETC"/*.bak
ok "部署完成"
