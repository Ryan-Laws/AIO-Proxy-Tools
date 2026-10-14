// vite build 会清空 dist/，这里重新创建 .gitkeep（Go 的 go:embed 需要目录存在）。
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (!existsSync(dist)) mkdirSync(dist, { recursive: true });
writeFileSync(dist + ".gitkeep", "");
