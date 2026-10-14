// Package release 在本机下载 3proxy 官方发布文件（服务器无法访问 GitHub 时代为上传），
// 并用官方 SHA256SUMS 校验，结果缓存在本机配置目录。
package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Fetcher struct {
	CacheDir string
	Mirror   string // 可选的 GitHub 下载镜像前缀
}

func (f *Fetcher) url(version, name string) string {
	return f.Mirror + "https://github.com/3proxy/3proxy/releases/download/" + version + "/" + name
}

// Get 返回发布文件内容；校验和文件本身不校验，其余文件必须与校验和文件中的 SHA256 一致。
func (f *Fetcher) Get(ctx context.Context, version, name, sumsName string) ([]byte, error) {
	dir := filepath.Join(f.CacheDir, "3proxy-"+version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	sums, err := f.cached(ctx, dir, version, sumsName)
	if err != nil {
		return nil, fmt.Errorf("下载校验文件 %s 失败: %v", sumsName, err)
	}
	if name == sumsName {
		return sums, nil
	}
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		fs := strings.Fields(line)
		if len(fs) == 2 && strings.TrimPrefix(fs[1], "*") == name {
			want = strings.ToLower(fs[0])
		}
	}
	if want == "" {
		return nil, fmt.Errorf("校验文件中没有 %s", name)
	}
	data, err := f.cached(ctx, dir, version, name)
	if err != nil {
		return nil, fmt.Errorf("下载 %s 失败: %v", name, err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != want {
		os.Remove(filepath.Join(dir, name))
		return nil, fmt.Errorf("%s 的 SHA256 与官方校验值不一致", name)
	}
	return data, nil
}

func (f *Fetcher) cached(ctx context.Context, dir, version, name string) ([]byte, error) {
	p := filepath.Join(dir, name)
	if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
		return b, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.url(version, name), nil)
	if err != nil {
		return nil, err
	}
	// 使用本机代理环境变量（HTTPS_PROXY 等），方便国内网络访问 GitHub
	cl := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return nil, err
	}
	return b, os.Rename(tmp, p)
}
