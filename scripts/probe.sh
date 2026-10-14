#!/bin/sh
# AIO Proxy Tools · 出口探测：从每个本机地址出站访问 IP 回显服务，得到它对外的公网 IP。
# 输入：同目录 addrs.txt，每行一个地址。输出：EGRESS=<本机地址> <公网IP|FAIL>
export LC_ALL=C
PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin:/usr/local/bin"
cd "$(dirname "$0")" || exit 1

# 需要 curl 按地址出站：busybox wget 不支持 -4/-6 和 --bind-address（Alpine、最小化 Debian 常见）
if ! command -v curl >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y -qq curl >/dev/null 2>&1 \
    || { apt-get -o DPkg::Lock::Timeout=120 update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y -qq curl >/dev/null 2>&1; }
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then yum install -y -q curl >/dev/null 2>&1
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache -q curl >/dev/null 2>&1
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed curl >/dev/null 2>&1
  elif command -v zypper >/dev/null 2>&1; then zypper -n -q install curl >/dev/null 2>&1
  fi
fi

probe() {
  a=$1; r=""
  case "$a" in
    # 末尾的 http 地址兜底：有些机器的 curl 没有 CA 证书，https 全部失败（回显的只是本机出口 IP，不敏感）
    *:*) fam=-6; urls="https://api64.ipify.org https://ipv6.icanhazip.com https://ifconfig.co/ip http://api64.ipify.org http://ipv6.icanhazip.com" ;;
    *)   fam=-4; urls="https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip http://api.ipify.org http://ipv4.icanhazip.com" ;;
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
