package store

import (
	"testing"
)

// 保险箱：创建、写入、锁定后用正确/错误密码解锁；保存时沿用文件里的 scrypt 参数
func TestVaultRoundTrip(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateVault("short"); err == nil {
		t.Fatal("主密码太短应被拒绝")
	}
	if err := s.CreateVault("correct horse"); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSecret("srv1", &Secret{Password: "p@ss"}); err != nil {
		t.Fatal(err)
	}
	s.LockVault()
	if _, err := s.UnlockVault("wrong password"); err != ErrBadPassword {
		t.Fatalf("错误密码应返回 ErrBadPassword，得到 %v", err)
	}
	m, err := s.UnlockVault("correct horse")
	if err != nil || m["srv1"].Password != "p@ss" {
		t.Fatalf("解锁失败: %v %v", m, err)
	}
	// 解锁后再写入、再解锁：参数必须一致，否则下次无法解锁
	if err := s.PutSecret("srv2", &Secret{Password: "x"}); err != nil {
		t.Fatal(err)
	}
	s.LockVault()
	if m, err := s.UnlockVault("correct horse"); err != nil || len(m) != 2 {
		t.Fatalf("第二次解锁失败: %v %v", m, err)
	}
	var vf vaultFile
	if err := readJSON(s.Path("vault.json"), &vf); err != nil || vf.N != newVaultN {
		t.Fatalf("保险箱应使用新参数 N=%d，文件里是 %d（%v）", newVaultN, vf.N, err)
	}
}

func TestDeriveKeyRejectsHugeParams(t *testing.T) {
	if _, err := deriveKey("x", []byte("salt"), 1<<30, 8, 1); err == nil {
		t.Fatal("过大的 N 应被拒绝")
	}
}
