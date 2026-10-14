// Package detect 解析服务器端 detect.sh / probe.sh 的输出。
package detect

import (
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/netx"
)

// MaxAnyIP 是 AnyIP 网段自动展开的上限。
const MaxAnyIP = 4096

// Parse 解析 detect.sh 的输出。
func Parse(out string) (*model.ServerInfo, error) {
	info := &model.ServerInfo{DetectedAt: time.Now()}
	done := false
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "OS":
			info.OS = v
		case "OS_ID":
			info.OSID = v
		case "OS_VERSION":
			info.OSVersion = v
		case "KERNEL":
			info.Kernel = v
		case "ARCH":
			info.Arch = v
		case "UID":
			info.IsRoot = v == "0"
		case "CPUS":
			info.CPUs, _ = strconv.Atoi(v)
		case "MEM_KB":
			kb, _ := strconv.Atoi(v)
			info.MemMB = kb / 1024
		case "INIT":
			info.Init = v
		case "PM":
			info.PM = v
		case "HAS_CURL":
			info.HasCurl = true
		case "HAS_WGET":
			info.HasWget = true
		case "NO_IP_CMD":
			info.Warnings = append(info.Warnings, "服务器缺少 ip 命令（iproute2），部署时会自动安装")
		case "FW":
			info.Firewalls = strings.Fields(v)
		case "TCP_CC":
			info.TCPCC = v
		case "INSTALLED":
			info.Installed = true
		case "VERSION":
			info.Version = v
		case "CONFLICTS":
			info.Conflicts = strings.Fields(v)
		case "DEFIF":
			info.DefaultIface = v
		case "LISTEN":
			info.Listening = normalizeListen(strings.Fields(v))
		case "ADDR4", "ADDR6":
			ifc, cidr, _ := strings.Cut(v, " ")
			p, err := netip.ParsePrefix(strings.TrimSpace(cidr))
			if err != nil {
				continue
			}
			ip := p.Addr().Unmap().String()
			if seen[ip] {
				continue
			}
			seen[ip] = true
			fam := 4
			if k == "ADDR6" {
				fam = 6
			}
			info.Addrs = append(info.Addrs, model.Addr{IP: ip, Prefix: p.Bits(), Iface: ifc, Family: fam, Source: "nic"})
		case "ANYIP4":
			ifc, cidr, _ := strings.Cut(v, " ")
			cidr = strings.TrimSpace(cidr)
			info.AnyIP = append(info.AnyIP, cidr)
			p, err := netip.ParsePrefix(cidr)
			if err != nil {
				continue
			}
			if 1<<(32-p.Bits()) > MaxAnyIP {
				info.Warnings = append(info.Warnings, fmt.Sprintf("AnyIP 网段 %s 太大，未自动展开，可手动添加需要的地址", cidr))
				continue
			}
			ips, _ := netx.Expand(cidr)
			for _, ip := range ips {
				if seen[ip] {
					continue
				}
				seen[ip] = true
				info.Addrs = append(info.Addrs, model.Addr{IP: ip, Prefix: 32, Iface: ifc, Family: 4, Source: "anyip"})
			}
		case "DETECT_DONE":
			done = true
		}
	}
	if !done {
		return nil, fmt.Errorf("探测输出不完整")
	}
	if info.Init == "unknown" {
		info.Warnings = append(info.Warnings, "未识别到 systemd 或 OpenRC，无法注册系统服务")
	}
	if len(info.Addrs) == 0 {
		info.Warnings = append(info.Warnings, "未发现可用的全局 IP 地址")
	}
	SortAddrs(info.Addrs)
	return info, nil
}

func normalizeListen(items []string) []string {
	var out []string
	for _, it := range items {
		i := strings.LastIndex(it, ":")
		if i < 0 {
			continue
		}
		host := strings.Trim(it[:i], "[]")
		if j := strings.Index(host, "%"); j >= 0 {
			host = host[:j]
		}
		out = append(out, host+" "+it[i+1:])
	}
	return out
}

// SortAddrs 按 IPv4 在前、地址从小到大排序。
func SortAddrs(a []model.Addr) {
	sort.SliceStable(a, func(i, j int) bool {
		if a[i].Family != a[j].Family {
			return a[i].Family < a[j].Family
		}
		x, _ := netip.ParseAddr(a[i].IP)
		y, _ := netip.ParseAddr(a[j].IP)
		return x.Less(y)
	})
}

// ParseProbe 解析 probe.sh 输出，返回 本机地址 → 公网 IP（失败为空）。
func ParseProbe(out string) map[string]string {
	res := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		v, ok := strings.CutPrefix(strings.TrimSpace(line), "EGRESS=")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) != 2 {
			continue
		}
		ip := netx.Canon(f[0])
		if f[1] == "FAIL" {
			res[ip] = ""
		} else {
			res[ip] = netx.Canon(f[1])
		}
	}
	return res
}

// ApplyProbe 把探测结果写回地址列表。
func ApplyProbe(addrs []model.Addr, res map[string]string) {
	for i := range addrs {
		pub, ok := res[addrs[i].IP]
		if !ok {
			continue
		}
		if pub == "" {
			addrs[i].Probe = "fail"
			addrs[i].Public = ""
		} else {
			addrs[i].Probe = "ok"
			addrs[i].Public = pub
		}
	}
}
