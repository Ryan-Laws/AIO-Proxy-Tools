#!/usr/bin/env bash
# 构建全部平台：./build.sh [版本号]，产物在 dist/
set -euo pipefail
cd "$(dirname "$0")"
VERSION=${1:-dev}
NAME=aio-proxy-tools

if [ "${SKIP_WEB:-0}" != 1 ]; then
  (cd web && npm ci && npm run build)
fi

rm -rf dist && mkdir -p dist
targets="windows/amd64 windows/arm64 darwin/amd64 darwin/arm64 linux/amd64 linux/arm64"
for t in $targets; do
  os=${t%/*}; arch=${t#*/}
  ext=""; [ "$os" = windows ] && ext=.exe
  dir="dist/$NAME-$VERSION-$os-$arch"
  mkdir -p "$dir"
  echo "构建 $os/$arch"
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" -o "$dir/$NAME$ext" ./cmd/aio-proxy-tools
  cp README.md README.zh-CN.md LICENSE "$dir/"
  if [ "$os" = windows ]; then
    (cd dist && zip -qr "$(basename "$dir").zip" "$(basename "$dir")")
  else
    tar -C dist -czf "$dir.tar.gz" "$(basename "$dir")"
  fi
  rm -rf "$dir"
done
(cd dist && sha256sum ./*.zip ./*.tar.gz | sed 's# \./# #' > SHA256SUMS)
ls -lh dist
