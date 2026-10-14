/** 简单 CSV 解析（支持引号、逗号/制表符/分号分隔） */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const delim = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((x) => x)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x)) rows.push(row);
  return rows;
}

const HOST = /^(host|ip|address|addr|server|主机|地址|服务器|ip地址)$/i;
const PORT = /^(port|ssh_?port|端口)$/i;
const USER = /^(user|username|login|用户|用户名|账号)$/i;
const PASS = /^(pass|password|pwd|密码)$/i;

/** CSV → 批量粘贴的文本格式：host[:port] [user] [password] */
export function csvToServerLines(text: string): string[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  let idx = { host: 0, port: -1, user: -1, pass: -1 };
  const head = rows[0].map((x) => x.toLowerCase().replace(/\s+/g, ""));
  const hasHeader = head.some((h) => HOST.test(h));
  if (hasHeader) {
    idx = {
      host: head.findIndex((h) => HOST.test(h)),
      port: head.findIndex((h) => PORT.test(h)),
      user: head.findIndex((h) => USER.test(h)),
      pass: head.findIndex((h) => PASS.test(h)),
    };
  } else {
    // 无表头：host, [port], user, pass
    const second = rows[0][1] ?? "";
    idx = /^\d{1,5}$/.test(second) ? { host: 0, port: 1, user: 2, pass: 3 } : { host: 0, port: -1, user: 1, pass: 2 };
  }
  const out: string[] = [];
  for (const r of rows.slice(hasHeader ? 1 : 0)) {
    const host = r[idx.host] ?? "";
    if (!host) continue;
    const port = idx.port >= 0 ? r[idx.port] : "";
    const user = idx.user >= 0 ? r[idx.user] : "";
    const pass = idx.pass >= 0 ? r[idx.pass] : "";
    const h = host.includes(":") && port ? `[${host}]` : host;
    let line = port ? `${h}:${port}` : h;
    if (user || pass) line += ` ${user || "root"}`;
    if (pass) line += ` ${pass}`;
    out.push(line);
  }
  return out;
}
