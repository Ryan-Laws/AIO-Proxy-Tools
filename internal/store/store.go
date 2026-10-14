// Package store 负责本机持久化：偏好设置、服务器历史（不含密码）与可选的加密保险箱。
package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/scrypt"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/model"
)

// Dir 返回本机数据目录。
func Dir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, "aio-proxy-tools")
}

// SavedServer 是写入磁盘的服务器记录，不含任何密码。
type SavedServer struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	User     string   `json:"user"`
	AuthType string   `json:"authType"`
	Remember bool     `json:"remember"`
	Selected []string `json:"selected"`
}

// Secret 是保险箱里一台服务器的凭据。
type Secret struct {
	Password   string `json:"password,omitempty"`
	Key        string `json:"key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

type Store struct {
	dir string
	mu  sync.Mutex

	vaultKey  []byte
	vaultSalt []byte
	vault     map[string]Secret
}

func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

func (s *Store) Path(name string) string { return filepath.Join(s.dir, name) }

func writeJSON(path string, v any, mode os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// ---------- 偏好 ----------

func (s *Store) LoadPrefs(def model.Preferences) model.Preferences {
	p := def
	if err := readJSON(s.Path("prefs.json"), &p); err != nil {
		return def
	}
	if p.Concurrency < 1 || p.Concurrency > 10 {
		p.Concurrency = def.Concurrency
	}
	return p
}

func (s *Store) SavePrefs(p model.Preferences) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeJSON(s.Path("prefs.json"), p, 0o600)
}

// ---------- 服务器历史 ----------

func (s *Store) LoadServers() []SavedServer {
	var list []SavedServer
	readJSON(s.Path("servers.json"), &list)
	return list
}

func (s *Store) SaveServers(list []SavedServer) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if list == nil {
		list = []SavedServer{}
	}
	return writeJSON(s.Path("servers.json"), list, 0o600)
}

func (s *Store) ClearServers() error {
	err := os.Remove(s.Path("servers.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// ---------- 加密保险箱 ----------
// 主密码经 scrypt 派生 256 位密钥，AES-256-GCM 加密全部凭据。主密码本身不落盘。

type vaultFile struct {
	V     int    `json:"v"`
	Salt  []byte `json:"salt"`
	N     int    `json:"n"`
	R     int    `json:"r"`
	P     int    `json:"p"`
	Nonce []byte `json:"nonce"`
	Data  []byte `json:"data"`
}

var ErrBadPassword = errors.New("主密码不正确")

func (s *Store) VaultExists() bool {
	_, err := os.Stat(s.Path("vault.json"))
	return err == nil
}

func (s *Store) VaultUnlocked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.vaultKey != nil
}

func deriveKey(pw string, salt []byte, n, r, p int) ([]byte, error) {
	return scrypt.Key([]byte(pw), salt, n, r, p, 32)
}

func (s *Store) CreateVault(password string) error {
	if len(password) < 8 {
		return errors.New("主密码至少 8 位")
	}
	if s.VaultExists() {
		return errors.New("保险箱已存在")
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := deriveKey(password, salt, 1<<15, 8, 1)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.vaultKey, s.vaultSalt, s.vault = key, salt, map[string]Secret{}
	s.mu.Unlock()
	return s.flushVault()
}

func (s *Store) UnlockVault(password string) (map[string]Secret, error) {
	var vf vaultFile
	if err := readJSON(s.Path("vault.json"), &vf); err != nil {
		return nil, errors.New("保险箱不存在或已损坏")
	}
	key, err := deriveKey(password, vf.Salt, vf.N, vf.R, vf.P)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, vf.Nonce, vf.Data, nil)
	if err != nil {
		return nil, ErrBadPassword
	}
	m := map[string]Secret{}
	if err := json.Unmarshal(plain, &m); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.vaultKey, s.vaultSalt, s.vault = key, vf.Salt, m
	s.mu.Unlock()
	out := map[string]Secret{}
	for k, v := range m {
		out[k] = v
	}
	return out, nil
}

func (s *Store) LockVault() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vaultKey, s.vault = nil, nil
}

func (s *Store) ResetVault() error {
	s.LockVault()
	err := os.Remove(s.Path("vault.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// PutSecret 写入/删除（sec 为 nil）一台服务器的凭据，保险箱必须已解锁。
func (s *Store) PutSecret(id string, sec *Secret) error {
	s.mu.Lock()
	if s.vaultKey == nil {
		s.mu.Unlock()
		return errors.New("保险箱未解锁")
	}
	if sec == nil {
		delete(s.vault, id)
	} else {
		s.vault[id] = *sec
	}
	s.mu.Unlock()
	return s.flushVault()
}

func (s *Store) flushVault() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	plain, err := json.Marshal(s.vault)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(s.vaultKey)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, gcm.NonceSize())
	rand.Read(nonce)
	vf := vaultFile{V: 1, Salt: s.vaultSalt, N: 1 << 15, R: 8, P: 1, Nonce: nonce, Data: gcm.Seal(nil, nonce, plain, nil)}
	return writeJSON(s.Path("vault.json"), vf, 0o600)
}
