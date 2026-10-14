package detect

import "testing"

const sample = `OS=Ubuntu 22.04.4 LTS
OS_ID=ubuntu
OS_VERSION=22.04
ARCH=x86_64
UID=0
CPUS=2
MEM_KB=2048000
INIT=systemd
PM=apt-get
HAS_CURL=1
FW=ufw
CONFLICTS=sing-box
DEFIF=eth0
ADDR4=eth0 10.0.0.5/24
ADDR4=eth0 203.0.113.10/24
ADDR4=eth0@if12 203.0.113.11/24
ADDR6=eth0 2001:db8::10/64
ANYIP4=lo 198.51.100.0/30
LISTEN=0.0.0.0:22 [::]:22 127.0.0.53%lo:53
DETECT_DONE=1
`

func TestParse(t *testing.T) {
	info, err := Parse(sample)
	if err != nil {
		t.Fatal(err)
	}
	if info.MemMB != 2000 || !info.IsRoot || info.Init != "systemd" || len(info.Firewalls) != 1 || info.Conflicts[0] != "sing-box" {
		t.Errorf("字段解析错误: %+v", info)
	}
	// 4 个网卡地址 + AnyIP /30 展开 2 个
	if len(info.Addrs) != 6 {
		t.Fatalf("地址数 %d: %+v", len(info.Addrs), info.Addrs)
	}
	if info.Addrs[0].IP != "10.0.0.5" || info.Addrs[len(info.Addrs)-1].Family != 6 {
		t.Errorf("排序错误: %+v", info.Addrs)
	}
	if info.Addrs[3].Iface != "eth0" {
		t.Errorf("网卡名应去掉 @ 后缀: %+v", info.Addrs[3])
	}
	want := []string{"0.0.0.0 22", ":: 22", "127.0.0.53 53"}
	for i, w := range want {
		if info.Listening[i] != w {
			t.Errorf("LISTEN[%d]=%q want %q", i, info.Listening[i], w)
		}
	}
	if _, err := Parse("OS=x\n"); err == nil {
		t.Error("不完整的输出应报错")
	}
}

func TestProbe(t *testing.T) {
	info, _ := Parse(sample)
	res := ParseProbe("EGRESS=10.0.0.5 198.51.100.77\nEGRESS=203.0.113.10 203.0.113.10\nEGRESS=203.0.113.11 FAIL\n")
	ApplyProbe(info.Addrs, res)
	for _, a := range info.Addrs {
		switch a.IP {
		case "10.0.0.5":
			if a.Public != "198.51.100.77" || a.Probe != "ok" {
				t.Errorf("NAT 映射错误 %+v", a)
			}
		case "203.0.113.11":
			if a.Probe != "fail" {
				t.Errorf("应为失败 %+v", a)
			}
		}
	}
}
