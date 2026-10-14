import { zhCN, type MessageKey } from "./zh-CN";

// 目前只有简体中文；以后加英文时在这里按偏好切换字典。
const dict: Record<string, string> = zhCN;

/** 取文案，支持 {name} 占位符 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export type { MessageKey };
