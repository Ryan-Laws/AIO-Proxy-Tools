#!/usr/bin/env python3
"""端到端测试用的回显服务器。

GET /ip           → 请求来源 IP（用来验证代理的出口地址）
GET /headers      → 收到的请求头（JSON，用来检查是否泄露客户端 IP）
GET /bytes?n=N    → N 字节数据（测限速、流量额度）
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, body, ctype="text/plain"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/ip":
            self.send(self.client_address[0].encode())
        elif u.path == "/headers":
            self.send(json.dumps(dict(self.headers)).encode(), "application/json")
        elif u.path == "/bytes":
            n = int(parse_qs(u.query).get("n", ["0"])[0])
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(n))
            self.end_headers()
            chunk = b"\0" * 65536
            try:
                while n > 0:
                    k = min(n, len(chunk))
                    self.wfile.write(chunk[:k])
                    n -= k
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            self.send_error(404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
