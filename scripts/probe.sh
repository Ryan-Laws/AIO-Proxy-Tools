#!/bin/sh
# AIO Proxy Tools · 出口探测：从每个本机地址出站访问 IP 回显服务，得到它对外的公网 IP。
# 输入：同目录 addrs.txt，每行一个地址。输出：EGRESS=<本机地址> <公网IP|FAIL>
export LC_ALL=C
cd "$(dirname "$0")" || exit 1

probe() {
  a=$1; r=""
  case "$a" in
    *:*) fam=-6; urls="https://api64.ipify.org https://ipv6.icanhazip.com https://ifconfig.co/ip" ;;
    *)   fam=-4; urls="https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip" ;;
  esac
  for u in $urls; do
    if command -v curl >/dev/null 2>&1; then
      r=$(curl -s $fam --interface "$a" -m 6 "$u" 2>/dev/null)
    else
      r=$(wget -q $fam --bind-address="$a" -T 6 -O - "$u" 2>/dev/null)
    fi
    r=$(echo "$r" | tr -d ' \r\n')
    case "$r" in *[!0-9a-fA-F.:]*|"") r="" ;; *) break ;; esac
  done
  echo "EGRESS=$a ${r:-FAIL}"
}

n=0
while read -r a; do
  [ -n "$a" ] || continue
  probe "$a" &
  n=$((n + 1))
  [ $((n % 48)) -eq 0 ] && wait
done < addrs.txt
wait
echo "PROBE_DONE=1"
