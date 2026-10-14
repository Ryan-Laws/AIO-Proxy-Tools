import * as React from "react";
import { FlaskConicalIcon, Loader2Icon, PlugZapIcon, RotateCwIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Dialog, SheetContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common";
import { hasToken } from "@/api/client";
import { init, setMobileNav, useApp } from "@/store/store";
import { ui, useUI } from "@/store/ui";
import { TopBar } from "@/features/layout/TopBar";
import { Hero, SelectHint } from "@/features/layout/Hero";
import { Workspace } from "@/features/layout/Workspace";
import { ServerList } from "@/features/servers/ServerList";
import { AddServerDialog } from "@/features/servers/AddServerDialog";
import { PasteDialog } from "@/features/servers/PasteDialog";
import { ExportDialog } from "@/features/export/ExportDialog";
import { PreferencesDialog } from "@/features/settings/PreferencesDialog";
import { setTheme } from "@/lib/theme";
import type { Theme } from "@/api/types";
import { t } from "@/i18n";

function GlobalDialogs() {
  const add = useUI((s) => s.add);
  const edit = useUI((s) => s.edit);
  const paste = useUI((s) => s.paste);
  const pasteText = useUI((s) => s.pasteText);
  const exportAll = useUI((s) => s.exportAll);
  return (
    <>
      <AddServerDialog open={add} onOpenChange={(v) => !v && ui.closeAdd()} edit={edit} />
      <PasteDialog open={paste} onOpenChange={(v) => !v && ui.closePaste()} initialText={pasteText} />
      <ExportDialog open={exportAll} onOpenChange={ui.setExportAll} />
      <PreferencesDialog />
    </>
  );
}

function Main() {
  const ready = useApp((s) => s.ready);
  const loadError = useApp((s) => s.loadError);
  const empty = useApp((s) => s.order.length === 0);
  const selectedId = useApp((s) => s.selectedId);
  const mobileNav = useApp((s) => s.mobileNav);

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2Icon className="mr-2 size-5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  if (loadError) {
    const noToken = !hasToken();
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<PlugZapIcon />}
          title={noToken ? t("load.noToken") : t("load.failed")}
          desc={
            <>
              {noToken ? t("load.noTokenD") : t("load.failedD")}
              <span className="mt-2 block font-mono text-xs text-destructive">{loadError}</span>
            </>
          }
        >
          <Button onClick={() => void init()}>
            <RotateCwIcon />
            {t("load.retry")}
          </Button>
          <Button variant="outline" onClick={() => (location.href = location.pathname + "?mock=1")}>
            <FlaskConicalIcon />
            {t("load.demo")}
          </Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {!empty && (
        <aside className="hidden w-72 shrink-0 border-r bg-sidebar md:block lg:w-80">
          <ServerList />
        </aside>
      )}
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent aria-describedby={undefined}>
          <DialogTitle className="sr-only">{t("side.title")}</DialogTitle>
          <ServerList />
        </SheetContent>
      </Dialog>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {empty ? <Hero /> : selectedId ? <Workspace key={selectedId} id={selectedId} /> : <SelectHint />}
      </main>
    </div>
  );
}

export default function App() {
  const prefsTheme = useApp((s) => s.prefs?.theme);
  React.useEffect(() => {
    void init();
  }, []);
  // 首次加载时，如本机没有设置过主题，则采用后端保存的偏好
  React.useEffect(() => {
    if (!prefsTheme) return;
    let local: string | null = null;
    try {
      local = localStorage.getItem("aio-theme");
    } catch {
      /* ignore */
    }
    if (!local && (prefsTheme === "light" || prefsTheme === "dark" || prefsTheme === "system")) setTheme(prefsTheme as Theme);
  }, [prefsTheme]);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh flex-col">
        <TopBar />
        <Main />
      </div>
      <GlobalDialogs />
      <Toaster />
    </TooltipProvider>
  );
}
