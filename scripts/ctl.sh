# AIO Proxy Tools · 运维操作（由客户端与 common.sh 拼接后执行）
# 参数 ACTION：status | stats | start | stop | restart | manifest | test
W=$(cd "$(dirname "$0")" && pwd)

status() {
  if svc_active "$SVC"; then echo "ACTIVE=1"; else echo "ACTIVE=0"; fi
  if svc_active "$DNS_SVC"; then echo "DNS_ACTIVE=1"; else echo "DNS_ACTIVE=0"; fi
  pid=$(main_pid)
  if [ -n "$pid" ] && [ "$pid" != 0 ] && [ -d "/proc/$pid" ]; then
    echo "PID=$pid"
    awk '/^Threads:/{print "THREADS="$2} /^VmRSS:/{print "RSS_KB="$2}' "/proc/$pid/status"
    if has ss; then echo "CONNS=$(ss -tnp state established 2>/dev/null | awk 'NR>1' | grep -c "pid=$pid,")"; fi
    # 启动时间输出 Unix 时间戳：systemctl 输出的时区缩写（如 CST）在浏览器里会被解析错
    btime=$(awk '/^btime/{print $2}' /proc/stat 2>/dev/null)
    st=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')
    hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
    [ -n "$btime" ] && [ -n "$st" ] && echo "SINCE=$((btime + st / hz))"
  fi
  [ -f "$ETC/dns.effective" ] && echo "DNS_EFFECTIVE=$(cat "$ETC/dns.effective")"
  [ -f "$OPT/3proxy.version" ] && echo "TP_VERSION=$(cat "$OPT/3proxy.version")"
}

stats() {
  # 从 3proxy 管理页（仅本机、只读模式）读取流量计数器
  port=$(sed -n 's/.*"adminPort": *\([0-9]*\).*/\1/p' "$ETC/proxies.json" | head -n1)
  user=$(sed -n 's/.*"adminUser": *"\([^"]*\)".*/\1/p' "$ETC/proxies.json" | head -n1)
  pass=$(sed -n 's/.*"adminPass": *"\([^"]*\)".*/\1/p' "$ETC/proxies.json" | head -n1)
  [ -n "$port" ] || { echo "::warn::未找到管理端口"; return; }
  has curl || pkg_install curl
  echo "::counters::begin"
  # 管理密码经 stdin 传给 curl，不出现在进程列表里
  echo "user = \"$user:$pass\"" | curl -s -m 10 -K - "http://127.0.0.1:$port/C"
  echo; echo "::counters::end"
}

case "$ACTION" in
  status)   status ;;
  stats)    status; stats ;;
  start)    svc_start "$DNS_SVC" 2>/dev/null; svc_start "$SVC"; sleep 2; status ;;
  stop)     svc_stop "$SVC"; status ;;
  restart)  svc_restart "$SVC"; sleep 2; status ;;
  manifest) if [ -f "$ETC/proxies.json" ]; then echo "::manifest::begin"; cat "$ETC/proxies.json"; echo; echo "::manifest::end"; fi; status ;;
  test)
    has curl || pkg_install curl
    n=0
    while read -r a b c d e f g; do
      selftest "$a" "$b" "$c" "$d" "$e" "$f" "$g" &
      n=$((n + 1)); [ $((n % 32)) -eq 0 ] && wait
    done < "$W/selftest.txt"
    wait ;;
  *) die "未知操作 $ACTION" ;;
esac
