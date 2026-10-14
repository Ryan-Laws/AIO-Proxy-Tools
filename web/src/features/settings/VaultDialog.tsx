import * as React from "react";
import { KeyRoundIcon, LockKeyholeOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { VaultState } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, PasswordInput } from "@/components/common";
import { errMsg, setVault } from "@/store/store";
import { t } from "@/i18n";

/** 创建或解锁保险箱。成功后调用 onDone(state)。 */
export function VaultDialog({
  mode,
  open,
  onOpenChange,
  onDone,
}: {
  mode: "create" | "unlock";
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: (v: VaultState) => void;
}) {
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setPw("");
      setPw2("");
      setErr("");
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "create") {
      if (pw.length < 8) return setErr(t("vault.tooShort"));
      if (pw !== pw2) return setErr(t("vault.mismatch"));
    }
    setBusy(true);
    try {
      const v = mode === "create" ? await api.vaultCreate(pw) : await api.vaultUnlock(pw);
      setVault(v);
      toast.success(mode === "create" ? t("vault.created") : t("vault.unlockedOk"));
      onOpenChange(false);
      onDone?.(v);
    } catch (e2) {
      setErr(errMsg(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {mode === "create" ? <KeyRoundIcon className="size-5 text-primary" /> : <LockKeyholeOpenIcon className="size-5 text-primary" />}
              {mode === "create" ? t("vault.createTitle") : t("vault.unlockTitle")}
            </DialogTitle>
            <DialogDescription>{mode === "create" ? t("vault.createDesc") : t("vault.unlockDesc")}</DialogDescription>
          </DialogHeader>
          <Field label={t("vault.password")} htmlFor="vault-pw">
            <PasswordInput id="vault-pw" autoFocus autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          {mode === "create" && (
            <Field label={t("vault.password2")} htmlFor="vault-pw2">
              <PasswordInput id="vault-pw2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </Field>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !pw}>
              {mode === "create" ? t("vault.create") : t("vault.unlock")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
