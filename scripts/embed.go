// Package scripts 内嵌服务器端脚本。
package scripts

import (
	_ "embed"
)

//go:embed common.sh
var Common string

//go:embed detect.sh
var Detect string

//go:embed probe.sh
var Probe string

//go:embed install.sh
var Install string

//go:embed uninstall.sh
var Uninstall string

//go:embed ctl.sh
var Ctl string

// WithCommon 把公共函数拼接到脚本前面，得到可直接执行的完整脚本。
func WithCommon(body string) string {
	return "#!/bin/sh\n" + Common + "\n" + body
}
