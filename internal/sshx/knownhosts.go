package sshx

import (
	"bufio"
	"bytes"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// KnownHosts 实现"首次信任"（TOFU）：第一次连接记录主机密钥，之后不一致则拒绝。
type KnownHosts struct {
	path string
	mu   sync.Mutex
}

func NewKnownHosts(path string) *KnownHosts {
	return &KnownHosts{path: path}
}

func (k *KnownHosts) Check(addr string, key ssh.PublicKey, trustNew bool) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(k.path), 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(k.path); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(k.path, nil, 0o600); err != nil {
			return err
		}
	}
	cb, err := knownhosts.New(k.path)
	if err != nil {
		return err
	}
	remote := &net.TCPAddr{IP: net.IPv4zero}
	err = cb(addr, remote, key)
	if err == nil {
		return nil
	}
	var ke *knownhosts.KeyError
	if !errors.As(err, &ke) {
		return err
	}
	if len(ke.Want) > 0 && !trustNew {
		exp := make([]string, 0, len(ke.Want))
		for _, w := range ke.Want {
			exp = append(exp, ssh.FingerprintSHA256(w.Key))
		}
		return &HostKeyError{Host: addr, Got: ssh.FingerprintSHA256(key), Expected: exp}
	}
	if len(ke.Want) > 0 {
		if err := k.remove(addr); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(k.path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(knownhosts.Line([]string{knownhosts.Normalize(addr)}, key) + "\n")
	return err
}

// remove 删除某主机的全部记录。
func (k *KnownHosts) remove(addr string) error {
	data, err := os.ReadFile(k.path)
	if err != nil {
		return err
	}
	host := knownhosts.Normalize(addr)
	var out bytes.Buffer
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		fields := strings.Fields(line)
		if len(fields) > 0 {
			hosts := strings.Split(fields[0], ",")
			match := false
			for _, h := range hosts {
				if h == host {
					match = true
				}
			}
			if match {
				continue
			}
		}
		out.WriteString(line + "\n")
	}
	return os.WriteFile(k.path, out.Bytes(), 0o600)
}
