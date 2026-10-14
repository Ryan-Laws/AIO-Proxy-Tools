package app

import "testing"

func TestParseBatch(t *testing.T) {
	text := "# 注释\n203.0.113.10\n203.0.113.11:2222 admin p@ss word\nhost,port,user,password\n198.51.100.5,22022,ubuntu,a,b\n[2001:db8::1]:22 root\nbad:99999\n"
	list, errs := ParseBatch(text, 22, "root", "password")
	if len(list) != 4 {
		t.Fatalf("应解析 4 台，得到 %d: %+v %v", len(list), list, errs)
	}
	if list[1].Port != 2222 || list[1].User != "admin" || list[1].Password != "p@ss word" {
		t.Errorf("空格分隔解析错误: %+v", list[1])
	}
	if list[2].Port != 22022 || list[2].User != "ubuntu" || list[2].Password != "a" {
		t.Errorf("CSV 解析错误: %+v", list[2])
	}
	if list[3].Host != "2001:db8::1" {
		t.Errorf("IPv6 解析错误: %+v", list[3])
	}
	if len(errs) != 1 {
		t.Errorf("应有 1 条错误: %v", errs)
	}
}
