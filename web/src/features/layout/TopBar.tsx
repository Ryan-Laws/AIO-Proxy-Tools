import { DownloadIcon, MenuIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon, FlaskConicalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMock } from "@/api/client";
import type { Theme } from "@/api/types";
import { savePrefs, setMobileNav, useApp } from "@/store/store";
import { ui } from "@/store/ui";
import { setTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export function Logo({ className }: { className?: string }) {
  return (
    // 与 web/public/favicon.svg、docs/assets/logo.svg 保持一致：一台服务器分出多个出口
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="aio-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#06b6d4" />
          <stop offset=".5" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#aio-g)" />
      <rect x="11" y="19" width="17" height="26" rx="4.5" fill="#fff" />
      <g fill="#3b82f6">
        <rect x="14.5" y="24.3" width="10" height="2.6" rx="1.3" />
        <rect x="14.5" y="30.7" width="10" height="2.6" rx="1.3" />
        <rect x="14.5" y="37.1" width="10" height="2.6" rx="1.3" />
      </g>
      <g fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round">
        <path d="M28 27C37 27 36 16 45 16" />
        <path d="M28 32H46" />
        <path d="M28 37C37 37 36 48 45 48" />
      </g>
      <g fill="#fff">
        <circle cx="49" cy="16" r="4.4" />
        <circle cx="50" cy="32" r="4.4" />
        <circle cx="49" cy="48" r="4.4" />
      </g>
    </svg>
  );
}

export function applyTheme(v: Theme) {
  setTheme(v);
  const p = useApp.getState().prefs;
  if (p && p.theme !== v) void savePrefs({ ...p, theme: v });
}

export function TopBar() {
  const conn = useApp((s) => s.conn);
  const hasServers = useApp((s) => s.order.length > 0);
  const theme = useTheme();
  const ThemeIcon = theme === "dark" ? MoonIcon : theme === "light" ? SunIcon : MonitorIcon;
  const connTip = conn === "open" ? t("top.conn.open") : conn === "connecting" ? t("top.conn.connecting") : t("top.conn.error");

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur md:px-4">
      <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setMobileNav(true)} aria-label={t("top.servers")}>
        <MenuIcon />
      </Button>
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo className="size-7 shrink-0" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[15px] font-semibold tracking-tight">{t("app.name")}</div>
          <div className="hidden truncate text-[11px] text-muted-foreground sm:block">{t("app.tagline")}</div>
        </div>
        <Tip content={connTip}>
          <span
            tabIndex={0}
            aria-label={connTip}
            className={cn(
              "ml-1 size-2 shrink-0 rounded-full",
              conn === "open" ? "bg-success" : conn === "connecting" ? "animate-pulse bg-warning" : "animate-pulse bg-destructive",
            )}
          />
        </Tip>
        {isMock && (
          <Tip content={t("top.mockTip")}>
            <Badge variant="warning" tabIndex={0}>
              <FlaskConicalIcon />
              <span className="hidden sm:inline">{t("top.mock")}</span>
            </Badge>
          </Tip>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => ui.setExportAll(true)} disabled={!hasServers}>
          <DownloadIcon />
          <span className="hidden sm:inline">{t("top.exportAll")}</span>
        </Button>
        <DropdownMenu>
          <Tip content={t("top.theme")}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("top.theme")}>
                <ThemeIcon />
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("top.theme")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => applyTheme(v as Theme)}>
              <DropdownMenuRadioItem value="system">
                <MonitorIcon />
                {t("top.theme.system")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <SunIcon />
                {t("top.theme.light")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon />
                {t("top.theme.dark")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip content={t("top.settings")}>
          <Button variant="ghost" size="icon-sm" onClick={() => ui.setPrefs(true)} aria-label={t("top.settings")}>
            <SettingsIcon />
          </Button>
        </Tip>
      </div>
    </header>
  );
}
