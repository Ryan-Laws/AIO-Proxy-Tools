// Package netx 提供 IP / CIDR / 范围的解析与展开。
package netx

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"
)

// MaxExpand 是单个网段/范围最多展开的地址数。
const MaxExpand = 4096

// Canon 返回地址的规范写法（IPv6 压缩形式），非法时返回空串。
func Canon(s string) string {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	if err != nil {
		return ""
	}
	return a.Unmap().String()
}

func Family(s string) int {
	a, err := netip.ParseAddr(s)
	if err != nil {
		return 0
	}
	if a.Unmap().Is4() {
		return 4
	}
	return 6
}

// IsPrivate 判断是否为内网/保留地址（用于识别 NAT 场景）。
func IsPrivate(s string) bool {
	a, err := netip.ParseAddr(s)
	if err != nil {
		return false
	}
	a = a.Unmap()
	if a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return true
	}
	// 100.64.0.0/10 运营商级 NAT
	return netip.MustParsePrefix("100.64.0.0/10").Contains(a)
}

// Expand 把一行文本展开为地址列表。支持：
//
//	单个地址 203.0.113.10
//	CIDR     203.0.113.0/24（IPv4 排除网络号与广播地址，/31、/32 除外）
//	范围     203.0.113.10-203.0.113.50 或 203.0.113.10-50
//
// 多个条目可用逗号、空格或换行分隔。
func Expand(text string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	add := func(a netip.Addr) {
		s := a.Unmap().String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	fields := strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\r' || r == '\t' || r == ';'
	})
	for _, f := range fields {
		switch {
		case strings.Contains(f, "/"):
			p, err := netip.ParsePrefix(f)
			if err != nil {
				return nil, fmt.Errorf("无效网段 %q", f)
			}
			p = p.Masked()
			bits := p.Addr().BitLen() - p.Bits()
			if bits > 12 {
				return nil, fmt.Errorf("网段 %s 太大（单个网段最多 %d 个地址）", f, MaxExpand)
			}
			n := 1 << bits
			a := p.Addr()
			for i := 0; i < n; i++ {
				skip := p.Addr().Is4() && p.Bits() < 31 && (i == 0 || i == n-1)
				if !skip {
					add(a)
				}
				a = a.Next()
			}
		case strings.Contains(f, "-"):
			parts := strings.SplitN(f, "-", 2)
			start, err := netip.ParseAddr(strings.TrimSpace(parts[0]))
			if err != nil {
				return nil, fmt.Errorf("无效范围 %q", f)
			}
			endS := strings.TrimSpace(parts[1])
			if start.Is4() && !strings.Contains(endS, ".") {
				b := start.As4()
				endS = fmt.Sprintf("%d.%d.%d.%s", b[0], b[1], b[2], endS)
			}
			end, err := netip.ParseAddr(endS)
			if err != nil || end.Less(start) || start.Is4() != end.Is4() {
				return nil, fmt.Errorf("无效范围 %q", f)
			}
			count := 0
			for a := start; ; a = a.Next() {
				add(a)
				count++
				if a == end {
					break
				}
				if count >= MaxExpand {
					return nil, fmt.Errorf("范围 %s 太大（最多 %d 个地址）", f, MaxExpand)
				}
			}
		default:
			a, err := netip.ParseAddr(f)
			if err != nil {
				return nil, fmt.Errorf("无效地址 %q", f)
			}
			add(a)
		}
	}
	return out, nil
}

// PortRanges 把端口列表压缩成连续区间，如 [1080 20000 20001 20002] → ["1080", "20000:20002"]。
func PortRanges(ports []int) []string {
	if len(ports) == 0 {
		return nil
	}
	set := map[int]bool{}
	for _, p := range ports {
		set[p] = true
	}
	var sorted []int
	for p := range set {
		sorted = append(sorted, p)
	}
	sort.Ints(sorted)
	var out []string
	start, prev := sorted[0], sorted[0]
	flush := func() {
		if start == prev {
			out = append(out, fmt.Sprint(start))
		} else {
			out = append(out, fmt.Sprintf("%d:%d", start, prev))
		}
	}
	for _, p := range sorted[1:] {
		if p == prev+1 {
			prev = p
			continue
		}
		flush()
		start, prev = p, p
	}
	flush()
	return out
}
