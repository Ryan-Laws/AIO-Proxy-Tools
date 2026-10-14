// Package webui 内嵌前端构建产物（web/dist）。
package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS 返回前端静态文件。
func FS() fs.FS {
	sub, _ := fs.Sub(dist, "dist")
	return sub
}
