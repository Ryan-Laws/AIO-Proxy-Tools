package netx

import (
	"reflect"
	"testing"
)

func TestExpand(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"203.0.113.10", []string{"203.0.113.10"}},
		{"203.0.113.10-12", []string{"203.0.113.10", "203.0.113.11", "203.0.113.12"}},
		{"203.0.113.10-203.0.113.11, 198.51.100.1", []string{"203.0.113.10", "203.0.113.11", "198.51.100.1"}},
		{"203.0.113.0/30", []string{"203.0.113.1", "203.0.113.2"}},
		{"203.0.113.8/31", []string{"203.0.113.8", "203.0.113.9"}},
		{"2001:db8::1 2001:DB8::0:1", []string{"2001:db8::1"}},
	}
	for _, c := range cases {
		got, err := Expand(c.in)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("Expand(%q) = %v, %v; want %v", c.in, got, err, c.want)
		}
	}
	if got, _ := Expand("203.0.113.0/24"); len(got) != 254 {
		t.Errorf("/24 应展开为 254 个地址，得到 %d", len(got))
	}
	for _, bad := range []string{"203.0.113.300", "10.0.0.0/8", "203.0.113.20-10", "x"} {
		if _, err := Expand(bad); err == nil {
			t.Errorf("Expand(%q) 应报错", bad)
		}
	}
}

func TestPortRanges(t *testing.T) {
	got := PortRanges([]int{8080, 1080, 20002, 20000, 20001, 1080})
	want := []string{"1080", "8080", "20000:20002"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestIsPrivate(t *testing.T) {
	for ip, want := range map[string]bool{"10.0.0.5": true, "100.64.1.1": true, "203.0.113.1": false, "fe80::1": true, "2001:db8::1": false} {
		if IsPrivate(ip) != want {
			t.Errorf("IsPrivate(%s) != %v", ip, want)
		}
	}
}
