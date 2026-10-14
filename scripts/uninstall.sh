# AIO Proxy Tools · 卸载（由客户端与 common.sh 拼接后执行）
step "停止服务"
for s in "$SVC" "$DNS_SVC" "$SVC-expire.timer"; do svc_stop "$s"; svc_disable "$s"; done

step "撤销防火墙规则"
[ -x "$OPT/fw-undo.sh" ] && "$OPT/fw-undo.sh"

if [ -s "$ETC/bind.txt" ]; then
  step "解除绑定的 IP"
  while read -r cidr dev; do ip addr del "$cidr" dev "$dev" 2>/dev/null; done < "$ETC/bind.txt"
fi

if [ -s "$ETC/stopped-services" ]; then
  for s in $(sort -u "$ETC/stopped-services"); do info "部署时停用过的服务 $s 未自动恢复，如需要请手动启用"; done
fi

step "删除文件"
rm -f /etc/systemd/system/$SVC.service /etc/systemd/system/$DNS_SVC.service \
      /etc/systemd/system/$SVC-expire.service /etc/systemd/system/$SVC-expire.timer \
      /etc/init.d/$SVC /etc/init.d/$DNS_SVC /etc/unbound/aio-proxy.conf /etc/periodic/hourly/$SVC-expire /etc/sysctl.d/99-aio-proxy.conf
[ $INIT = systemd ] && systemctl daemon-reload
rm -rf "$OPT" "$ETC" "$VAR"
if id "$RUN_USER" >/dev/null 2>&1; then
  if has userdel; then userdel "$RUN_USER" 2>/dev/null; else deluser "$RUN_USER" 2>/dev/null; fi
fi
ok "已卸载（3proxy 程序与配置均已删除，系统软件包 unbound 保留）"
