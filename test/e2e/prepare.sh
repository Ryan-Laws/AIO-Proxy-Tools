#!/bin/sh
# CI 端到端测试准备：开启 SSH 登录，并添加 3 个"额外 IP"（经 NAT 出网，模拟云服务器的内网→公网映射）
set -eu
mode=$1

sudo apt-get install -y -qq openssh-server >/dev/null
sudo tee /etc/ssh/sshd_config.d/00-e2e.conf >/dev/null <<CONF
PermitRootLogin yes
PasswordAuthentication yes
CONF
sudo systemctl restart ssh

if [ "$mode" = root-password ]; then
  pw=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  echo "root:$pw" | sudo chpasswd
  echo "AIO_SSH_PASSWORD=$pw" >> "$GITHUB_ENV"
  echo "::add-mask::$pw"
else
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/aio_e2e
  cat ~/.ssh/aio_e2e.pub >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
fi

sudo ip link add aio0 type dummy
sudo ip link set aio0 up
for i in 1 2 3; do sudo ip addr add 10.200.0.$i/32 dev aio0; done
dev=$(ip route show default | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}')
sudo iptables -t nat -A POSTROUTING -s 10.200.0.0/24 -o "$dev" -j MASQUERADE
ip -br addr
