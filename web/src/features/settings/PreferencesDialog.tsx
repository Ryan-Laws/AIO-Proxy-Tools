import * as React from "react";
import { KeyRoundIcon, LockIcon, LockOpenIcon, RotateCcwIcon, SettingsIcon, ShieldIcon, InfoIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { Preferences, Theme } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { ConfirmDialog, NumberInput, SwitchRow } from "@/components/common";
import { run, savePrefs, setVault, useApp } from "@/store/store";
import { useUI, ui } from "@/store/ui";
import { setTheme, useTheme } from "@/lib/theme";
import { t } from "@/i18n";
import { VaultDialog } from "./VaultDialog";

export function PreferencesDialog() {
  const open = useUI((s) => s.prefs);
  const prefs = useApp((s) => s.prefs);
  const meta = useApp((s) => s.meta);
  const vault = useApp((s) => s.vault);
  const theme = useTheme();
  const [p, setP] = React.useState<Preferences | null>(prefs);
  const [vaultMode, setVaultMode] = React.useState<"create" | "unlock" | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);

  React.useEffect(() => {
    if (open) setP(prefs ? { ...prefs, theme } : null);
  }, [open, prefs, theme]);

  const save = async () => {
    if (!p) return;
    const r = await savePrefs({ ...p, concurrency: Math.max(1, Math.min(10, Math.round(p.concurrency || 3))) });
    if (r) {
      setTheme((p.theme as Theme) || "system");
      toast.success(t("pref.saved"));
      ui.setPrefs(false);
    }
  };

  const vaultState = vault.unlocked ? t("vault.unlocked") : vault.exists ? t("vault.locked") : t("vault.notCreated");

  return (
    <>
      <Dialog open={open} onOpenChange={ui.setPrefs}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SettingsIcon className="size-5 text-primary" />
              {t("pref.title")}
            </DialogTitle>
          </DialogHeader>

          {p && (
            <div className="grid gap-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase">{t("pref.general")}</h4>
              <SwitchRow
                id="pref-history"
                label={t("pref.saveHistory")}
                desc={t("pref.saveHistoryD")}
                checked={p.saveHistory}
                onCheckedChange={(saveHistory) => setP({ ...p, saveHistory })}
              />
              <div className="flex items-start justify-between gap-4 py-2.5">
                <div className="grid gap-1">
                  <Label htmlFor="pref-conc" className="text-[13px]">
                    {t("pref.concurrency")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("pref.concurrencyD")}</p>
                </div>
                <NumberInput id="pref-conc" className="w-20 shrink-0" min={1} max={10} value={p.concurrency} onChange={(v) => setP({ ...p, concurrency: v })} />
              </div>
              <div className="flex items-center justify-between gap-4 py-2.5">
                <Label className="text-[13px]">{t("pref.theme")}</Label>
                <Select value={(p.theme as string) || "system"} onValueChange={(v) => setP({ ...p, theme: v })}>
                  <SelectTrigger className="w-32" size="sm" aria-label={t("pref.theme")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">{t("top.theme.system")}</SelectItem>
                    <SelectItem value="light">{t("top.theme.light")}</SelectItem>
                    <SelectItem value="dark">{t("top.theme.dark")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <Separator />

          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldIcon className="size-4 text-primary" />
                {t("vault.title")}
              </h4>
              <Badge variant={vault.unlocked ? "success" : vault.exists ? "warning" : "muted"}>{vaultState}</Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("vault.desc")}</p>
            <div className="flex flex-wrap gap-2">
              {!vault.exists && (
                <Button size="sm" onClick={() => setVaultMode("create")}>
                  <KeyRoundIcon />
                  {t("vault.create")}
                </Button>
              )}
              {vault.exists && !vault.unlocked && (
                <Button size="sm" onClick={() => setVaultMode("unlock")}>
                  <LockOpenIcon />
                  {t("vault.unlock")}
                </Button>
              )}
              {vault.exists && vault.unlocked && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const v = await run(api.vaultLock(), t("vault.lockedOk"));
                    if (v) setVault(v);
                  }}
                >
                  <LockIcon />
                  {t("vault.lock")}
                </Button>
              )}
              {vault.exists && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setResetOpen(true)}>
                  <RotateCcwIcon />
                  {t("vault.reset")}
                </Button>
              )}
            </div>
          </div>

          <Separator />
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <InfoIcon className="size-3.5" />
            {t("app.name")} · {t("pref.version", { v: meta?.version ?? "–" })} · MIT
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => ui.setPrefs(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={!p}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <VaultDialog mode={vaultMode ?? "create"} open={vaultMode !== null} onOpenChange={(v) => !v && setVaultMode(null)} />
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("vault.resetTitle")}
        desc={t("vault.resetDesc")}
        destructive
        confirmText={t("vault.reset")}
        onConfirm={async () => {
          const r = await run(api.vaultReset(), t("vault.resetOk"));
          if (r !== undefined) setVault({ exists: false, unlocked: false });
        }}
      />
    </>
  );
}
