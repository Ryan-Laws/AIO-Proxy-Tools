// Package release 在本机下载 3proxy 官方发布文件（服务器无法访问 GitHub 时代为上传），
// 用程序内置的 SHA256（threeproxy.Pinned）校验，结果缓存在本机配置目录。
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
	"time"

	"github.com/Ryan-Laws/AIO-Proxy-Tools/internal/threeproxy"
)

type Fetcher struct {
	CacheDir string
}

// Get 返回发布文件内容。name 只能是内置校验清单里的文件名（它来自服务器输出，不可信）；
// 内容（包括缓存）每次都按内置 SHA256 校验。mirror 为可选的 GitHub 下载镜像前缀。
func (f *Fetcher) Get(ctx context.Context, name, mirror string) ([]byte, error) {
	want, ok := threeproxy.Pinned[name]
	if !ok {
		return nil, fmt.Errorf("拒绝下载未知文件 %q", name)
	}
	dir := filepath.Join(f.CacheDir, "3proxy-"+threeproxy.Version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	p := filepath.Join(dir, name) // name 已在白名单内，不含路径分隔符
	if b, err := os.ReadFile(p); err == nil && sum(b) == want {
		return b, nil
	}
	b, err := download(ctx, mirror+"https://github.com/3proxy/3proxy/releases/download/"+threeproxy.Version+"/"+name)
	if err != nil {
		return nil, fmt.Errorf("下载 %s 失败: %v", name, err)
	}
	if sum(b) != want {
		return nil, fmt.Errorf("%s 的 SHA256 与官方校验值不一致", name)
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err == nil {
		os.Rename(tmp, p)
	}
	return b, nil
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func download(ctx context.Context, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}
